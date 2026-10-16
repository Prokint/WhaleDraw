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
    projects: CanvasProject[];
    deletedProjects: CanvasDeletedProject[];
    /** 上次写入本地存储失败的原因，不持久化；写入恢复后置回 null。 */
    storageError: string | null;
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
/** 页面隐藏/关闭时同步落下的最后一次未保存改动，只在下次启动读一次。 */
const CANVAS_JOURNAL_KEY = "infinite-canvas:canvas_store:journal";
/** 早期兜底记录用的基线键，只用于清理历史遗留。 */
const CANVAS_JOURNAL_BASE_KEY = "infinite-canvas:canvas_store:journal-base";
type PersistedCanvasState = Pick<CanvasStore, "projects" | "deletedProjects">;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;
let pendingPersistValue: StorageValue<CanvasStore> | null = null;
let persistWrite = Promise.resolve();
/** 本页面最后一次读写的画布库原文，用来判断其他页面是否改过磁盘上的内容。 */
let knownRaw: string | null = null;
/** 本页面打开时的画布库原文，兜底记录按它算差异，避免写入成功后差异被抹掉。 */
let loadedRaw: string | null = null;
/** 兜底记录代次，用来判断一次写入完成时该记录是否已经被更晚的写入取代。 */
let journalEpoch = 0;
/** 上次写入失败后置位：避免每次页面隐藏都把整份画布库重写一遍，只在确有新改动或再次主动保存时重试。 */
let persistBlocked = false;

export function flushCanvasStorage() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    const value = pendingPersistValue;
    pendingPersistValue = null;
    if (value) {
        const raw = JSON.stringify(value);
        // 这次写入期间若又写下了更新的兜底记录，就不能在完成时把它清掉。
        const epoch = journalEpoch;
        persistBlocked = false;
        persistWrite = persistWrite
            .then(() => localForageStorage.setItem(CANVAS_STORE_KEY, raw))
            .then(() => {
                knownRaw = raw;
                if (epoch === journalEpoch) clearCanvasJournal();
                useCanvasStore.setState({ storageError: null });
            })
            .catch((error: unknown) => {
                // 不丢掉这次的值，放回待写入状态，等下一次改动或页面隐藏时再写。
                if (!pendingPersistValue) pendingPersistValue = value;
                persistBlocked = true;
                useCanvasStore.setState({ storageError: error instanceof Error ? error.message : String(error) });
            });
    }
    return persistWrite;
}

function clearCanvasJournal() {
    try {
        window.localStorage.removeItem(CANVAS_JOURNAL_KEY);
        window.localStorage.removeItem(CANVAS_JOURNAL_BASE_KEY);
    } catch {
        // 兜底记录清理失败不影响正常保存
    }
}

/**
 * 页面隐藏或关闭时调用。IndexedDB 是异步的，来不及在关闭前写完，所以把本页还没落盘的改动同步写进
 * localStorage，下次启动时并回磁盘状态。只记录真正改过的项目，避免整份画布库超出 localStorage 配额。
 */
export function journalCanvasStorage() {
    const value = pendingPersistValue;
    if (!value) return;
    try {
        const changed = changedProjects(value);
        if (!changed.projects.length && !changed.deletedProjects.length) {
            return;
        }
        window.localStorage.setItem(CANVAS_JOURNAL_KEY, JSON.stringify(changed));
        journalEpoch += 1;
    } catch {
        // 兜底记录超出 localStorage 配额时直接放弃，不阻塞关闭
    }
    // 顺手推一次真正的落盘；写成功时这次兜底记录会被清掉。上次写入失败时不再重复全量重试，等下一次改动。
    if (!persistBlocked) void flushCanvasStorage();
}

/** 本页打开时的画布库状态，没有可比对的基线时返回 null。 */
function loadedState() {
    if (!loadedRaw) return null;
    return (JSON.parse(loadedRaw) as StorageValue<CanvasStore>).state as PersistedCanvasState;
}

/** 提取本页相对打开时改过、且还没写进兜底记录的项目与删除标记。 */
function changedProjects(value: StorageValue<CanvasStore>) {
    const state = value.state as PersistedCanvasState;
    const previous = loadedState();
    const before = new Map<string, string>();
    const previousDeletions = new Set<string>();
    for (const project of previous?.projects || []) before.set(project.id, JSON.stringify(project));
    for (const item of previous?.deletedProjects || []) previousDeletions.add(item.id);
    const projects = state.projects.filter((project) => !before.has(project.id) || before.get(project.id) !== JSON.stringify(project));
    const deletedProjects = (state.deletedProjects || []).filter((item) => !previousDeletions.has(item.id));
    return { projects, deletedProjects };
}

/** 把兜底记录并回磁盘状态；磁盘上其它项目的改动仍然保留。没有记录时返回 null。 */
function mergeCanvasJournal(diskValue: StorageValue<CanvasStore> | null) {
    let raw: string | null = null;
    try {
        raw = window.localStorage.getItem(CANVAS_JOURNAL_KEY);
        window.localStorage.removeItem(CANVAS_JOURNAL_KEY);
        window.localStorage.removeItem(CANVAS_JOURNAL_BASE_KEY);
    } catch {
        return null;
    }
    if (!raw) return null;
    let journal: PersistedCanvasState;
    try {
        journal = JSON.parse(raw) as PersistedCanvasState;
    } catch {
        return null;
    }
    if (!diskValue) {
        // 磁盘上还没有画布库：兜底记录就是全部内容。
        return { state: journal, version: 0 } as StorageValue<CanvasStore>;
    }
    const disk = diskValue.state as PersistedCanvasState;
    const changed = new Map(journal.projects.map((project) => [project.id, project]));
    const deletedIds = new Set(journal.deletedProjects.map((item) => item.id));
    const projects = disk.projects.filter((project) => !deletedIds.has(project.id) && !changed.has(project.id));
    return {
        ...diskValue,
        state: {
            projects: [...changed.values(), ...projects],
            deletedProjects: [...disk.deletedProjects.filter((item) => !changed.has(item.id) && !deletedIds.has(item.id)), ...journal.deletedProjects],
        } as StorageValue<CanvasStore>["state"],
    };
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
    const previous = knownRaw ? (JSON.parse(knownRaw) as StorageValue<CanvasStore>).state : { projects: [], deletedProjects: [] };
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
        useCanvasStore.setState({ hydrated: true });
    }
    await flushCanvasStorage();
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        knownRaw = value;
        // 兜底记录按「打开时的磁盘状态」算差异，所以重载时基线也要跟着更新。
        loadedRaw = value;
        const parsed = value ? (JSON.parse(value) as StorageValue<CanvasStore>) : null;
        const merged = mergeCanvasJournal(parsed);
        const result = merged || parsed;
        if (result) queuedPersistState = result.state as PersistedCanvasState;
        // 并回的状态还没落盘，交给 onRehydrateStorage 里的 flush 写回。
        if (merged) pendingPersistValue = merged;
        return result;
    },
    setItem: (_name, value) => {
        const nextState = value.state as PersistedCanvasState;
        if (queuedPersistState && queuedPersistState.projects === nextState.projects && queuedPersistState.deletedProjects === nextState.deletedProjects) return;
        queuedPersistState = nextState;
        pendingPersistValue = value;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => void flushCanvasStorage(), 400);
    },
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            deletedProjects: [],
            storageError: null,
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
            onRehydrateStorage: () => () => {
                useCanvasStore.setState({ hydrated: true });
                // getItem 并回的兜底快照需要立刻落盘，否则它只活在内存里。
                void flushCanvasStorage();
            },
        },
    ),
);
