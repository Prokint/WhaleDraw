import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { c as pack } from "tar";
import { installVerifiedBundle } from "../src/verified-install.mjs";

const name = "dsh-infinite-canvas";
const native = process.env.DSH_MANAGER_MODULE;
const pnpm = process.env.DSH_TEST_PNPM;
const node = process.env.DSH_TEST_NODE || process.execPath;
const nativeOptions = { skip: !native || !pnpm };

async function runPnpm(profile, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(node, [pnpm, ...args, "--ignore-scripts"], { cwd: profile, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        child.stdout.on("data", (chunk) => { output += chunk; });
        child.stderr.on("data", (chunk) => { output += chunk; });
        child.once("error", reject);
        child.once("exit", (exitCode) => resolve({ exitCode, output, truncated: false }));
    });
}

async function packageAt(path, version) {
    await mkdir(join(path, "dist/app"), { recursive: true });
    await mkdir(join(path, "src"));
    await writeFile(join(path, "package.json"), JSON.stringify({ name, version, type: "module", main: "src/index.mjs", dsh: { bundle: { patch: "./cordis.yml" } } }));
    await writeFile(join(path, "cordis.yml"), "[]\n");
    await writeFile(join(path, "src/index.mjs"), `export const version = '${version}';\n`);
    await writeFile(join(path, "dist/app/version.json"), JSON.stringify({ version: `v${version}` }));
    await writeFile(join(path, "dist/app/index.html"), version);
}

async function fixture(t, useNative = false) {
    const root = await mkdtemp(join(tmpdir(), "canvas-verified-update-"));
    t.after(async () => {
        const part = relative(await realpath(tmpdir()), await realpath(root));
        assert.ok(part.startsWith("canvas-verified-update-") && !isAbsolute(part) && !part.includes(".."));
        await rm(root, { recursive: true, force: true });
    });
    const profile = join(root, "profile");
    const modules = join(profile, "node_modules");
    const source = join(root, "source");
    const otherSource = join(root, "other-source");
    await packageAt(source, "1.0.0");
    await writeFile(join(source, "keep.txt"), "源码必须保留");
    await link(join(source, "keep.txt"), join(source, "keep-alias.txt"));
    await mkdir(otherSource);
    await writeFile(join(otherSource, "package.json"), JSON.stringify({ name: "other-plugin", version: "1.0.0" }));
    await writeFile(join(otherSource, "keep.txt"), "其他插件");
    await mkdir(join(source, "node_modules"));
    await symlink(otherSource, join(source, "node_modules/dev-dep"), process.platform === "win32" ? "junction" : "dir");
    await mkdir(modules, { recursive: true });
    await writeFile(join(profile, "package.json"), JSON.stringify({ name: "test-profile", private: true, dependencies: { [name]: `link:${source}`, "other-plugin": `link:${otherSource}` }, dsh: { profile: { bundles: [name] } } }));
    await writeFile(join(profile, "pnpm-workspace.yaml"), "packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n");
    let manager;
    if (useNative) {
        const { PluginManager } = await import(pathToFileURL(native));
        manager = Object.create(PluginManager.prototype);
        Object.assign(manager, {
            profile: { dir: profile, installAnchor: join(profile, "package.json"), startedBundles: [name] },
            abort: new AbortController(), installs: new Map(), packageOperations: new Set(),
            ownerContext: { get() {}, emit() {}, logger: { warn() {} } },
            async registries() { return { registry: null, fallbackRegistries: [], resolved: null }; },
            async configure(operation) { return operation(); }, async selectBundle() {},
            async runPnpm(args) { return runPnpm(profile, args); },
        });
        const first = await runPnpm(profile, ["add", `link:${source}`]);
        assert.equal(first.exitCode, 0, first.output);
    } else {
        await symlink(source, join(modules, name), process.platform === "win32" ? "junction" : "dir");
        manager = {
            profile: { dir: profile },
            async readRestoredFiles() { return new Map([[join(profile, "package.json"), await readFile(join(profile, "package.json"), "utf8")]]); },
            async restoreFiles(files) { for (const [file, text] of files) await writeFile(file, text); },
            async change(operation, request) {
                const result = { ...request };
                try { result.application = await operation(result); }
                catch (error) { result.application = "failed"; result.error = { diagnostic: error.message }; }
                return result;
            },
            installBundle(file) { return this.change(async (result) => {
                await cp(join(root, "release/package"), join(modules, name), { recursive: true });
                await symlink(otherSource, join(modules, "other-plugin"), process.platform === "win32" ? "junction" : "dir");
                result.bundle = name;
                return "restart-required";
            }, { stage: "install", target: file }); },
        };
    }
    // 其他插件的文件必须一起恢复，不能只检查目标插件。
    if (!useNative) await symlink(otherSource, join(modules, "other-plugin"), process.platform === "win32" ? "junction" : "dir");
    const build = async (version) => {
        const stage = join(root, `release-${version}`);
        await packageAt(join(stage, "package"), version);
        const downloads = join(profile, ".plugin-manager/downloads");
        await mkdir(downloads, { recursive: true });
        const directory = await mkdtemp(join(downloads, "update-"));
        const file = join(directory, "update.tgz");
        await pack({ cwd: stage, file, gzip: true }, ["package"]);
        if (!useNative) { await rm(join(root, "release"), { recursive: true, force: true }); await cp(stage, join(root, "release"), { recursive: true }); }
        return { directory, file };
    };
    return { root, profile, modules, source, manager, build };
}

