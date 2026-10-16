import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import type { ServerResponse } from "node:http";
import test from "node:test";
import express from "express";
import { CanvasSession } from "../canvas/session.js";
import { installDshChannel } from "./dsh.js";

class Page extends EventEmitter {
    events: { type: string; payload: any }[] = [];
    writeHead() { return this; }
    write(chunk: string) {
        if (chunk.startsWith("event: ")) this.events.push({ type: chunk.split("\n", 1)[0].slice(7), payload: JSON.parse(chunk.split("data: ")[1]) });
        if (chunk.startsWith("event: tool_call\n")) this.emit("tool", JSON.parse(chunk.split("data: ")[1]));
        return true;
    }
    close() { this.emit("close"); }
}

test("DSH 专用 HTTP 通道隔离双会话、占用、重绑与断连，普通 Agent 目标不变", async (t) => {
    const canvas = new CanvasSession();
    const pages: Page[] = [];
    const connectPage = (clientId: string, projectId?: string) => {
        const page = new Page();
        canvas.openEvents(new URL(`http://localhost/events?clientId=${clientId}`), page as unknown as ServerResponse, "");
        canvas.updateState(projectId ? { projectId, title: projectId, nodes: [], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } } : null, clientId);
        pages.push(page);
        return page;
    };
    const first = connectPage("client-a", "canvas-a");
    const second = connectPage("client-b", "canvas-b");
    canvas.bindClient("client-b");
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { if (req.headers["x-canvas-agent-token"] !== "fixture") res.sendStatus(401); else next(); });
    const channel = installDshChannel(app, canvas);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}/agent/dsh/`;
    t.after(async () => { for (const page of pages) page.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
    const post = async (path: string, body: unknown) => {
        const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-canvas-agent-token": "fixture" }, body: JSON.stringify(body) });
        return { status: response.status, ...await response.json() };
    };
    assert.equal((await fetch(base + "connect", { method: "POST" })).status, 401);
    assert.equal((await post("connect", {})).status, 400);
    const bind = async (sessionId: string, clientId: string, projectId?: string) => {
        const result = await post("connect", { sessionId, clientId, mode: projectId ? "canvas" : "workbench", ...(projectId ? { projectId } : {}) });
        assert.equal(result.status, 200, result.error);
        return { sessionId, connectionId: result.result.connectionId };
    };
    const a = await bind("session-a", "client-a", "canvas-a");
    const b = await bind("session-b", "client-b", "canvas-b");
    assert.deepEqual(await bind("session-a", "client-a", "canvas-a"), a);
    const invoke = (identity: object, name = "canvas_get_state", input = {}) => post("tools", { ...identity, name, input });
    const [readA, readB] = await Promise.all([invoke(a), invoke(b)]);
    assert.equal(readA.result.projectId, "canvas-a");
    assert.equal(readB.result.projectId, "canvas-b");
    assert.equal((await canvas.callTool("canvas_get_state", {}) as { projectId: string }).projectId, "canvas-b");
    const events = Promise.all([once(first, "tool"), once(second, "tool")]);
    const writes = Promise.all([invoke(a, "canvas_create_text_node", { text: "A" }), invoke(b, "canvas_create_text_node", { text: "B" })]);
    const [[eventA], [eventB]] = await events;
    assert.equal(eventA.projectId, "canvas-a");
    assert.equal(eventB.projectId, "canvas-b");
    assert.equal(canvas.resolveResult("client-b", { requestId: eventA.requestId, result: "wrong" }), false);
    canvas.resolveResult("client-b", { requestId: eventB.requestId, result: "B" });
    canvas.resolveResult("client-a", { requestId: eventA.requestId, result: "A" });
    assert.deepEqual((await writes).map((value) => value.result), ["A", "B"]);
    connectPage("duplicate", "canvas-a");
    assert.equal((await post("connect", { sessionId: "session-other", clientId: "duplicate", mode: "canvas", projectId: "canvas-a" })).code, "canvas-occupied");
    assert.equal((await invoke({ ...a, sessionId: "session-b" })).code, "dsh-disconnected");
    canvas.updateState({ projectId: "new-a", nodes: [] }, "client-a");
    assert.equal((await invoke(a)).code, "dsh-target-changed");
    const newA = await bind("session-a", "client-a", "new-a");
    assert.notEqual(newA.connectionId, a.connectionId);
    assert.equal((await post("disconnect", a)).result.disconnected, false);
    assert.equal((await invoke(newA)).result.projectId, "new-a");
    await bind("released-canvas-owner", "duplicate", "canvas-a");
    first.close();
    channel.clientDisconnected("client-a");
    assert.equal((await invoke(newA)).code, "dsh-disconnected");
    assert.equal((await invoke(b)).result.projectId, "canvas-b");
    connectPage("new-client-a", "new-a");
    const reconnected = await bind("session-a", "new-client-a", "new-a");
    assert.equal((await invoke(reconnected)).result.projectId, "new-a");
    assert.equal((await invoke(newA)).code, "dsh-disconnected");
    connectPage("workbench");
    const workbench = await bind("workbench-session", "workbench");
    assert.equal((await invoke(workbench)).code, "dsh-mode-mismatch");
});

test("DSH 画布观察只给订阅页面完整快照，不抢占两个会话，并随重绑、切换与断连清理", async (t) => {
    const canvas = new CanvasSession();
    const pages: Page[] = [];
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { if (req.headers["x-canvas-agent-token"] !== "fixture") res.sendStatus(401); else next(); });
    const channel = installDshChannel(app, canvas);
    app.post("/canvas/state", (req, res) => {
        const clientId = String(req.query.clientId || "");
        canvas.updateState(req.body, clientId);
        channel.stateChanged(clientId);
        res.json({ ok: true });
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    t.after(async () => { for (const page of pages) page.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
    const post = async (path: string, body: unknown) => {
        const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-canvas-agent-token": "fixture" }, body: JSON.stringify(body) });
        return { status: response.status, ...await response.json() };
    };
    const page = (clientId: string, projectId?: string) => {
        const result = new Page();
        canvas.openEvents(new URL(`${base}/events?clientId=${clientId}`), result as unknown as ServerResponse);
        channel.clientConnected(clientId);
        result.on("close", () => channel.clientDisconnected(clientId));
        if (projectId) { canvas.updateState({ projectId, title: projectId, nodes: [] }, clientId); channel.stateChanged(clientId); }
        pages.push(result);
        return result;
    };
    const events = (target: Page, type: string) => target.events.filter((event) => event.type === type).map((event) => event.payload);
    const bind = async (sessionId: string, clientId: string, projectId?: string) => {
        const result = await post("/agent/dsh/connect", { sessionId, clientId, mode: projectId ? "canvas" : "workbench", ...(projectId ? { projectId } : {}) });
        assert.equal(result.status, 200, result.error);
        return { sessionId, connectionId: result.result.connectionId };
    };
    const watch = (clientId: string, projectId?: string) => post("/agent/dsh/watch", { clientId, ...(projectId ? { projectId } : {}) });
    const update = (clientId: string, projectId: string, nodes: unknown[] = []) => post(`/canvas/state?clientId=${clientId}`, { projectId, title: projectId, nodes });
    const ownerA = page("owner-a", "canvas-a");
    const ownerB = page("owner-b", "canvas-b");
    const observerA = page("observer-a");
    const observerB = page("observer-b");
    const manual = page("manual-editor", "manual-canvas");
    assert.deepEqual(events(manual, "dsh_canvases").at(-1), { canvases: [] });
    assert.equal((await fetch(base + "/agent/dsh/watch", { method: "POST" })).status, 401);
    for (const body of [{}, { clientId: "observer-a", projectId: "" }, { clientId: "observer-a", activate: true }]) {
        assert.equal((await post("/agent/dsh/watch", body)).status, 400);
    }
    assert.equal((await watch("missing", "canvas-a")).code, "dsh-disconnected");
    assert.deepEqual((await watch("observer-a", "manual-canvas")).result, { canvases: [], snapshot: null });
    assert.deepEqual(events(observerA, "dsh_canvas_state").at(-1), { projectId: "manual-canvas", snapshot: null });
    assert.equal(events(observerB, "dsh_canvas_state").length, 0);
    const a = await bind("session-a", "owner-a", "canvas-a");
    const b = await bind("session-b", "owner-b", "canvas-b");
    page("workbench");
    await bind("session-workbench", "workbench");
    const statuses = [{ projectId: "canvas-a", title: "canvas-a", clientId: "owner-a" }, { projectId: "canvas-b", title: "canvas-b", clientId: "owner-b" }];
    assert.deepEqual(events(observerA, "dsh_canvases").at(-1), { canvases: statuses });
    assert.deepEqual((await watch("observer-a", "canvas-a")).result, { canvases: statuses, snapshot: canvas.canvasStateForClient("owner-a") });
    assert.deepEqual(events(observerA, "dsh_canvas_state").at(-1), { projectId: "canvas-a", snapshot: canvas.canvasStateForClient("owner-a") });
    assert.equal(events(observerB, "dsh_canvas_state").length, 0);
    await watch("observer-b", "canvas-b");
    canvas.bindClient("owner-b");
    const counts = [ownerA, ownerB, observerA, observerB, manual].map((target) => events(target, "dsh_canvas_state").length);
    const listCount = events(observerA, "dsh_canvases").length;
    const node = { id: "a-text", type: "text", position: { x: 1, y: 2 }, width: 200, height: 100, metadata: { text: "完整正文", custom: { untrimmed: true } } };
    await update("owner-a", "canvas-a", [node]);
    assert.deepEqual([ownerA, ownerB, observerA, observerB, manual].map((target, index) => events(target, "dsh_canvas_state").length - counts[index]), [0, 0, 1, 0, 0]);
    assert.deepEqual(events(observerA, "dsh_canvas_state").at(-1), { projectId: "canvas-a", snapshot: canvas.canvasStateForClient("owner-a") });
    assert.deepEqual(events(observerA, "dsh_canvas_state").at(-1).snapshot.nodes, [node]);
    assert.equal(events(observerA, "dsh_canvases").length, listCount);
    assert.equal(canvas.canvasStateForClient("observer-a"), null);
    assert.equal((await canvas.callTool("canvas_get_state", {}) as { projectId: string }).projectId, "canvas-b");
    assert.equal((await post("/agent/dsh/tools", { ...a, name: "canvas_get_state", input: {} })).result.projectId, "canvas-a");
    assert.equal((await post("/agent/dsh/tools", { ...b, name: "canvas_get_state", input: {} })).result.projectId, "canvas-b");
    const write = post("/agent/dsh/tools", { ...a, name: "canvas_create_text_node", input: { text: "仍由 A 控制" } });
    const [call] = await once(ownerA, "tool");
    canvas.resolveResult("owner-a", { requestId: call.requestId, result: "written-by-a" });
    assert.equal((await write).result, "written-by-a");
    await watch("observer-a", "canvas-b");
    const switched = events(observerA, "dsh_canvas_state").length;
    await update("owner-a", "canvas-a", []);
    assert.equal(events(observerA, "dsh_canvas_state").length, switched);
    await update("owner-b", "canvas-b", []);
    assert.equal(events(observerA, "dsh_canvas_state").at(-1).projectId, "canvas-b");
    assert.equal((await watch("observer-a")).result.snapshot, null);
    const cancelled = events(observerA, "dsh_canvas_state").length;
    await update("owner-b", "canvas-b", []);
    assert.equal(events(observerA, "dsh_canvas_state").length, cancelled);
    await watch("observer-a", "canvas-a");
    page("owner-c", "canvas-c");
    const rebind = await bind("session-a", "owner-c", "canvas-c");
    assert.deepEqual(events(observerA, "dsh_canvas_state").at(-1), { projectId: "canvas-a", snapshot: null });
    assert.equal((await post("/agent/dsh/disconnect", a)).result.disconnected, false);
    await watch("observer-a", "canvas-c");
    await update("owner-c", "another-canvas", []);
    assert.deepEqual(events(observerA, "dsh_canvas_state").at(-1), { projectId: "canvas-c", snapshot: null });
    assert.deepEqual(events(observerA, "dsh_canvases").at(-1), { canvases: [statuses[1]] });
    await update("owner-c", "canvas-c", []);
    assert.equal(events(observerA, "dsh_canvas_state").at(-1).snapshot.projectId, "canvas-c");
    assert.equal((await post("/agent/dsh/disconnect", rebind)).result.disconnected, true);
    assert.deepEqual(events(observerA, "dsh_canvas_state").at(-1), { projectId: "canvas-c", snapshot: null });
    const replacementB = page("owner-b", "canvas-b");
    ownerB.close();
    assert.equal((await watch("observer-b", "canvas-b")).result.snapshot.projectId, "canvas-b");
    const replacementObserver = page("observer-b");
    observerB.close();
    await update("owner-b", "canvas-b", []);
    assert.equal(events(replacementObserver, "dsh_canvas_state").at(-1).snapshot.projectId, "canvas-b");
    replacementObserver.close();
    const disconnectedObserver = page("observer-b");
    await update("owner-b", "canvas-b", []);
    assert.equal(events(disconnectedObserver, "dsh_canvas_state").length, 0);
    await watch("observer-a", "canvas-b");
    replacementB.close();
    assert.deepEqual(events(observerA, "dsh_canvas_state").at(-1), { projectId: "canvas-b", snapshot: null });
    assert.deepEqual(events(disconnectedObserver, "dsh_canvases").at(-1), { canvases: [] });
    assert.equal((await watch("observer-a", "canvas-b")).result.snapshot, null);
});
