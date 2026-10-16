window.__ModuleLoader__.load({
    id: "dsh-infinite-canvas",
    factory: (require) => {
        const { createElement: h, useEffect, useRef } = require("react");
        const panelId = "infinite-canvas";
        const workbenchId = "infinite-canvas-image";
        const appPath = "/plugins/dsh-infinite-canvas/app";
        const canvasRoutes = new Map();
        const sidebarFrames = new Map();
        const hostId = crypto.randomUUID();
        let hostEvents;
        let wantedSessions = new Set();
        let hostUpdate = Promise.resolve();
        let disposed = false;
        let focusedFrame;
        let hostContext;
        const reportOpen = (sessionId, result) => fetch(`${appPath}/host-result?${new URLSearchParams({ hostId, sessionId, ...result })}`);
        const framesOf = (sessionId, mode) => [...sidebarFrames.entries()].filter(([, frame]) => frame.sessionId === sessionId && (!mode || frame.mode === mode));
        const hostParams = () => {
            const params = new URLSearchParams({ hostId });
            for (const sessionId of wantedSessions) params.append("sessionId", sessionId);
            return params;
        };
        const syncHostSessions = () => {
            if (hostEvents?.readyState !== EventSource.OPEN) return;
            const params = hostParams();
            hostUpdate = hostUpdate.then(async () => {
                if (disposed || hostEvents?.readyState !== EventSource.OPEN) return;
                const response = await fetch(`${appPath}/host-sessions?${params}`, { cache: "no-store" });
                if (!response.ok) throw new Error("WhaleDraw 会话订阅同步失败");
            }).catch((error) => console.error(error));
        };
        // 同一窗口的前台与后台会话共用事件流，避免长期 HTTP 连接占满浏览器连接池。
        const sessionHost = () => {
            if (hostEvents || disposed) return;
            const events = hostEvents = new EventSource(`${appPath}/host-events?${hostParams()}`);
            events.addEventListener("open", syncHostSessions);
            events.addEventListener("inspect-canvas", (event) => {
                const request = JSON.parse(event.data);
                const { sessionId } = request;
                const visible = framesOf(sessionId).filter(([, frame]) => frame.visibility.current);
                const selected = visible.find(([element]) => element === document.activeElement) || visible.find(([element]) => element === focusedFrame) || visible.at(-1);
                if (selected) selected[1].inspect(request);
                else void reportOpen(sessionId, { requestId: request.requestId, mode: "none" });
            });
            events.addEventListener("open-canvas", (event) => {
                const params = JSON.parse(event.data);
                const { sessionId } = params;
                if (hostContext.sidebarRight.mounted.getSnapshot() === sessionId) {
                    try { hostContext.sidebarRight.openTab(params.mode === "workbench" ? workbenchId : panelId, { params }); }
                    catch (error) { void reportOpen(sessionId, { requestId: params.requestId, error: error.message }); }
                    return;
                }
                const frame = framesOf(sessionId, params.mode === "workbench" ? "workbench" : "canvas").at(-1) || framesOf(sessionId).at(-1);
                if (!frame) { void reportOpen(sessionId, { requestId: params.requestId, error: "该会话的 WhaleDraw 画布已关闭，请先打开一次画布" }); return; }
                // 后台会话的画布正文不在屏幕上，标记后由正文在操作前重新读取磁盘状态。
                frame[1].prepare({ ...params, background: true });
            });
        };
        const syncHosts = () => {
            if (!hostContext || disposed) return;
            const wanted = new Set([...sidebarFrames.values()].map((frame) => frame.sessionId));
            const mounted = hostContext.sidebarRight.mounted.getSnapshot();
            if (mounted) wanted.add(mounted);
            const changed = wanted.size !== wantedSessions.size || [...wanted].some((sessionId) => !wantedSessions.has(sessionId));
            wantedSessions = wanted;
            if (wanted.size) sessionHost();
            if (changed) syncHostSessions();
        };

        function CanvasFrame({ side = false, visible = false, fullscreen = false, sessionId, requestId, mode, projectId }) {
            const frame = useRef(null);
            const visibility = useRef(visible);
            visibility.current = visible;
            const inspections = useRef(new Map());
            const prepares = useRef(new Set());
            const initialRoute = useRef(mode === "workbench" ? "/image" : side ? canvasRoutes.get(sessionId) || "/" : "/");
            const currentRequest = useRef(requestId);
            currentRequest.current = requestId;
            const postPrepare = (request) => {
                prepares.current.add(request.requestId);
                frame.current?.contentWindow.postMessage({ type: "dsh-infinite-canvas:prepare", ...request }, window.location.origin);
            };
            const prepare = () => {
                if (!requestId) return;
                void fetch(`${appPath}/host-request?${new URLSearchParams({ hostId, sessionId, requestId })}`, { cache: "no-store" })
                    .then((response) => response.ok ? response.json() : null)
                    .then((request) => {
                        if (request && currentRequest.current === requestId) postPrepare(request);
                    })
                    .catch((error) => { void reportOpen(sessionId, { requestId, error: error.message }); });
            };
            useEffect(prepare, [requestId, mode, projectId]);
            useEffect(() => {
                if (!side) return;
                const element = frame.current;
                sidebarFrames.set(element, { sessionId, mode: mode === "workbench" ? "workbench" : "canvas", visibility, inspect(request) {
                    inspections.current.set(request.requestId, request);
                    element.contentWindow.postMessage({ type: "dsh-infinite-canvas:inspect", ...request }, window.location.origin);
                }, prepare(request) { postPrepare(request); } });
                syncHosts();
                return () => {
                    sidebarFrames.delete(element);
                    if (focusedFrame === element) focusedFrame = undefined;
                    for (const request of inspections.current.values()) void reportOpen(sessionId, { requestId: request.requestId, error: "侧边栏画布已关闭" });
                    inspections.current.clear();
                    for (const requestId of prepares.current) void reportOpen(sessionId, { requestId, error: "侧边栏画布已关闭" });
                    prepares.current.clear();
                    syncHosts();
                };
            }, [side, sessionId]);
            useEffect(() => {
                const onMessage = (event) => {
                    if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
                    if (event.data?.type === "dsh-infinite-canvas:focused") { focusedFrame = frame.current; return; }
                    if (event.data?.type === "dsh-infinite-canvas:bridge-mounted") {
                        prepare();
                        for (const request of inspections.current.values()) frame.current.contentWindow.postMessage({ type: "dsh-infinite-canvas:inspect", ...request }, window.location.origin);
                        return;
                    }
                    if (event.data?.type === "dsh-infinite-canvas:inspected") {
                        const { requestId, mode, projectId, title, defaultTitle } = event.data;
                        if (!inspections.current.delete(requestId)) return;
                        void reportOpen(sessionId, { requestId, mode: visibility.current ? mode : "none", ...(projectId ? { projectId } : {}), title: title || "", defaultTitle: defaultTitle || "" });
                        return;
                    }
                    if (event.data?.type === "dsh-infinite-canvas:prepared") {
                        const { requestId: preparedId, clientId, projectId, error, errorCode } = event.data;
                        if (!prepares.current.delete(preparedId)) return;
                        void reportOpen(sessionId, { requestId: preparedId, ...(error ? { error, ...(errorCode ? { errorCode } : {}) } : { clientId, ...(projectId ? { projectId } : {}) }) });
                        return;
                    }
                    if (event.data?.type !== "dsh-infinite-canvas:open-chat") return;
                    const location = frame.current.contentWindow.location;
                    const currentSessionId = sessionId || hostContext.sidebarRight.mounted.getSnapshot();
                    if (location.pathname.startsWith(`${appPath}/`)) canvasRoutes.set(currentSessionId, `${location.pathname.slice(appPath.length)}${location.search}`);
                    const targetPanel = location.pathname.endsWith("/image") ? workbenchId : panelId;
                    hostContext.layout.selectPanel(null);
                    if (side) {
                        if (fullscreen) {
                            const target = hostContext.sidebarRight.focusedTarget(frame.current);
                            if (target) hostContext.sidebarRight.toggleFullscreen(target);
                        }
                    } else {
                        requestAnimationFrame(() => hostContext.sidebarRight.openTab(targetPanel));
                    }
                };
                window.addEventListener("message", onMessage);
                return () => window.removeEventListener("message", onMessage);
            }, [side, fullscreen, sessionId, requestId, mode, projectId]);
            return h("iframe", {
                ref: frame,
                onLoad: prepare,
                src: `${appPath}${initialRoute.current}`,
                title: mode === "workbench" ? "生图工作台" : "WhaleDraw",
                allow: "clipboard-read; clipboard-write; fullscreen",
                style: { display: "block", width: "100%", height: "100%", flex: 1, minHeight: 0, border: 0 },
            });
        }

        function CanvasPage() {
            return h(CanvasFrame);
        }

        function CanvasSidebarPage({ useTabInfo, sessionId }) {
            const { sidebar, tab } = useTabInfo();
            return h(CanvasFrame, { side: true, visible: tab.visible, fullscreen: sidebar.fullscreen, sessionId, ...tab.navigation.params, ...(tab.kind === workbenchId ? { mode: "workbench" } : {}) });
        }

        function CanvasIcon() {
            return h("svg", {
                width: 20, height: 20, viewBox: "0 0 24 24", fill: "none",
                stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round",
                "aria-hidden": true,
            }, h("rect", { x: 3, y: 3, width: 18, height: 18, rx: 3 }),
            h("path", { d: "M7 9h4v4H7zM13 15h4M15 13v4" }));
        }

        return {
            inject: ["slots", "layout", "sidebarRight", "sidebarRightTabs"],
            apply(ctx) {
                hostContext = ctx;
                ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: panelId }, CanvasPage));
                ctx.effect(() => ctx.sidebarRightTabs.register({
                    id: panelId, kind: panelId, title: () => "WhaleDraw", keepMounted: true,
                    guide: [{ id: "canvas", order: 40, title: () => "WhaleDraw", description: () => "在聊天旁打开画布并连接 Agent", icon: CanvasIcon }],
                }));
                ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: panelId }, CanvasSidebarPage));
                ctx.effect(() => ctx.sidebarRightTabs.register({ id: workbenchId, kind: workbenchId, title: () => "生图工作台", keepMounted: true }));
                ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: workbenchId }, CanvasSidebarPage));
                ctx.slots.inject("sidebar.panellist", () => ctx.slots.register(
                    { name: "sidebar.panellist", id: panelId, order: 21, label: () => "WhaleDraw" },
                    CanvasIcon,
                ));
                ctx.effect(() => {
                    const unsubscribe = ctx.sidebarRight.mounted.subscribe(syncHosts);
                    syncHosts();
                    return () => {
                        disposed = true;
                        unsubscribe();
                        hostEvents?.close();
                        hostEvents = undefined;
                    };
                });
            },
        };
    },
});
