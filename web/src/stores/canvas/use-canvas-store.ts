import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { localForageStorage } from "@/lib/localforage-storage";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};

export type CanvasDeletedProject = {
    id: string;
    deletedAt: string;
};

type CanvasStore = {
    hydrated: boolean;
    storageError: string | null;
    projects: CanvasProject[];
    deletedProjects: CanvasDeletedProject[];
    createProject: (title?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[], deletedProjects?: CanvasDeletedProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
type PersistedCanvasState = Pick<CanvasStore, "projects" | "deletedProjects">;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;
let pendingPersistValue: StorageValue<CanvasStore> | null = null;
let persistWrite = Promise.resolve();
let lastWrite = persistWrite;
let saveSequence = 0;
let storageReady = false;
/** 本页面最后一次读写的画布库原文，用来判断其他页面是否改过磁盘上的内容。 */
let knownRaw: string | null = null;
let savedLocalState: PersistedCanvasState = { projects: [], deletedProjects: [] };

export function flushCanvasStorage() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    const value = pendingPersistValue;
    pendingPersistValue = null;
    if (value) {
        const sequence = ++saveSequence;
        const save = async () => {
            if (!storageReady) throw new Error("画布库尚未成功读取，已停止写入以保护原数据");
            const current = await localForageStorage.getItem(CANVAS_STORE_KEY);
            const disk = current ? (JSON.parse(current) as StorageValue<CanvasStore>).state : { projects: [], deletedProjects: [] };
            const raw = JSON.stringify({ ...value, state: {
                projects: mergePendingChanges(savedLocalState.projects, value.state.projects, disk.projects),
                deletedProjects: mergePendingChanges(savedLocalState.deletedProjects, value.state.deletedProjects, disk.deletedProjects),
            } });
            await localForageStorage.setItem(CANVAS_STORE_KEY, raw);
            savedLocalState = value.state;
            knownRaw = raw;
            useCanvasStore.setState({ storageError: null });
        };
        // 只将磁盘读改写放进跨窗口锁，画布操作仍可并行执行。
        lastWrite = persistWrite.then(() => globalThis.navigator?.locks ? navigator.locks.request(CANVAS_STORE_KEY, save) : save()).catch((error: unknown) => {
            // 后续已排队的新快照包含本次改动，不能再把失败的旧快照放回去覆盖它。
            if (sequence === saveSequence && !pendingPersistValue) pendingPersistValue = value;
            useCanvasStore.setState({ storageError: error instanceof Error ? error.message : String(error) });
            throw error;
        });
        persistWrite = lastWrite.catch(() => {});
    }
    return lastWrite;
}

/** 磁盘上的画布库是否已被其他页面改写。 */
export async function canvasStorageChanged() {
    return (await localForageStorage.getItem(CANVAS_STORE_KEY)) !== knownRaw;
}

function mergePendingChanges<T extends { id: string }>(previous: T[], pending: T[], disk: T[]) {
    const before = new Map(previous.map((item) => [item.id, JSON.stringify(item)]));
    const localIds = new Set(pending.map((item) => item.id));
    const changed = pending.filter((item) => JSON.stringify(item) !== before.get(item.id));
    const changedIds = new Set(changed.map((item) => item.id));
    return [...changed, ...disk.filter((item) => !changedIds.has(item.id) && (!before.has(item.id) || localIds.has(item.id)))];
}

/** 重读磁盘时只保留本页尚未保存的变更，避免重载丢掉新项目或回写旧副本。 */
export async function reloadCanvasStorage() {
    await persistWrite;
    const pending = pendingPersistValue;
    const previous = savedLocalState;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    pendingPersistValue = null;
    useCanvasStore.setState({ hydrated: false });
    try {
        await useCanvasStore.persist.rehydrate();
        if (!useCanvasStore.persist.hasHydrated()) throw new Error("无法重新读取画布库，请重试");
        if (pending) {
            const disk = useCanvasStore.getState();
            useCanvasStore.setState({
                projects: mergePendingChanges(previous.projects, pending.state.projects, disk.projects),
                deletedProjects: mergePendingChanges(previous.deletedProjects, pending.state.deletedProjects, disk.deletedProjects),
            });
        }
    } catch (error) {
        pendingPersistValue = pending;
        throw error;
    } finally {
        useCanvasStore.setState({ hydrated: storageReady });
    }
    await flushCanvasStorage();
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        storageReady = false;
        const value = await localForageStorage.getItem(name);
        const parsed = value ? JSON.parse(value) as StorageValue<CanvasStore> : null;
        knownRaw = value;
        savedLocalState = parsed?.state ?? { projects: [], deletedProjects: [] };
        queuedPersistState = savedLocalState;
        storageReady = true;
        return parsed;
    },
    setItem: (_name, value) => {
        if (!storageReady) return;
        const nextState = value.state as PersistedCanvasState;
        if (queuedPersistState && queuedPersistState.projects === nextState.projects && queuedPersistState.deletedProjects === nextState.deletedProjects) return;
        queuedPersistState = nextState;
        pendingPersistValue = value;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => void flushCanvasStorage().catch(() => {}), 400);
    },
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            storageError: null,
            projects: [],
            deletedProjects: [],
            createProject: (title = i18n.t("canvas.project.untitled")) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return id;
            },
            importProject: (source) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    title: source.title || i18n.t("canvas.project.imported"),
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            openProject: (id) => {
                return get().projects.find((item) => item.id === id) || null;
            },
            renameProject: (id, title) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project)),
                })),
            deleteProjects: (ids) =>
                set((state) => {
                    const now = new Date().toISOString();
                    const removing = new Set(ids);
                    const projects = state.projects.filter((project) => !removing.has(project.id));
                    const deletedProjects = [...state.deletedProjects.filter((item) => !removing.has(item.id)), ...ids.map((id) => ({ id, deletedAt: now }))];
                    return { projects, deletedProjects };
                }),
            replaceProjects: (projects, deletedProjects = []) => set({ projects, deletedProjects }),
            updateProject: (id, patch) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project)),
                })),
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                    deletedProjects: state.deletedProjects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => (_state, error) => {
                if (error) {
                    storageReady = false;
                    useCanvasStore.setState({ hydrated: false, storageError: error instanceof Error ? error.message : String(error) });
                    return;
                }
                useCanvasStore.setState({ hydrated: true, storageError: null });
            },
        },
    ),
);
