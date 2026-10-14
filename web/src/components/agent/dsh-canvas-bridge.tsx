import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { runSiteTool, isSiteTool } from "@/lib/agent/agent-site-tools";
import { randomId } from "@/lib/utils";
import i18n from "@/i18n";
import { activateAgentClient, postState, postToolResult } from "@/services/api/canvas-agent";
import { useAgentStore, type AgentPendingToolCall } from "@/stores/use-agent-store";
import { canvasStorageChanged, flushCanvasStorage, reloadCanvasStorage, useCanvasStore } from "@/stores/canvas/use-canvas-store";

type BridgeConfig = { url: string; token: string };

export function DshCanvasBridge() {
    const navigate = useNavigate();
    const { pathname } = useLocation();
    const route = useRef(pathname);
    const routeChanged = useRef<() => void>(() => {});
    route.current = pathname;
    const setAgentState = useAgentStore((state) => state.setAgentState);

    useEffect(() => { routeChanged.current(); }, [pathname]);

    useEffect(() => {
        setAgentState({ enabled: true, connected: false, connectError: "", activity: "连接中" });
        const clientId = randomId();
        let source: EventSource | undefined;
        let disposed = false;
        let stateTimer: ReturnType<typeof setTimeout> | undefined;
        let config: BridgeConfig | undefined;
        const inspections = new Map<string, string>();
        let prepareRequestId = "";
        let lastRequestId = "";
        let prepareMode = "";
        let preparedProjectId = "";
        let existingProjectIds = new Set<string>();
        let selectionPrepared = false;
        let selectionStarted = false;
        let reportingReady = false;
        let choosingProject = false;
        let reloading = false;
        const reportPrepare = (result: { clientId?: string; projectId?: string; error?: string }) => {
            if (!prepareRequestId || disposed) return;
            window.parent.postMessage({ type: "dsh-infinite-canvas:prepared", requestId: prepareRequestId, ...result }, window.location.origin);
            prepareRequestId = "";
        };
        const completePrepare = async () => {
            const snapshot = useAgentStore.getState().canvasContext?.snapshot;
            const workbench = prepareMode === "workbench";
            const pageReady = workbench ? route.current === "/image" && !snapshot : snapshot && snapshot.projectId === preparedProjectId && route.current === `/canvas/${preparedProjectId}`;
            if (!prepareRequestId || !config || !useAgentStore.getState().connected || !pageReady || reportingReady || reloading) return;
            reportingReady = true;
            const requestId = prepareRequestId;
            const posted = await (workbench ? Promise.resolve() : flushCanvasStorage()).then(() => postState(config!.url, config!.token, clientId, workbench ? null : snapshot!)).catch(() => false);
            reportingReady = false;
            if (requestId !== prepareRequestId) { void completePrepare(); return; }
            const current = useAgentStore.getState();
            const ready = posted && current.connected && (workbench ? route.current === "/image" && !current.canvasContext : current.canvasContext?.snapshot.projectId === preparedProjectId && route.current === `/canvas/${preparedProjectId}`);
            reportPrepare(ready ? { clientId, ...(!workbench ? { projectId: preparedProjectId } : {}) } : { error: "页面状态同步失败或连接已断开" });
        };
        const reportInspections = () => {
            const store = useCanvasStore.getState();
            if (!store.hydrated) return;
            const id = /^\/canvas\/([^/]+)$/.exec(route.current)?.[1];
            const project = store.projects.find((project) => project.id === id);
            const snapshot = useAgentStore.getState().canvasContext?.snapshot;
            if (project && snapshot?.projectId !== id) return;
            for (const [requestId, defaultProjectId] of inspections) {
                window.parent.postMessage({ type: "dsh-infinite-canvas:inspected", requestId,
                    mode: project ? "canvas" : route.current === "/image" ? "workbench" : "none",
                    projectId: project?.id, title: snapshot?.projectId === id ? snapshot.title : project?.title,
                    defaultTitle: store.projects.find((project) => project.id === defaultProjectId)?.title,
                }, window.location.origin);
                inspections.delete(requestId);
            }
        };
        const prepareProject = () => {
            reportInspections();
            if (!prepareRequestId || choosingProject || reloading) return;
            const store = useCanvasStore.getState();
            if (!store.hydrated) return;
            if (prepareMode === "workbench") { void completePrepare(); return; }
            if (prepareMode === "canvas" && !store.projects.some((project) => project.id === preparedProjectId)) {
                reportPrepare({ error: "会话关联的画布已不存在，请让 Agent 重新选择连接方式" });
                return;
            }
            if (prepareMode === "existing" && !selectionPrepared) {
                selectionPrepared = true;
                existingProjectIds = new Set(store.projects.map((project) => project.id));
                if (!existingProjectIds.size) { reportPrepare({ error: "没有已有画布，请让 Agent 重新选择「新开画布」或「不连接任何画布」" }); return; }
            }
            if (!preparedProjectId) {
                if (prepareMode === "existing") {
                    if (route.current === "/canvas") selectionStarted = true;
                    const snapshot = useAgentStore.getState().canvasContext?.snapshot;
                    if (!selectionStarted || !snapshot || !existingProjectIds.has(snapshot.projectId) || route.current !== `/canvas/${snapshot.projectId}`) return;
                    preparedProjectId = snapshot.projectId;
                } else if (prepareMode === "new") {
                    choosingProject = true;
                    preparedProjectId = store.createProject(i18n.t("canvas.defaultTitle", { count: store.projects.length + 1 }));
                    choosingProject = false;
                    navigate(`/canvas/${preparedProjectId}`);
                }
            }
            void completePrepare();
        };
        routeChanged.current = prepareProject;
        const onPrepare = (event: MessageEvent) => {
            if (event.origin !== window.location.origin || event.source !== window.parent || typeof event.data?.requestId !== "string") return;
            if (event.data.type === "dsh-infinite-canvas:inspect") {
                inspections.set(event.data.requestId, typeof event.data.defaultProjectId === "string" ? event.data.defaultProjectId : "");
                reportInspections();
                return;
            }
            if (event.data.type !== "dsh-infinite-canvas:prepare") return;
            if (event.data.requestId === lastRequestId) return;
            lastRequestId = event.data.requestId;
            prepareRequestId = event.data.requestId;
            prepareMode = event.data.mode;
            preparedProjectId = prepareMode === "canvas" && typeof event.data.projectId === "string" ? event.data.projectId : "";
            existingProjectIds = new Set();
            selectionPrepared = false;
            selectionStarted = false;
            // 后台会话的画布正文停在自己的内存副本上；其他页面改过磁盘时先重新加载，避免用旧副本覆盖对方的改动。
            if (event.data.background === true && prepareMode !== "workbench") {
                reloading = true;
                const reload = async () => {
                    if (await canvasStorageChanged().catch(() => false)) {
                        // 先放下旧上下文，确保本次连接只可能用重新加载后的画布状态完成。
                        useAgentStore.getState().setCanvasContext(null);
                        await reloadCanvasStorage().catch(() => {});
                    }
                    reloading = false;
                    prepareProject();
                };
                void reload();
            }
            const { connectError } = useAgentStore.getState();
            if (connectError) reportPrepare({ error: connectError });
            else if (prepareMode === "workbench") { navigate("/image"); prepareProject(); }
            else if (prepareMode === "existing") { navigate("/canvas?mode=choose"); prepareProject(); }
            else if (prepareMode === "canvas" && preparedProjectId) { navigate(`/canvas/${preparedProjectId}`); prepareProject(); }
            else if (prepareMode === "new") prepareProject();
            else reportPrepare({ error: "画布连接方式无效" });
        };
        window.addEventListener("message", onPrepare);
        const notifyFocus = () => window.parent.postMessage({ type: "dsh-infinite-canvas:focused" }, window.location.origin);
        window.addEventListener("pointerdown", notifyFocus);
        window.addEventListener("focus", notifyFocus);
        const unsubscribeCanvas = useCanvasStore.subscribe(prepareProject);
        const publishState = () => {
            if (config) void postState(config.url, config.token, clientId, prepareMode === "workbench" ? null : useAgentStore.getState().canvasContext?.snapshot || null);
        };
        const unsubscribe = useAgentStore.subscribe((state, previous) => {
            prepareProject();
            if (!config || !state.connected || state.canvasContext === previous.canvasContext) return;
            if (stateTimer) clearTimeout(stateTimer);
            stateTimer = setTimeout(publishState, 300);
        });
        window.parent.postMessage({ type: "dsh-infinite-canvas:bridge-mounted" }, window.location.origin);
        const runTool = async (call: AgentPendingToolCall) => {
            const bridge = config;
            if (!bridge) return;
            try {
                let result: unknown;
                if (prepareMode === "workbench" && ((call.name.startsWith("canvas_") && call.name !== "canvas_list_projects") || (call.name === "site_navigate" && /^\/(?:canvas)?(?:\/|$)/.test(call.input?.path || "/")))) {
                    throw new Error("当前会话不连接画布，请在生图工作台生成图片");
                }
                if (preparedProjectId && call.name.startsWith("canvas_") && call.name !== "canvas_list_projects" && useAgentStore.getState().canvasContext?.snapshot.projectId !== preparedProjectId) {
                    throw new Error("当前页面不是会话关联的画布，请重新打开会话画布");
                }
                if (isSiteTool(call.name)) {
                    result = await runSiteTool(call.name, call.input || {}, navigate, { canvasSnapshot: useAgentStore.getState().canvasContext?.snapshot || null });
                } else if (call.name === "site_navigate") {
                    const path = call.input?.path || "/";
                    navigate(path);
                    result = { ok: true, path };
                } else if (call.name === "canvas_apply_ops") {
                    const context = useAgentStore.getState().canvasContext;
                    if (!context) throw new Error("请先打开画布");
                    const snapshot = context.applyOps(call.input?.ops || []);
                    result = snapshot;
                    await flushCanvasStorage();
                    await postState(bridge.url, bridge.token, clientId, snapshot);
                } else if (call.name.startsWith("canvas_") && call.name !== "canvas_create_attachment_nodes") {
                    const snapshot = useAgentStore.getState().canvasContext?.snapshot;
                    if (!snapshot) throw new Error("请先打开画布");
                    result = snapshot;
                } else {
                    throw new Error(`DSH 画布连接不支持 ${call.name}`);
                }
                await postToolResult(bridge.url, bridge.token, clientId, { requestId: call.requestId, result });
            } catch (error) {
                await postToolResult(bridge.url, bridge.token, clientId, { requestId: call.requestId, error: error instanceof Error ? error.message : String(error) });
            }
        };
        void fetch(`${import.meta.env.BASE_URL}bridge-config`, { cache: "no-store" }).then(async (response) => {
            if (!response.ok) throw new Error("DSH 画布桥接服务未就绪");
            return response.json() as Promise<BridgeConfig>;
        }).then((value) => {
            if (disposed) return;
            config = value;
            setAgentState({ enabled: true, activity: "连接中", connectError: "" });
            source = new EventSource(`${value.url}/events?token=${encodeURIComponent(value.token)}&clientId=${encodeURIComponent(clientId)}`);
            source.addEventListener("hello", (event) => {
                if (disposed) return;
                const hello = JSON.parse(event.data) as { protocolVersion?: number };
                if (hello.protocolVersion !== 6) {
                    source?.close();
                    setAgentState({ enabled: false, connected: false, connectError: "Canvas Agent 协议版本不匹配" });
                    reportPrepare({ error: "Canvas Agent 协议版本不匹配" });
                    return;
                }
                setAgentState({ enabled: true, connected: true, activity: "已连接", connectError: "" });
                publishState();
                void activateAgentClient(value.url, value.token, clientId);
                prepareProject();
            });
            source.addEventListener("tool_call", (event) => {
                if (!disposed) void runTool(JSON.parse(event.data) as AgentPendingToolCall);
            });
            source.onerror = () => {
                if (!disposed) {
                    setAgentState({ connected: false, activity: "连接中" });
                    reportPrepare({ error: "无法连接本地画布服务" });
                }
            };
        }).catch((error) => {
            if (!disposed) {
                const text = error instanceof Error ? error.message : String(error);
                setAgentState({ enabled: false, connected: false, connectError: text });
                reportPrepare({ error: text });
            }
        });
        return () => {
            disposed = true;
            routeChanged.current = () => {};
            unsubscribe();
            unsubscribeCanvas();
            window.removeEventListener("message", onPrepare);
            window.removeEventListener("pointerdown", notifyFocus);
            window.removeEventListener("focus", notifyFocus);
            if (stateTimer) clearTimeout(stateTimer);
            source?.close();
            setAgentState({ enabled: false, connected: false });
        };
    }, [navigate, setAgentState]);

    return null;
}
