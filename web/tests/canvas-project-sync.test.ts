import { afterAll, expect, test } from "bun:test";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import type { CanvasNodeData } from "../src/types/canvas";

const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
const { useCanvasStore, flushCanvasStorage } = await import("../src/stores/canvas/use-canvas-store");
const { useCanvasGenerationStore } = await import("../src/stores/canvas/use-canvas-generation-store");
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
    const generation = useCanvasGenerationStore.getState();
    const task = generation.resume(project!.id, project!.nodes[0].id, false);
    expect(task).not.toBeNull();
    expect(generation.resume(id, video.id, false)).toBeNull();
    await task!.finish();
    const resumed = generation.resume(id, video.id, false);
    expect(resumed).not.toBeNull();
    await task!.finish(); // A stale owner cannot release the next view's task.
    expect(generation.resume(id, video.id, false)).toBeNull();
    await resumed!.finish();
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

test("failed hydration can be retried and video tasks are isolated by project", async () => {
    const store = useCanvasStore.getState();
    const a = store.createProject("retry-restore");
    const b = store.createProject("independent-video");
    await expect(store.restoreProject(a, async () => { throw new Error("storage unavailable"); }, true)).rejects.toThrow("storage unavailable");
    expect((await store.restoreProject(a, async () => ({ nodes: [node("restored")] }), true))?.nodes[0].id).toBe("restored");
    const video = { ...node("video"), type: "video", metadata: { videoTaskId: "task" } } as CanvasNodeData;
    store.updateProject(a, { nodes: [video] });
    store.updateProject(b, { nodes: [video] });
    const generation = useCanvasGenerationStore.getState();
    const taskA = generation.resume(a, video.id, false);
    const taskB = generation.resume(b, video.id, false);
    expect(taskA).not.toBeNull();
    expect(taskB).not.toBeNull();
    await taskA!.finish();
    await taskB!.finish();
});

test("asynchronous preparation and completion stay in the starting project", async () => {
    const store = useCanvasStore.getState();
    const a = store.createProject("generation-A");
    const b = store.createProject("generation-B");
    store.updateProject(a, { nodes: [node("source")] });
    store.updateProject(b, { nodes: [node("source"), node("result")] });
    const other = store.openProject(b)!;
    const task = useCanvasGenerationStore.getState().start(a, "source");
    try {
        await Promise.resolve(); // The view can leave A while references are loading.
        task.target("result");
        task.setNodes((nodes) => [...nodes, node("result", "loading")]);
        task.setConnections((connections) => [...connections, { id: "edge", fromNodeId: "source", toNodeId: "result" }]);
        await Promise.resolve();
        task.setNodes((nodes) => nodes.map((item) => item.id === "result" ? { ...item, title: "finished" } : item));
        expect(store.openProject(a)?.nodes[1].title).toBe("finished");
        expect(store.openProject(a)?.connections).toHaveLength(1);
        expect(store.openProject(b)).toBe(other);
    } finally { await task.finish(); }
});

test("views share task state and either view can stop the whole batch", async () => {
    const store = useCanvasStore.getState();
    const id = store.createProject("shared-generation");
    store.updateProject(id, { nodes: [node("source", "loading"), { ...node("result", "loading"), metadata: { status: "loading", images: [{ id: "image", status: "loading", content: "" }] } } as CanvasNodeData] });
    const generation = useCanvasGenerationStore.getState();
    let viewA = false;
    let viewB = false;
    const closeA = useCanvasGenerationStore.subscribe((state) => { viewA = state.tasks.some((task) => task.projectId === id); });
    const closeB = useCanvasGenerationStore.subscribe((state) => { viewB = state.tasks.some((task) => task.projectId === id); });
    const task = generation.start(id, "source");
    try {
        task.target("result");
        expect(viewA && viewB).toBe(true);
        generation.stop(id, "result");
        expect(viewA || viewB).toBe(false);
        expect(task.controller.signal.aborted).toBe(true);
        expect(store.openProject(id)?.nodes[1].metadata?.images?.[0].status).toBe("error");
        const stopped = store.openProject(id);
        task.setNodes((nodes) => [...nodes, node("late")]);
        expect(store.openProject(id)).toBe(stopped);
    } finally { closeA(); closeB(); await task.finish(); }
});

