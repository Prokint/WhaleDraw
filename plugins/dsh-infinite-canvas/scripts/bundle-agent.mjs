import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

export async function bundleAgent() {
    const source = new URL("../../../canvas-agent/", import.meta.url);
    const destination = new URL("../dist/agent/", import.meta.url);
    await stat(new URL("dist/agent/dsh.js", source)).catch(() => { throw new Error("请先在 canvas-agent 目录执行 npm run build，再构建 DSH 插件。"); });
    const agent = JSON.parse(await readFile(new URL("package.json", source), "utf8"));
    const plugin = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    for (const name of Object.keys(agent.dependencies)) if (!plugin.dependencies[name]) throw new Error(`插件缺少内置 Agent 运行依赖：${name}`);
    if (relative(fileURLToPath(new URL("../dist/", import.meta.url)), fileURLToPath(destination)) !== "agent") throw new Error("内置 Agent 目标目录异常");
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    for (const path of ["dist", "package.json", "agent-instructions.md", "README.md"]) await cp(new URL(path, source), new URL(path, destination), { recursive: true });
}
