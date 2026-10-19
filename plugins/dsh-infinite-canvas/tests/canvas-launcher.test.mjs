import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { appPath, installCanvasLauncher } from "../src/canvas-launcher.mjs";

function setup(t, choice = "新开画布", sidebar = { mode: "none" }) {
    const routes = new Map();
    const handlers = new Map();
    const disposers = [];
    const activations = [];
    const bindings = new Map();
    const nativeTools = new Map();
    const questions = [];
    let tool;
    let prompt;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        activations.push({ url: new URL(url), signal: options.signal, body });
        return Response.json({ ok: true, result: url.endsWith("/connect") ? { connectionId: `${body.sessionId}:${body.clientId}` } : body });
    };
    const ctx = {
        effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose); },
        on(name, fn) { handlers.set(name, fn); },
        connection: { admit(req) { return req.headers.authorization ? {} : 401; } },
        webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
        tools: { register(value) { if (value.name === "infinite_canvas_open") tool = value; else nativeTools.set(value.name, value); return () => {}; } },
        userQuestions: { async ask(input) { questions.push(input); return { answers: [{ id: "canvas-connection", selected: [choice] }] }; } },
        systemPrompt: { getSectionOrder() { return 1; }, section(value) { prompt = value; return () => {}; } },
    };
    installCanvasLauncher(ctx, async () => ({ url: "http://127.0.0.1:17371", token: "test-token" }), { get: (id) => bindings.get(id), put: async (id, value) => { bindings.set(id, value); } }, ["canvas_get_state", "canvas_apply_ops"].map((name) => ({ name, parameters: { type: "object" } })));
    t.after(async () => { for (const dispose of disposers.reverse()) await dispose(); globalThis.fetch = previousFetch; });
    const request = (path, authorization = "test") => ({ method: "GET", url: path, socket: { remoteAddress: "127.0.0.1" }, headers: { authorization } });
    const response = () => Object.assign(new EventEmitter(), {
        status: 200, chunks: [],
        writeHead(status) { this.status = status; },
        write(chunk) {
            this.chunks.push(chunk);
            if (chunk.startsWith("event: inspect-canvas")) {
                const { requestId, sessionId } = JSON.parse(chunk.split("data: ")[1]);
                routes.get(`${appPath}/host-result`)(request(`${appPath}/host-result?${new URLSearchParams({ requestId, sessionId, hostId: this.hostId, ...sidebar })}`), response());
            }
        },
        end() { this.emit("close"); },
    });
    return {
        tool, handlers, activations, prompt, nativeTools, questions, bindings,
        attach(sessionId, authorization, hostId = crypto.randomUUID()) {
            const stream = response();
            stream.sessionId = Array.isArray(sessionId) ? sessionId[0] : sessionId;
            stream.hostId = hostId;
            const params = new URLSearchParams({ hostId });
            for (const id of Array.isArray(sessionId) ? sessionId : [sessionId]) params.append("sessionId", id);
            routes.get(`${appPath}/host-events`)(request(`${appPath}/host-events?${params}`, authorization), stream);
            return stream;
        },
        subscribe(stream, sessions) {
            const params = new URLSearchParams({ hostId: stream.hostId });
            for (const id of sessions) params.append("sessionId", id);
            const res = response();
            routes.get(`${appPath}/host-sessions`)(request(`${appPath}/host-sessions?${params}`), res);
            return res.status;
        },
        acknowledge(stream, sessionId, extra = {}) {
            const opens = stream.chunks.filter((chunk) => chunk.startsWith("event: open-canvas")).map((chunk) => JSON.parse(chunk.split("data: ")[1]));
            const { requestId } = opens.findLast((event) => event.sessionId === sessionId) || opens.at(-1);
            const res = response();
            const params = new URLSearchParams({ requestId, sessionId, hostId: stream.hostId, clientId: "iframe-client", projectId: "canvas-project", ...extra });
            routes.get(`${appPath}/host-result`)(request(`${appPath}/host-result?${params}`), res);
            return res.status;
        },
    };
}

const execution = (sessionId = "chat-a") => ({ token: Symbol(), agent: { session: { id: sessionId } }, signal: new AbortController().signal });

