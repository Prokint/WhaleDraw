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
    vm.runInNewContext(source, {
        window, document: {}, EventSource, URLSearchParams, crypto: { randomUUID: () => "test-window" }, console,
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
    });
    const dispose = () => { for (const cleanup of disposers.splice(0).reverse()) cleanup(); };
    t.after(() => { dispose(); for (const frame of frames) frame.unmount(); });
    return {
        streams, requests, dispose,
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
