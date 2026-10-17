import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("框选下载的 ZIP 保留文字、图片和视频内容及重名文件", async (t) => {
    const server = await createServer({ configLoader: "runner", root: fileURLToPath(new URL("../../../", import.meta.url)), server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } });
    t.after(() => server.close());
    const previousStorage = globalThis.localStorage;
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    t.after(() => { globalThis.localStorage = previousStorage; });
    const { createCanvasNodesZip } = await server.ssrLoadModule("/src/lib/canvas/canvas-export.ts");
    const { readZip } = await server.ssrLoadModule("/src/lib/zip.ts");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => url === "https://example.test/clip.webm"
        ? Promise.resolve(new Response("remote-video", { headers: { "Content-Type": "video/webm" } }))
        : originalFetch(url, options);
    t.after(() => { globalThis.fetch = originalFetch; });
    const dataUrl = (type, value) => `data:${type};base64,${Buffer.from(value).toString("base64")}`;
    const node = (type, title, content, mimeType) => ({ id: `${type}-${title}`, type, title, metadata: { content, mimeType } });
    const zip = await createCanvasNodesZip([
        node("text", "笔记", "你好"),
        node("image", "图片.png", dataUrl("image/png", "image-bytes"), "image/png"),
        node("video", "片段.mp4", dataUrl("video/mp4", "video-one"), "video/mp4"),
        node("video", "片段.mp4", dataUrl("video/mp4", "video-two"), "video/mp4"),
        node("video", "远程素材", "https://example.test/clip.webm", "video/webm"),
    ]);
    const files = await readZip(zip);
    assert.deepEqual([...files.keys()].sort(), ["图片.png", "片段-1.mp4", "片段.mp4", "笔记.txt", "远程素材.webm"].sort());
    assert.equal(await files.get("笔记.txt").text(), "你好");
    assert.equal(await files.get("图片.png").text(), "image-bytes");
    assert.deepEqual([await files.get("片段.mp4").text(), await files.get("片段-1.mp4").text()].sort(), ["video-one", "video-two"]);
    assert.equal(await files.get("远程素材.webm").text(), "remote-video");
});
