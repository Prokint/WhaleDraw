import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { appPath, installCanvasLauncher } from "../src/canvas-launcher.mjs";

function setup(t) {
    const routes = new Map();
    const handlers = new Map();
    const disposers = [];
    const calls = [];
    const bindings = new Map();
    let tool;
    const ctx = {
        effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose); },
        on(name, fn) { handlers.set(name, fn); },
        connection: { admit(req) { return req.headers.authorization ? {} : 401; } },
        webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
        tools: { register(value) { tool = value; return () => {}; } },
        userQuestions: { async ask() { return { answers: [{ id: "canvas-connection", selected: ["新开画布"] }] }; } },
        systemPrompt: { getSectionOrder() { return 1; }, section() { return () => {}; } },
    };
    installCanvasLauncher(ctx, async () => ({ url: "http://127.0.0.1:17371", token: "test-token" }), { get: (id) => bindings.get(id), put: async (id, value) => { bindings.set(id, value); } });
    t.after(() => { for (const dispose of disposers.reverse()) dispose(); });
    const request = (path, authorization = "test") => ({ method: "GET", url: path, socket: { remoteAddress: "127.0.0.1" }, headers: { authorization } });
    const response = () => Object.assign(new EventEmitter(), {
        status: 200, chunks: [],
        writeHead(status) { this.status = status; },
        write(chunk) {
            this.chunks.push(chunk);
            if (chunk.startsWith("event: inspect-canvas")) {
                const { requestId, sessionId } = JSON.parse(chunk.split("data: ")[1]);
                routes.get(`${appPath}/host-result`)(request(`${appPath}/host-result?${new URLSearchParams({ requestId, sessionId, mode: "none" })}`), response());
            }
            if (chunk.startsWith("event: call-canvas")) {
                const call = JSON.parse(chunk.split("data: ")[1]);
                calls.push(call);
                const body = { sessionId: call.sessionId, requestId: call.requestId, clientId: call.clientId, result: { projectId: "canvas-project", nodes: [], connections: [], selectedNodeIds: [] } };
                const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), request(`${appPath}/host-tool-result`), { method: "POST" });
                routes.get(`${appPath}/host-tool-result`)(req, response());
            }
        },
        end() { this.emit("close"); },
    });
    return {
        tool, handlers, calls,
        attach(sessionId, authorization) {
            const stream = response();
            stream.sessionId = sessionId;
            routes.get(`${appPath}/host-events`)(request(`${appPath}/host-events?${new URLSearchParams({ uiId: sessionId })}`, authorization), stream);
            routes.get(`${appPath}/host-session`)(request(`${appPath}/host-session?${new URLSearchParams({ uiId: sessionId, sessionId })}`, authorization), response());
            return stream;
        },
        join(uiId, sessionId) {
            const res = response();
            routes.get(`${appPath}/host-session`)(request(`${appPath}/host-session?${new URLSearchParams({ uiId, sessionId })}`), res);
            return res.status;
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
});

test("routes the MCP call to the session iframe only after it is ready", async (t) => {
    const fixture = setup(t);
    const stream = fixture.attach("chat-a");
    let called = false;
    const result = fixture.handlers.get("tools/execute")({ ...execution(), name: "mcp__infinite-canvas__canvas_generate_image", arguments: { prompt: "绘制橘猫" } }, async () => { called = true; return "generated"; });
    await setImmediate();
    assert.equal(called, false);
    fixture.acknowledge(stream, "chat-a");
    assert.equal((await result).isError, false);
    assert.equal(called, false);
    assert.deepEqual(fixture.calls.map(({ sessionId, clientId, name }) => ({ sessionId, clientId, name })), [
        { sessionId: "chat-a", clientId: "iframe-client", name: "canvas_get_state" },
        { sessionId: "chat-a", clientId: "iframe-client", name: "canvas_apply_ops" },
    ]);
});

test("a stale iframe connection cannot dispatch a canvas tool", async (t) => {
    const fixture = setup(t);
    const stream = fixture.attach("chat-a");
    let called = false;
    const rejected = assert.rejects(fixture.handlers.get("tools/execute")({ ...execution(), name: "mcp__infinite-canvas__canvas_get_state" }, async () => { called = true; }), /连接已失效/);
    await setImmediate();
    fixture.acknowledge(stream, "chat-a", { error: "连接已失效" });
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
    assert.equal(fixture.calls.length, 0);
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
    await assert.rejects(fixture.tool.execute({}, execution()), /打开当前聊天/);
});

test("unauthenticated interfaces cannot subscribe to opening requests", async (t) => {
    const fixture = setup(t);
    assert.equal(fixture.attach("chat-a", "").status, 401);
    await assert.rejects(fixture.tool.execute({}, execution()), /打开当前聊天/);
});

test("one interface retains multiple session routes through a single stream", async (t) => {
    const fixture = setup(t);
    const stream = fixture.attach("chat-a");
    for (const sessionId of ["chat-a", "chat-b", "chat-c", "chat-d", "chat-e", "chat-f", "chat-g", "chat-h"]) {
        assert.equal(fixture.join("chat-a", sessionId), 204);
        const result = fixture.tool.execute({}, execution(sessionId));
        await setImmediate();
        assert.equal(fixture.acknowledge(stream, sessionId, { clientId: `iframe-${sessionId}` }), 204);
        assert.equal((await result).connected, true);
    }
    assert.equal(stream.chunks.filter((chunk) => chunk === ": connected\n\n").length, 1);
    assert.equal(stream.chunks.filter((chunk) => chunk.startsWith("event: open-canvas")).length, 8);
    stream.end();
    await assert.rejects(fixture.tool.execute({}, execution("chat-h")), /打开当前聊天/);
});

test("a request not to change the binding retains the default canvas", async (t) => {
    const fixture = setup(t);
    const stream = fixture.attach("chat-a");
    const exec = execution();
    const initial = fixture.tool.execute({}, exec);
    await setImmediate();
    fixture.acknowledge(stream, "chat-a");
    await initial;
    const controller = new AbortController();
    t.after(() => controller.abort());
    for (const text of ["在已绑定画布继续操作，不要重新选择或更改画布绑定。", "在原绑定画布追加标题「切换会话后」的文本节点，内容为「修改已完成」。"]) {
        const decision = { kind: "enter", messages: [{ source: { kind: "user" }, content: [{ type: "text", text }] }] };
        const result = fixture.handlers.get("agent/pre-step")({ ...exec, signal: controller.signal }, async () => decision);
        void result.catch(() => {});
        await setImmediate();
        const request = JSON.parse(stream.chunks.findLast((chunk) => chunk.startsWith("event: open-canvas")).split("data: ")[1]);
        assert.equal(request.mode, "canvas");
        fixture.acknowledge(stream, "chat-a");
        assert.equal(await result, decision);
    }
});

test("an explicit request to change the canvas connection asks again", async (t) => {
    const fixture = setup(t);
    const stream = fixture.attach("chat-a");
    const exec = execution();
    const initial = fixture.tool.execute({}, exec);
    await setImmediate();
    fixture.acknowledge(stream, "chat-a");
    await initial;
    const decision = { kind: "enter", messages: [{ source: { kind: "user" }, content: [{ type: "text", text: "请更改连接画布。" }] }] };
    const result = fixture.handlers.get("agent/pre-step")(exec, async () => decision);
    await setImmediate();
    const request = JSON.parse(stream.chunks.findLast((chunk) => chunk.startsWith("event: open-canvas")).split("data: ")[1]);
    assert.equal(request.mode, "new");
    fixture.acknowledge(stream, "chat-a");
    assert.equal(await result, decision);
});
