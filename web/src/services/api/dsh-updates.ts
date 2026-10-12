const appPath = "/plugins/dsh-infinite-canvas/app";

export type PluginUpdateInfo = {
    version: string;
    available: boolean;
    reason: string;
    token: string;
    installing: boolean;
    installed: boolean;
};

async function request<T>(action: string, version: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${appPath}/plugin-update-${action}?${new URLSearchParams({ version })}`, { cache: "no-store", ...options });
    if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("请先安装支持立即更新的 DSH 插件版本。");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "插件更新失败，请重试。");
    return result;
}

export function fetchPluginUpdateInfo(version: string, signal: AbortSignal) {
    return request<PluginUpdateInfo>("info", version, { signal });
}

export function installPluginUpdate(info: PluginUpdateInfo) {
    return request<{ installed: boolean; version: string; restartRequired: boolean }>("install", info.version, {
        method: "POST", headers: { "X-DSH-Update-Token": info.token },
    });
}
