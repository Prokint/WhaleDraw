import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import test from "node:test";

test("正式插件包在无法访问 GitHub 时可安装并加载内置 Agent", { skip: !process.env.DSH_TEST_PLUGIN_PACKAGE || !process.env.DSH_TEST_PNPM, timeout: 120_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "whaledraw-packaged-agent-"));
    t.after(async () => {
        const part = relative(await realpath(tmpdir()), await realpath(root));
        assert.ok(part.startsWith("whaledraw-packaged-agent-") && !isAbsolute(part) && !part.includes(".."));
        await rm(root, { recursive: true, force: true });
    });
    const profile = join(root, "profile");
    await mkdir(profile);
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    // 只预热普通 registry 依赖；Agent 附件仍不可从 GitHub 下载。
    const dependencies = Object.fromEntries(Object.entries(manifest.dependencies).filter(([, value]) => !value.startsWith("https://")));
    await writeFile(join(profile, "package.json"), JSON.stringify({ name: "packaged-agent-test", private: true, type: "module", dependencies }));
    await writeFile(join(profile, "pnpm-workspace.yaml"), "packages:\n  - .\nnodeLinker: hoisted\n");
    await copyFile(new URL("../pnpm-lock.yaml", import.meta.url), join(profile, "pnpm-lock.yaml"));
    let networkRequests = 0;
    let installer;
    let blockedRequest = "";
    const block = (request) => { networkRequests++; blockedRequest = request.url; installer?.kill(); };
    const proxy = createServer((req, res) => { block(req); res.writeHead(502); res.end(); });
    proxy.on("connect", (req, socket) => { socket.on("error", () => {}); block(req); socket.destroy(); });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    t.after(() => { proxy.closeAllConnections(); proxy.close(); });
    await writeFile(join(profile, ".npmrc"), `https-proxy=http://127.0.0.1:${proxy.address().port}\n`);
    const environment = { ...process.env, DSH_HOME: join(root, "home") };
    const run = async (args) => {
        const child = spawn(process.execPath, [process.env.DSH_TEST_PNPM, ...args], { cwd: profile, env: environment, windowsHide: true, signal: t.signal, stdio: ["ignore", "pipe", "pipe"] });
        installer = child;
        let output = "";
        child.stdout.on("data", (chunk) => { output += chunk; });
        child.stderr.on("data", (chunk) => { output += chunk; });
        const [code] = await once(child, "exit");
        assert.equal(code, 0, `${args[0]}: ${blockedRequest ? `安装发起了被禁止的网络请求：${blockedRequest}\n` : ""}${output.slice(-6000)}`);
    };
    await run(["install", "--frozen-lockfile", "--offline", "--ignore-scripts", "--registry=https://registry.npmmirror.com"]);
    await run(["add", process.env.DSH_TEST_PLUGIN_PACKAGE, "--offline", "--ignore-scripts", "--registry=https://registry.npmmirror.com"]);
    assert.equal(networkRequests, 0, "安装插件及内置 Agent 时不应再发起远端请求");
    const script = join(root, "load-agent.mjs");
    await writeFile(script, `
        import assert from "node:assert/strict";
        import os from "node:os";
        import { pathToFileURL } from "node:url";
        os.homedir = () => process.env.DSH_HOME;
        const root = ${JSON.stringify(join(profile, "node_modules/dsh-infinite-canvas"))};
        await import(pathToFileURL(root + "/src/index.mjs"));
        const { VERSION } = await import(pathToFileURL(root + "/dist/agent/dist/config.js"));
        const { dshToolDefinitions } = await import(pathToFileURL(root + "/dist/agent/dist/agent/dsh.js"));
        const { startHttpServer } = await import(pathToFileURL(root + "/dist/agent/dist/server/http.js"));
        assert.ok(VERSION && dshToolDefinitions.length && typeof startHttpServer === "function");
        console.log(JSON.stringify({ agentVersion: VERSION, nativeTools: dshToolDefinitions.length }));
    `);
    const child = spawn(process.execPath, [script], { cwd: profile, env: environment, windowsHide: true, signal: t.signal });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const [code] = await once(child, "exit");
    assert.equal(code, 0, output);
    assert.equal(JSON.parse(output.trim()).agentVersion, JSON.parse(await readFile(new URL("../../../canvas-agent/package.json", import.meta.url), "utf8")).version);
});
