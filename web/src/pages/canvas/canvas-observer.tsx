import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Eye, Focus, Radio } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { CanvasNode } from "@/components/canvas/canvas-node";
import { ConnectionPath } from "@/components/canvas/canvas-connections";
import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { canvasThemes } from "@/lib/canvas-theme";
import { focusViewportForNode } from "@/lib/canvas/canvas-node-geometry";
import { ensurePluginsLoaded } from "@/lib/canvas/plugin-loader";
import { useNodeRegistryVersion } from "@/lib/canvas/node-registry";
import { createCanvasObserverHost } from "@/pages/canvas/canvas-observer-host";
import { useCanvasObserverStore } from "@/stores/canvas/use-canvas-observer-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ViewportTransform } from "@/types/canvas";

const ignore = () => {};

export function CanvasObserver({ projectId, onEdit }: { projectId: string; onEdit: () => void }) {
    const navigate = useNavigate();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const project = useCanvasStore((state) => state.projects.find((item) => item.id === projectId));
    const snapshot = useCanvasObserverStore((state) => state.projectId === projectId ? state.snapshot : null);
    const active = useCanvasObserverStore((state) => state.controls.some((item) => item.projectId === projectId));
    const connected = useCanvasObserverStore((state) => state.connected);
    const error = useCanvasObserverStore((state) => state.error);
    const watchProject = useCanvasObserverStore((state) => state.watchProject);
    const registryVersion = useNodeRegistryVersion((state) => state.version);
    const containerRef = useRef<HTMLDivElement>(null);
    const [localViewport, setLocalViewport] = useState<ViewportTransform | null>(null);
    const nodes = snapshot?.nodes || project?.nodes || [];
    const connections = snapshot?.connections || project?.connections || [];
    const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const pluginHost = useMemo(() => createCanvasObserverHost(nodes, connections), [nodes, connections]);
    const viewport = localViewport || snapshot?.viewport || project?.viewport || { x: 0, y: 0, k: 1 };

    useEffect(() => {
        void ensurePluginsLoaded();
    }, []);

    useEffect(() => {
        watchProject(projectId);
        return () => { if (useCanvasObserverStore.getState().projectId === projectId) watchProject(""); };
    }, [projectId, watchProject]);

    const fitView = () => {
        const container = containerRef.current;
        if (!container || !nodes.length) return;
        const x = Math.min(...nodes.map((node) => node.position.x));
        const y = Math.min(...nodes.map((node) => node.position.y));
        const width = Math.max(...nodes.map((node) => node.position.x + node.width)) - x;
        const height = Math.max(...nodes.map((node) => node.position.y + node.height)) - y;
        setLocalViewport(focusViewportForNode({ position: { x, y }, width, height }, { width: container.clientWidth, height: container.clientHeight }));
    };
    const buttonClass = "inline-flex shrink-0 items-center gap-1.5 rounded px-2 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/10";

    return (
        <main className="flex h-full min-h-0 flex-col" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <button type="button" className={buttonClass} onClick={() => navigate("/canvas")} aria-label="返回画布库"><ArrowLeft className="size-4" /></button>
                <span className="min-w-0 truncate text-sm font-medium">{snapshot?.title || project?.title || "画布"}</span>
                <span role="status" className="inline-flex items-center gap-1.5 text-xs" style={{ color: theme.node.muted }}>
                    <Eye className="size-3.5" />
                    {!connected ? "连接已断开，显示最后画面" : active ? "正在被 Agent 调用 · 只读查看" : "Agent 已停止调用 · 只读查看"}
                </span>
                <div className="ml-auto flex items-center gap-1" style={{ color: theme.node.muted }}>
                    <button type="button" className={buttonClass} aria-pressed={!localViewport} onClick={() => setLocalViewport(null)}><Radio className="size-3.5" />跟随 Agent 视图</button>
                    <button type="button" className={buttonClass} onClick={fitView}><Focus className="size-3.5" />居中查看</button>
                    {!active && connected ? <button type="button" className={buttonClass} onClick={onEdit}>进入编辑</button> : null}
                </div>
            </header>
            {error ? <p role="status" className="px-5 pb-2 text-xs" style={{ color: theme.node.muted }}>{error}，当前显示最后收到的画面。</p> : null}
            <section className="relative min-h-0 flex-1" aria-label="画布只读实时视图">
                <InfiniteCanvas containerRef={containerRef} viewport={viewport} tool="pan" backgroundMode={project?.backgroundMode} onViewportChange={setLocalViewport} onContextMenu={(event) => event.preventDefault()}>
                    <div inert className="pointer-events-none">
                        <svg className="absolute left-0 top-0 h-[10000px] w-[10000px] overflow-visible" style={{ pointerEvents: "none" }}>
                            {connections.map((connection) => {
                                const from = nodeMap.get(connection.fromNodeId), to = nodeMap.get(connection.toNodeId);
                                return from && to ? <ConnectionPath key={connection.id} connection={connection} from={from} to={to} active={false} onSelect={ignore} /> : null;
                            })}
                        </svg>
                        {nodes.map((node) => <CanvasNode key={node.id} data={node} pluginHost={pluginHost} registryVersion={registryVersion} scale={viewport.k} isSelected={snapshot?.selectedNodeIds.includes(node.id) || false} isRelated={false} isFocusRelated={false} isConnectionTarget={false} isConnecting={false} showPanel={false} showImageInfo={project?.showImageInfo || false} onMouseDown={ignore} onHoverStart={ignore} onHoverEnd={ignore} onConnectStart={ignore} onResizeStart={ignore} onResize={ignore} onResizeEnd={ignore} onContentChange={ignore} onTitleChange={ignore} onContextMenu={ignore} />)}
                    </div>
                </InfiniteCanvas>
                <span className="pointer-events-none absolute bottom-4 right-5 text-xs" style={{ color: theme.node.muted }}>{nodes.length} 个节点 · {connections.length} 条连线 · {Math.round(viewport.k * 100)}%</span>
            </section>
        </main>
    );
}
