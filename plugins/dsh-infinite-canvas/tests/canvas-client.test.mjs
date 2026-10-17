import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src/client.js", import.meta.url), "utf8");

function setup(t, fetchResponse = async () => ({ ok: true, json: async () => null })) {
    const streams = [];
    const requests = [];
    const components = new Map();
    const disposers = [];
    const frames = [];
    const listeners = new Set();
    const subscribers = new Set();
    const drafts = [];
    const files = [];
    const textEdits = [];
    const inputState = { draft: "已有内容", draftRev: 1, occurrences: [] };
    const input = { state: { getSnapshot: () => inputState }, addAttachments: (ids) => { drafts.push(...ids); return true; }, focus() {} };
    let mounted = "chat-a";
    let effects;
    let plugin;
    class EventSource {
        static OPEN = 1;
        readyState = 0;
        handlers = new Map();
        constructor(url) { this.url = new URL(url, "http://localhost"); streams.push(this); }
        addEventListener(name, handler) { this.handlers.set(name, handler); }
        emit(name, value) { if (name === "open") this.readyState = 1; this.handlers.get(name)?.({ data: JSON.stringify(value) }); }
        close() { this.readyState = 2; }
    }
    const window = {
        location: { origin: "http://localhost" },
        addEventListener(_name, handler) { listeners.add(handler); },
        removeEventListener(_name, handler) { listeners.delete(handler); },
        __ModuleLoader__: { load({ factory }) { plugin = factory(() => ({
            useRef: (current) => ({ current }),
            useEffect: (effect) => effects.push(effect),
            createElement(type, props) {
                if (typeof type === "function") return type(props);
                if (type !== "iframe") return {};
                const messages = [];
                const frame = { messages, contentWindow: { postMessage: (message) => messages.push(message) } };
                props.ref.current = frame;
                return frame;
            },
        })); } },
    };
    class File extends Blob {
        constructor(parts, name, options) { super(parts, options); this.name = name; }
    }
    vm.runInNewContext(source, {
        window, document: {}, EventSource, URLSearchParams, crypto: { randomUUID: () => "test-window" }, console,
        Blob, File,
        fetch(url) { const request = new URL(url, "http://localhost"); requests.push(request); return fetchResponse(request); },
    });
    plugin.apply({
        slots: {
            inject(_name, callback) { callback(); },
            register({ key }, component) { components.set(key, component); return () => {}; },
        },
        effect(callback) { const dispose = callback(); if (dispose) disposers.push(dispose); },
        sidebarRightTabs: { register: () => () => {} },
        sidebarRight: {
            mounted: { getSnapshot: () => mounted, subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); } },
            openTab() {},
        },
        sessions: { scope(id) { return { bail(_ctx, type, payload) { textEdits.push({ id, type, payload }); return true; } }; } },
        conversation: {
            input: { for: () => input },
            createDrafts(id, inputs) { files.push(...inputs); return inputs.map((file) => ({ id: `${id}:${file.name}`, file })); },
            releaseDraftAttachments() {},
        },
    });
    const dispose = () => { for (const cleanup of disposers.splice(0).reverse()) cleanup(); };
    t.after(() => { dispose(); for (const frame of frames) frame.unmount(); });
    return {
        streams, requests, drafts, files, textEdits, inputState, dispose,
        select(sessionId) { mounted = sessionId; for (const subscriber of subscribers) subscriber(); },
        frame(sessionId, visible = false, params = {}) {
            effects = [];
            const element = components.get("infinite-canvas")({ sessionId, useTabInfo: () => ({ sidebar: {}, tab: { visible, navigation: { params } } }) });
            const cleanups = effects.map((effect) => effect()).filter(Boolean);
            const frame = { element, unmount() { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); } };
            frames.push(frame);
            return frame;
        },
        message(frame, data) { for (const listener of listeners) listener({ origin: window.location.origin, source: frame.element.contentWindow, data }); },
    };
}

test("前后台会话共用一条事件流，OPEN 后同步最新集合，空集合保留连接", async (t) => {
    const fixture = setup(t);
    const a = fixture.frame("chat-a");
    const b = fixture.frame("chat-b");
    fixture.select("chat-b");
    assert.equal(fixture.streams.length, 1);
    assert.equal(fixture.requests.length, 0);
    const stream = fixture.streams[0];
    assert.deepEqual(stream.url.searchParams.getAll("sessionId"), ["chat-a"]);
    stream.emit("open");
    await setImmediate();
    assert.deepEqual(fixture.requests.at(-1).searchParams.getAll("sessionId"), ["chat-a", "chat-b"]);
    fixture.select(undefined);
    a.unmount();
    b.unmount();
    await setImmediate();
    assert.deepEqual(fixture.requests.at(-1).searchParams.getAll("sessionId"), []);
    assert.equal(stream.readyState, 1);
    assert.equal(fixture.streams.length, 1);
    fixture.dispose();
    assert.equal(stream.readyState, 2);
});

