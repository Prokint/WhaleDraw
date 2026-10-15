import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gt, valid } from "semver";
import { appPath } from "./canvas-launcher.mjs";
import { installVerifiedBundle } from "./verified-install.mjs";

const repository = "Prokint/WhaleDraw";
const packageName = "dsh-infinite-canvas";
const releasePackageName = "whaledraw";
const updateStages = ["checking", "downloading", "verifying", "backing-up", "preparing", "installing", "checking-files"];

export function installPluginUpdater(ctx) {
    const token = randomUUID();
    const abort = new AbortController();
    ctx.effect(() => () => abort.abort());
    let installing = false;
    let activeUpdate;
    let installedVersion;
    const progressClients = new Set();
    ctx.effect(() => () => { for (const client of progressClients) client.res.end(); progressClients.clear(); });
    const candidate = async (requestedVersion, signal = abort.signal) => {
        const version = valid(requestedVersion);
        if (!version) throw new Error("更新版本无效，请重新检查更新。");
        if (installedVersion === version) return { version, available: false, reason: "新版本已安装，重启 DSH 后生效。" };
        let currentVersion;
        try { currentVersion = valid(JSON.parse(await readFile(new URL("../dist/app/version.json", import.meta.url), "utf8")).version); }
        catch { throw new Error("当前插件缺少构建版本信息，请先构建或重新安装支持更新的插件包。"); }
        if (!currentVersion) throw new Error("当前插件构建版本无效，请重新安装插件包。");
        if (!gt(version, currentVersion)) return { version, available: false, reason: "当前插件已安装此版本或更高版本。" };
        const tag = `v${version}`;
        const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, {
            headers: { Accept: "application/vnd.github+json" }, cache: "no-store", signal,
        });
        if (response.status === 404) return { version, available: false, reason: "该版本尚未发布可安装的 Release。" };
        if (!response.ok) throw new Error("无法读取 Release，请检查网络后重试。");
        const release = await response.json();
        const name = `${releasePackageName}-${version}.tgz`;
        const url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
        const asset = release.assets?.find((item) => item.name === name && item.state === "uploaded" && item.browser_download_url === url);
        const available = release.tag_name === tag && !release.draft && !release.prerelease && Boolean(asset);
        return { version, available, reason: available ? "" : "该版本安装包尚未就绪，请稍后重新检查更新。", url, digest: asset?.digest, size: asset?.size };
    };
    const respond = (res, status, value) => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(value));
    };
    const sendProgress = (res, progress) => {
        if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(progress)}\n\n`);
    };
    for (const action of ["info", "install", "cancel", "progress"]) ctx.effect(() => ctx.webServer.register({
        kind: "exact", path: `${appPath}/plugin-update-${action}`,
        handler(req, res) {
            const admission = ctx.connection.admit(req);
            if ("rejection" in admission) { res.writeHead(admission.rejection); res.end(); return; }
            if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) { res.writeHead(403); res.end(); return; }
            const method = ["info", "progress"].includes(action) ? "GET" : "POST";
            if (req.method !== method) { res.writeHead(405, { Allow: method }); res.end(); return; }
            if (!["info", "progress"].includes(action) && req.headers["x-dsh-update-token"] !== token) { res.writeHead(403); res.end(); return; }
            const manager = ctx.get("pluginManager");
            if (!manager) { respond(res, 503, { error: "DSH 插件管理器不可用，无法安装更新。" }); return; }
            const version = new URL(req.url, "http://localhost").searchParams.get("version");
            if (action === "progress") {
                if (!valid(version)) { respond(res, 400, { error: "更新版本无效。" }); return; }
                res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
                res.flushHeaders();
                const client = { version: valid(version), res };
                progressClients.add(client);
                res.on("close", () => progressClients.delete(client));
                if (activeUpdate?.version === client.version) sendProgress(res, activeUpdate.progress);
                return;
            }
            if (action === "cancel") {
                if (!activeUpdate || activeUpdate.version !== valid(version)) { respond(res, 409, { error: "当前没有此版本正在更新。" }); return; }
                activeUpdate.controller.abort(new DOMException("已取消更新。", "AbortError"));
                respond(res, 200, { cancelRequested: true });
                return;
            }
            if (action === "info") {
                void candidate(version).then((info) => {
                    respond(res, 200, { ...info, token, installing, installed: installedVersion === info.version });
                }).catch((error) => respond(res, 502, { error: error.message }));
                return;
            }
            if (installing) { respond(res, 409, { error: "已有更新正在安装，请等待完成。" }); return; }
            installing = true;
            activeUpdate = { version: valid(version), controller: new AbortController(), progress: { stage: "checking" } };
            const report = (stage, details = {}) => {
                const index = stage === "waiting" ? updateStages.indexOf("backing-up") : updateStages.indexOf(stage);
                const completedSteps = stage === "completed" ? updateStages.length : index < 0 ? activeUpdate.progress.completedSteps || 0 : index;
                activeUpdate.progress = { stage, completedSteps, totalSteps: updateStages.length, ...details };
                for (const client of progressClients) if (client.version === activeUpdate.version) sendProgress(client.res, activeUpdate.progress);
            };
            const signal = AbortSignal.any([abort.signal, activeUpdate.controller.signal]);
            report("checking");
            void (async () => {
                const info = await candidate(version, signal);
                signal.throwIfAborted();
                if (!info.available) throw new Error(info.reason);
                if (!/^sha256:[a-f0-9]{64}$/.test(info.digest || "")) throw new Error("Release 安装包缺少有效的 SHA-256，请联系发布者重新发布。");
                const root = join(manager.profile.dir, ".plugin-manager", "downloads");
                await mkdir(root, { recursive: true });
                const directory = await mkdtemp(join(root, `${packageName}-`));
                const file = join(directory, `${releasePackageName}-${info.version}.tgz`);
                let installStarted = false;
                try {
                    let receivedBytes = 0;
                    const totalBytes = Number.isSafeInteger(info.size) && info.size > 0 ? info.size : undefined;
                    report("downloading", { receivedBytes, totalBytes });
                    try {
                        const response = await fetch(info.url, { cache: "no-store", signal });
                        if (!response.ok || !response.body) throw new Error("下载失败");
                        const counter = new Transform({ transform(chunk, _encoding, next) {
                            receivedBytes += chunk.length;
                            report("downloading", { receivedBytes, totalBytes });
                            next(null, chunk);
                        } });
                        await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(file, { flags: "wx" }), { signal });
                    } catch { signal.throwIfAborted(); throw new Error("下载安装包失败，请检查 GitHub 网络连接后重试；尚未执行安装。"); }
                    report("verifying");
                    const hash = createHash("sha256");
                    for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
                    if (`sha256:${hash.digest("hex")}` !== info.digest) throw new Error("安装包 SHA-256 校验失败，请重新下载；尚未执行安装。");
                    signal.throwIfAborted();
                    // DSH 将本地包路径写入 profile，安装开始后保留该文件供后续依赖重装使用。
                    installStarted = true;
                    const result = await installVerifiedBundle(manager, file, info.version, directory, signal, report);
                    if (result.application === "cancelled") { report("cancelled"); respond(res, 200, { cancelled: true, message: "已取消更新，旧插件与配置保持不变。" }); return; }
                    if (!["applied", "restart-required"].includes(result.application) || result.bundle !== packageName) {
                        throw new Error(`DSH 更新未完成（${result.error?.code || result.application}）：${result.error?.diagnostic || "请在 DSH 插件管理页面查看详情。"}`);
                    }
                } catch (error) {
                    if (!installStarted) await rm(directory, { recursive: true, force: true }).catch(() => {});
                    throw error;
                }
                installedVersion = info.version;
                report("completed");
                respond(res, 200, { installed: true, version: installedVersion, restartRequired: true });
            })().catch((error) => {
                if (error.name === "AbortError") { report("cancelled"); respond(res, 200, { cancelled: true, message: "已取消更新，尚未执行安装。" }); }
                else { report("failed"); respond(res, 502, { error: error.message }); }
            }).finally(() => { installing = false; activeUpdate = undefined; });
        },
    }));
}
