/** 画布正文持有占用直到关闭；浏览器会在页面退出时自动释放。 */
export function acquireCanvasAccess(projectId: string, locks: LockManager = navigator.locks): Promise<() => void> {
    if (!locks) return Promise.reject(new Error("当前环境不支持画布占用保护，请使用本机 DSH 桌面端或浏览器"));
    return new Promise((resolve, reject) => {
        void locks.request(`whaledraw:canvas:${projectId}`, { ifAvailable: true }, async (lock) => {
            if (!lock) {
                reject(Object.assign(new Error("画布已被其他会话或页面占用，请先关闭原会话中的画布，再重试"), { code: "canvas-occupied" }));
                return;
            }
            await new Promise<void>((release) => resolve(release));
        }).catch(reject);
    });
}
