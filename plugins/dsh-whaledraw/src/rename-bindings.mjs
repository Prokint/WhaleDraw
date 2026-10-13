import { z } from "zod";

export async function openBindings(ctx) {
    const tables = { sessions: { valueSchema: z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("canvas"), projectId: z.string().min(1) }).strict(),
        z.object({ mode: z.literal("workbench") }).strict(),
    ]) } };
    const domain = await ctx.storageDomain.open({ name: "dsh_whaledraw", version: 1, tables,
        global: { schema: z.object({ legacyMigrated: z.boolean() }).strict(), initial: { legacyMigrated: false } },
    });
    ctx.effect(() => () => domain.close());
    if (domain.global.get().legacyMigrated) return domain;
    const legacy = await ctx.storageDomain.open({ name: "dsh_infinite_canvas", version: 1, tables });
    let backup;
    try {
        backup = await ctx.storageDomain.open({ name: "dsh_whaledraw_rename_backup", version: 1, tables });
        const source = legacy.table("sessions"), saved = backup.table("sessions"), target = domain.table("sessions");
        for (const [key, value] of source.entries()) {
            for (const table of [saved, target]) {
                const existing = table.get(key);
                if (existing && JSON.stringify(existing) !== JSON.stringify(value)) throw new Error("WhaleDraw 会话迁移发现冲突，旧绑定与备份已保留，未覆盖原内容。");
                if (!existing) await table.put(key, value);
                if (JSON.stringify(table.get(key)) !== JSON.stringify(value)) throw new Error("WhaleDraw 会话迁移复查失败。");
            }
        }
        if (saved.size !== source.size) throw new Error("旧会话与迁移快照不一致，已停止迁移。");
        await domain.global.set({ legacyMigrated: true });
        return domain;
    } finally {
        await legacy.close();
        await backup?.close();
    }
}
