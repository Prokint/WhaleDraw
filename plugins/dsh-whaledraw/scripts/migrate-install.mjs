import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, realpath, mkdir, mkdtemp, copyFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { installVerifiedBundle } from "../src/verified-install.mjs";

const { values } = parseArgs({ options: Object.fromEntries(["profile", "runtime", "pnpm", "package", "version"].map((key) => [key, { type: "string" }])) });
if (Object.keys(values).length !== 5 || Object.values(values).some((value) => !value)) throw new Error("需要 --profile <profile绝对路径> --runtime <DSH包目录> --pnpm <pnpm.mjs路径> --package <官方tgz路径> --version <版本号>。请先退出目标 DSH。");
const profile = await realpath(values.profile);
const anchor = await realpath(join(values.runtime, "package.json"));
const pnpm = await realpath(values.pnpm);
const packageFile = await realpath(values.package);
const manifest = JSON.parse(await readFile(join(profile, "package.json"), "utf8"));
if (!manifest.dependencies?.["dsh-infinite-canvas"] || manifest.dependencies["dsh-whaledraw"]) throw new Error("目标 profile 不是单独安装旧版插件的状态，尚未执行迁移。");
if (!/^\d+\.\d+\.\d+$/.test(values.version)) throw new Error("版本号无效。");
const response = await fetch(`https://api.github.com/repos/Prokint/WhaleDraw/releases/tags/v${values.version}`);
if (!response.ok) throw new Error("无法读取正式 Release，尚未执行迁移。");
const release = await response.json();
const name = `dsh-whaledraw-${values.version}.tgz`;
const asset = release.assets?.find((item) => item.name === name && item.state === "uploaded" && item.browser_download_url === `https://github.com/Prokint/WhaleDraw/releases/download/v${values.version}/${name}`);
const hash = createHash("sha256").update(await readFile(packageFile)).digest("hex");
if (release.draft || release.prerelease || asset?.digest !== `sha256:${hash}`) throw new Error("正式安装包未就绪或摘要不符，尚未执行迁移。");
const require = createRequire(anchor);
const { PluginManager } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-plugin-manager")));
const { Context } = await import(pathToFileURL(require.resolve("@deepseek-ai/cordis")));
const downloads = join(profile, ".plugin-manager", "downloads");
await mkdir(downloads, { recursive: true });
const directory = await mkdtemp(join(downloads, "whaledraw-rename-"));
const file = join(directory, name);
await copyFile(packageFile, file);
if (createHash("sha256").update(await readFile(file)).digest("hex") !== hash) throw new Error("安装文件复制复查失败。");
const root = new Context();
root.provide("profileContext", { name: basename(profile), dir: profile, installAnchor: anchor, startedBundles: [], patchPath: join(profile, "cordis.patch.yml"),
    packageManager: { command: process.execPath, args: ["--expose-internals", pnpm], env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {} },
});
try {
    await root.plugin({ name: "whaledraw-rename-installer", apply(ctx) { new PluginManager(ctx, PluginManager.Config({})); } });
    const result = await installVerifiedBundle(root.get("pluginManager"), file, values.version, directory);
    if (!["applied", "restart-required"].includes(result.application)) throw new Error(result.error?.diagnostic || "安装未完成。");
    console.log(`WhaleDraw 已安装，请重新打开 DSH。旧依赖与配置备份：${directory}`);
} finally {
    await root.fiber.dispose();
}
