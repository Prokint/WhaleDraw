import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("代理保留来源门禁、元数据阻断、手动重定向及请求体上限", async (t) => {
    const upstream = createServer((req, res) => {
        if (req.url === "/redirect") { res.writeHead(302, { location: "http://169.254.169.254/" }); res.end(); return; }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ origin: req.headers.origin, marker: req.headers["x-canvas-proxy"] }));
    });
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    t.after(() => { upstream.closeAllConnections(); upstream.close(); });
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const child = spawn(process.execPath, [fileURLToPath(new URL("./index.js", import.meta.url)), "--port", String(port), "--allow-origin", "http://allowed.test"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    t.after(async () => { if (child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; } });
    await new Promise((resolve, reject) => {
        let output = "";
        child.on("error", reject);
        child.once("exit", (code) => reject(new Error(`Proxy exited: ${code}`)));
        child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("listening on")) resolve(); });
    });
    const proxy = `http://127.0.0.1:${port}/`;
    const target = `http://127.0.0.1:${upstream.address().port}`;
    const headers = { origin: "http://allowed.test" };
    const denied = await fetch(`${proxy}${target}`, { headers: { origin: "http://denied.test" } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
    const allowed = await fetch(`${proxy}${target}`, { headers });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), headers.origin);
    assert.deepEqual(await allowed.json(), { origin: headers.origin, marker: "1" });
    const metadata = await fetch(`${proxy}http://169.254.169.254/latest/meta-data/`, { headers });
    assert.equal(metadata.status, 403);
    const redirect = await fetch(`${proxy}${target}/redirect`, { headers, redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), "http://169.254.169.254/");
    const oversized = await fetch(`${proxy}${target}`, { method: "POST", headers, body: Buffer.alloc(32 * 1024 * 1024 + 1) });
    assert.equal(oversized.status, 413);
    assert.match((await oversized.json()).error, /32/);
    const recovered = await fetch(`${proxy}${target}`, { headers });
    assert.equal(recovered.status, 200);
});