test("订阅更新按顺序完成，前一请求未完成时不并发覆盖集合", async (t) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let count = 0;
    const fixture = setup(t, async () => { if (++count === 1) await gate; return { ok: true }; });
    fixture.streams[0].emit("open");
    await setImmediate();
    fixture.select("chat-b");
    fixture.select("chat-c");
    await setImmediate();
    assert.equal(fixture.requests.length, 1);
    release();
    await setImmediate();
    assert.deepEqual(fixture.requests.map((request) => request.searchParams.getAll("sessionId")), [["chat-a"], ["chat-b"], ["chat-c"]]);
    assert.ok(fixture.requests.every((request) => request.searchParams.get("hostId") === "test-window"));
});

test("复用事件按 sessionId 投递，后台 prepare 和结果回报保留窗口归属", async (t) => {
    const fixture = setup(t);
    const a = fixture.frame("chat-a");
    const b = fixture.frame("chat-b", true, { requestId: "pending-b" });
    fixture.select("chat-b");
    const stream = fixture.streams[0];
    stream.emit("inspect-canvas", { sessionId: "chat-b", requestId: "inspect-b" });
    assert.equal(a.element.messages.length, 0);
    assert.equal(b.element.messages.at(-1).requestId, "inspect-b");
    stream.emit("open-canvas", { sessionId: "chat-a", requestId: "open-a", mode: "canvas", projectId: "project-a" });
    assert.equal(a.element.messages.at(-1).requestId, "open-a");
    assert.equal(a.element.messages.at(-1).background, true);
    fixture.message(b, { type: "dsh-infinite-canvas:inspected", requestId: "inspect-b", mode: "canvas", projectId: "project-b" });
    await setImmediate();
    const report = fixture.requests.find((request) => request.pathname.endsWith("/host-result"));
    assert.equal(report.searchParams.get("sessionId"), "chat-b");
    assert.equal(report.searchParams.get("hostId"), "test-window");
    const request = fixture.requests.find((request) => request.pathname.endsWith("/host-request"));
    assert.equal(request.searchParams.get("hostId"), "test-window");
});

test("画布节点内容只添加到当前 DSH 会话草稿，不自动发送", async (t) => {
    const fixture = setup(t);
    const a = fixture.frame("chat-a", true);
    fixture.message(a, { type: "dsh-infinite-canvas:add-to-chat", kind: "text", text: "新文字" });
    assert.deepEqual(fixture.textEdits.map(({ id, payload }) => [id, payload.text, payload.span.start]), [["chat-a", "\n新文字", 4]]);
    assert.equal(a.element.messages.at(-1).type, "dsh-infinite-canvas:added-to-chat");

    fixture.inputState.draft = "引用 @path";
    fixture.inputState.occurrences = [{ length: 5 }];
    fixture.message(a, { type: "dsh-infinite-canvas:add-to-chat", kind: "text", text: "继续" });
    assert.equal(fixture.textEdits.at(-1).payload.span.start, 4);

    fixture.message(a, { type: "dsh-infinite-canvas:add-to-chat", kind: "image", blob: new Blob(["image"], { type: "image/png" }), name: "素材" });
    assert.deepEqual(fixture.drafts, ["chat-a:素材.png"]);

    for (const [mimeType, name] of [["text/markdown", "文档"], ["image/svg+xml", "矢量图"], ["text/html", "页面"]]) {
        fixture.message(a, { type: "dsh-infinite-canvas:add-to-chat", kind: "file", text: "节点源码", mimeType, name });
    }
    assert.deepEqual(fixture.drafts, ["chat-a:素材.png", "chat-a:文档.md", "chat-a:矢量图.svg", "chat-a:页面.html"]);
    assert.deepEqual(fixture.files.slice(1).map(({ type }) => type), ["text/markdown", "image/svg+xml", "text/html"]);
    assert.deepEqual(await Promise.all(fixture.files.slice(1).map((file) => file.text())), ["节点源码", "节点源码", "节点源码"]);
    fixture.message(a, { type: "dsh-infinite-canvas:add-to-chat", kind: "video", blob: new Blob(["video"], { type: "video/webm" }), name: "片段.webm" });
    assert.equal(fixture.drafts.at(-1), "chat-a:片段.webm");
    assert.equal(fixture.files.at(-1).type, "video/webm");
    assert.equal(await fixture.files.at(-1).text(), "video");
    fixture.message(a, { type: "dsh-infinite-canvas:add-to-chat", kind: "video", blob: new Blob(["mp4"], { type: "video/mp4" }), name: "生成视频" });
    assert.equal(fixture.drafts.at(-1), "chat-a:生成视频.mp4");
    fixture.message(a, { type: "dsh-infinite-canvas:add-to-chat", kind: "video", blob: new Blob(["video"], { type: "text/html" }), name: "错误格式" });
    assert.match(a.element.messages.at(-1).error, /不支持该节点文件格式/);
    assert.equal(fixture.drafts.length, 6);
    assert.equal(fixture.textEdits.length, 2);

    fixture.select("chat-b");
    fixture.message(a, { type: "dsh-infinite-canvas:add-to-chat", kind: "text", text: "不可串线" });
    assert.match(a.element.messages.at(-1).error, /会话已切换/);
    assert.equal(fixture.textEdits.length, 2);
});