test("链接入口移开后安装，源码保留，正式包可以再次更新", async (t) => {
    const f = await fixture(t);
    for (const version of ["1.0.1", "1.0.2"]) {
        const { file, directory } = await f.build(version);
        assert.equal((await installVerifiedBundle(f.manager, file, version, directory)).application, "restart-required");
        assert.equal(await readFile(join(f.source, "keep.txt"), "utf8"), "源码必须保留");
        assert.equal(JSON.parse(await readFile(join(f.modules, name, "package.json"))).version, version);
        assert.equal(JSON.parse(await readFile(join(directory, "recovery.json"))).status, "installed");
        assert.equal(await readFile(join(f.modules, "other-plugin/keep.txt"), "utf8"), "其他插件");
    }
});

for (const failure of ["安装器抛错", "文件缺失", "文件篡改", "多出文件"]) test(`${failure}时恢复整个依赖目录与配置`, async (t) => {
    const f = await fixture(t);
    const before = await readFile(join(f.profile, "package.json"), "utf8");
    const install = f.manager.installBundle;
    f.manager.installBundle = function (file) {
        return this.change(async (result) => {
            await cp(join(f.root, "release/package"), join(f.modules, name), { recursive: true });
            await writeFile(join(f.profile, "package.json"), "错误配置");
            result.bundle = name;
            if (failure === "安装器抛错") throw new Error("模拟安装中断");
            if (failure === "文件缺失") await rename(join(f.modules, name, "src/index.mjs"), join(f.root, "missing.mjs"));
            if (failure === "文件篡改") await writeFile(join(f.modules, name, "src/index.mjs"), "被修改");
            if (failure === "多出文件") await writeFile(join(f.modules, name, "extra.txt"), "额外文件");
            return "restart-required";
        }, { stage: "install", target: file });
    };
    const { file, directory } = await f.build("1.0.1");
    const result = await installVerifiedBundle(f.manager, file, "1.0.1", directory);
    assert.equal(result.application, "failed");
    assert.match(result.error.diagnostic, /已回滚/);
    assert.equal(JSON.parse(await readFile(join(directory, "recovery.json"))).status, "rolled-back");
    assert.equal(await readFile(join(f.profile, "package.json"), "utf8"), before);
    assert.equal(await realpath(join(f.modules, name)), await realpath(f.source));
    assert.equal(await readFile(join(f.modules, "other-plugin/keep.txt"), "utf8"), "其他插件");
    assert.equal(await readFile(join(f.source, "keep.txt"), "utf8"), "源码必须保留");
    f.manager.installBundle = install;
});

