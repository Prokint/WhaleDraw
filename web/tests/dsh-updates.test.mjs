import assert from "node:assert/strict";
import test from "node:test";
import { installPluginUpdate } from "../src/services/api/dsh-updates.ts";

const info = { version: "1.0.1", token: "local-test" };
const installed = { installed: true, version: info.version, restartRequired: true };

function mockEvents(t) {
    const original = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
    class Events {
        static current;
        constructor(url) { this.url = url; this.closed = false; Events.current = this; }
        close() { this.closed = true; }
    }
    Object.defineProperty(globalThis, "EventSource", { configurable: true, value: Events });
    t.after(() => { if (original) Object.defineProperty(globalThis, "EventSource", original); else delete globalThis.EventSource; });
    return Events;
}

test("安装请求转发进度并在完成后关闭事件流", async (t) => {
    const Events = mockEvents(t);
    let finish;
    t.mock.method(globalThis, "fetch", () => new Promise((resolve) => { finish = resolve; }));
    const progress = [];
    const pending = installPluginUpdate(info, (event) => progress.push(event));
    const event = { stage: "downloading", completedSteps: 1, totalSteps: 7, receivedBytes: 75, totalBytes: 100 };
    Events.current.onmessage({ data: JSON.stringify(event) });
    assert.deepEqual(progress, [event]);
    assert.equal(Events.current.closed, false);
    finish(Response.json(installed));
    assert.deepEqual(await pending, installed);
    assert.equal(Events.current.closed, true);
});

test("进度连接断开提示中断，不取消正在执行的安装或自动重连", async (t) => {
    const Events = mockEvents(t);
    let finish, completed = false;
    t.mock.method(globalThis, "fetch", () => new Promise((resolve) => { finish = resolve; }));
    const progress = [];
    const pending = installPluginUpdate(info, (event) => progress.push(event)).then((result) => { completed = true; return result; });
    const event = { stage: "installing", completedSteps: 5, totalSteps: 7 };
    Events.current.onmessage({ data: JSON.stringify(event) });
    Events.current.onerror();
    assert.equal(Events.current.closed, true);
    assert.deepEqual(progress.at(-1), { ...event, disconnected: true });
    assert.equal(completed, false);
    finish(Response.json(installed));
    assert.deepEqual(await pending, installed);
});

test("安装失败也关闭进度订阅并保留错误信息", async (t) => {
    const Events = mockEvents(t);
    t.mock.method(globalThis, "fetch", async () => Response.json({ error: "模拟安装失败" }, { status: 502 }));
    await assert.rejects(installPluginUpdate(info, () => {}), /模拟安装失败/);
    assert.equal(Events.current.closed, true);
});
