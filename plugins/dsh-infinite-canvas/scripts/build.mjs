import { copyFile, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import "../../../scripts/sync-version.mjs";

const webRoot = new URL("../../../web/", import.meta.url);
const require = createRequire(new URL("package.json", webRoot));
const { build } = await import(pathToFileURL(require.resolve("vite")).href);
process.chdir(fileURLToPath(webRoot));

await build({
    root: fileURLToPath(webRoot),
    base: "/plugins/dsh-infinite-canvas/app/",
    build: {
        outDir: fileURLToPath(new URL("../dist/app/", import.meta.url)),
        emptyOutDir: true,
    },
});
await writeFile(new URL("../dist/app/version.json", import.meta.url), JSON.stringify({ version: (await readFile(new URL("../../../VERSION", import.meta.url), "utf8")).trim() }));
await copyFile(new URL("../../../LICENSE", import.meta.url), new URL("../LICENSE", import.meta.url));
console.log("DSH 无限画布插件已打包，可使用 dsh plugin --profile desktop add link:<插件目录> 安装。");
