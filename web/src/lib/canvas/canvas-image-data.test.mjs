import assert from "node:assert/strict";
import test from "node:test";

import { imageBlobToPng } from "./canvas-image-data.ts";

test("图片剪贴板保留 PNG，其他格式按原尺寸转成 PNG", async () => {
    const original = new Blob(["png"], { type: "image/png" });
    assert.strictEqual(await imageBlobToPng(original), original);

    const oldBitmap = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
    const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    let closed = false;
    const bitmap = { width: 8, height: 5, close: () => { closed = true; } };
    const canvas = {
        getContext: () => ({ drawImage: (source, x, y) => assert.deepEqual([source, x, y], [bitmap, 0, 0]) }),
        toBlob: (callback, type) => callback(new Blob(["converted"], { type })),
    };
    Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: async () => bitmap });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => canvas } });
    try {
        const result = await imageBlobToPng(new Blob(["jpeg"], { type: "image/jpeg" }));
        assert.equal(result.type, "image/png");
        assert.equal(await result.text(), "converted");
        assert.deepEqual([canvas.width, canvas.height], [8, 5]);
        assert.equal(closed, true);
    } finally {
        if (oldBitmap) Object.defineProperty(globalThis, "createImageBitmap", oldBitmap);
        else delete globalThis.createImageBitmap;
        if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
        else delete globalThis.document;
    }
});
