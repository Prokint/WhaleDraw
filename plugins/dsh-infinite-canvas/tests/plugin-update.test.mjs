import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { c as pack } from "tar";

test("更新 HTTP 接口使用本地 Release 夹具验证鉴权、校验、回滚和安装", { timeout: 30_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "canvas-update-http-"));
    t.after(async () => {
        const part = relative(await realpath(tmpdir()), await realpath(root));
        assert.ok(part.startsWith("canvas-update-http-") && !isAbsolute(part) && !part.includes(".."));
        await rm(root, { recursive: true, force: true });
    });
    const plugin = join(root, "plugin");
    await mkdir(join(plugin, "dist/app"), { recursive: true });
    await cp(new URL("../src/", import.meta.url), join(plugin, "src"), { recursive: true });
    await symlink(await realpath(new URL("../node_modules", import.meta.url)), join(plugin, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(join(plugin, "dist/app/version.json"), JSON.stringify({ version: "v1.0.0" }));
    const profile = join(root, "profile");
    const target = join(profile, "node_modules/dsh-infinite-canvas");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "old.txt"), "旧插件");
    const config = join(profile, "package.json");
    await writeFile(config, "{}\n");
    await writeFile(join(profile, "pnpm-workspace.yaml"), "packages: [.]\n");
    const stage = join(root, "release/package");
    await mkdir(join(stage, "dist/app"), { recursive: true });
    await writeFile(join(stage, "package.json"), JSON.stringify({ name: "dsh-infinite-canvas", version: "1.0.1" }));
    await writeFile(join(stage, "dist/app/version.json"), JSON.stringify({ version: "v1.0.1" }));
    await writeFile(join(stage, "dist/app/index.html"), "本地测试包");
    const file = join(root, "release.tgz");
    await pack({ file, cwd: dirname(stage), gzip: true }, ["package"]);
    const bytes = await readFile(file);
    const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    let mode = "valid", installs = 0, authenticated = true;
    let downloadReady, installReady, finishInstall;
    const manager = {
        profile: { dir: profile },
        async readRestoredFiles() { return new Map([[config, await readFile(config, "utf8")]]); },
        async restoreFiles(files) { for (const [path, text] of files) await writeFile(path, text); },
        async change(operation, request) {
            const result = { ...request };
            try { result.application = await operation(result); }
            catch (error) { result.application = "failed"; result.error = { code: "operation-error", diagnostic: error.message }; }
            return result;
        },
        installBundle(file) { return this.change(async (result) => {
            installs++;
            if (mode === "install-failure") { await writeFile(config, "坏配置"); throw new Error("测试安装失败"); }
            await rename(target, join(root, `retired-plugin-${installs}`));
            await cp(join(dirname(file), "expected/package"), target, { recursive: true });
            if (mode === "cancel-install") {
                await writeFile(config, "待回滚配置");
                installReady();
                await new Promise((resolve) => { finishInstall = resolve; });
            }
            result.bundle = "dsh-infinite-canvas";
            return "restart-required";
        }, { stage: "install", target: file }); },
    };
    const nativeFetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async (url) => {
        if (url === "https://api.github.com/repos/Prokint/WhaleDraw/releases/tags/v1.0.1") return Response.json({
            tag_name: "v1.0.1", draft: false, prerelease: false,
            assets: [{ name: "whaledraw-1.0.1.tgz", state: "uploaded", browser_download_url: "https://github.com/Prokint/WhaleDraw/releases/download/v1.0.1/whaledraw-1.0.1.tgz", size: bytes.length, digest: mode === "bad-hash" ? "sha256:" + "0".repeat(64) : digest }],
        });
        assert.equal(url, "https://github.com/Prokint/WhaleDraw/releases/download/v1.0.1/whaledraw-1.0.1.tgz", "禁止访问未模拟的外部网络");
        if (mode === "slow-download") return new Response(new ReadableStream({ start(stream) { stream.enqueue(bytes.subarray(0, 1)); downloadReady(); } }));
        return new Response(bytes);
    });
    const routes = new Map(), dispose = [];
    const { installPluginUpdater } = await import(pathToFileURL(join(plugin, "src/plugin-update.mjs")));
    installPluginUpdater({
        effect(fn) { dispose.push(fn()); },
        webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
        connection: { admit() { return authenticated ? { peer: {} } : { rejection: 401 }; } },
        get() { return manager; },
    });
    const server = createServer((req, res) => {
        const handler = routes.get(new URL(req.url, "http://localhost").pathname);
        if (handler) handler(req, res); else { res.writeHead(404); res.end(); }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { dispose.reverse().forEach((fn) => fn()); await new Promise((resolve) => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}/plugins/dsh-infinite-canvas/app/plugin-update-`;
    const request = (action, options = {}) => nativeFetch(base + action + "?version=1.0.1", options);
    const observe = async () => {
        const response = await request("progress");
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /text\/event-stream/);
        const input = Readable.fromWeb(response.body);
        const lines = createInterface({ input });
        const events = [];
        const done = (async () => {
            try {
                for await (const line of lines) if (line.startsWith("data: ")) {
                    const event = JSON.parse(line.slice(6));
                    events.push(event);
                    if (["completed", "cancelled", "failed"].includes(event.stage)) break;
                }
            } finally { lines.close(); input.destroy(); }
        })();
        t.after(() => { lines.close(); input.destroy(); });
        return { events, done };
    };
    await t.test("宿主拒绝未认证请求和进度订阅", async () => {
        authenticated = false;
        assert.equal((await request("info")).status, 401);
        assert.equal((await request("progress")).status, 401);
        authenticated = true;
    });
    await t.test("错误方法和令牌拒绝且不安装", async () => {
        assert.equal((await request("install")).status, 405);
        assert.equal((await request("install", { method: "POST" })).status, 403);
        assert.equal((await request("cancel")).status, 405);
        assert.equal((await request("cancel", { method: "POST" })).status, 403);
        assert.equal(installs, 0);
    });
    const info = await (await request("info")).json();
    assert.equal(info.available, true);
    const options = { method: "POST", headers: { "X-DSH-Update-Token": info.token } };
    assert.equal((await request("cancel", options)).status, 409, "取消接口必须存在，无活动更新时应明确拒绝");
    await t.test("取消下载会结束请求且不进入安装", async () => {
        mode = "slow-download";
        const progress = await observe();
        const started = new Promise((resolve) => { downloadReady = resolve; });
        const pending = request("install", options);
        await started;
        const cancel = await request("cancel", options);
        assert.equal(cancel.status, 200);
        const response = await pending;
        assert.equal(response.status, 200); assert.equal((await response.json()).cancelled, true);
        await progress.done;
        assert.ok(progress.events.some((event) => event.stage === "downloading" && event.receivedBytes === 1 && event.totalBytes === bytes.length));
        assert.equal(progress.events.at(-1).stage, "cancelled");
        assert.ok(progress.events.every((event) => event.completedSteps < event.totalSteps));
        assert.equal(installs, 0); assert.equal(await readFile(join(target, "old.txt"), "utf8"), "旧插件");
    });
    await t.test("哈希不符拒绝且不进入安装", async () => {
        mode = "bad-hash";
        const progress = await observe();
        const response = await request("install", options);
        assert.equal(response.status, 502); assert.match((await response.json()).error, /SHA-256 校验失败/); assert.equal(installs, 0);
        assert.equal(await readFile(join(target, "old.txt"), "utf8"), "旧插件");
        await progress.done;
        assert.deepEqual([...new Set(progress.events.map((event) => event.stage))], ["checking", "downloading", "verifying", "failed"]);
    });
    await t.test("安装失败返回回滚信息并保留旧插件与配置", async () => {
        mode = "install-failure";
        const progress = await observe();
        const response = await request("install", options);
        assert.equal(response.status, 502); assert.match((await response.json()).error, /operation-error.*已回滚/);
        assert.equal(installs, 1); assert.equal(await readFile(config, "utf8"), "{}\n");
        assert.equal(await readFile(join(target, "old.txt"), "utf8"), "旧插件");
        await progress.done;
        assert.ok(progress.events.some((event) => event.stage === "rolling-back"));
        assert.equal(progress.events.at(-1).stage, "failed");
    });
    await t.test("安装中取消会等待安装器结束并回滚，不报告已安装", async () => {
        mode = "cancel-install";
        const started = new Promise((resolve) => { installReady = resolve; });
        let completed = false;
        const pending = request("install", options).then((response) => { completed = true; return response; });
        await started;
        const progress = await observe();
        const cancel = await request("cancel", options);
        try { assert.equal(cancel.status, 200); assert.equal(completed, false, "取消确认不能提前当作安装已安全结束"); }
        finally { finishInstall(); }
        const response = await pending;
        assert.equal(response.status, 200); assert.equal((await response.json()).cancelled, true);
        assert.equal(installs, 2); assert.equal(await readFile(config, "utf8"), "{}\n");
        assert.equal(await readFile(join(target, "old.txt"), "utf8"), "旧插件");
        assert.equal((await (await request("info")).json()).installed, false);
        await progress.done;
        assert.equal(progress.events[0].stage, "installing", "安装中订阅会立即收到当前进度");
        assert.ok(progress.events.some((event) => event.stage === "rolling-back"));
        assert.equal(progress.events.at(-1).stage, "cancelled");
    });
    await t.test("失败后重试安装成功并拒绝重复更新", async () => {
        mode = "valid";
        const progress = await observe();
        const response = await request("install", options);
        assert.equal(response.status, 200); assert.deepEqual(await response.json(), { installed: true, version: "1.0.1", restartRequired: true });
        assert.equal(installs, 3); assert.equal(JSON.parse(await readFile(join(target, "package.json"))).version, "1.0.1");
        const after = await (await request("info")).json(); assert.equal(after.installed, true); assert.equal(after.available, false);
        await progress.done;
        assert.deepEqual([...new Set(progress.events.map((event) => event.stage))], ["checking", "downloading", "verifying", "waiting", "backing-up", "preparing", "installing", "checking-files", "completed"]);
        const final = progress.events.at(-1);
        assert.equal(final.completedSteps, final.totalSteps);
        assert.ok(progress.events.slice(0, -1).every((event) => event.completedSteps < event.totalSteps));
    });
});
