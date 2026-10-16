import { randomUUID } from "node:crypto";
import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { CanvasSession } from "../canvas/session.js";
import { toolDescriptions, toolInputSchemas, toolNames } from "../canvas/schemas.js";

// DSH 原生工具仅支持 JSON Schema 子集；完整业务约束仍由原始 Zod schema 校验。
function nativeSchema(schema: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
        if (key === "anyOf") {
            const branches = value as Record<string, unknown>[];
            const tags = branches.map((branch) => (branch.properties as Record<string, { const?: unknown }> | undefined)?.type?.const);
            // 当前唯一联合是按 type 判别的画布操作，互斥分支才能等价转换为 oneOf。
            if (tags.some((tag) => typeof tag !== "string") || new Set(tags).size !== tags.length) throw new Error("DSH 工具联合必须使用互斥的 type 判别字段");
            result.oneOf = branches.map(nativeSchema);
        } else if (key === "properties") result.properties = Object.fromEntries(Object.entries(value as Record<string, Record<string, unknown>>).map(([name, item]) => [name, nativeSchema(item)]));
        else if (key === "items") result.items = nativeSchema(value as Record<string, unknown>);
        else if (key === "additionalProperties") result.additionalProperties = value !== false;
        else if (["type", "enum", "const", "required", "description"].includes(key)) result[key] = value;
    }
    return result;
}

export const dshToolDefinitions = toolNames.map((name) => ({
    name, description: toolDescriptions[name], parameters: nativeSchema(zodToJsonSchema(toolInputSchemas[name], { $refStrategy: "none" })),
}));

const identity = z.object({ sessionId: z.string().min(1), connectionId: z.string().uuid() }).strict();
const connect = z.object({ sessionId: z.string().min(1), clientId: z.string().min(1), mode: z.enum(["canvas", "workbench"]), projectId: z.string().min(1).optional() }).strict()
    .refine((value) => value.mode === "canvas" ? Boolean(value.projectId) : !value.projectId, "画布绑定无效");
const tool = identity.extend({ name: z.string().min(1), input: z.record(z.unknown()) });
const watch = z.object({ clientId: z.string().min(1), projectId: z.string().min(1).optional() }).strict();
type Binding = z.infer<typeof connect> & { connectionId: string };
type CanvasStatus = { projectId: string; title: string; clientId: string };

export class DshChannelError extends Error {
    constructor(message: string, readonly code: string) { super(message); }
}

/** DSH 的会话、占用与调用归属；不共享 Codex/Claude 的全局 turn 绑定。 */
export class DshChannel {
    private sessions = new Map<string, Binding>();
    private watchers = new Map<string, string>();
    private announcedCanvases: CanvasStatus[] = [];
    constructor(private canvas: CanvasSession) {}

    connect(value: z.infer<typeof connect>) {
        this.assertTarget(value);
        for (const [id, existing] of this.sessions) {
            const projectId = this.canvas.canvasStateForClient(existing.clientId)?.projectId;
            if (!this.canvas.hasClient(existing.clientId) || (existing.mode === "canvas" ? projectId !== existing.projectId : Boolean(projectId))) {
                this.sessions.delete(id); continue;
            }
            if (value.mode === "canvas" && existing.mode === "canvas" && value.projectId === existing.projectId
                && (value.sessionId !== id || value.clientId !== existing.clientId)) {
                this.publishCanvases();
                throw new DshChannelError("画布已被其他会话或窗口占用，请先关闭原画布，再重试", "canvas-occupied");
            }
        }
        const previous = this.sessions.get(value.sessionId);
        const same = previous && previous.clientId === value.clientId && previous.mode === value.mode && previous.projectId === value.projectId;
        const binding = { ...value, connectionId: same ? previous.connectionId : randomUUID() };
        this.sessions.set(value.sessionId, binding);
        this.publishCanvases();
        return { connectionId: binding.connectionId };
    }

    /** 观察只订阅快照，不发布画布、不改变焦点或会话绑定。 */
    watch(value: z.infer<typeof watch>) {
        if (!this.canvas.hasClient(value.clientId)) throw new DshChannelError("观察页面已断开，请重新连接", "dsh-disconnected");
        this.publishCanvases();
        if (value.projectId) {
            this.watchers.set(value.clientId, value.projectId);
            this.sendSnapshot(value.clientId, value.projectId);
        } else this.watchers.delete(value.clientId);
        return { canvases: this.canvases(), snapshot: value.projectId ? this.snapshot(value.projectId) : null };
    }

    clientConnected(clientId: string) {
        if (!this.canvas.hasClient(clientId)) return;
        this.publishCanvases();
        this.canvas.emitClient(clientId, "dsh_canvases", { canvases: this.canvases() });
        const projectId = this.watchers.get(clientId);
        if (projectId) this.sendSnapshot(clientId, projectId);
    }

