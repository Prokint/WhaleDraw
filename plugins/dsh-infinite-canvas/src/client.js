window.__ModuleLoader__.load({
    id: "dsh-infinite-canvas",
    factory: (require) => {
        const { createElement: h, useEffect, useLayoutEffect, useRef } = require("react");
        const panelId = "infinite-canvas";
        const workbenchId = "infinite-canvas-image";
        const appPath = "/plugins/dsh-infinite-canvas/app";
        const frames = new Map();
        const sessions = new Map();
        const canvasRoutes = new Map();
        let focusedFrame;
        let hostContext;
        let parking;
        const reportOpen = (sessionId, result) => fetch(`${appPath}/host-result?${new URLSearchParams({ sessionId, ...result })}`);
        const visible = (record) => record.view?.visible && hostContext.sidebarRight.mounted.getSnapshot() === record.sessionId;
        const send = (record, type, request) => record.element.contentWindow.postMessage({ type: `dsh-infinite-canvas:${type}`, ...request }, window.location.origin);
        const prepare = (record, request) => {
            record.request = request;
            if (record.mounted) send(record, "prepare", request);
        };
        const getFrame = (key, sessionId, mode) => {
            if (frames.has(key)) return frames.get(key);
            if (!parking.moveBefore) throw new Error("当前浏览器不支持画布后台保活，请更新 DSH 或浏览器");
            mode = mode === "workbench" ? "workbench" : "canvas";
            const parked = sessionFrames(sessionId).findLast((record) => !record.view && record.mode === mode);
            if (parked) {
                frames.delete(parked.key);
                parked.key = key;
                frames.set(key, parked);
                return parked;
            }
            const element = document.createElement("iframe");
            element.src = `${appPath}${mode === "workbench" ? "/image" : canvasRoutes.get(sessionId) || "/"}`;
            element.title = mode === "workbench" ? "生图工作台" : "WhaleDraw";
            element.allow = "clipboard-read; clipboard-write; fullscreen";
            Object.assign(element.style, { display: "block", width: "100%", height: "100%", flex: "1", minHeight: "0", border: "0" });
            const record = { key, element, sessionId, mode, inspections: new Map(), calls: new Set(), mounted: false };
            element.onload = () => { if (record.request && record.mounted) send(record, "prepare", record.request); };
            frames.set(key, record);
            parking.appendChild(element);
            if (sessionId) connectSession(sessionId);
            return record;
        };
        const sessionFrames = (sessionId) => [...frames.values()].filter((record) => record.sessionId === sessionId);
        const connectSession = (sessionId) => {
            if (!sessionId || sessions.has(sessionId)) return;
            const events = new EventSource(`${appPath}/host-events?sessionId=${encodeURIComponent(sessionId)}`);
            sessions.set(sessionId, events);
            events.addEventListener("inspect-canvas", (event) => {
                const request = JSON.parse(event.data);
                const candidates = sessionFrames(sessionId).filter(visible);
                const selected = candidates.find((record) => record.element === document.activeElement) || candidates.find((record) => record.element === focusedFrame) || candidates.at(-1);
                if (selected) {
                    selected.inspections.set(request.requestId, request);
                    if (selected.mounted) send(selected, "inspect", request);
                } else void reportOpen(sessionId, { requestId: request.requestId, mode: "none" });
            });
            events.addEventListener("open-canvas", (event) => {
                const request = JSON.parse(event.data);
                try {
                    if (["existing", "new"].includes(request.mode) || request.show && request.mode === "workbench") {
                        hostContext.sidebarRight.openTabIn(sessionId, request.mode === "workbench" ? workbenchId : panelId, { params: request });
                        return;
                    }
                    const candidates = sessionFrames(sessionId).filter((record) => record.mode === request.mode);
                    const record = candidates.find((record) => record.clientId === request.clientId && (!request.projectId || record.projectId === request.projectId))
                        || candidates.find((record) => request.projectId && record.projectId === request.projectId)
                        || candidates.at(-1)
                        || getFrame(`background:${sessionId}:${request.mode}`, sessionId, request.mode);
                    prepare(record, request);
                } catch (error) { void reportOpen(sessionId, { requestId: request.requestId, error: error.message }); }
            });
            events.addEventListener("call-canvas", (event) => {
                const request = JSON.parse(event.data);
                const record = sessionFrames(sessionId).find((record) => record.clientId === request.clientId);
                if (!record?.mounted) {
                    void fetch(`${appPath}/host-tool-result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, requestId: request.requestId, clientId: request.clientId, error: "会话画布连接已断开" }) });
                    return;
                }
                record.calls.add(request.requestId);
                send(record, "tool-call", request);
            });
        };
        const onMessage = (event) => {
            if (event.origin !== window.location.origin) return;
            const record = [...frames.values()].find((record) => event.source === record.element.contentWindow);
            if (!record) return;
            const data = event.data;
            if (data?.type === "dsh-infinite-canvas:focused") { focusedFrame = record.element; return; }
            if (data?.type === "dsh-infinite-canvas:bridge-mounted") {
                record.mounted = true;
                if (record.request) send(record, "prepare", record.request);
                for (const request of record.inspections.values()) send(record, "inspect", request);
                return;
            }
            if (data?.type === "dsh-infinite-canvas:inspected") {
                if (!record.inspections.delete(data.requestId)) return;
                record.projectId = data.projectId;
                if (["canvas", "workbench"].includes(data.mode)) record.mode = data.mode;
                void reportOpen(record.sessionId, { requestId: data.requestId, mode: visible(record) ? data.mode : "none", ...(data.projectId ? { projectId: data.projectId } : {}), title: data.title || "", defaultTitle: data.defaultTitle || "" });
                return;
            }
            if (data?.type === "dsh-infinite-canvas:prepared") {
                if (record.request?.requestId !== data.requestId) return;
                if (!data.error) {
                    record.clientId = data.clientId;
                    record.projectId = data.projectId;
                    record.mode = record.request.mode === "workbench" ? "workbench" : "canvas";
                }
                void reportOpen(record.sessionId, { requestId: data.requestId, ...(data.error ? { error: data.error } : { clientId: data.clientId, ...(data.projectId ? { projectId: data.projectId } : {}) }) });
                record.request = undefined;
                return;
            }
            if (data?.type === "dsh-infinite-canvas:tool-result") {
                if (data.clientId !== record.clientId || !record.calls.delete(data.requestId)) return;
                void fetch(`${appPath}/host-tool-result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...data, sessionId: record.sessionId }) });
                return;
            }
            if (data?.type !== "dsh-infinite-canvas:open-chat") return;
            const location = record.element.contentWindow.location;
            const sessionId = record.sessionId || hostContext.sidebarRight.mounted.getSnapshot();
            if (location.pathname.startsWith(`${appPath}/`)) canvasRoutes.set(sessionId, `${location.pathname.slice(appPath.length)}${location.search}`);
            const targetPanel = location.pathname.endsWith("/image") ? workbenchId : panelId;
            hostContext.layout.selectPanel(null);
            if (record.view?.side) {
                if (record.view.fullscreen) {
                    const target = hostContext.sidebarRight.focusedTarget(record.element);
                    if (target) hostContext.sidebarRight.toggleFullscreen(target);
                }
            } else requestAnimationFrame(() => hostContext.sidebarRight.openTab(targetPanel));
        };

        function CanvasFrame({ side = false, visible: shown = false, fullscreen = false, sessionId, tabId, requestId, mode = "canvas", projectId }) {
            const container = useRef(null);
            const record = useRef(null);
            const presentation = useRef({});
            const supported = Boolean(parking?.moveBefore);
            Object.assign(presentation.current, { side, visible: shown, fullscreen });
            useLayoutEffect(() => {
                if (!supported) return;
                const value = getFrame(side ? `${sessionId}:${tabId}` : "main", side ? sessionId : undefined, mode);
                record.current = value;
                value.view = presentation.current;
                // moveBefore preserves the iframe document and its in-flight requests.
                container.current.moveBefore(value.element, null);
                return () => {
                    if (value.view === presentation.current) {
                        value.view = undefined;
                        if (parking.isConnected && value.element.isConnected) parking.moveBefore(value.element, null);
                    }
                };
            }, [side, sessionId, tabId, supported]);
            useEffect(() => {
                if (!requestId) return;
                if (!supported) {
                    void reportOpen(sessionId, { requestId, error: "当前浏览器不支持画布后台保活，请更新 DSH 或浏览器" });
                    return;
                }
                let active = true;
                void fetch(`${appPath}/host-request?${new URLSearchParams({ sessionId, requestId })}`, { cache: "no-store" })
                    .then((response) => response.ok ? response.json() : null)
                    .then((request) => { if (active && request && record.current) prepare(record.current, request); })
                    .catch((error) => { void reportOpen(sessionId, { requestId, error: error.message }); });
                return () => { active = false; };
            }, [sessionId, requestId, mode, projectId, supported]);
            return h("div", { ref: container, style: { display: "flex", width: "100%", height: "100%", flex: 1, minHeight: 0 } }, supported ? null : "当前浏览器不支持画布后台保活，请更新 DSH 或浏览器");
        }
        function CanvasPage() { return h(CanvasFrame); }
        function CanvasSidebarPage({ useTabInfo, sessionId }) {
            const { sidebar, tab } = useTabInfo();
            return h(CanvasFrame, { side: true, visible: tab.visible, fullscreen: sidebar.fullscreen, sessionId, tabId: tab.id, ...tab.navigation.params, ...(tab.kind === workbenchId ? { mode: "workbench" } : {}) });
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
                parking = document.createElement("div");
                parking.hidden = true;
                document.body.appendChild(parking);
                window.addEventListener("message", onMessage);
                ctx.effect(() => () => {
                    window.removeEventListener("message", onMessage);
                    for (const events of sessions.values()) events.close();
                    for (const record of frames.values()) record.element.remove();
                    sessions.clear(); frames.clear(); parking.remove();
                });
                ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: panelId }, CanvasPage));
                ctx.effect(() => ctx.sidebarRightTabs.register({
                    id: panelId, kind: panelId, title: () => "WhaleDraw", keepMounted: true,
                    guide: [{ id: "canvas", order: 40, title: () => "WhaleDraw", description: () => "在聊天旁打开画布并连接 Agent", icon: CanvasIcon }],
                }));
                ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: panelId }, CanvasSidebarPage));
                ctx.effect(() => ctx.sidebarRightTabs.register({ id: workbenchId, kind: workbenchId, title: () => "生图工作台", keepMounted: true }));
                ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: workbenchId }, CanvasSidebarPage));
                ctx.slots.inject("sidebar.panellist", () => ctx.slots.register(
                    { name: "sidebar.panellist", id: panelId, order: 21, label: () => "WhaleDraw" }, CanvasIcon,
                ));
                ctx.effect(() => {
                    const connect = () => connectSession(ctx.sidebarRight.mounted.getSnapshot());
                    const unsubscribe = ctx.sidebarRight.mounted.subscribe(connect);
                    connect();
                    return unsubscribe;
                });
            },
        };
    },
});
