import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import sirv from "sirv";
import { z } from "zod";
import { loadConfig } from "@basketikun/canvas-agent/dist/config.js";
import { dshToolDefinitions } from "@basketikun/canvas-agent/dist/agent/dsh.js";
import { DEFAULT_PROBE_TIMEOUT_MS, probeHealth, resolveStartTimeout, stopChild, waitForReady } from "./agent-start.mjs";
import { appPath, installCanvasLauncher } from "./canvas-launcher.mjs";
import { installPluginUpdater } from "./plugin-update.mjs";

export const name = "dsh-infinite-canvas";
export const inject = ["webServer", "connection", "tools", "systemPrompt", "userQuestions", "storageDomain"];

const appDirectory = fileURLToPath(new URL("../dist/app/", import.meta.url));

export async function apply(ctx) {
    if (!existsSync(new URL("../dist/app/index.html", import.meta.url))) {
        throw new Error("WhaleDraw 尚未打包，请先在 plugins/dsh-infinite-canvas 中运行 node scripts/build.mjs。");
    }
    let child;
    let disposed = false;
    let agentReady;
    const ensureAgent = async () => {
        const config = loadConfig(true);
        try {
            if (await probeHealth(config.url)) return;
        } catch {}
        if (disposed) throw new Error("插件已停用");
        await stopChild(child);
        child = spawn(process.execPath, [fileURLToPath(new URL("./agent.mjs", import.meta.url))], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        // 就绪判据同时用启动横幅和健康探测，避免横幅没拿到时把已经可用的 agent 判成启动失败。
        await waitForReady(child, { startTimeoutMs: resolveStartTimeout(), probe: () => probeHealth(config.url) });
    };
    const ensureReady = () => agentReady ||= ensureAgent().then(async () => {
        const config = loadConfig();
        const response = await fetch(`${config.url}/health`, { signal: AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS) });
        const health = response.ok ? await response.json() : null;
        if (!health?.ok) throw new Error(`Canvas Agent 未能提供服务，请检查 ${config.url} 是否已被占用`);
        if (!health.dshChannel) throw new Error("Canvas Agent 不支持 DSH 专用通道，请安装配套的修复版 Agent 后重启 DSH");
        return config;
    }).finally(() => { agentReady = undefined; });
    const domain = await ctx.storageDomain.open({
        name: "dsh_infinite_canvas", version: 1,
        tables: { sessions: { valueSchema: z.discriminatedUnion("mode", [
            z.object({ mode: z.literal("canvas"), projectId: z.string().min(1) }).strict(),
            z.object({ mode: z.literal("workbench") }).strict(),
        ]) } },
    });
    ctx.effect(() => () => domain.close());
    installCanvasLauncher(ctx, ensureReady, domain.table("sessions"), dshToolDefinitions);
    installPluginUpdater(ctx);
    ctx.effect(() => () => { disposed = true; child?.kill(); });
    const serve = sirv(appDirectory, { single: true, etag: true, dev: true });
    ctx.effect(() => ctx.webServer.register({
        kind: "prefix",
        path: appPath,
        handler(req, res) {
            if (req.method !== "GET" && req.method !== "HEAD") {
                res.writeHead(405, { Allow: "GET, HEAD" });
                res.end();
                return;
            }
            const url = new URL(req.url, "http://localhost");
            if (url.pathname === `${appPath}/bridge-config`) {
                res.setHeader("Cache-Control", "no-store");
                if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) {
                    res.writeHead(403);
                    res.end();
                    return;
                }
                void ensureReady().then(({ url: agentUrl, token }) => {
                    res.setHeader("Content-Type", "application/json; charset=utf-8");
                    res.end(req.method === "HEAD" ? undefined : JSON.stringify({ url: agentUrl, token }));
                }).catch((error) => {
                    // 把原因带出去：只有 503 而没有说明时，这类启动失败完全没法排查。
                    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
                    res.end(req.method === "HEAD" ? undefined : JSON.stringify({ error: error instanceof Error ? error.message : "Canvas Agent 未就绪" }));
                });
                return;
            }
            if (url.pathname === appPath) {
                res.writeHead(307, { Location: `${appPath}/${url.search}` });
                res.end();
                return;
            }
            // Only packaged public files are served; sirv owns path decoding and SPA fallback.
            req.url = `${url.pathname.slice(appPath.length)}${url.search}`;
            res.setHeader("X-Content-Type-Options", "nosniff");
            serve(req, res, () => {
                res.writeHead(404);
                res.end();
            });
        },
    }));
}
