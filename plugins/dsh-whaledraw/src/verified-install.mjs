import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename } from "node:fs/promises";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { c as pack, t as list, x as extract } from "tar";

const packageName = "dsh-whaledraw";
const legacyPackageName = "dsh-infinite-canvas";

async function streamHash(stream) {
    const hash = createHash("sha256");
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
}

const serialize = (files) => JSON.stringify(Object.keys(files).sort().map((key) => [key, files[key]]));
const linkName = (name) => process.platform === "win32" ? name.replaceAll("\\", "/") : name;

async function inventory(directory, skipDependencies = false) {
    const files = Object.create(null);
    const walk = async (dir, prefix = "") => {
        for (const name of (await readdir(dir)).sort()) {
            if (!prefix && skipDependencies && name === "node_modules") continue;
            const key = prefix + name;
            const path = join(dir, name);
            const stat = await lstat(path);
            if (stat.isSymbolicLink()) files[key] = ["link", linkName(await readlink(path))];
            else if (stat.isDirectory()) { files[key] = ["directory"]; await walk(path, key + "/"); }
            else if (stat.isFile()) files[key] = ["file", await streamHash(createReadStream(path))];
            else throw new Error(`无法备份特殊文件：${key}`);
        }
    };
    await walk(directory);
    return serialize(files);
}

async function archiveInventory(file) {
    const files = Object.create(null);
    const links = new Map();
    const checks = [];
    await list({ file, strict: true, noResume: true, onReadEntry(entry) {
        const key = posix.normalize(entry.path).replace(/\/$/, "");
        if (key === ".") { entry.resume(); return; }
        if (entry.type === "File" && entry.size === 0) {
            files[key] = ["file", createHash("sha256").digest("hex")];
            entry.resume();
        } else if (entry.type === "File") {
            const check = streamHash(entry).then((hash) => { files[key] = ["file", hash]; });
            checks.push(check);
            void check.catch(() => {});
        } else {
            if (entry.type === "Directory") files[key] = ["directory"];
            else if (entry.type === "SymbolicLink") files[key] = ["link", linkName(entry.linkpath)];
            else if (entry.type === "Link") links.set(key, posix.normalize(entry.linkpath));
            entry.resume();
        }
    } });
    await Promise.all(checks);
    while (links.size) {
        const count = links.size;
        for (const [key, target] of links) if (files[target]?.[0] === "file") { files[key] = files[target]; links.delete(key); }
        if (links.size === count) throw new Error("源码备份包含无法复查的硬链接，已停止更新。");
    }
    return serialize(files);
}