    stateChanged(clientId: string) {
        this.publishCanvases();
        const binding = this.canvases().find((item) => item.clientId === clientId);
        if (binding) for (const [watcher, projectId] of this.watchers) if (projectId === binding.projectId) this.sendSnapshot(watcher, projectId);
    }

    async callTool(value: z.infer<typeof tool>) {
        const binding = this.sessions.get(value.sessionId);
        if (!binding || binding.connectionId !== value.connectionId) throw new DshChannelError("DSH 画布连接已失效，请重新连接当前会话", "dsh-disconnected");
        this.assertTarget(binding);
        if (binding.mode === "workbench" && value.name.startsWith("canvas_") && value.name !== "canvas_list_projects") {
            throw new DshChannelError("当前会话不连接画布，请在生图工作台生成图片", "dsh-mode-mismatch");
        }
        if (binding.mode === "canvas" && value.name === "workbench_image_generate") throw new DshChannelError("当前会话使用画布，请使用画布生成工具", "dsh-mode-mismatch");
        return this.canvas.callToolForClient(binding.clientId, value.name, value.input);
    }

    disconnect(value: z.infer<typeof identity>) {
        if (this.sessions.get(value.sessionId)?.connectionId !== value.connectionId) return false;
        const disconnected = this.sessions.delete(value.sessionId);
        this.publishCanvases();
        return disconnected;
    }

    clientDisconnected(clientId: string) {
        if (this.canvas.hasClient(clientId)) return;
        this.watchers.delete(clientId);
        for (const [id, binding] of this.sessions) if (binding.clientId === clientId) this.sessions.delete(id);
        this.publishCanvases();
    }

    private canvases(): CanvasStatus[] {
        return [...this.sessions.values()].flatMap((binding) => {
            const snapshot = this.canvas.canvasStateForClient(binding.clientId);
            return binding.mode === "canvas" && snapshot && snapshot.projectId === binding.projectId
                ? [{ projectId: binding.projectId!, title: snapshot.title || "", clientId: binding.clientId }] : [];
        });
    }

    private snapshot(projectId: string) {
        const binding = this.canvases().find((item) => item.projectId === projectId);
        return binding ? this.canvas.canvasStateForClient(binding.clientId) : null;
    }

    private sendSnapshot(clientId: string, projectId: string) {
        this.canvas.emitClient(clientId, "dsh_canvas_state", { projectId, snapshot: this.snapshot(projectId) });
    }

    private publishCanvases() {
        const canvases = this.canvases();
        if (JSON.stringify(canvases) === JSON.stringify(this.announcedCanvases)) return;
        const previous = this.announcedCanvases;
        this.announcedCanvases = canvases;
        this.canvas.emitAll("dsh_canvases", { canvases });
        for (const [clientId, projectId] of this.watchers) {
            if (previous.find((item) => item.projectId === projectId)?.clientId !== canvases.find((item) => item.projectId === projectId)?.clientId) this.sendSnapshot(clientId, projectId);
        }
    }

    private assertTarget(value: z.infer<typeof connect>) {
        if (!this.canvas.hasClient(value.clientId)) throw new DshChannelError("目标画布连接已断开，请重新连接当前会话", "dsh-disconnected");
        const projectId = this.canvas.canvasStateForClient(value.clientId)?.projectId;
        if (value.mode === "canvas" ? projectId !== value.projectId : Boolean(projectId)) {
            throw new DshChannelError("目标页面已切换，请重新确认会话画布", "dsh-target-changed");
        }
    }
}

/** 在既有 token 认证之后安装专用通道。 */
export function installDshChannel(app: Express, canvas: CanvasSession) {
    const channel = new DshChannel(canvas);
    const handle = <T>(schema: z.ZodType<T>, run: (value: T) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
        const parsed = schema.safeParse(req.body);
        if (!parsed.success) { res.status(400).json({ ok: false, error: "DSH 通道请求无效" }); return; }
        try { res.json({ ok: true, result: await run(parsed.data) }); }
        catch (error) {
            if (error instanceof DshChannelError) res.status(409).json({ ok: false, error: error.message, code: error.code });
            else next(error);
        }
    };
    app.post("/agent/dsh/connect", handle(connect, (value) => channel.connect(value)));
    app.post("/agent/dsh/watch", handle(watch, (value) => channel.watch(value)));
    app.post("/agent/dsh/tools", handle(tool, (value) => channel.callTool(value)));
    app.post("/agent/dsh/disconnect", handle(identity, (value) => ({ disconnected: channel.disconnect(value) })));
    return channel;
}
