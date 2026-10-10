import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sirv from "sirv";

export const name = "dsh-infinite-canvas";
export const inject = ["webServer"];

const appPath = "/plugins/dsh-infinite-canvas/app";
const appDirectory = fileURLToPath(new URL("../dist/app/", import.meta.url));

export function apply(ctx) {
    if (!existsSync(new URL("../dist/app/index.html", import.meta.url))) {
        throw new Error("无限画布尚未打包，请先在 plugins/dsh-infinite-canvas 中运行 bun run build。");
    }
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
