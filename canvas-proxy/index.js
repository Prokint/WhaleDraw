#!/usr/bin/env node
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { Readable } from "node:stream";

const pkg = createRequire(import.meta.url)("./package.json");

/** 只有命中白名单的来源才回显 CORS 头，避免任意网页把本机代理当内网转发器使用。 */
const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000", "http://127.0.0.1:3000"];
/** 云厂商元数据端点：转发到这些地址等于把实例凭证交给调用方。 */
const BLOCKED_TARGET_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "100.100.100.200", "metadata", "0.0.0.0", "255.255.255.255", "::", "[::]"]);
/** 上游迟迟不返回响应头时主动断开，避免请求和连接一直挂着；响应体流式转发不受此时限约束。 */
const FORWARD_TIMEOUT_MS = 120_000;
/** 代理请求体上限；超出后停止读取并返回 413。 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const CORS_HEADERS = {
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS",
    "access-control-allow-headers": "*",
    "access-control-expose-headers": "*",
    "access-control-max-age": "86400",
    vary: "origin",
};

/** Headers that describe the hop to this proxy rather than the upstream request. `origin` is forwarded so downstream origin checks still see the caller. */
const SKIP_REQUEST_HEADERS = new Set(["host", "connection", "content-length", "accept-encoding", "referer", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site"]);
/** fetch() already decoded and re-framed the body, so the upstream framing headers no longer apply. */
const SKIP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

function readArg(args, name, fallback) {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

/** `--allow-origin` 可重复出现。 */
function readArgs(args, name) {
    return args.flatMap((arg, index) => (arg === `--${name}` && args[index + 1] ? [args[index + 1]] : []));
}

function readAllowedOrigins(args) {
    const fromEnv = (process.env.CANVAS_PROXY_ALLOW_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean);
    return new Set([...DEFAULT_ALLOWED_ORIGINS, ...fromEnv, ...readArgs(args, "allow-origin")]);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let rejected = false;
        req.on("data", (chunk) => {
            if (rejected) return;
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                // 先停止读取，返回 413 后再关闭连接，避免提前 destroy 把错误响应一起丢掉。
                rejected = true;
                chunks.length = 0;
                reject(Object.assign(new Error(`请求体超过 ${MAX_BODY_BYTES / 1024 / 1024} MiB 上限`), { statusCode: 413 }));
                req.pause();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (!rejected) resolve(Buffer.concat(chunks));
        });
        req.on("error", reject);
    });
}

/** 非回环地址意味着同网络的其他设备都能使用本机代理，必须显式确认。 */
function isLoopbackHost(host) {
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function readTarget(url) {
    const raw = url.slice(1);
    // decodeURI undoes the escaping browsers apply to the path while keeping intentional encodeURIComponent escapes.
    let target = raw;
    try {
        target = decodeURI(raw);
    } catch {
        // Malformed escape sequence: forward the raw form instead of failing.
    }
    // Some clients collapse the "//" in the embedded target URL, so restore it before parsing.
    target = target.replace(/^(https?:)\/*/i, "$1//");
    return /^https?:\/\/[^/]/i.test(target) ? target : "";
}

/** 云厂商元数据与保留地址：转发过去等于把实例凭证交给调用方。私网、本机地址不拦，代理本机/局域网服务是本工具的用途。 */
function isBlockedAddress(address) {
    const value = address.startsWith("::ffff:") ? address.slice(7) : address;
    if (isIP(value) === 4) {
        // 169.254.0.0/16 链路本地（含 AWS/GCP/Azure 元数据）、100.64.0.0/10 CGNAT（含阿里云元数据）、0.0.0.0/8、广播地址。
        return /^(?:169\.254\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.|255\.255\.255\.255$)/.test(value);
    }
    const lower = value.toLowerCase();
    return lower === "::" || lower === "::1" || lower.startsWith("fe80:");
}

/** 返回拒绝原因，空字符串表示目标地址允许转发；域名按解析结果判断，避免用自带域名指向元数据地址绕过。 */
async function blockedTargetReason(target) {
    let host;
    try {
        host = new URL(target).hostname.toLowerCase();
    } catch {
        return "目标地址无法解析";
    }
    const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    if (BLOCKED_TARGET_HOSTS.has(bare)) return `已拒绝转发到 ${bare}`;
    if (isIP(bare)) return isBlockedAddress(bare) ? `已拒绝转发到 ${bare}` : "";
    let addresses;
    try {
        addresses = await lookup(bare, { all: true, verbatim: true });
    } catch {
        // 解析失败交给 fetch 自己报错，这里不改变原有错误路径。
        return "";
    }
    const blocked = addresses.find((item) => isBlockedAddress(item.address));
    return blocked ? `已拒绝转发到解析为 ${blocked.address} 的地址` : "";
}

function requestHeaders(req) {
    const headers = { "x-canvas-proxy": "1" };
    for (const [key, value] of Object.entries(req.headers)) {
        if (SKIP_REQUEST_HEADERS.has(key) || value === undefined) continue;
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    return headers;
}

function responseHeaders(upstream, cors) {
    const headers = { ...cors };
    upstream.headers.forEach((value, key) => {
        if (SKIP_RESPONSE_HEADERS.has(key) || key.startsWith("access-control-")) return;
        headers[key] = value;
    });
    return headers;
}

function sendJson(res, status, payload, cors) {
    res.writeHead(status, { ...cors, "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
}

function logForward(method, target, outcome, startedAt) {
    console.log(`${new Date().toLocaleTimeString()} ${method} ${target} -> ${outcome} ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

async function forward(req, res, target, cors) {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`上游 ${FORWARD_TIMEOUT_MS / 1000}s 内未返回响应`)), FORWARD_TIMEOUT_MS);
    let upstream;
    try {
        // redirect: "manual" 让 3xx 原样回到调用方，避免重定向绕过目标地址校验。
        upstream = await fetch(target, { method: req.method, headers: requestHeaders(req), body, redirect: "manual", signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
    // 部分 Node 版本对 redirect: "manual" 返回 opaque 响应（status 0），此时无法把状态码原样回传。
    if (!upstream.status) throw new Error("上游返回了不可见的重定向响应");
    // Logged as soon as the status line arrives, so a long SSE stream still shows up immediately.
    res.writeHead(upstream.status, responseHeaders(upstream, cors));
    if (!upstream.body) {
        res.end();
        return upstream.status;
    }
    // Streamed so that SSE responses (text generation) reach the browser chunk by chunk.
    const stream = Readable.fromWeb(upstream.body);
    stream.on("error", (error) => {
        console.error(`上游响应中断: ${error instanceof Error ? error.message : String(error)}`);
        res.destroy();
    });
    res.on("error", () => stream.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
    return upstream.status;
}

export function createProxyServer({ allowedOrigins = new Set(DEFAULT_ALLOWED_ORIGINS), allowNullOrigin = false } = {}) {
    const isOriginAllowed = (req) => {
        const origin = req.headers.origin;
        // 浏览器跨域请求一定带 Origin；没有该头的调用方（curl、本地脚本）本来就不经过 CORS，不构成网页越权。
        if (!origin) return true;
        if (origin === "null") return allowNullOrigin;
        return allowedOrigins.has(origin);
    };
    const corsHeaders = (req) => (req.headers.origin ? { ...CORS_HEADERS, "access-control-allow-origin": req.headers.origin } : { ...CORS_HEADERS });

    return createServer(async (req, res) => {
        if (!isOriginAllowed(req)) {
            // 不返回 CORS 头，浏览器侧表现为跨域失败。
            res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: `来源 ${req.headers.origin} 未被允许使用本地代理，请用 --allow-origin 加入白名单` }));
            return;
        }
        const cors = corsHeaders(req);
        if (req.method === "OPTIONS") {
            res.writeHead(204, cors);
            res.end();
            return;
        }
        const target = readTarget(req.url || "/");
        if (!target) {
            sendJson(res, 200, { app: "infinite-canvas", proxy: pkg.name, version: pkg.version, usage: "/<full-target-url>" }, cors);
            return;
        }
        let blocked = "";
        try {
            blocked = await blockedTargetReason(target);
        } catch (error) {
            blocked = `目标地址校验失败：${error instanceof Error ? error.message : String(error)}`;
        }
        if (blocked) {
            sendJson(res, 403, { error: blocked }, cors);
            return;
        }
        const startedAt = Date.now();
        const method = req.method || "GET";
        forward(req, res, target, cors)
            .then((status) => logForward(method, target, status, startedAt))
            .catch((error) => {
                const reason = error instanceof Error ? error.message : String(error);
                logForward(method, target, `failed (${reason})`, startedAt);
                if (res.headersSent) {
                    res.destroy();
                    return;
                }
                if (error?.statusCode === 413) res.setHeader("Connection", "close");
                sendJson(res, typeof error?.statusCode === "number" ? error.statusCode : 502, { error: reason }, cors);
            });
    });
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
    console.log(
        `${pkg.name} v${pkg.version}\n\n` +
            `Usage: npx ${pkg.name}@latest [--port 23210] [--host 127.0.0.1] [--allow-origin <origin>] [--allow-null-origin] [--allow-public]\n\n` +
            `Forwards http://<host>:<port>/<full-target-url> to <full-target-url>.\n` +
            `Only requests whose Origin is allowlisted receive CORS headers; other web pages get 403.\n` +
            `Default allowlist: ${DEFAULT_ALLOWED_ORIGINS.join(", ")}\n` +
            `Add more with repeatable --allow-origin or the CANVAS_PROXY_ALLOW_ORIGINS env var (comma separated).\n` +
            `Cloud metadata endpoints are always rejected. Request bodies over ${MAX_BODY_BYTES / 1024 / 1024} MiB get 413.\n` +
            `A non-loopback --host requires --allow-public, which lets other devices on the network use this proxy.`,
    );
    process.exit(0);
}

const port = Number(readArg(args, "port", process.env.PORT || 23210));
const host = readArg(args, "host", process.env.HOST || "127.0.0.1");
const allowedOrigins = readAllowedOrigins(args);
const allowNullOrigin = args.includes("--allow-null-origin");

if (!isLoopbackHost(host) && !args.includes("--allow-public")) {
    console.error(`拒绝监听 ${host}：非回环地址会让同网络或公网上的任何设备都能使用本机代理。确认需要时加 --allow-public 重新启动。`);
    process.exit(1);
}

createProxyServer({ allowedOrigins, allowNullOrigin }).listen(port, host, () => {
    console.log(`${pkg.name} v${pkg.version} listening on http://${host}:${port}`);
    if (!isLoopbackHost(host)) console.warn(`警告：正在监听非回环地址 ${host}，同网络的其他设备可以使用本机代理。`);
    console.log(`允许的来源: ${[...allowedOrigins].join(", ")}${allowNullOrigin ? ", null" : ""}`);
    console.log(`Fill this address into Infinite Canvas → 配置 → 本地代理: http://${host}:${port}`);
});
