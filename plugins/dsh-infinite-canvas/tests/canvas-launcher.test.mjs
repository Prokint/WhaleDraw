import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { appPath, installCanvasLauncher } from "../src/canvas-launcher.mjs";

function setup(t) {
    const routes = new Map();
    const handlers = new Map();
    const disposers = [];
    const activations = [];
    const bindings = new Map();
    let tool;
    let prompt;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => { activations.push({ url: new URL(url), signal: options.signal }); return { ok: true }; };
    const ctx = {
        effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose); },
        on(name, fn) { handlers.set(name, fn); },
        connection: { admit(req) { return req.headers.authorization ? {} : 401; } },
        webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
        tools: { register(value) { tool = value; return () => {}; } },
        userQuestions: { async ask() { return { answers: [{ id: "canvas-connection", selected: ["新开画布"] }] }; } },
        systemPrompt: { getSectionOrder() { return 1; }, section(value) { prompt = value; return () => {}; } },
    };
    installCanvasLauncher(ctx, async () => ({ url: "http://127.0.0.1:17371", token: "test-token" }), { get: (id) => bindings.get(id), put: async (id, value) => { bindings.set(id, value); } });
    t.after(() => { for (const dispose of disposers.reverse()) dispose(); globalThis.fetch = previousFetch; });
    const request = (path, authorization = "test") => ({ method: "GET", url: path, socket: { remoteAddress: "127.0.0.1" }, headers: { authorization } });
    const response = () => Object.assign(new EventEmitter(), {
        status: 200, chunks: [],
        writeHead(status) { this.status = status; },
        write(chunk) {
            this.chunks.push(chunk);
            if (chunk.startsWith("event: inspect-canvas")) {
                const { requestId } = JSON.parse(chunk.split("data: ")[1]);
                routes.get(`${appPath}/host-result`)(request(`${appPath}/host-result?${new URLSearchParams({ requestId, sessionId: this.sessionId, mode: "none" })}`), response());
            }
        },
        end() { this.emit("close"); },
    });
    return {
        tool, handlers, activations, prompt,
        attach(sessionId, authorization) {
            const stream = response();
            stream.sessionId = sessionId;
            routes.get(`${appPath}/host-events`)(request(`${appPath}/host-events?${new URLSearchParams({ sessionId })}`, authorization), stream);
            return stream;
        },
        acknowledge(stream, sessionId, extra = {}) {
            const requestId = JSON.parse(stream.chunks.findLast((chunk) => chunk.startsWith("event: open-canvas")).split("data: ")[1]).requestId;
            const res = response();
            const params = new URLSearchParams({ requestId, sessionId, clientId: "iframe-client", projectId: "canvas-project", ...extra });
            routes.get(`${appPath}/host-result`)(request(`${appPath}/host-result?${params}`), res);
            return res.status;
        },
    };
}

const execution = (sessionId = "chat-a") => ({ agent: { session: { id: sessionId } }, signal: new AbortController().signal });

test("opens only the caller's interface and waits for its restored canvas", async (t) => {
    const fixture = setup(t);
    const caller = fixture.attach("chat-a");
    const other = fixture.attach("chat-b");
    let finished = false;
    const result = fixture.tool.execute({}, execution()).then((value) => { finished = true; return value; });
    await setImmediate();
    assert.equal(finished, false);
    assert.equal(other.chunks.length, 1);
    assert.equal(fixture.acknowledge(caller, "chat-b"), 409);
    assert.equal(fixture.acknowledge(caller, "chat-a"), 204);
    assert.deepEqual(await result, { opened: true, connected: true, mode: "canvas", projectId: "canvas-project" });
    assert.equal(fixture.activations[0].url.searchParams.get("clientId"), "iframe-client");
});

test("does not execute the MCP call until the iframe is ready", async (t) => {
    const fixture = setup(t);
    const stream = fixture.attach("chat-a");
    let called = false;
    const result = fixture.handlers.get("tools/execute")({ ...execution(), name: "mcp__infinite-canvas__canvas_generate_image" }, async () => { called = true; return "generated"; });
    await setImmediate();
    assert.equal(called, false);
    fixture.acknowledge(stream, "chat-a");
    assert.equal(await result, "generated");
});

test("a stale iframe connection cannot dispatch a canvas tool", async (t) => {
    const fixture = setup(t);
    const stream = fixture.attach("chat-a");
    globalThis.fetch = async () => ({ ok: false });
    let called = false;
    const rejected = assert.rejects(fixture.handlers.get("tools/execute")({ ...execution(), name: "mcp__infinite-canvas__canvas_get_state" }, async () => { called = true; }), /连接已失效/);
    await setImmediate();
    fixture.acknowledge(stream, "chat-a");
    await rejected;
    assert.equal(called, false);
});

test("human canvas and image requests open before the model step", async (t) => {
    const fixture = setup(t);
    const stream = fixture.attach("chat-a");
    for (const text of ["打开画布", "帮我生成一张橘猫图片"]) {
        const decision = { kind: "enter", messages: [{ source: { kind: "user" }, content: [{ type: "text", text }] }] };
        const result = fixture.handlers.get("agent/pre-step")({ ...execution() }, async () => decision);
        await setImmediate();
        fixture.acknowledge(stream, "chat-a");
        assert.equal(await result, decision);
    }
    const ordinary = { kind: "enter", messages: [{ source: { kind: "user" }, content: [{ type: "text", text: "解释这段代码" }] }] };
    const before = stream.chunks.length;
    assert.equal(await fixture.handlers.get("agent/pre-step")(execution(), async () => ordinary), ordinary);
    assert.equal(stream.chunks.length, before);
});