test("单窗口事件流复用多个会话，取消一项订阅不影响其他会话", async (t) => {
    const fixture = setup(t);
    const stream = fixture.attach(["chat-a", "chat-b"]);
    const a = fixture.tool.execute({}, execution("chat-a"));
    const b = fixture.tool.execute({}, execution("chat-b"));
    void a.catch(() => {}); void b.catch(() => {});
    await setImmediate();
    const opens = stream.chunks.filter((chunk) => chunk.startsWith("event: open-canvas")).map((chunk) => JSON.parse(chunk.split("data: ")[1]));
    assert.deepEqual(new Set(opens.map((event) => event.sessionId)), new Set(["chat-a", "chat-b"]));
    const rejected = assert.rejects(a, /界面已断开/);
    assert.equal(fixture.subscribe(stream, ["chat-b"]), 204);
    await rejected;
    fixture.acknowledge(stream, "chat-b");
    assert.equal((await b).connected, true);
    assert.equal((await fixture.tool.execute({}, execution("chat-a"))).connected, false);
});

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
    assert.equal(fixture.activations[0].body.clientId, "iframe-client");
});

test("本轮结束释放画布控制，下轮调用重新连接", async (t) => {
    const fixture = setup(t);
    const stream = fixture.attach("chat-a");
    const first = fixture.tool.execute({}, execution());
    await setImmediate();
    fixture.acknowledge(stream, "chat-a");
    await first;
    fixture.handlers.get("session/event")({ id: "chat-a" }, { type: "turn/end" });
    await setImmediate();
    assert.equal(fixture.activations.filter((item) => item.url.pathname.endsWith("/disconnect")).length, 1);
    const second = fixture.tool.execute({}, execution());
    await setImmediate();
    fixture.acknowledge(stream, "chat-a");
    await second;
    assert.equal(fixture.activations.filter((item) => item.url.pathname.endsWith("/connect")).length, 2);
});

test("本轮等待画布页面时结束，不再建立控制连接", async (t) => {
    const fixture = setup(t);
    const stream = fixture.attach("chat-a");
    const opening = fixture.tool.execute({}, execution());
    await setImmediate();
    fixture.handlers.get("session/event")({ id: "chat-a" }, { type: "turn/end" });
    fixture.acknowledge(stream, "chat-a");
    await assert.rejects(opening, /本轮画布调用已结束/);
    assert.equal(fixture.activations.filter((item) => item.url.pathname.endsWith("/connect")).length, 0);
});

test("同会话在第二个窗口恢复后台副本后，续用仍交给已连接的原窗口", async (t) => {
    const fixture = setup(t);
    const owner = fixture.attach("chat-a");
    const first = fixture.tool.execute({}, execution());
    await setImmediate();
    fixture.acknowledge(owner, "chat-a", { clientId: "owner-client" });
    assert.equal((await first).connected, true);
    const duplicate = fixture.attach("chat-a");
    const second = fixture.tool.execute({}, execution());
    void second.catch(() => {});
    await setImmediate();
    assert.equal(duplicate.chunks.length, 1, "后台副本不得收到原窗口的检查和连接请求");
    fixture.acknowledge(owner, "chat-a", { clientId: "owner-client" });
    assert.equal((await second).connected, true);
    owner.end();
    const reconnect = fixture.tool.execute({}, execution());
    await setImmediate();
    fixture.acknowledge(duplicate, "chat-a", { clientId: "replacement-client" });
    assert.equal((await reconnect).connected, true);
});

test("原窗口事件流重连保留归属，其他窗口不能代答连接请求", async (t) => {
    const fixture = setup(t);
    const owner = fixture.attach("chat-a");
    const first = fixture.tool.execute({}, execution());
    await setImmediate();
    fixture.acknowledge(owner, "chat-a");
    await first;
    const duplicate = fixture.attach("chat-a");
    const restored = fixture.attach("chat-a", undefined, owner.hostId);
    const next = fixture.tool.execute({}, execution());
    await setImmediate();
    assert.equal(duplicate.chunks.length, 1);
    assert.equal(fixture.acknowledge(restored, "chat-a", { hostId: duplicate.hostId }), 409);
    fixture.acknowledge(restored, "chat-a");
    assert.equal((await next).connected, true);
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
    globalThis.fetch = async () => Response.json({ ok: false, error: "画布连接已失效" }, { status: 409 });
    let called = false;
    const rejected = assert.rejects(fixture.handlers.get("tools/execute")({ ...execution(), name: "mcp__infinite-canvas__canvas_get_state" }, async () => { called = true; }), /连接已失效/);
    await setImmediate();
    fixture.acknowledge(stream, "chat-a");
    await rejected;
    assert.equal(called, false);
});