test("stopping from the source cancels result tasks and preserves other projects and completed images", async () => {
    const store = useCanvasStore.getState();
    const id = store.createProject("source-stop");
    const otherId = store.createProject("source-stop-other");
    const resultIds = ["mask", "angle", "retry"];
    const result = (id: string) => ({ ...node(id, "loading"), metadata: { status: "loading", images: [{ id: "done", status: "success", content: "completed" }, { id: "pending", status: "loading", content: "" }] } } as CanvasNodeData);
    store.updateProject(id, { nodes: [node("source"), ...resultIds.map(result)] });
    store.updateProject(otherId, { nodes: [node("source"), result("mask")] });
    const generation = useCanvasGenerationStore.getState();
    const tasks = resultIds.map((resultId) => {
        const task = generation.start(id, "source", resultId);
        task.target(resultId);
        return task;
    });
    const other = generation.start(otherId, "source", "mask");
    other.target("mask");
    try {
        generation.stop(id, "source");
        for (const task of tasks) {
            expect(task.controller.signal.aborted).toBe(true);
            expect(useCanvasGenerationStore.getState().tasks).not.toContain(task);
        }
        for (const item of store.openProject(id)!.nodes.slice(1)) {
            expect(item.metadata?.images?.[0]).toMatchObject({ status: "success", content: "completed" });
            expect(item.metadata?.images?.[1].status).toBe("error");
        }
        expect(other.controller.signal.aborted).toBe(false);
        expect(useCanvasGenerationStore.getState().tasks).toContain(other);
    } finally { await Promise.all([...tasks, other].map((task) => task.finish())); }
});

test("deleting one result only cancels its task when several tasks share a source", async () => {
    const store = useCanvasStore.getState();
    const id = store.createProject("shared-source-deletion");
    store.updateProject(id, { nodes: [node("source"), node("first", "loading"), node("second", "loading")] });
    const generation = useCanvasGenerationStore.getState();
    const first = generation.start(id, "source");
    first.target("first");
    const second = generation.start(id, "source", "second");
    second.target("second");
    try {
        store.updateProject(id, (project) => ({ nodes: project.nodes.filter((item) => item.id !== "first") }));
        expect(first.controller.signal.aborted).toBe(true);
        expect(second.controller.signal.aborted).toBe(false);
        expect(useCanvasGenerationStore.getState().tasks).toContain(second);
        store.updateProject(id, (project) => ({ nodes: project.nodes.filter((item) => item.id !== "source") }));
        expect(second.controller.signal.aborted).toBe(false);
        second.setNodes((nodes) => nodes.map((item) => ({ ...item, title: "completed" })));
        expect(store.openProject(id)?.nodes[0].title).toBe("completed");
    } finally { await Promise.all([first.finish(), second.finish()]); }
});

test("deleting a result invalidates its task even if undo restores the node", async () => {
    const store = useCanvasStore.getState();
    const id = store.createProject("deleted-result");
    store.updateProject(id, { nodes: [node("source"), node("result", "loading")] });
    const task = useCanvasGenerationStore.getState().start(id, "source");
    try {
        task.target("result");
        store.updateProject(id, (project) => ({ nodes: project.nodes.filter((item) => item.id !== "result") }));
        expect(task.controller.signal.aborted).toBe(true);
        store.updateProject(id, (project) => ({ nodes: [...project.nodes, node("result")] }));
        const restored = store.openProject(id);
        task.setNodes((nodes) => nodes.map((item) => ({ ...item, title: "late" })));
        expect(store.openProject(id)).toBe(restored);
    } finally { await task.finish(); }
});

