/**
 * 本地 canvas-agent 的启动等待与健康探测。
 *
 * 这里单独成模块的原因是可测试性：这些等待都必须有上限，否则子进程一旦不打就绪横幅，
 * 调用方会永久挂在一个 pending promise 上（插件侧表现为「连接画布」一直转圈且不报错）。
 * 所有外部依赖都可注入，测试里用假子进程和假 fetch 驱动。
 */

export const READINESS_MARKER = "Local URL:";
export const DEFAULT_START_TIMEOUT_MS = 20_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
export const DEFAULT_STOP_TIMEOUT_MS = 3_000;

const tail = (value, size = 400) => value.slice(-size) || "无输出";
const seconds = (ms) => Math.max(1, Math.round(ms / 1000));

/**
 * 等待子进程就绪：横幅或健康探测任一先到即算就绪。
 * 只看横幅不够稳——子进程偶尔已经在服务，但横幅没被拿到；那会把可用状态误判成启动失败。
 */
export function waitForReady(child, { startTimeoutMs = DEFAULT_START_TIMEOUT_MS, marker = READINESS_MARKER, probe, probeIntervalMs = 500 } = {}) {
    return new Promise((resolve, reject) => {
        let output = "";
        let errorOutput = "";
        let settled = false;
        let poll;
        const finish = (settle, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (poll) clearInterval(poll);
            settle(value);
        };
        const timer = setTimeout(() => {
            // 先落定再杀：kill 可能同步触发 exit，让 exit 分支把超时原因覆盖掉。
            finish(reject, new Error(`Canvas Agent 启动超时（${seconds(startTimeoutMs)} 秒），请检查端口是否已被其它服务占用：${tail(errorOutput || output)}`));
            child.kill();
        }, startTimeoutMs);
        if (probe) {
            poll = setInterval(() => {
                void probe().then((ready) => {
                    if (ready) finish(resolve);
                }, () => {});
            }, probeIntervalMs);
        }
        child.stdout.on("data", (chunk) => {
            output = (output + chunk.toString()).slice(-200);
            if (output.includes(marker)) finish(resolve);
        });
        child.stderr.on("data", (chunk) => {
            errorOutput = (errorOutput + chunk.toString()).slice(-4000);
        });
        child.once("error", (error) => finish(reject, error));
        child.once("exit", () => finish(reject, new Error(`Canvas Agent 启动失败：${tail(errorOutput || output)}`)));
    });
}

/** 启动等待上限：允许用 WHALEDRAW_AGENT_START_TIMEOUT_MS 覆盖，非法值回落到默认。 */
export function resolveStartTimeout(env = process.env) {
    const value = Number(env.WHALEDRAW_AGENT_START_TIMEOUT_MS);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_START_TIMEOUT_MS;
}

/** 收掉上一次留下的子进程：先挂监听再发 kill，最多等 stopTimeoutMs。 */
export async function stopChild(child, { stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS } = {}) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, stopTimeoutMs))]);
}

/** 健康探测；探测自身也要有上限，否则同样会把调用方挂住。 */
export async function probeHealth(url, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, fetchImpl = fetch } = {}) {
    const response = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok && (await response.json()).ok;
}
