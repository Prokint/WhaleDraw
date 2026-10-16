import { create } from "zustand";
import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";

export type CanvasAgentControl = { projectId: string; title: string; clientId: string };

type CanvasObserverStore = {
    clientId: string;
    connected: boolean;
    controls: CanvasAgentControl[];
    projectId: string;
    snapshot: CanvasAgentSnapshot | null;
    error: string;
    watchProject: (projectId: string) => void;
};

// 观察快照只保存在内存中，不能进入画布持久化或成为工具控制上下文。
export const useCanvasObserverStore = create<CanvasObserverStore>((set) => ({
    clientId: "", connected: false, controls: [], projectId: "", snapshot: null, error: "",
    watchProject: (projectId) => set({ projectId, snapshot: null, error: "" }),
}));
