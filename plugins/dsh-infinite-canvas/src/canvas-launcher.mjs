import { randomUUID } from "node:crypto";

export const appPath = "/plugins/dsh-infinite-canvas/app";

export function installCanvasLauncher(ctx, ensureAgent, bindings) {
    const clients = new Map();
    const pending = new Map();
    const preparing = new Map();
    const targets = new WeakMap();
    const defaultChanges = new WeakSet();
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
            stream.write(`event: ${kind}\ndata: ${JSON.stringify({ requestId, ...binding })}\n\n`);
        });
    };
    const ask = async (agent, signal, question, options) => {
        const answer = await ctx.userQuestions.ask({ agent, signal, questions: [{ id: "canvas-connection", header: "生图位置", question, options }] });
        const item = answer.answers.find((item) => item.id === "canvas-connection");
        const choice = item?.selected.length === 1 && !item.custom?.trim() ? options.findIndex((option) => option.label === item.selected[0]) : -1;
        if (choice < 0) throw new Error("请明确选择生图位置，再继续生成");
        return choice;
    };
    const openCanvas = async (agent, signal, reselect = false, checkSidebar = false) => {
        signal.throwIfAborted();
        const sessionId = agent?.session.id;
        const stream = [...(clients.get(sessionId) || [])].at(-1);
        if (!stream) throw new Error("请在 DSH 中打开当前聊天，画布将自动显示在右侧面板");
        reselect = reselect && defaultChanges.has(agent);
        const defaultBinding = bindings.get(sessionId);
        let binding = reselect ? undefined : targets.get(agent) || defaultBinding;
        const saveDefault = reselect || !defaultBinding;
        const page = await requestPage(sessionId, stream, signal, "inspect-canvas", { defaultProjectId: defaultBinding?.projectId || "" });
        const sidebar = page.mode === "canvas" ? { mode: "canvas", projectId: page.projectId } : page.mode === "workbench" ? { mode: "workbench" } : undefined;
        if (binding && sidebar && checkSidebar && (binding.mode !== sidebar.mode || binding.projectId !== sidebar.projectId)) {
            const currentLabel = sidebar.mode === "canvas" ? `当前侧边栏：「${page.title || "未命名画布"}」（仅本次）` : "当前侧边栏：生图工作台（仅本次）";
            const defaultLabel = defaultBinding.mode === "canvas" ? `默认绑定：「${page.defaultTitle || "默认画布"}」` : "默认位置：生图工作台";
            const choice = await ask(agent, signal, "当前侧边栏与本次已确认的位置不同，这次在哪里生图？以下选择不会改变默认绑定。", [
                { label: currentLabel, description: "在当前侧边栏页面操作，默认绑定保持不变。" },
                { label: defaultLabel, description: "打开会话默认位置，在那里操作。" },
                { label: "选择其他画布（仅本次）", description: "从我的画布中点选其他项目，默认绑定保持不变。" },
            ]);
            binding = choice === 0 ? sidebar : choice === 1 ? defaultBinding : { mode: "existing" };
        }
        if (!binding) {
            const options = [
                { label: "连接到已有画布", description: "打开我的画布，点选要连接的项目。" },
                { label: "新开画布", description: "创建空白画布，生成的图片放入这个画布。" },
                { label: "不连接任何画布", description: "打开生图工作台，图片不写入任何画布。" },
            ];
            if (sidebar?.mode === "canvas") options.push({ label: `连接侧边栏画布：「${page.title || "未命名画布"}」`, description: "将当前侧边栏画布设为会话默认画布。" });
            const choice = await ask(agent, signal, "当前会话要如何连接画布？选择会保存为默认位置，之后可以明确要求更改连接。", options);
            binding = choice === 3 ? sidebar : { mode: ["existing", "new", "workbench"][choice] };
        }
        const { url, token } = await ensureAgent();
        signal.throwIfAborted();
        if (!clients.get(sessionId)?.has(stream)) throw new Error("DSH 当前聊天界面已断开");
        const result = await requestPage(sessionId, stream, signal, "open-canvas", binding);
        signal.throwIfAborted();
        const response = await fetch(`${url}/canvas/activate?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(result.clientId)}`, { method: "POST", signal });
        if (!response.ok) throw new Error("画布连接已失效，请重新打开画布");
        binding = binding.mode === "workbench" ? { mode: "workbench" } : { mode: "canvas", projectId: result.projectId };
        if (saveDefault) {
            await bindings.put(sessionId, binding);
            defaultChanges.delete(agent);
        }
        targets.set(agent, binding);
        return { opened: true, connected: true, ...binding };
    };
    const prepare = (agent, signal, reselect = false, checkSidebar = false) => {
        const sessionId = agent?.session.id;
        if (!preparing.has(sessionId)) preparing.set(sessionId, openCanvas(agent, signal, reselect, checkSidebar).finally(() => preparing.delete(sessionId)));
        return preparing.get(sessionId);
    };
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
    ctx.effect(() => ctx.webServer.register({
        kind: "exact", path: `${appPath}/host-events`,
        handler(req, res) {
            if (!admit(req, res)) return;
            const sessionId = new URL(req.url, "http://localhost").searchParams.get("sessionId");
            if (!sessionId) { res.writeHead(400); res.end(); return; }
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
            res.write(": connected\n\n");
            const streams = clients.get(sessionId) || new Set();
            streams.add(res);
            clients.set(sessionId, streams);
            res.on("close", () => {
                streams.delete(res);
                if (!streams.size) clients.delete(sessionId);
                for (const request of pending.values()) {
                    if (request.stream === res) request.finish(new Error("DSH 当前聊天界面已断开"));
                }
            });
        },
    }));
    ctx.effect(() => ctx.webServer.register({
        kind: "exact", path: `${appPath}/host-request`,
        handler(req, res) {
            if (!admit(req, res)) return;
            const params = new URL(req.url, "http://localhost").searchParams;
            const requestId = params.get("requestId");
            const request = pending.get(requestId);
            if (!request || request.sessionId !== params.get("sessionId")) { res.writeHead(409); res.end(); return; }
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
            if (!request || request.sessionId !== params.get("sessionId")) { res.writeHead(409); res.end(); return; }
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
            request.finish(error || invalid ? new Error(error || "所选页面尚未就绪") : null, { clientId, projectId });
            res.writeHead(204);
            res.end();
        },
    }));
    ctx.effect(() => ctx.tools.register({
        name: "infinite_canvas_open",
        description: "检查会话默认位置与侧边栏画布，询问本次生图位置并打开连接。临时选择不会改变默认绑定；只有用户明确要求更改连接时传 reselect=true。",
        parameters: { type: "object", properties: { reselect: { type: "boolean", description: "重新询问当前会话的画布连接方式" } }, additionalProperties: false },
        output: {
            schema: { type: "object", properties: { opened: { type: "boolean" }, connected: { type: "boolean" }, mode: { type: "string", enum: ["canvas", "workbench"] }, projectId: { type: "string" } }, required: ["opened", "connected", "mode"], additionalProperties: false },
            render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
        },
        execute: (args, exec) => prepare(exec.agent, exec.signal, args.reselect === true, true),
    }));
    ctx.on("tools/execute", async (exec, next) => {
        if (exec.name.startsWith("mcp__infinite-canvas__")) {
            const name = exec.name.slice("mcp__infinite-canvas__".length);
            const input = exec.arguments || {};
            const generates = ["canvas_generate_image", "canvas_run_generation", "workbench_image_generate"].includes(name)
                || (name === "canvas_apply_ops" && input.ops?.some((op) => op.type === "run_generation"))
                || (input.autoRun === true && ["canvas_create_config_node", "canvas_create_image_prompt_flow", "canvas_create_generation_flow"].includes(name));
            const binding = await prepare(exec.agent, exec.signal, false, generates || (name.startsWith("canvas_") && name !== "canvas_list_projects") || name === "workbench_image_get_config");
            if (binding.mode === "workbench" && exec.name.includes("__canvas_") && !exec.name.endsWith("__canvas_list_projects")) {
                throw new Error("本次操作位置是生图工作台，请使用 workbench_image_get_config / workbench_image_generate；可调用 infinite_canvas_open 重新确认位置");
            }
            if (binding.mode === "canvas" && exec.name.endsWith("__workbench_image_generate")) {
                throw new Error("本次操作位置是画布，请使用 canvas_generate_image 将图片生成到所选画布");
            }
        }
        return next();
    });
    ctx.on("agent/pre-step", async (payload, next) => {
        const decision = await next();
        if (decision.kind !== "enter") return decision;
        const text = decision.messages.filter((message) => message.source?.kind === "user").flatMap((message) => message.content).filter((part) => part.type === "text").map((part) => part.text).join("\n");
        if (text || payload.step === 1) {
            targets.delete(payload.agent);
            defaultChanges.delete(payload.agent);
        }
        if (/画布|生图|出图|绘图|(?:生成|绘制|制作|编辑|修改).*(?:图|照片|海报|封面)|画(?:一|张|个)|\b(?:whaledraw|canvas|draw|text-to-image|generate\s+(?:an?\s+)?image)\b/is.test(text)) {
            const reselect = /(?:更改|更换|修改|切换|重新选择|重新设置|设为|设置).*(?:连接|绑定|默认)|(?:连接|绑定|默认画布).*(?:更改|更换|修改|切换|重新选择)|infinite_canvas_open.*reselect["']?\s*:\s*true/.test(text);
            if (reselect) defaultChanges.add(payload.agent);
            await prepare(payload.agent, payload.signal, reselect, true);
        }
        return decision;
    });
    ctx.effect(() => ctx.systemPrompt.section({
        name: "dsh-infinite-canvas:usage", order: ctx.systemPrompt.getSectionOrder("WEB_SURFACE"),
        text: ({ agent }) => {
            const binding = agent && (targets.get(agent) || bindings.get(agent.session.id));
            const current = binding?.mode === "canvas" ? `本次操作画布为 ${binding.projectId}，图片使用 canvas_generate_image 生成到这个画布。`
                : binding?.mode === "workbench" ? "本次操作位置为生图工作台。必须使用 workbench_image_get_config / workbench_image_generate 生图，不得创建或修改画布。"
                : "当前会话尚未选择画布连接方式。";
            return `用户提到 WhaleDraw、画布或需要生成、编辑图片时，先调用 infinite_canvas_open 等待选择与连接完成。插件每次生图前检查侧边栏，位置不同时询问当前侧边栏、默认绑定或其他画布，不得代替用户选择。${current} 这是本次请求的操作位置，临时选择不修改默认绑定；仅当用户明确要求更改连接或默认画布时调用 infinite_canvas_open({reselect:true})。使用 mcp__infinite-canvas__ 前缀的工具和插件自己的模型配置。打开、选择或连接失败时说明原因，不声称已生成或已修改。`;
        },
    }));
    ctx.effect(() => () => {
        for (const request of pending.values()) request.finish(new Error("WhaleDraw 插件已停用"));
        for (const streams of clients.values()) for (const stream of streams) stream.end();
        clients.clear();
    });
}