test("不同会话交错执行原生工具时固定专用连接，不修改冻结的执行参数", async (t) => {
    const fixture = setup(t);
    const streamA = fixture.attach("chat-a");
    const streamB = fixture.attach("chat-b");
    const execA = Object.freeze({ ...execution("chat-a"), name: "mcp__infinite-canvas__canvas_get_state", arguments: Object.freeze({}) });
    const execB = Object.freeze({ ...execution("chat-b"), name: "mcp__infinite-canvas__canvas_get_state", arguments: Object.freeze({}) });
    let resumeA;
    const gate = new Promise((resolve) => { resumeA = resolve; });
    const resultA = fixture.handlers.get("tools/execute")(execA, async () => { await gate; return fixture.nativeTools.get(execA.name).execute(execA.arguments, execA); });
    await setImmediate();
    fixture.acknowledge(streamA, "chat-a", { clientId: "client-a", projectId: "project-a" });
    await setImmediate();
    const resultB = fixture.handlers.get("tools/execute")(execB, async () => fixture.nativeTools.get(execB.name).execute(execB.arguments, execB));
    await setImmediate();
    fixture.acknowledge(streamB, "chat-b", { clientId: "client-b", projectId: "project-b" });
    assert.equal((await resultB).result.connectionId, "chat-b:client-b");
    resumeA();
    assert.equal((await resultA).result.connectionId, "chat-a:client-a");
    assert.deepEqual(execA.arguments, {});
    await assert.rejects(fixture.nativeTools.get(execA.name).execute(execA.arguments, execA), /请先连接/);
});

test("预步骤不因画布关键词弹窗或占用，Agent 调用工具后才连接", async (t) => {
    const fixture = setup(t);
    const stream = fixture.attach("chat-a");
    const exec = { ...execution(), step: 1 };
    for (const text of ["解释这段画布代码", "帮我生成一张橘猫图片"]) {
        const decision = { kind: "enter", messages: [{ source: { kind: "user" }, content: [{ type: "text", text }] }] };
        assert.equal(await fixture.handlers.get("agent/pre-step")(exec, async () => decision), decision);
    }
    assert.equal(fixture.questions.length, 0);
    assert.equal(fixture.activations.length, 0);
    assert.equal(stream.chunks.length, 1);
    const opened = fixture.tool.execute({}, exec);
    await setImmediate();
    assert.equal(fixture.questions.length, 1);
    fixture.acknowledge(stream, "chat-a");
    assert.equal((await opened).connected, true);
    assert.equal(fixture.activations.filter((item) => item.url.pathname.endsWith("/connect")).length, 1);
});

test("不使用鲸绘只跳过本轮，不打开侧边栏或保存默认绑定", async (t) => {
    const fixture = setup(t, "不使用鲸绘");
    const stream = fixture.attach("chat-a");
    const exec = { ...execution(), step: 1 };
    const decision = { kind: "enter", messages: [{ source: { kind: "user" }, content: [{ type: "text", text: "帮我生成一张图" }] }] };
    await fixture.handlers.get("agent/pre-step")(exec, async () => decision);
    assert.equal(fixture.questions.length, 0);
    assert.equal(stream.chunks.length, 1);
    await fixture.tool.execute({}, exec);
    assert.equal(fixture.questions.length, 1);
    assert.equal(stream.chunks.some((chunk) => chunk.startsWith("event: open-canvas")), false);
    assert.equal(fixture.activations.length, 0);
    assert.equal(fixture.bindings.has("chat-a"), false);
    assert.match(fixture.prompt.text({ agent: exec.agent }), /继续完成用户的其他任务/);
    let called = false;
    const blocked = await fixture.handlers.get("tools/execute")({ ...exec, name: "mcp__infinite-canvas__canvas_get_state" }, async () => { called = true; });
    assert.equal(blocked.value.result.connected, false);
    assert.match(blocked.content[0].text, /继续处理其他任务/);
    assert.equal(called, false);
    await fixture.handlers.get("agent/pre-step")({ ...exec, step: 2 }, async () => decision);
    assert.equal(fixture.questions.length, 1);
    fixture.handlers.get("session/event")({ id: "chat-a" }, { type: "turn/end" });
    await fixture.handlers.get("agent/pre-step")(exec, async () => decision);
    await fixture.tool.execute({}, exec);
    assert.equal(fixture.questions.length, 2);
});

test("打开生图工作台仍保存工作台绑定", async (t) => {
    const fixture = setup(t, "打开生图工作台");
    const stream = fixture.attach("chat-a");
    const result = fixture.tool.execute({}, execution());
    await setImmediate();
    assert.equal(fixture.questions[0].questions[0].options[2].label, "打开生图工作台");
    fixture.acknowledge(stream, "chat-a");
    assert.equal((await result).mode, "workbench");
    assert.deepEqual(fixture.bindings.get("chat-a"), { mode: "workbench" });
});

