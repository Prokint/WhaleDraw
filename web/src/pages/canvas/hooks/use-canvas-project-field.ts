import { useCallback, useRef, type MutableRefObject, type SetStateAction } from "react";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";

type ProjectData = Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo">;
const defaults: ProjectData = { nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false };

// Views edit current project data; generation tasks write to their original project directly.
export function useCanvasProjectField<K extends keyof ProjectData>(id: string, key: K, writing: MutableRefObject<boolean>) {
    const projectId = useRef(id);
    projectId.current = id;
    const value = useCanvasStore((state) => state.projects.find((project) => project.id === id)?.[key] ?? defaults[key]);
    const setShared = useCallback((action: SetStateAction<ProjectData[K]>) => {
        writing.current = true;
        try {
            useCanvasStore.getState().updateProject(projectId.current, (project) => ({ [key]: typeof action === "function" ? (action as (value: ProjectData[K]) => ProjectData[K])(project[key]) : action }));
        } finally { writing.current = false; }
    }, [key, writing]);
    return [value, setShared] as const;
}