test("错误版本在触碰安装目录前拒绝", async (t) => {
    const f = await fixture(t);
    const { file, directory } = await f.build("1.0.1");
    await assert.rejects(installVerifiedBundle(f.manager, file, "1.0.2", directory), /版本不一致/);
    assert.equal(await realpath(join(f.modules, name)), await realpath(f.source));
});

test("检测到未完成的恢复记录时拒绝下一次更新", async (t) => {
    const f = await fixture(t);
    const first = await f.build("1.0.1");
    await installVerifiedBundle(f.manager, first.file, "1.0.1", first.directory);
    const file = join(first.directory, "recovery.json");
    const journal = JSON.parse(await readFile(file));
    journal.status = "rollback-incomplete";
    await writeFile(file, JSON.stringify(journal));
    const second = await f.build("1.0.2");
    const result = await installVerifiedBundle(f.manager, second.file, "1.0.2", second.directory);
    assert.equal(result.application, "failed");
    assert.match(result.error.diagnostic, /上次更新未完整结束/);
    assert.equal(JSON.parse(await readFile(join(f.modules, name, "package.json"))).version, "1.0.1");
});

test("安装包中的目录链接在安装前拒绝", async (t) => {
    const f = await fixture(t);
    const { file, directory } = await f.build("1.0.1");
    const stage = join(f.root, "release-1.0.1");
    await symlink(f.source, join(stage, "package/outside"), process.platform === "win32" ? "junction" : "dir");
    await pack({ cwd: stage, file, gzip: true }, ["package"]);
    await assert.rejects(installVerifiedBundle(f.manager, file, "1.0.1", directory), /非法路径或链接/);
    assert.equal(await readFile(join(f.source, "keep.txt"), "utf8"), "源码必须保留");
    assert.equal(await realpath(join(f.modules, name)), await realpath(f.source));
});

test("配置恢复失败会记录阻断状态并保留配置快照", async (t) => {
    const f = await fixture(t);
    const restore = f.manager.restoreFiles;
    f.manager.restoreFiles = async function (files) {
        if (files.has(join(f.profile, "package.json"))) throw new Error("模拟配置恢复失败");
        return restore.call(this, files);
    };
    f.manager.installBundle = function (file) {
        return this.change(async () => { throw new Error("模拟安装失败"); }, { stage: "install", target: file });
    };
    const { file, directory } = await f.build("1.0.1");
    const result = await installVerifiedBundle(f.manager, file, "1.0.1", directory);
    assert.equal(result.application, "failed");
    assert.match(result.error.diagnostic, /回滚未完整完成/);
    const record = JSON.parse(await readFile(join(directory, "recovery.json")));
    assert.equal(record.status, "rollback-incomplete");
    assert.ok(record.files.some(([path, text]) => path === join(f.profile, "package.json") && text));
    assert.equal(await realpath(join(f.modules, name)), await realpath(f.source));
});

test("旧依赖文件被改动时从独立归档恢复，外部源码不被覆盖", async (t) => {
    const f = await fixture(t);
    const first = await f.build("1.0.1");
    await installVerifiedBundle(f.manager, first.file, "1.0.1", first.directory);
    const second = await f.build("1.0.2");
    f.manager.installBundle = function (file) {
        return this.change(async () => {
            await writeFile(join(second.directory, "previous-node_modules", name, "src/index.mjs"), "模拟旧依赖文件损坏");
            throw new Error("模拟安装失败");
        }, { stage: "install", target: file });
    };
    const result = await installVerifiedBundle(f.manager, second.file, "1.0.2", second.directory);
    assert.equal(result.application, "failed");
    assert.match(result.error.diagnostic, /已回滚/);
    assert.equal(await readFile(join(f.modules, name, "src/index.mjs"), "utf8"), "export const version = '1.0.1';\n");
    assert.equal(await readFile(join(f.source, "keep.txt"), "utf8"), "源码必须保留");
});