async function exists(path) {
    try { return await lstat(path); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function inside(root, path) {
    const part = relative(root, path);
    return part && !isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep);
}

async function assertNoInterruptedUpdate(downloads) {
    for (const entry of await readdir(downloads, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const directory = join(downloads, entry.name);
        const file = join(directory, "recovery.json");
        if (!await exists(file)) continue;
        let status;
        try {
            const record = JSON.parse(await readFile(file, "utf8"));
            if (record.formatVersion !== 1) throw new Error("未知恢复记录格式");
            status = record.status;
        }
        catch { throw new Error(`更新恢复记录损坏，已停止更新。请检查备份：${directory}`); }
        if (!["prepared", "installing", "installed", "rolled-back", "rollback-incomplete"].includes(status)
            || ["installing", "rollback-incomplete"].includes(status)
            || (status === "prepared" && await exists(join(directory, "previous-node_modules")))) {
            throw new Error(`上次更新未完整结束，已停止更新。请先退出 DSH 并从备份恢复：${directory}`);
        }
    }
}

async function readPackage(file, version, directory) {
    const expected = join(directory, "expected");
    await mkdir(expected);
    let invalid = false;
    await extract({ file, cwd: expected, strict: true, filter(path, entry) {
        const parts = path.replace(/\/$/, "").split("/");
        const valid = parts[0] === "package" && parts.every((part) => part && part !== "." && part !== ".." && !/[\\:]/.test(part))
            && ["File", "Directory"].includes(entry.type);
        if (!valid) invalid = true;
        return valid;
    } });
    if (invalid) throw new Error("安装包包含非法路径或链接，尚未执行安装。");
    const root = join(expected, "package");
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const build = JSON.parse(await readFile(join(root, "dist/app/version.json"), "utf8"));
    if (manifest.name !== packageName || manifest.version !== version || typeof build.version !== "string" || build.version.replace(/^v/, "") !== version) {
        throw new Error("安装包名称、包版本与前端版本不一致，尚未执行安装。");
    }
    if (!(await exists(join(root, "dist/app/index.html")))?.isFile()) throw new Error("安装包缺少前端入口，尚未执行安装。");
    return inventory(root);
}

// 使用原生 change 的写锁包住备份、pnpm、文件复查和回滚，不另外启动安装器。
export async function installVerifiedBundle(manager, file, version, directory) {
    if (!["change", "installBundle", "readRestoredFiles", "restoreFiles"].every((key) => typeof manager[key] === "function")) {
        throw new Error("当前 DSH 不支持安全更新事务，尚未执行安装。请升级 DSH 后重试。");
    }
    const profile = await realpath(manager.profile.dir);
    directory = await realpath(directory);
    if (!inside(join(profile, ".plugin-manager", "downloads"), directory)) throw new Error("更新工作目录无效，尚未执行安装。");
    const expected = await readPackage(file, version, directory);
    const modules = join(profile, "node_modules");
    const target = join(modules, packageName);
    const previous = join(directory, "previous-node_modules");
    const change = manager.change;
    let intercepted = false;
    manager.change = function (operation, request, reason) {
        if (request.stage !== "install" || request.target !== file) return change.call(this, operation, request, reason);
        intercepted = true;
        return change.call(this, async (result) => {
            await assertNoInterruptedUpdate(join(profile, ".plugin-manager", "downloads"));
            const legacyTarget = join(modules, legacyPackageName);
            if (await exists(target) && await exists(legacyTarget)) throw new Error("新旧插件同时存在，请先退出 DSH 并检查安装状态，尚未执行安装。");
            const previousTarget = await exists(target) ? target : legacyTarget;
            const original = await exists(previousTarget);
            if (!original || (!original.isDirectory() && !original.isSymbolicLink())) throw new Error("旧插件目录异常，已停止更新。");
            const moduleStat = await lstat(modules);
            if (!moduleStat.isDirectory() || moduleStat.isSymbolicLink()) throw new Error("DSH 依赖目录是外部链接，已停止更新。");
            const source = await realpath(previousTarget);
            if (source === directory || inside(source, directory)) throw new Error("备份目录位于源码内，已停止更新。");
            const externalSource = original.isSymbolicLink() && !inside(modules, source);
            const before = await inventory(modules);
            const sourceBefore = externalSource ? await inventory(source) : null;
            const dependencyArchive = join(directory, "dependencies-backup.tgz");
            await pack({ file: dependencyArchive, cwd: modules, gzip: true, follow: false, strict: true, sync: true }, ["."]);
            if (await archiveInventory(dependencyArchive) !== before || await inventory(modules) !== before) throw new Error("旧依赖归档复查不一致，已停止更新。");
            const dependencyArchiveSHA = await streamHash(createReadStream(dependencyArchive));
            const files = await this.readRestoredFiles();
            const workspace = join(profile, "pnpm-workspace.yaml");
            files.set(workspace, (await exists(workspace)) ? await readFile(workspace, "utf8") : undefined);
            if (this.profile.patchPath) files.set(this.profile.patchPath, (await exists(this.profile.patchPath)) ? await readFile(this.profile.patchPath, "utf8") : undefined);
            for (const path of files.keys()) if (!inside(profile, path)) throw new Error("配置备份路径超出当前 profile，已停止更新。");
            let sourceArchiveSHA = null;
            const saveJournal = (status) => this.restoreFiles(new Map([[join(directory, "recovery.json"), JSON.stringify({
                formatVersion: 1, status, profile, version, files: [...files].map(([path, text]) => [path, text ?? null]),
                previousInventory: createHash("sha256").update(before).digest("hex"),
                source: externalSource ? source : null, sourceArchiveSHA, dependencyArchiveSHA,
            }, null, 2)]]));
            if (externalSource) {
                const copy = join(directory, "source-backup.tgz");
                await pack({ file: copy, cwd: source, gzip: true, follow: false, strict: true, sync: true }, ["."]);
                if (await archiveInventory(copy) !== sourceBefore || await inventory(source) !== sourceBefore) throw new Error("源码备份复查不一致，已停止更新。");
                sourceArchiveSHA = await streamHash(createReadStream(copy));
            }
            await saveJournal("prepared");
            // 保留整个旧依赖树（包括其他插件的链接），让 pnpm 在空目录安装，失败可整体恢复。
            try { await rename(modules, previous); }
            catch (error) { throw new Error(`无法保留旧依赖目录，可能被运行任务占用；尚未执行安装。${error.message}`); }
            try {
                await saveJournal("installing");
                if (previousTarget === legacyTarget) {
                    const manifestPath = join(profile, "package.json");
                    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
                    delete manifest.dependencies[legacyPackageName];
                    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== legacyPackageName);
                    await this.restoreFiles(new Map([[manifestPath, JSON.stringify(manifest, null, 2) + "\n"]]));
                }
                const application = await operation(result) ?? result.application;
                if (!["applied", "restart-required"].includes(application) || result.bundle !== packageName) throw new Error("DSH 未确认安装成功。");
                const installed = await exists(target);
                if (!installed || !inside(modules, await realpath(target))) throw new Error("新插件安装目录异常。");
                if (await inventory(target, true) !== expected) throw new Error("安装后文件复查失败：文件缺失、被修改或多出文件。");
                if (await inventory(previous) !== before || (externalSource && await inventory(source) !== sourceBefore)) throw new Error("旧依赖或源码完整性复查失败。");
                await saveJournal("installed");
                return application;
            } catch (error) {
                try {
                    // 异常的新目录也保留供调查；不用递归删除完成回滚。
                    if (await exists(modules)) await rename(modules, join(directory, "failed-node_modules"));
                    if (await inventory(previous) !== before) {
                        if (await streamHash(createReadStream(dependencyArchive)) !== dependencyArchiveSHA) throw new Error("旧依赖备份归档已损坏");
                        // unlink 先断开旧文件硬链接；只恢复普通文件，保留原有目录链接，绝不写入其目标。
                        await extract({ file: dependencyArchive, cwd: previous, strict: true, unlink: true,
                            filter: (_path, entry) => ["File", "Directory", "Link"].includes(entry.type) });
                        if (await inventory(previous) !== before) throw new Error("旧依赖备份不能完整恢复");
                    }
                    await rename(previous, modules);
                    await this.restoreFiles(files);
                    if (await inventory(modules) !== before || (externalSource && await inventory(source) !== sourceBefore)) throw new Error("原文件内容发生变化，请从备份人工恢复，避免覆盖并发修改。");
                    await saveJournal("rolled-back");
                } catch (rollbackError) {
                    await saveJournal("rollback-incomplete").catch(() => {});
                    throw new Error(`${error.message} 回滚未完整完成：${rollbackError.message}。备份保留在 ${directory}，请勿继续更新。`);
                }
                throw new Error(`${error.message} 已回滚旧插件与配置；备份保留在 ${directory}。`);
            }
        }, request, reason);
    };
    let pending;
    try {
        pending = manager.installBundle(file, { enabled: true });
    } finally {
        // installBundle 同步提交 operation；立刻恢复入口，避免影响并行的管理请求。
        manager.change = change;
    }
    if (!intercepted) throw new Error("DSH 安装接口未进入安全事务，请停止更新。");
    return pending;
}
