import assert from "node:assert/strict";
import test from "node:test";
import { latestAgentRelease } from "./version-check.js";

const url = "https://github.com/Prokint/WhaleDraw/releases/download/v0.2.4/whaledraw-canvas-agent-0.6.1.tgz";
const asset = { name: "whaledraw-canvas-agent-0.6.1.tgz", state: "uploaded", browser_download_url: url };

test("Agent 更新读取本仓库附件的独立版本号", async (t) => {
    t.mock.method(globalThis, "fetch", async (input) => {
        assert.equal(input, "https://api.github.com/repos/Prokint/WhaleDraw/releases/latest");
        return Response.json({ tag_name: "v0.2.4", assets: [asset] });
    });
    assert.deepEqual(await latestAgentRelease(), { version: "0.6.1", url });
});

test("Agent 更新拒绝缺失、未完成或来自其他来源的附件", async (t) => {
    for (const assets of [[], [{ ...asset, state: "new" }], [{ ...asset, browser_download_url: "https://example.com/agent.tgz" }]]) {
        t.mock.method(globalThis, "fetch", async () => Response.json({ tag_name: "v0.2.4", assets }));
        await assert.rejects(latestAgentRelease(), /缺少正式 Agent 安装包/);
        t.mock.restoreAll();
    }
});

test("Agent 更新请求失败保留 HTTP 错误", async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response("", { status: 503 }));
    await assert.rejects(latestAgentRelease(), /HTTP 503/);
});
