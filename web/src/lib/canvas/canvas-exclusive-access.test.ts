import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { acquireCanvasAccess } from "./canvas-exclusive-access.ts";

test("同画布拒绝第二个页面，不同画布独立，关闭后可以接手", async () => {
    const first = await acquireCanvasAccess("exclusive-test-a");
    const other = await acquireCanvasAccess("exclusive-test-b");
    try {
        await assert.rejects(acquireCanvasAccess("exclusive-test-a"), /已被.*占用/);
        first();
        await setImmediate();
        const next = await acquireCanvasAccess("exclusive-test-a");
        next();
    } finally {
        first();
        other();
    }
});
