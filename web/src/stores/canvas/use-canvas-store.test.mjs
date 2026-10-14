import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("重载保留未保存的新项目、编辑和删除，并取消旧副本回写", async (t) => {
    const server = await createServer({ root: fileURLToPath(new URL("../../../", import.meta.url)), server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } });
    const previousStorage = globalThis.localStorage;
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    t.after(async () => { t.mock.timers.reset(); globalThis.localStorage = previousStorage; await server.close(); });
    const project = (id, title = id) => ({ id, title, updatedAt: title, nodes: [], connections: [], chatSessions: [] });
    const raw = (projects, deletedProjects = []) => JSON.stringify({ state: { projects, deletedProjects }, version: 0 });
    let disk = raw([project("a"), project("b")]);
    const { localForageStorage } = await server.ssrLoadModule("/src/lib/localforage-storage.ts");
    localForageStorage.getItem = async () => disk;
    localForageStorage.setItem = async (_key, value) => { disk = value; };
    const { useCanvasStore: store, reloadCanvasStorage, flushCanvasStorage } = await server.ssrLoadModule("/src/stores/canvas/use-canvas-store.ts");
    await store.persist.rehydrate();
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const id = store.getState().createProject("新画布");
    disk = raw([project("a", "其他页面已保存"), project("b")]);
    await reloadCanvasStorage();
    assert.equal(store.getState().openProject(id).title, "新画布");
    assert.equal(store.getState().openProject("a").title, "其他页面已保存");
    t.mock.timers.tick(400);
    await flushCanvasStorage();
    assert.equal(JSON.parse(disk).state.projects.find((item) => item.id === "a").title, "其他页面已保存");

    store.getState().updateProject(id, { viewport: { x: 10, y: 20, k: 1 } });
    const saved = JSON.parse(disk).state.projects;
    disk = raw(saved.map((item) => item.id === "a" ? project("a", "另一项外部修改") : item));
    await reloadCanvasStorage();
    assert.deepEqual(store.getState().openProject(id).viewport, { x: 10, y: 20, k: 1 });
    assert.equal(store.getState().openProject("a").title, "另一项外部修改");

    store.getState().deleteProjects(["b"]);
    disk = raw(JSON.parse(disk).state.projects.filter((item) => item.id !== "a"), [{ id: "a", deletedAt: "external" }]);
    await reloadCanvasStorage();
    assert.equal(store.getState().openProject("a"), null);
    assert.equal(store.getState().openProject("b"), null);
    assert.equal(store.getState().deletedProjects.length, 2);
    assert.equal(store.getState().openProject(id).title, "新画布");
});
