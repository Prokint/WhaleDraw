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
    expect((await first).initialized).toBe(true);
    expect((await second).initialized).toBe(false);
    store.updateProject(id, { nodes: [node("generating", "loading")] });
    const third = await store.restoreProject(id, restore, true);
    expect(restorations).toBe(1);
    expect(third.project?.nodes[0].metadata?.status).toBe("loading");
});

test("project changes stay isolated from other canvases", () => {
    const store = useCanvasStore.getState();
    const a = store.createProject("A");
    const b = store.createProject("B");
    store.updateProject(a, (project) => ({ nodes: [...project.nodes, node("only-A")] }));
    expect(store.openProject(b)?.nodes).toEqual([]);
});
