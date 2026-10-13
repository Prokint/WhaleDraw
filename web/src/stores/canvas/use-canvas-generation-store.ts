import { create } from "zustand";
import i18n from "@/i18n";
import { createDshSharedStore } from "@/lib/dsh-shared-store";
import { deleteStoredImages } from "@/services/image-storage";
import { collectMediaStorageKeys, deleteStoredMedia } from "@/services/file-storage";
import { useCanvasStore, type CanvasProject } from "./use-canvas-store";

type Action<T> = T | ((value: T) => T);
type GeneratedFile = { url: string; storageKey?: string };
export type CanvasGenerationTask = {
    projectId: string;
    originNodeId: string;
    runningNodeId: string;
    targetNodeId: string;
    controller: AbortController;
    target: (nodeId: string) => void;
    setNodes: (action: Action<CanvasProject["nodes"]>) => void;
    setConnections: (action: Action<CanvasProject["connections"]>) => void;
    keep: <T extends GeneratedFile>(file: Promise<T>) => Promise<T>;
    finish: () => Promise<void>;
};

type GenerationStore = {
    tasks: CanvasGenerationTask[];
    start: (projectId: string, originNodeId: string, runningNodeId?: string, writing?: { current: boolean }) => CanvasGenerationTask;
    resume: (projectId: string, nodeId: string, manual: boolean, writing?: { current: boolean }) => CanvasGenerationTask | null;
    stop: (projectId: string, nodeId: string) => void;
};

async function discard(file: GeneratedFile) {
    if (!file.storageKey) return;
    await (file.storageKey.startsWith("image:") ? deleteStoredImages([file.storageKey]) : deleteStoredMedia([file.storageKey]));
    URL.revokeObjectURL(file.url);
}

export const useCanvasGenerationStore = createDshSharedStore("canvas-generation", () => {
    const stop = (task: CanvasGenerationTask) => {
        task.controller.abort();
        store.setState((state) => ({ tasks: state.tasks.filter((item) => item !== task) }));
        useCanvasStore.getState().updateProject(task.projectId, (project) => ({
            nodes: project.nodes.map((node) => [task.originNodeId, task.targetNodeId].includes(node.id) && node.metadata?.status === "loading" ? {
                ...node,
                metadata: {
                    ...node.metadata, status: node.metadata.content ? "success" as const : "idle" as const, errorDetails: undefined,
                    ...(node.metadata.videoTaskId ? { videoTaskPaused: true } : {}),
                    images: node.metadata.images?.map((image) => image.status === "loading" ? { ...image, status: "error" as const, errorDetails: i18n.t("common.requestCanceled") } : image),
                    texts: node.metadata.texts?.map((text) => text.status === "loading" ? { ...text, status: "error" as const, errorDetails: i18n.t("common.requestCanceled") } : text),
                },
            } : node),
        }));
    };
    const store = create<GenerationStore>()((set, get) => {
        return {
            tasks: [],
            stop: (projectId, nodeId) => {
                get().tasks.filter((task) => task.projectId === projectId && [task.originNodeId, task.runningNodeId, task.targetNodeId].includes(nodeId)).forEach(stop);
            },
            resume: (projectId, nodeId, manual, writing) => {
                const node = useCanvasStore.getState().openProject(projectId)?.nodes.find((item) => item.id === nodeId);
                if (!node?.metadata?.videoTaskId || node.metadata.content || (!manual && node.metadata.videoTaskPaused) || get().tasks.some((task) => task.projectId === projectId && task.targetNodeId === nodeId)) return null;
                const task = get().start(projectId, nodeId, nodeId, writing);
                task.setNodes((nodes) => nodes.map((item) => item.id === nodeId ? { ...item, metadata: { ...item.metadata, status: "loading" as const, videoTaskPaused: false, errorDetails: undefined } } : item));
                return task;
            },
            start: (projectId, originNodeId, runningNodeId = originNodeId, writing) => {
                get().tasks.filter((task) => task.projectId === projectId && (task.runningNodeId === runningNodeId || task.targetNodeId === runningNodeId)).forEach(stop);
                const pendingFiles = new Set<GeneratedFile>();
                const active = () => get().tasks.includes(task) && !task.controller.signal.aborted && Boolean(useCanvasStore.getState().openProject(projectId));
                const commit = (patch: (project: CanvasProject) => Partial<Pick<CanvasProject, "nodes" | "connections">>) => {
                    if (!active()) return;
                    if (writing) writing.current = true;
                    try { useCanvasStore.getState().updateProject(projectId, patch); }
                    finally { if (writing) writing.current = false; }
                    if (pendingFiles.size) {
                        const used = collectMediaStorageKeys(useCanvasStore.getState().openProject(projectId)?.nodes);
                        for (const file of pendingFiles) if (file.storageKey && used.has(file.storageKey)) pendingFiles.delete(file);
                    }
                };
                const task: CanvasGenerationTask = {
                    projectId, originNodeId, runningNodeId, targetNodeId: originNodeId, controller: new AbortController(),
                    target: (nodeId) => {
                        if (!active()) return;
                        get().tasks.filter((item) => item !== task && item.projectId === projectId && item.targetNodeId === nodeId).forEach(stop);
                        task.targetNodeId = nodeId;
                        set((state) => ({ tasks: [...state.tasks] }));
                    },
                    setNodes: (action) => commit((project) => ({ nodes: typeof action === "function" ? action(project.nodes) : action })),
                    setConnections: (action) => commit((project) => ({ connections: (typeof action === "function" ? action(project.connections) : action).filter((edge) => project.nodes.some((node) => node.id === edge.fromNodeId) && project.nodes.some((node) => node.id === edge.toNodeId)) })),
                    keep: async (pending) => {
                        const file = await pending;
                        if (!active()) { await discard(file); throw new DOMException("Aborted", "AbortError"); }
                        pendingFiles.add(file);
                        return file;
                    },
                    finish: async () => {
                        set((state) => ({ tasks: state.tasks.filter((item) => item !== task) }));
                        await Promise.all([...pendingFiles].map(discard));
                        pendingFiles.clear();
                    },
                };
                set((state) => ({ tasks: [...state.tasks, task] }));
                if (!useCanvasStore.getState().openProject(projectId)?.nodes.some((node) => node.id === originNodeId)) task.controller.abort();
                return task;
            },
        };
    });
    useCanvasStore.subscribe((state, previous) => {
        for (const task of store.getState().tasks) {
            const project = state.projects.find((item) => item.id === task.projectId);
            const before = previous.projects.find((item) => item.id === task.projectId);
            if (!project || (before?.nodes.some((node) => node.id === task.targetNodeId) && !project.nodes.some((node) => node.id === task.targetNodeId))) {
                stop(task);
            }
        }
    });
    return store;
});