test("task cancellation removes the pending open request", async (t) => {
    const fixture = setup(t);
    const stream = fixture.attach("chat-a");
    const controller = new AbortController();
    const result = fixture.tool.execute({}, { ...execution(), signal: controller.signal });
    const rejected = assert.rejects(result, /cancelled/);
    await setImmediate();
    controller.abort(new Error("cancelled"));
    await rejected;
    assert.equal(fixture.acknowledge(stream, "chat-a"), 409);
    assert.equal(fixture.activations.length, 0);
});

test("frontend errors and closed interfaces prevent canvas tool execution", async (t) => {
    const fixture = setup(t);
    const stream = fixture.attach("chat-a");
    const error = assert.rejects(fixture.tool.execute({}, execution()), /模型页面加载失败/);
    await setImmediate();
    fixture.acknowledge(stream, "chat-a", { error: "模型页面加载失败" });
    await error;
    const closed = assert.rejects(fixture.tool.execute({}, execution()), /界面已断开/);
    await setImmediate();
    stream.end();
    await closed;
    const missing = await fixture.tool.execute({}, execution());
    assert.equal(missing.connected, false);
    assert.match(missing.message, /打开当前聊天/);
});

test("unauthenticated interfaces cannot subscribe to opening requests", async (t) => {
    const fixture = setup(t);
    assert.equal(fixture.attach("chat-a", "").status, 401);
    assert.equal((await fixture.tool.execute({}, execution())).connected, false);
});

test("画布占用不使模型前置步骤失败，工具返回正常提示且不执行读写", async (t) => {
    const fixture = setup(t);
    const stream = fixture.attach("chat-a");
    const exec = execution();
    const decision = { kind: "enter", messages: [{ source: { kind: "user" }, content: [{ type: "text", text: "读取画布" }] }] };
    const result = fixture.handlers.get("agent/pre-step")(exec, async () => decision);
    await setImmediate();
    fixture.acknowledge(stream, "chat-a", { error: "画布已被其他会话或页面占用，请先关闭原会话中的画布，再重试", errorCode: "canvas-occupied" });
    assert.equal(await result, decision);
    let called = false;
    const blocked = await fixture.handlers.get("tools/execute")({ ...exec, name: "mcp__infinite-canvas__canvas_apply_ops" }, async () => { called = true; });
    assert.equal(blocked.isError, false);
    assert.equal(blocked.value.connected, false);
    assert.match(blocked.content[0].text, /未读取或修改/);
    assert.equal(called, false);
    assert.equal(fixture.activations.length, 0);
    assert.equal(fixture.tool.execute({}, exec).connected, false);
    const retried = fixture.tool.execute({ reselect: true }, exec);
    await setImmediate();
    fixture.acknowledge(stream, "chat-a");
    assert.equal((await retried).connected, true);
});

test("连接工具将占用结果作为正常状态返回", async (t) => {
    const fixture = setup(t);
    const stream = fixture.attach("chat-a");
    const result = fixture.tool.execute({}, execution());
    await setImmediate();
    fixture.acknowledge(stream, "chat-a", { error: "目标正在使用，请稍后重新连接", errorCode: "canvas-occupied" });
    assert.equal((await result).opened, false);
    assert.match((await result).message, /正在使用/);
    assert.equal(fixture.activations.length, 0);
});

test("无事件流时前置步骤继续，Agent 收到提示，MCP 不执行且新请求可以重试", async (t) => {
    const fixture = setup(t);
    const other = fixture.attach("chat-b");
    const exec = execution();
    const decision = { kind: "enter", messages: [{ source: { kind: "user" }, content: [{ type: "text", text: "读取画布" }] }] };
    assert.equal(await fixture.handlers.get("agent/pre-step")(exec, async () => decision), decision);
    assert.match(fixture.prompt.text({ agent: exec.agent }), /打开当前聊天.*正常的连接状态提示/);
    assert.equal(fixture.tool.execute({}, exec).opened, false);
    let called = false;
    const blocked = await fixture.handlers.get("tools/execute")({ ...exec, name: "mcp__infinite-canvas__canvas_get_state" }, async () => { called = true; });
    assert.equal(blocked.isError, false);
    assert.equal(called, false);
    assert.equal(other.chunks.length, 1);
    const stream = fixture.attach("chat-a");
    const retry = fixture.handlers.get("agent/pre-step")(exec, async () => decision);
    await setImmediate();
    fixture.acknowledge(stream, "chat-a");
    assert.equal(await retry, decision);
    assert.equal(fixture.activations.length, 1);
    assert.match(fixture.prompt.text({ agent: exec.agent }), /本次操作画布为 canvas-project/);
});

test("占用文案没有状态码时仍作为真实异常处理", async (t) => {
    const fixture = setup(t);
    const stream = fixture.attach("chat-a");
    const result = fixture.tool.execute({}, execution());
    const rejected = assert.rejects(result, /占用/);
    await setImmediate();
    fixture.acknowledge(stream, "chat-a", { error: "画布已被其他会话或页面占用" });
    await rejected;
});
