import { execFile, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

import { VERSION } from "./config.js";
import { logger } from "./utils/logger.js";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const CODEX_VERSION = String((require("@openai/codex/package.json") as { version: string }).version);
export const AGENT_COMMAND = "npx -y --prefer-online https://github.com/Prokint/WhaleDraw/releases/latest/download/whaledraw-canvas-agent.tgz";

/** 输出当前版本，并在后台检查 WhaleDraw Release 与 Codex npm 版本。 */
export function checkVersions() {
    const localCodexVersion = commandVersion("codex");
    logger.info("Canvas Agent version", { version: VERSION });
    logger.info("Bundled Codex version", { version: CODEX_VERSION });
    logger.info("Local Codex version", { version: localCodexVersion || "not found" });
    if (!localCodexVersion) {
        logger.warn("Local Codex was not found. Install the latest version with: npm install -g @openai/codex@latest");
    } else if (localCodexVersion !== CODEX_VERSION) {
        logger.warn(`Bundled Codex ${CODEX_VERSION} does not match local Codex ${localCodexVersion}. Keep both current with: npm install -g @openai/codex@latest && ${AGENT_COMMAND}`);
    }
    void checkLatestVersions(localCodexVersion);
}

/** 分别查询本仓库 Release 与 Codex npm，提醒升级旧版本。 */
async function checkLatestVersions(localCodexVersion: string) {
    try {
        const [latestAgent, latestCodex] = await Promise.all([
            latestAgentRelease(),
            npmVersion("@openai/codex"),
        ]);
        if (isOlder(VERSION, latestAgent.version)) logger.warn(`Update available: Canvas Agent ${VERSION} -> ${latestAgent.version}. Run: npx -y ${latestAgent.url}`);
        if (isOlder(CODEX_VERSION, latestCodex)) logger.warn(`Update available: bundled Codex ${CODEX_VERSION} -> ${latestCodex}. Upgrade Canvas Agent with: ${AGENT_COMMAND}`);
        if (localCodexVersion && isOlder(localCodexVersion, latestCodex)) logger.warn(`Update available: local Codex ${localCodexVersion} -> ${latestCodex}. Run: npm install -g @openai/codex@latest`);
    } catch {
        logger.warn("Unable to check the latest releases; startup will continue.");
    }
}

export async function latestAgentRelease() {
    const response = await fetch("https://api.github.com/repos/Prokint/WhaleDraw/releases/latest", { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`WhaleDraw Release: HTTP ${response.status}`);
    const release = await response.json() as { tag_name: string; assets: { name: string; state: string; browser_download_url: string }[] };
    const asset = release.assets.find((item) => item.state === "uploaded" && /^whaledraw-canvas-agent-\d+\.\d+\.\d+\.tgz$/.test(item.name));
    if (!asset || asset.browser_download_url !== `https://github.com/Prokint/WhaleDraw/releases/download/${release.tag_name}/${asset.name}`) throw new Error("WhaleDraw Release 缺少正式 Agent 安装包");
    return { version: asset.name.slice("whaledraw-canvas-agent-".length, -4), url: asset.browser_download_url };
}

/** 读取本机命令输出中的语义版本号。 */
function commandVersion(command: string) {
    try {
        return execFileSync(command, ["--version"], { encoding: "utf8", timeout: 5_000 }).match(/\d+\.\d+\.\d+/)?.[0] || "";
    } catch {
        return "";
    }
}

/** 读取 npm 包的最新版本。 */
async function npmVersion(name: string) {
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    const { stdout } = await execFileAsync(command, ["view", name, "version"], { encoding: "utf8", timeout: 10_000 });
    return stdout.trim();
}

/** 比较仅包含数字段的稳定版语义版本。 */
function isOlder(current: string, latest: string) {
    const left = current.split(".").map(Number);
    const right = latest.split(".").map(Number);
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
        if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) < (right[index] || 0);
    }
    return false;
}
