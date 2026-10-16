import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("两个窗口交错保存各自画布时保留另一窗口的新建、编辑和删除", async (t) => {
    const servers = await Promise.all([0, 1].map(() => createServer({ root: fileURLToPath(new URL("../../../", import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } })));
    const previousStorage = globalThis.localStorage;
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    t.after(async () => { t.mock.timers.reset(); globalThis.localStorage = previousStorage; await Promise.all(servers.map((server) => server.close())); });
    let disk = null;
    const pages = await Promise.all(servers.map(async (server) => {
        const { localForageStorage } = await server.ssrLoadModule("/src/lib/localforage-storage.ts");
        localForageStorage.getItem = async () => disk;
        localForageStorage.setItem = async (_key, value) => { disk = value; };
        const page = await server.ssrLoadModule("/src/stores/canvas/use-canvas-store.ts");
        await page.useCanvasStore.persist.rehydrate();
        return page;
    }));
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const [a, b] = pages;
    const idA = a.useCanvasStore.getState().createProject("窗口 A");
    const idB = b.useCanvasStore.getState().createProject("窗口 B");
    await Promise.all(pages.map((page) => page.flushCanvasStorage()));
    assert.equal(JSON.parse(disk).state.projects.length, 2);

    for (let x = 1; x <= 2; x++) {
        a.useCanvasStore.getState().updateProject(idA, { viewport: { x, y: 0, k: 1 } });
        b.useCanvasStore.getState().updateProject(idB, { viewport: { x: -x, y: 0, k: 1 } });
        await Promise.all(pages.map((page) => page.flushCanvasStorage()));
        assert.equal(JSON.parse(disk).state.projects.find((project) => project.id === idA).viewport.x, x);
        assert.equal(JSON.parse(disk).state.projects.find((project) => project.id === idB).viewport.x, -x);
    }
    a.useCanvasStore.getState().deleteProjects([idA]);
    b.useCanvasStore.getState().renameProject(idB, "窗口 B 保留");
    await Promise.all(pages.map((page) => page.flushCanvasStorage()));
    assert.deepEqual(JSON.parse(disk).state.projects.map(({ id }) => id), [idB]);
    assert.equal(JSON.parse(disk).state.deletedProjects[0].id, idA);
    await b.reloadCanvasStorage();
    assert.equal(b.useCanvasStore.getState().openProject(idB).title, "窗口 B 保留");
    assert.equal(b.useCanvasStore.getState().openProject(idA), null);
});

test("写入失败保留待保存内容，重试时仍合并其他窗口的新画布", async (t) => {
    const server = await createServer({ root: fileURLToPath(new URL("../../../", import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
    const previousStorage = globalThis.localStorage;
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    t.after(async () => { globalThis.localStorage = previousStorage; await server.close(); });
    let disk = null, fail = true;
    const { localForageStorage } = await server.ssrLoadModule("/src/lib/localforage-storage.ts");
    localForageStorage.getItem = async () => disk;
    localForageStorage.setItem = async (_key, value) => { if (fail) throw new Error("quota full"); disk = value; };
    const page = await server.ssrLoadModule("/src/stores/canvas/use-canvas-store.ts");
    await page.useCanvasStore.persist.rehydrate();
    const id = page.useCanvasStore.getState().createProject("待重试");
    await assert.rejects(page.flushCanvasStorage(), /quota full/);
    assert.equal(page.useCanvasStore.getState().storageError, "quota full");
    disk = JSON.stringify({ state: { projects: [{ id: "other", title: "外部画布" }], deletedProjects: [] }, version: 0 });
    fail = false;
    await page.flushCanvasStorage();
    assert.deepEqual(new Set(JSON.parse(disk).state.projects.map((project) => project.id)), new Set([id, "other"]));
    assert.equal(page.useCanvasStore.getState().storageError, null);
});

test("旧写入失败时不重放旧快照，后续排队写入继续保存最新修改", async (t) => {
    const server = await createServer({ root: fileURLToPath(new URL("../../../", import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
    const previousStorage = globalThis.localStorage;
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    t.after(async () => { globalThis.localStorage = previousStorage; await server.close(); });
    let disk = null, calls = 0, started, rejectWrite;
    const firstStarted = new Promise((resolve) => { started = resolve; });
    const { localForageStorage } = await server.ssrLoadModule("/src/lib/localforage-storage.ts");
    localForageStorage.getItem = async () => disk;
    localForageStorage.setItem = async (_key, value) => {
        calls++;
        if (calls === 1) await new Promise((_resolve, reject) => { rejectWrite = reject; started(); });
        disk = value;
    };
    const page = await server.ssrLoadModule("/src/stores/canvas/use-canvas-store.ts");
    await page.useCanvasStore.persist.rehydrate();
    const first = page.useCanvasStore.getState().createProject("第一项");
    const failure = assert.rejects(page.flushCanvasStorage(), /failed write/);
    await firstStarted;
    const second = page.useCanvasStore.getState().createProject("第二项");
    const latest = page.flushCanvasStorage();
    rejectWrite(new Error("failed write"));
    await failure;
    await latest;
    await page.flushCanvasStorage();
    assert.equal(calls, 2, "失败的旧快照不能排到新快照后再次保存");
    assert.deepEqual(new Set(JSON.parse(disk).state.projects.map((project) => project.id)), new Set([first, second]));
});

test("读取失败时停止写入，不把空画布库覆盖到原数据，重读成功后恢复", async (t) => {
    const server = await createServer({ root: fileURLToPath(new URL("../../../", import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
    const previousStorage = globalThis.localStorage;
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    t.after(async () => { globalThis.localStorage = previousStorage; await server.close(); });
    let fail = true, writes = 0;
    let disk = JSON.stringify({ state: { projects: [{ id: "saved", title: "已保存" }], deletedProjects: [] }, version: 0 });
    const { localForageStorage } = await server.ssrLoadModule("/src/lib/localforage-storage.ts");
    localForageStorage.getItem = async () => { if (fail) throw new Error("read failed"); return disk; };
    localForageStorage.setItem = async (_key, value) => { writes++; disk = value; };
    const page = await server.ssrLoadModule("/src/stores/canvas/use-canvas-store.ts");
    await page.useCanvasStore.persist.rehydrate();
    assert.equal(page.useCanvasStore.getState().hydrated, false);
    assert.equal(page.useCanvasStore.getState().storageError, "read failed");
    page.useCanvasStore.getState().createProject("不能覆盖原数据");
    await page.flushCanvasStorage();
    assert.equal(writes, 0);
    assert.equal(JSON.parse(disk).state.projects[0].title, "已保存");
    fail = false;
    await page.reloadCanvasStorage();
    assert.equal(page.useCanvasStore.getState().hydrated, true);
    page.useCanvasStore.getState().renameProject("saved", "恢复写入");
    await page.flushCanvasStorage();
    assert.equal(JSON.parse(disk).state.projects[0].title, "恢复写入");
});

test("重载保留未保存的新项目、编辑和删除，并取消旧副本回写", async (t) => {
    const server = await createServer({ root: fileURLToPath(new URL("../../../", import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
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