test("DSH 原生事务：pnpm 失败后完整恢复依赖树、manifest 和锁文件", nativeOptions, async (t) => {
    const f = await fixture(t, true);
    const saved = await f.manager.readRestoredFiles();
    const run = f.manager.runPnpm;
    f.manager.runPnpm = async function (args) {
        const result = await run.call(this, args);
        assert.equal(result.exitCode, 0, result.output);
        return { ...result, exitCode: 1, output: "模拟 pnpm 安装失败" };
    };
    const { file, directory } = await f.build("1.0.1");
    const result = await installVerifiedBundle(f.manager, file, "1.0.1", directory);
    assert.equal(result.application, "failed");
    assert.match(result.error.diagnostic, /已回滚/);
    for (const [file, text] of saved) assert.equal(await readFile(file, "utf8"), text);
    assert.equal(await realpath(join(f.modules, name)), await realpath(f.source));
    assert.equal(await readFile(join(f.modules, "other-plugin/keep.txt"), "utf8"), "其他插件");
    assert.equal(await readFile(join(f.source, "keep.txt"), "utf8"), "源码必须保留");
});

test("DSH 原生安装事务 + pnpm：link 和连续正式包升级保留源码", nativeOptions, async (t) => {
    const f = await fixture(t, true);
    for (const version of ["1.0.1", "1.0.2"]) {
        const { file, directory } = await f.build(version);
        const result = await installVerifiedBundle(f.manager, file, version, directory);
        assert.equal(result.application, "restart-required", JSON.stringify(result));
        assert.equal(await readFile(join(f.source, "keep.txt"), "utf8"), "源码必须保留");
        assert.equal(await readFile(join(f.modules, "other-plugin/keep.txt"), "utf8"), "其他插件");
    }
});

test("通过 Cordis 宿主服务代理调用时仍进入安全事务", nativeOptions, async (t) => {
    const f = await fixture(t, true);
    const require = createRequire(pathToFileURL(native));
    const { Context } = await import(pathToFileURL(require.resolve("@deepseek-ai/cordis")));
    const { PluginManager } = await import(pathToFileURL(native));
    const root = new Context();
    root.provide("profileContext", { ...f.manager.profile, startedBundles: [] });
    await root.plugin({ name: "canvas-update-test-service", apply(ctx) { new PluginManager(ctx, { fallbackRegistries: [] }); } });
    t.after(() => root.fiber.dispose());
    const manager = root.get("pluginManager");
    for (const key of ["registries", "runPnpm", "configure", "selectBundle"]) manager[key] = f.manager[key];
    const { file, directory } = await f.build("1.0.1");
    const result = await installVerifiedBundle(manager, file, "1.0.1", directory);
    assert.equal(result.application, "restart-required", JSON.stringify(result));
    assert.equal(await readFile(join(f.source, "keep.txt"), "utf8"), "源码必须保留");
    assert.equal(JSON.parse(await readFile(join(directory, "recovery.json"))).status, "installed");
});

test("旧依赖含多目录硬链接和空文件时完成归档复查与安装", async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.modules, "empty.txt"), "");
    await writeFile(join(f.modules, "large.bin"), Buffer.concat(Array.from({ length: 4096 }, (_, i) => createHash("sha256").update(String(i)).digest())));
    for (let i = 0; i < 8; i++) {
        const dir = join(f.modules, "scope-" + i);
        await mkdir(dir);
        await link(join(f.modules, "large.bin"), join(dir, "shared.bin"));
    }
    const { file, directory } = await f.build("1.0.1");
    assert.equal((await installVerifiedBundle(f.manager, file, "1.0.1", directory)).application, "restart-required");
    assert.equal(await readFile(join(directory, "previous-node_modules/empty.txt"), "utf8"), "");
    assert.equal(JSON.parse(await readFile(join(directory, "recovery.json"))).status, "installed");
    assert.equal(await readFile(join(f.source, "keep.txt"), "utf8"), "源码必须保留");
});
