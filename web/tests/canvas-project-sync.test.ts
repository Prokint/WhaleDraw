import { afterAll, expect, test } from "bun:test";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import type { CanvasNodeData } from "../src/types/canvas";

const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
const { useCanvasStore, flushCanvasStorage } = await import("../src/stores/canvas/use-canvas-store");
await useCanvasStore.persist.rehydrate();
afterAll(async () => {
    await flushCanvasStorage();
    if (storage) Object.defineProperty(globalThis, "localStorage", storage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const node = (id: string, status = "success"): CanvasNodeData => ({ id, type: "text", title: id, position: { x: 0, y: 0 }, width: 340, height: 240, metadata: { content: id, status } } as CanvasNodeData);

test("two views observe each edit and their sequential changes preserve both nodes", () => {
    const store = useCanvasStore.getState();
    const id = store.createProject("shared");
    let viewA = store.openProject(id)!;
    let viewB = viewA;
    const subscribe = (update: (project: CanvasProject) => void) => useCanvasStore.subscribe((state) => update(state.projects.find((project) => project.id === id)!));
    const closeA = subscribe((project) => { viewA = project; });
    const closeB = subscribe((project) => { viewB = project; });
    try {
        store.updateProject(id, (project) => ({ nodes: [...project.nodes, node("A")] }));
        expect(viewB.nodes.map((item) => item.id)).toEqual(["A"]);
        store.updateProject(id, (project) => ({ nodes: [...project.nodes, node("B")] }));
        expect(viewA.nodes.map((item) => item.id)).toEqual(["A", "B"]);
        store.updateProject(id, { connections: [{ id: "edge", fromNodeId: "A", toNodeId: "B" }] });
        store.updateProject(id, (project) => ({ nodes: project.nodes.map((item) => item.id === "B" ? { ...item, title: "B changed" } : item) }));
        expect(viewA.connections).toHaveLength(1);
        expect(viewB.nodes[0].id).toBe("A");
        expect(viewA.nodes[1].title).toBe("B changed");
    } finally { closeA(); closeB(); }
});

test("a second view joins initialization and preserves an already running generation", async () => {
    const store = useCanvasStore.getState();
    const id = store.createProject("restore-once");
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    let restorations = 0;
    const restore = async () => { restorations++; await gate; return { nodes: [node("restored")] }; };
    const first = store.restoreProject(id, restore, true);
    const second = store.restoreProject(id, restore, true);
    finish();
    expect(await first).toBe(await second);
    store.updateProject(id, { nodes: [node("generating", "loading")] });
    const third = await store.restoreProject(id, restore, true);
    expect(restorations).toBe(1);
    expect(third?.nodes[0].metadata?.status).toBe("loading");
});

test("project changes stay isolated from other canvases", () => {
    const store = useCanvasStore.getState();
    const a = store.createProject("A");
    const b = store.createProject("B");
    store.updateProject(a, (project) => ({ nodes: [...project.nodes, node("only-A")] }));
    expect(store.openProject(b)?.nodes).toEqual([]);
});

test("restoring images preserves edits made while hydration is pending", async () => {
    const store = useCanvasStore.getState();
    const id = store.createProject("restore-race");
    store.updateProject(id, { nodes: [node("original")] });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const restoredSessions: CanvasProject["chatSessions"] = [];
    const pending = store.restoreProject(id, async (source) => {
        await gate;
        return { nodes: source.nodes.map((item) => ({ ...item, title: "hydrated" })), chatSessions: restoredSessions };
    }, true);
    store.updateProject(id, { nodes: [node("new-edit")] });
    finish();
    await pending;
    expect(store.openProject(id)?.nodes.map((item) => item.id)).toEqual(["new-edit"]);
    expect(store.openProject(id)?.chatSessions).toBe(restoredSessions);
});

test("a mounted view can resume a video after the first restore caller is cancelled", async () => {
    const store = useCanvasStore.getState();
    const id = store.createProject("cancelled-restore");
    const video = { ...node("video", "loading"), type: "video", metadata: { videoTaskId: "task" } } as CanvasNodeData;
    store.updateProject(id, { nodes: [video] });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const restore = async (source: CanvasProject) => { await gate; return { nodes: source.nodes }; };
    const cancelled = store.restoreProject(id, restore, true);
    const mounted = store.restoreProject(id, restore, true);
    finish();
    await cancelled; // This view unmounted, so it never starts polling.
    const project = await mounted;
    const release = store.claimVideoTask(project!.id, project!.nodes[0].id, "task");
    expect(release).not.toBeNull();
    expect(store.claimVideoTask(id, video.id, "task")).toBeNull();
    release!();
    const resumed = store.claimVideoTask(id, video.id, "task");
    expect(resumed).not.toBeNull();
    release!(); // A stale owner cannot release the next view's claim.
    expect(store.claimVideoTask(id, video.id, "task")).toBeNull();
    resumed!();
});

test("hydration does not resurrect a deleted project", async () => {
    const store = useCanvasStore.getState();
    const id = store.createProject("deleted-during-restore");
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const pending = store.restoreProject(id, async () => { await gate; return { nodes: [node("old")] }; }, true);
    store.deleteProjects([id]);
    finish();
    expect(await pending).toBeNull();
    expect(store.openProject(id)).toBeNull();
});

test("hydration preserves fields replaced by an external sync", async () => {
    const store = useCanvasStore.getState();
    const id = store.createProject("sync-during-restore");
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const pending = store.restoreProject(id, async () => { await gate; return { nodes: [node("old")], chatSessions: [] }; }, true);
    const replacement = { ...store.openProject(id)!, nodes: [node("synced")], chatSessions: [] };
    store.replaceProjects(useCanvasStore.getState().projects.map((project) => project.id === id ? replacement : project));
    finish();
    expect(await pending).toBe(replacement);
});

test("failed hydration can be retried and video claims are isolated by project", async () => {
    const store = useCanvasStore.getState();
    const a = store.createProject("retry-restore");
    const b = store.createProject("independent-video");
    await expect(store.restoreProject(a, async () => { throw new Error("storage unavailable"); }, true)).rejects.toThrow("storage unavailable");
    expect((await store.restoreProject(a, async () => ({ nodes: [node("restored")] }), true))?.nodes[0].id).toBe("restored");
    const releaseA = store.claimVideoTask(a, "video", "task");
    const releaseB = store.claimVideoTask(b, "video", "task");
    expect(releaseA).not.toBeNull();
    expect(releaseB).not.toBeNull();
    releaseA!();
    releaseB!();
});
