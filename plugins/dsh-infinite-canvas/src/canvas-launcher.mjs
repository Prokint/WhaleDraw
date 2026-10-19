import { randomUUID } from "node:crypto";

export const appPath = "/plugins/dsh-infinite-canvas/app";

export function installCanvasLauncher(ctx, ensureAgent, bindings, definitions = []) {
    const clients = new Map();
    const hosts = new Map();
    const streamHosts = new WeakMap();
    const pending = new Map();
    const preparing = new Map();
    const targets = new WeakMap();
    const notices = new WeakMap();
    const skipped = new Set();
    const defaultChanges = new WeakSet();
    const preparedTools = new Map();
    const connections = new Map();
    const releasing = new Map();
    const generations = new Map();
    const channelRequest = async (config, action, input, signal) => {
        const response = await fetch(`${config.url}/agent/dsh/${action}`, {
            method: "POST", headers: { "content-type": "application/json", "x-canvas-agent-token": config.token },
            body: JSON.stringify(input), signal,
        });
        const body = await response.json();
        if (!response.ok || !body.ok) throw Object.assign(new Error(body.error || "DSH 画布通道请求失败"), { code: body.code });
        return body.result;
    };
    const disconnected = (message) => ({ opened: false, connected: false, mode: "canvas", message });
    const requestPage = (sessionId, stream, signal, kind, binding) => {
        signal.throwIfAborted();
        if (!clients.get(sessionId)?.has(stream)) throw new Error("DSH 当前聊天界面已断开");
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
            const finish = (error, value) => {
                pending.delete(requestId);
                signal.removeEventListener("abort", abort);
                error ? reject(error) : resolve(value);
            };
            const abort = () => finish(signal.reason || new Error("画布连接已取消"));
            pending.set(requestId, { sessionId, stream, kind, binding, finish });
            signal.addEventListener("abort", abort, { once: true });
            stream.write(`event: ${kind}\ndata: ${JSON.stringify({ requestId, sessionId, ...binding })}\n\n`);
        });
    };
    const ask = async (agent, signal, question, options) => {
        const answer = await ctx.userQuestions.ask({ agent, signal, questions: [{ id: "canvas-connection", header: "鲸绘", question, options: options.map(({ label, description }) => ({ label, description })) }] });
        const item = answer.answers.find((item) => item.id === "canvas-connection");
        const action = item?.selected.length === 1 && !item.custom?.trim() ? options.find((option) => option.label === item.selected[0])?.action : undefined;
        if (!action) throw new Error("请明确选择本次操作方式");
        return action;
    };
    const openCanvas = async (agent, signal, reselect = false, checkSidebar = false) => {
        signal.throwIfAborted();
        const sessionId = agent?.session.id;
        const generation = generations.get(sessionId) || 0;
        const assertCurrent = () => {
            signal.throwIfAborted();
            if ((generations.get(sessionId) || 0) !== generation) throw new Error("本轮画布调用已结束");
        };
        const streams = clients.get(sessionId);
        const owner = hosts.get(connections.get(sessionId)?.hostId)?.stream;
        const stream = streams?.has(owner) ? owner : [...(streams || [])].at(-1);
        if (!stream) return disconnected("请在 DSH 中打开当前聊天，画布将自动显示在右侧面板");
        reselect = reselect && defaultChanges.has(agent);
        const defaultBinding = bindings.get(sessionId);
        let binding = reselect ? undefined : targets.get(agent) || defaultBinding;
        const saveDefault = reselect || !defaultBinding;
        const skip = async () => {
            skipped.add(sessionId);
            const connection = connections.get(sessionId);
            if (connection) {
                await channelRequest(connection, "disconnect", { sessionId, connectionId: connection.connectionId });
                connections.delete(sessionId);
            }
            return disconnected("本次不使用鲸绘，继续处理用户的其他任务");
        };
        const page = await requestPage(sessionId, stream, signal, "inspect-canvas", { defaultProjectId: defaultBinding?.projectId || "" });
        const sidebar = page.mode === "canvas" ? { mode: "canvas", projectId: page.projectId } : page.mode === "workbench" ? { mode: "workbench" } : undefined;
        if (binding && sidebar && checkSidebar && (binding.mode !== sidebar.mode || binding.projectId !== sidebar.projectId)) {
            const currentLabel = sidebar.mode === "canvas" ? `当前侧边栏：「${page.title || "未命名画布"}」（仅本次）` : "当前侧边栏：生图工作台（仅本次）";
            const defaultLabel = defaultBinding.mode === "canvas" ? `默认绑定：「${page.defaultTitle || "默认画布"}」` : "默认位置：生图工作台";
            const choice = await ask(agent, signal, "当前侧边栏与本次已确认的位置不同，这次在哪里生图？以下选择不会改变默认绑定。", [
                { label: currentLabel, description: "在当前侧边栏页面操作，默认绑定保持不变。", action: "sidebar" },
                { label: defaultLabel, description: "打开会话默认位置，在那里操作。", action: "default" },
                { label: "选择其他画布（仅本次）", description: "从我的画布中点选其他项目，默认绑定保持不变。", action: "existing" },
                { label: "不使用鲸绘（仅本次）", description: "不打开鲸绘侧边栏，继续处理其他任务。", action: "skip" },
            ]);
            if (choice === "skip") return skip();
            binding = choice === "sidebar" ? sidebar : choice === "default" ? defaultBinding : { mode: "existing" };
        }
        if (!binding) {
            const options = [
                { label: "连接到已有画布", description: "打开我的画布，点选要连接的项目。", action: "existing" },
                { label: "新开画布", description: "创建空白画布，生成的图片放入这个画布。", action: "new" },
                { label: "打开生图工作台", description: "不连接画布，图片在生图工作台生成。", action: "workbench" },
                { label: "不使用鲸绘", description: "本次不打开鲸绘侧边栏，继续处理其他任务。", action: "skip" },
            ];
            if (sidebar?.mode === "canvas") options.push({ label: `连接侧边栏画布：「${page.title || "未命名画布"}」`, description: "将当前侧边栏画布设为会话默认画布。", action: "sidebar" });
            const choice = await ask(agent, signal, "本次要如何使用鲸绘？画布或生图工作台会保存为会话默认位置。", options);
            if (choice === "skip") return skip();
            binding = choice === "sidebar" ? sidebar : { mode: choice };
        }
        const { url, token } = await ensureAgent();
        assertCurrent();
        if (!clients.get(sessionId)?.has(stream)) throw new Error("DSH 当前聊天界面已断开");
        const result = await requestPage(sessionId, stream, signal, "open-canvas", binding);
        assertCurrent();
        binding = binding.mode === "workbench" ? { mode: "workbench" } : { mode: "canvas", projectId: result.projectId };
        // 发出连接请求后等待服务器返回 ID；任务此时结束也要拿到 ID 才能释放占用。
        const { connectionId } = await channelRequest({ url, token }, "connect", { sessionId, clientId: result.clientId, ...binding });
        const connection = { url, token, connectionId, sessionId, hostId: streamHosts.get(stream) };
        if ((generations.get(sessionId) || 0) !== generation) {
            await channelRequest(connection, "disconnect", { sessionId, connectionId });
            throw new Error("本轮画布调用已结束");
        }
        connections.set(sessionId, connection);
        if (saveDefault) {
            await bindings.put(sessionId, binding);
            defaultChanges.delete(agent);
        }
        targets.set(agent, binding);
        return { opened: true, connected: true, ...binding, connection };
    };
    const prepare = (agent, signal, reselect = false, checkSidebar = false) => {
        const sessionId = agent?.session.id;
        if (skipped.has(sessionId)) return Promise.resolve(disconnected("本次不使用鲸绘，继续处理用户的其他任务"));
        if (!preparing.has(sessionId)) {
            const work = Promise.resolve(releasing.get(sessionId)).then(() => openCanvas(agent, signal, reselect, checkSidebar)).then((result) => {
                if (result.opened === false) notices.set(agent, result);
                else notices.delete(agent);
                return result;
            }).catch((error) => {
                if (error.code !== "canvas-occupied") throw error;
                const result = disconnected(error.message);
                notices.set(agent, result);
                return result;
            }).finally(() => { if (preparing.get(sessionId) === work) preparing.delete(sessionId); });
            preparing.set(sessionId, work);
        }
        return preparing.get(sessionId);
    };
    ctx.on("session/event", (session, event) => {
        if (event.type !== "turn/end") return;
        const sessionId = session.id;
        skipped.delete(sessionId);
        const connection = connections.get(sessionId);
        const opening = preparing.get(sessionId);
        if (!connection && !opening) return;
        generations.set(sessionId, (generations.get(sessionId) || 0) + 1);
        connections.delete(sessionId);
        preparing.delete(sessionId);
        const work = Promise.resolve(opening).catch(() => {}).then(() => connection && channelRequest(connection, "disconnect", { sessionId, connectionId: connection.connectionId })).catch((error) => console.error("释放画布控制失败", error)).finally(() => {
            if (releasing.get(sessionId) === work) releasing.delete(sessionId);
        });
        releasing.set(sessionId, work);
    });
    const admit = (req, res) => {
        if (req.method !== "GET") {
            res.writeHead(405, { Allow: "GET" });
            res.end();
            return false;
        }
        if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) {
            res.writeHead(403);
            res.end();
            return false;
        }
        const peer = ctx.connection.admit(req);
        if (typeof peer === "number") {
            res.writeHead(peer);
            res.end();
            return false;
        }
        return true;
    };
    const detachSession = (sessionId, stream) => {
        const streams = clients.get(sessionId);
        streams?.delete(stream);
        if (!streams?.size) clients.delete(sessionId);
        for (const request of pending.values()) {
            if (request.stream === stream && request.sessionId === sessionId) request.finish(new Error("DSH 当前聊天界面已断开"));
        }
    };
    const subscribe = (host, sessions) => {
        for (const id of host.sessions) if (!sessions.has(id)) detachSession(id, host.stream);
        for (const id of sessions) {
            const streams = clients.get(id) || new Set();
            streams.add(host.stream);
            clients.set(id, streams);
        }
        host.sessions = sessions;
    };
    ctx.effect(() => ctx.webServer.register({
        kind: "exact", path: `${appPath}/host-events`,
        handler(req, res) {
            if (!admit(req, res)) return;
            const params = new URL(req.url, "http://localhost").searchParams;
            const hostId = params.get("hostId");
            if (!hostId) { res.writeHead(400); res.end(); return; }
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
            res.write(": connected\n\n");
            const previous = hosts.get(hostId);
            const host = { stream: res, sessions: new Set() };
            hosts.set(hostId, host);
            streamHosts.set(res, hostId);
            previous?.stream.end();
            subscribe(host, new Set(params.getAll("sessionId").filter(Boolean)));
            res.on("close", () => {
                if (hosts.get(hostId) === host) hosts.delete(hostId);
                for (const id of host.sessions) detachSession(id, res);
            });
        },
    }));
    ctx.effect(() => ctx.webServer.register({
        kind: "exact", path: `${appPath}/host-sessions`,
        handler(req, res) {
            if (!admit(req, res)) return;
            const params = new URL(req.url, "http://localhost").searchParams;
            const host = hosts.get(params.get("hostId"));
            if (!host) { res.writeHead(409); res.end(); return; }
            subscribe(host, new Set(params.getAll("sessionId").filter(Boolean)));
            res.writeHead(204);
            res.end();
        },
    }));
    ctx.effect(() => ctx.webServer.register({
        kind: "exact", path: `${appPath}/host-request`,
        handler(req, res) {
            if (!admit(req, res)) return;
            const params = new URL(req.url, "http://localhost").searchParams;
            const requestId = params.get("requestId");
            const request = pending.get(requestId);
            if (!request || request.sessionId !== params.get("sessionId") || streamHosts.get(request.stream) !== params.get("hostId")) { res.writeHead(409); res.end(); return; }
            res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ requestId, ...request.binding }));
        },
    }));
    ctx.effect(() => ctx.webServer.register({
        kind: "exact", path: `${appPath}/host-result`,
        handler(req, res) {
            if (!admit(req, res)) return;
            const params = new URL(req.url, "http://localhost").searchParams;
            const request = pending.get(params.get("requestId"));
            if (!request || request.sessionId !== params.get("sessionId") || streamHosts.get(request.stream) !== params.get("hostId")) { res.writeHead(409); res.end(); return; }
            const error = params.get("error");
            if (request.kind === "inspect-canvas") {
                const mode = params.get("mode");
                const projectId = params.get("projectId");
                const invalid = !["none", "canvas", "workbench"].includes(mode) || (mode === "canvas" && !projectId);
                request.finish(error || invalid ? new Error(error || "无法读取侧边栏状态") : null, { mode, projectId, title: params.get("title"), defaultTitle: params.get("defaultTitle") });
                res.writeHead(204);
                res.end();
                return;
            }
            const clientId = params.get("clientId");
            const projectId = params.get("projectId");
            const invalid = !clientId || (request.binding.mode !== "workbench" && (!projectId || (request.binding.projectId && request.binding.projectId !== projectId)));
            request.finish(error || invalid ? Object.assign(new Error(error || "所选页面尚未就绪"), { code: error ? params.get("errorCode") : null }) : null, { clientId, projectId });
            res.writeHead(204);
            res.end();
        },
    }));
    ctx.effect(() => ctx.tools.register({
        name: "infinite_canvas_open",
        description: "用户明确要求使用鲸绘画布或实际生成、编辑图片时调用；检查位置、询问选择并连接画布。仅讨论画布相关代码或文档时不要调用。只有用户要求更改连接时传 reselect=true。",
        parameters: { type: "object", properties: { reselect: { type: "boolean", description: "重新询问当前会话的画布连接方式" } }, additionalProperties: false },
        output: {
            schema: { type: "object", properties: { opened: { type: "boolean" }, connected: { type: "boolean" }, mode: { type: "string", enum: ["canvas", "workbench"] }, projectId: { type: "string" }, message: { type: "string" } }, required: ["opened", "connected", "mode"], additionalProperties: false },
            render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
        },
        execute: (args, exec) => args.reselect !== true && notices.has(exec.agent) ? notices.get(exec.agent) : prepare(exec.agent, exec.signal, args.reselect === true, true).then(({ connection, ...result }) => result),
    }));
    for (const definition of definitions) ctx.effect(() => ctx.tools.register({
        ...definition, name: `mcp__infinite-canvas__${definition.name}`,
        output: {
            schema: { type: "object", properties: { result: {} }, required: ["result"], additionalProperties: false },
            render: (_args, value) => [{ type: "text", text: JSON.stringify(value.result) }],
        },
        async execute(input, exec) {
            const connection = preparedTools.get(exec.token)?.connection;
            if (!connection) throw new Error("请先连接当前会话的画布");
            return { result: await channelRequest(connection, "tools", {
                sessionId: connection.sessionId, connectionId: connection.connectionId, name: definition.name, input,
            }, exec.signal) };
        },
    }));
    ctx.on("tools/execute", async (exec, next) => {
        if (exec.name.startsWith("mcp__infinite-canvas__")) {
            const name = exec.name.slice("mcp__infinite-canvas__".length);
            const input = exec.arguments || {};
            const generates = ["canvas_generate_image", "canvas_run_generation", "workbench_image_generate"].includes(name)
                || (name === "canvas_apply_ops" && input.ops?.some((op) => op.type === "run_generation"))
                || (input.autoRun === true && ["canvas_create_config_node", "canvas_create_image_prompt_flow", "canvas_create_generation_flow"].includes(name));
            const binding = notices.get(exec.agent) || await prepare(exec.agent, exec.signal, false, generates || (name.startsWith("canvas_") && name !== "canvas_list_projects") || name === "workbench_image_get_config");
            if (binding.opened === false) return { isError: false, value: { result: binding }, content: [{ type: "text", text: skipped.has(exec.agent.session.id) ? "用户本次不使用鲸绘，请继续处理其他任务。" : `${binding.message} 本次未读取或修改画布，请向用户说明原因和可行的下一步。` }] };
            if (binding.mode === "workbench" && exec.name.includes("__canvas_") && !exec.name.endsWith("__canvas_list_projects")) {
                throw new Error("本次操作位置是生图工作台，请使用 workbench_image_get_config / workbench_image_generate；可调用 infinite_canvas_open 重新确认位置");
            }
            if (binding.mode === "canvas" && exec.name.endsWith("__workbench_image_generate")) {
                throw new Error("本次操作位置是画布，请使用 canvas_generate_image 将图片生成到所选画布");
            }
            preparedTools.set(exec.token, binding);
            try { return await next(); }
            finally { preparedTools.delete(exec.token); }
        }
        return next();
    });
    ctx.on("agent/pre-step", async (payload, next) => {
        const decision = await next();
        if (decision.kind !== "enter" || payload.step > 1) return decision;
        const text = decision.messages.filter((message) => message.source?.kind === "user").at(-1)?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "";
        if (payload.step === 1) {
            targets.delete(payload.agent);
            notices.delete(payload.agent);
            defaultChanges.delete(payload.agent);
            skipped.delete(payload.agent.session.id);
        }
        if (/(?:更改|更换|修改|切换|重新选择|重新设置|设为|设置)(?:当前会话的|本次的|默认的)?(?:画布)?(?:连接|绑定|默认)|(?:连接|绑定|默认画布)(?:更改|更换|修改|切换|重新选择)|infinite_canvas_open.*reselect["']?\s*:\s*true/.test(text)) defaultChanges.add(payload.agent);
        return decision;
    });
    ctx.effect(() => ctx.systemPrompt.section({
        name: "dsh-infinite-canvas:usage", order: ctx.systemPrompt.getSectionOrder("WEB_SURFACE"),
        text: ({ agent }) => {
            if (agent && skipped.has(agent.session.id)) return "用户本次选择不使用鲸绘。不要打开鲸绘侧边栏或调用鲸绘工具，继续完成用户的其他任务。";
            const binding = agent && (targets.get(agent) || bindings.get(agent.session.id));
            const notice = agent && notices.get(agent);
            const current = notice ? `${notice.message} 这是正常的连接状态提示，本次未连接画布。向用户说明原因与可行的下一步后停止画布调用；用户要求重试后再调用 infinite_canvas_open。`
                : binding?.mode === "canvas" ? `本次操作画布为 ${binding.projectId}，图片使用 canvas_generate_image 生成到这个画布。`
                : binding?.mode === "workbench" ? "本次操作位置为生图工作台。必须使用 workbench_image_get_config / workbench_image_generate 生图，不得创建或修改画布。"
                : "当前会话尚未选择画布连接方式。";
            return `仅当用户明确要求在鲸绘操作画布，或实际生成、编辑图片时，先调用 infinite_canvas_open 等待选择与连接完成；讨论画布相关代码或文档时不要调用。插件每次生图前检查侧边栏，位置不同时询问当前侧边栏、默认绑定或其他画布，不得代替用户选择。${current} 这是本次请求的操作位置，临时选择不修改默认绑定；仅当用户明确要求更改连接或默认画布时调用 infinite_canvas_open({reselect:true})。使用 mcp__infinite-canvas__ 前缀的工具和插件自己的模型配置。打开、选择或连接失败时说明原因，不声称已生成或已修改。`;
        },
    }));
    ctx.effect(() => async () => {
        for (const request of pending.values()) request.finish(new Error("WhaleDraw 插件已停用"));
        for (const host of hosts.values()) host.stream.end();
        hosts.clear();
        clients.clear();
        await Promise.allSettled([...connections.values()].map((connection) => channelRequest(connection, "disconnect", { sessionId: connection.sessionId, connectionId: connection.connectionId })));
        connections.clear();
    });
}