test("侧边栏与默认画布不同时可选择本轮不使用鲸绘", async (t) => {
    const fixture = setup(t, "不使用鲸绘（仅本次）", { mode: "canvas", projectId: "other-project", title: "其他画布" });
    fixture.bindings.set("chat-a", { mode: "canvas", projectId: "canvas-project" });
    const stream = fixture.attach("chat-a");
    const exec = { ...execution(), step: 1 };
    const decision = { kind: "enter", messages: [{ source: { kind: "user" }, content: [{ type: "text", text: "读取画布" }] }] };
    await fixture.handlers.get("agent/pre-step")(exec, async () => decision);
    await fixture.tool.execute({}, exec);
    assert.equal(fixture.questions.length, 1);
    assert.equal(stream.chunks.some((chunk) => chunk.startsWith("event: open-canvas")), false);
    assert.deepEqual(fixture.bindings.get("chat-a"), { mode: "canvas", projectId: "canvas-project" });
});

test("不要修改画布不触发重新选择，历史画布请求不触发当前普通任务", async (t) => {
    const fixture = setup(t);
    fixture.bindings.set("chat-a", { mode: "canvas", projectId: "canvas-project" });
    const stream = fixture.attach("chat-a");
    const exec = { ...execution(), step: 1 };
    const decision = { kind: "enter", messages: [{ source: { kind: "user" }, content: [{ type: "text", text: "连接右侧画布并读取状态，不要修改画布" }] }] };
    await fixture.handlers.get("agent/pre-step")(exec, async () => decision);
    assert.equal(fixture.questions.length, 0);
    const result = fixture.tool.execute({}, exec);
    await setImmediate();
    fixture.acknowledge(stream, "chat-a");
    await result;
    assert.equal(fixture.questions.length, 0);
    const before = stream.chunks.length;
    decision.messages.push({ source: { kind: "user" }, content: [{ type: "text", text: "解释这段代码" }] });
    await fixture.handlers.get("agent/pre-step")({ ...exec, step: 1 }, async () => decision);
    assert.equal(stream.chunks.length, before);
    fixture.handlers.get("session/event")({ id: "chat-a" }, { type: "turn/end" });
    const change = { kind: "enter", messages: [{ source: { kind: "user" }, content: [{ type: "text", text: "重新选择画布连接" }] }] };
    await fixture.handlers.get("agent/pre-step")(exec, async () => change);
    const chosen = fixture.tool.execute({ reselect: true }, exec);
    await setImmediate();
    fixture.acknowledge(stream, "chat-a");
    await chosen;
    assert.equal(fixture.questions.length, 1);
    await fixture.handlers.get("agent/pre-step")({ ...exec, step: 2 }, async () => change);
    assert.equal(fixture.questions.length, 1);
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
    assert.equal(await fixture.handlers.get("agent/pre-step")(exec, async () => decision), decision);
    const result = fixture.tool.execute({}, exec);
    await setImmediate();
    fixture.acknowledge(stream, "chat-a", { error: "画布已被其他会话或页面占用，请先关闭原会话中的画布，再重试", errorCode: "canvas-occupied" });
    assert.equal((await result).connected, false);
    let called = false;
    const blocked = await fixture.handlers.get("tools/execute")({ ...exec, name: "mcp__infinite-canvas__canvas_apply_ops" }, async () => { called = true; });
    assert.equal(blocked.isError, false);
    assert.equal(blocked.value.result.connected, false);
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

test("无事件流时连接工具返回提示，MCP 不执行且新请求可以重试", async (t) => {
    const fixture = setup(t);
    const other = fixture.attach("chat-b");
    const exec = execution();
    const decision = { kind: "enter", messages: [{ source: { kind: "user" }, content: [{ type: "text", text: "读取画布" }] }] };
    assert.equal(await fixture.handlers.get("agent/pre-step")(exec, async () => decision), decision);
    assert.equal((await fixture.tool.execute({}, exec)).opened, false);
    assert.match(fixture.prompt.text({ agent: exec.agent }), /打开当前聊天.*正常的连接状态提示/);
    let called = false;
    const blocked = await fixture.handlers.get("tools/execute")({ ...exec, name: "mcp__infinite-canvas__canvas_get_state" }, async () => { called = true; });
    assert.equal(blocked.isError, false);
    assert.equal(called, false);
    assert.equal(other.chunks.length, 1);
    const stream = fixture.attach("chat-a");
    const retry = fixture.tool.execute({ reselect: true }, exec);
    await setImmediate();
    fixture.acknowledge(stream, "chat-a");
    assert.equal((await retry).connected, true);
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
