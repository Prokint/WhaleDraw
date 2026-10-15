const appPath = "/plugins/dsh-infinite-canvas/app";

export type PluginUpdateInfo = {
    version: string;
    available: boolean;
    reason: string;
    token: string;
    installing: boolean;
    installed: boolean;
};

export type PluginUpdateProgress = {
    stage: "saving" | "checking" | "downloading" | "verifying" | "waiting" | "backing-up" | "preparing" | "installing" | "checking-files" | "rolling-back" | "completed" | "cancelled" | "failed";
    completedSteps?: number;
    totalSteps?: number;
    receivedBytes?: number;
    totalBytes?: number;
    disconnected?: boolean;
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

export async function installPluginUpdate(info: PluginUpdateInfo, onProgress: (progress: PluginUpdateProgress) => void) {
    const events = new EventSource(`${appPath}/plugin-update-progress?${new URLSearchParams({ version: info.version })}`);
    let latest: PluginUpdateProgress = { stage: "checking" };
    events.onmessage = (event) => { latest = JSON.parse(event.data); onProgress(latest); };
    events.onerror = () => { events.close(); onProgress({ ...latest, disconnected: true }); };
    try {
        return await request<{ installed: true; version: string; restartRequired: boolean } | { cancelled: true; message: string }>("install", info.version, {
            method: "POST", headers: { "X-DSH-Update-Token": info.token },
        });
    } finally { events.close(); }
}

export function cancelPluginUpdate(info: PluginUpdateInfo) {
    return request<{ cancelRequested: true }>("cancel", info.version, {
        method: "POST", headers: { "X-DSH-Update-Token": info.token },
    });
}