test("deleting only the source preserves a task with an existing result", async () => {
    const store = useCanvasStore.getState();
    const id = store.createProject("deleted-source");
    store.updateProject(id, { nodes: [node("source"), node("result", "loading")] });
    const task = useCanvasGenerationStore.getState().start(id, "source");
    try {
        task.target("result");
        store.updateProject(id, { nodes: [node("result", "loading")] });
        expect(task.controller.signal.aborted).toBe(false);
        task.setNodes((nodes) => nodes.map((item) => ({ ...item, title: "finished" })));
        expect(store.openProject(id)?.nodes[0].title).toBe("finished");
        task.setConnections((connections) => [...connections, { id: "late-edge", fromNodeId: "source", toNodeId: "result" }]);
        expect(store.openProject(id)?.connections).toHaveLength(0);
    } finally { await task.finish(); }
});

test("clearing or deleting a project prevents prepared nodes from reappearing", async () => {
    const store = useCanvasStore.getState();
    for (const deletion of ["clear", "project"]) {
        const id = store.createProject(deletion);
        store.updateProject(id, { nodes: [node("source")] });
        const task = useCanvasGenerationStore.getState().start(id, "source");
        try {
            if (deletion === "clear") store.updateProject(id, { nodes: [] });
            else store.deleteProjects([id]);
            task.target("result");
            task.setNodes((nodes) => [...nodes, node("result")]);
            expect(task.controller.signal.aborted).toBe(true);
            expect(store.openProject(id)?.nodes || []).toHaveLength(0);
        } finally { await task.finish(); }
    }
});

test("replacement ignores late writes and cleanup from its predecessor", async () => {
    const store = useCanvasStore.getState();
    const id = store.createProject("replacement");
    store.updateProject(id, { nodes: [node("result", "loading")] });
    const generation = useCanvasGenerationStore.getState();
    const old = generation.start(id, "result");
    const current = generation.start(id, "result");
    try {
        expect(old.controller.signal.aborted).toBe(true);
        current.setNodes((nodes) => nodes.map((item) => ({ ...item, title: "new" })));
        old.setNodes((nodes) => nodes.map((item) => ({ ...item, title: "old" })));
        await old.finish();
        expect(useCanvasGenerationStore.getState().tasks).toContain(current);
        expect(store.openProject(id)?.nodes[0].title).toBe("new");
    } finally { await current.finish(); }
});

test("stopping a video preserves its remote ID and requires manual resume", async () => {
    const store = useCanvasStore.getState();
    const id = store.createProject("paused-video");
    store.updateProject(id, { nodes: [{ ...node("video", "loading"), type: "video", metadata: { status: "loading", videoTaskId: "remote" } } as CanvasNodeData] });
    const generation = useCanvasGenerationStore.getState();
    const task = generation.resume(id, "video", false)!;
    generation.stop(id, "video");
    await task.finish();
    expect(store.openProject(id)?.nodes[0].metadata?.videoTaskId).toBe("remote");
    expect(generation.resume(id, "video", false)).toBeNull();
    const resumed = generation.resume(id, "video", true)!;
    try {
        expect(resumed).not.toBeNull();
        expect(store.openProject(id)?.nodes[0].metadata?.videoTaskPaused).toBe(false);
        expect(generation.resume(id, "video", false)).toBeNull();
    } finally { await resumed.finish(); }
});

test("cancelled tasks reject files that arrive after cancellation", async () => {
    const store = useCanvasStore.getState();
    const id = store.createProject("late-file");
    store.updateProject(id, { nodes: [node("result", "loading")] });
    const generation = useCanvasGenerationStore.getState();
    const task = generation.start(id, "result");
    let finish!: (file: { url: string }) => void;
    const pending = task.keep(new Promise<{ url: string }>((resolve) => { finish = resolve; }));
    generation.stop(id, "result");
    finish({ url: "https://example.test/late.png" });
    await expect(pending).rejects.toThrow("Aborted");
    await task.finish();
});
