import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gt, valid } from "semver";
import { appPath } from "./canvas-launcher.mjs";

const repository = "Prokint/infinite-canvas-dsh";
const packageName = "dsh-infinite-canvas";

export function installPluginUpdater(ctx) {
    const token = randomUUID();
    let installing = false;
    let installedVersion;
    const candidate = async (requestedVersion) => {
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
            headers: { Accept: "application/vnd.github+json" }, cache: "no-store",
        });
        if (response.status === 404) return { version, available: false, reason: "该版本尚未发布可安装的 Release。" };
        if (!response.ok) throw new Error("无法读取 Release，请检查网络后重试。");
        const release = await response.json();
        const name = `${packageName}-${version}.tgz`;
        const url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
        const asset = release.assets?.find((item) => item.name === name && item.state === "uploaded" && item.browser_download_url === url);
        const available = release.tag_name === tag && !release.draft && !release.prerelease && Boolean(asset);
        return { version, available, reason: available ? "" : "该版本安装包尚未就绪，请稍后重新检查更新。", url };
    };
    const respond = (res, status, value) => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(value));
    };
    for (const action of ["info", "install"]) ctx.effect(() => ctx.webServer.register({
        kind: "exact", path: `${appPath}/plugin-update-${action}`,
        handler(req, res) {
            const admission = ctx.connection.admit(req);
            if ("rejection" in admission) { res.writeHead(admission.rejection); res.end(); return; }
            if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) { res.writeHead(403); res.end(); return; }
            const method = action === "info" ? "GET" : "POST";
            if (req.method !== method) { res.writeHead(405, { Allow: method }); res.end(); return; }
            if (action !== "info" && req.headers["x-dsh-update-token"] !== token) { res.writeHead(403); res.end(); return; }
            const manager = ctx.get("pluginManager");
            if (!manager) { respond(res, 503, { error: "DSH 插件管理器不可用，无法安装更新。" }); return; }
            const version = new URL(req.url, "http://localhost").searchParams.get("version");
            if (action === "info") {
                void candidate(version).then((info) => respond(res, 200, {
                    ...info, token, installing, installed: installedVersion === info.version,
                })).catch((error) => respond(res, 502, { error: error.message }));
                return;
            }
            if (installing) { respond(res, 409, { error: "已有更新正在安装，请等待完成。" }); return; }
            installing = true;
            void (async () => {
                const info = await candidate(version);
                if (!info.available) throw new Error(info.reason);
                const result = await manager.installBundle(info.url, { enabled: true });
                if (!["applied", "restart-required"].includes(result.application) || result.bundle !== packageName) {
                    throw new Error(`安装更新未完成（${result.error?.code || result.application}）。请在 DSH 插件管理页面查看详情。`);
                }
                installedVersion = info.version;
                respond(res, 200, { installed: true, version: installedVersion, restartRequired: true });
            })().catch((error) => respond(res, 502, { error: error.message })).finally(() => { installing = false; });
        },
    }));
}
