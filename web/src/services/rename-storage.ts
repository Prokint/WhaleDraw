import localforage from "localforage";

// 改名只复制与复查，旧数据库和迁移快照都保留；失败时不启动业务 store。
export async function migrateWhaleDrawStorage() {
    const migrate = async () => {
        const options = { name: "whaledraw-rename-backup", driver: localforage.INDEXEDDB };
        const meta = localforage.createInstance({ ...options, storeName: "migration" });
        const state = await meta.getItem<{ version: number; status: string }>("state");
        if (state !== null && (state.version !== 1 || !["copying", "complete"].includes(state.status))) throw new Error("迁移记录无法识别，请保留备份并检查。");
        if (state?.status === "complete") return;
        await meta.setItem("state", { version: 1, status: "copying" });
        const serializer = await localforage.getSerializer();
        const serialize = (value: unknown) => new Promise<string>((resolve, reject) => serializer.serialize(value, (text, error) => error ? reject(error) : resolve(text)));
        const instance = (name: string, storeName: string) => localforage.createInstance({ name, storeName, driver: localforage.INDEXEDDB });
        const renameKey = (key: string) => key.replace(/^infinite-canvas:/, "whaledraw:");
        const copyStore = async (source: LocalForage, target: LocalForage, backup: LocalForage) => {
            const keys = (await source.keys()).sort();
            const targetKeys = new Set(await target.keys());
            const backupKeys = new Set(await backup.keys());
            for (const key of keys) {
                const value = await source.getItem(key);
                const text = await serialize(value);
                if (backupKeys.has(key) && await serialize(await backup.getItem(key)) !== text) throw new Error("旧数据与迁移快照冲突，已停止迁移。");
                if (!backupKeys.has(key)) await backup.setItem(key, value);
                if (await serialize(await backup.getItem(key)) !== text) throw new Error("迁移快照复查失败。");
                const next = renameKey(key);
                if (targetKeys.has(next) && await serialize(await target.getItem(next)) !== text) throw new Error("WhaleDraw 已有不同的数据，已停止迁移，未覆盖原内容。");
                if (!targetKeys.has(next)) await target.setItem(next, value);
                if (await serialize(await target.getItem(next)) !== text) throw new Error("迁移数据复查失败。");
                targetKeys.add(next);
            }
            if (JSON.stringify((await source.keys()).sort()) !== JSON.stringify(keys)) throw new Error("旧页面仍在写入数据，请关闭旧页面后重试。");
            for (const key of keys) if (await serialize(await source.getItem(key)) !== await serialize(await backup.getItem(key))) throw new Error("旧页面仍在写入数据，请关闭旧页面后重试。");
        };
        const databases = await indexedDB.databases();
        let oldAppKeys = new Set<string>();
        for (const [oldName, newName] of [["infinite-canvas", "whaledraw"], ["infinite-canvas-plugins", "whaledraw-plugins"]]) {
            if (!databases.some((db) => db.name === oldName)) continue;
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const request = indexedDB.open(oldName);
                request.onupgradeneeded = () => request.transaction?.abort();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
                request.onblocked = () => reject(new Error("请关闭旧版页面后重试数据迁移。"));
            });
            const stores = Array.from(db.objectStoreNames);
            db.close();
            for (const store of stores) {
                const source = instance(oldName, store);
                await copyStore(source, instance(newName, store), instance(options.name, `${oldName}_${store}`));
                if (oldName === "infinite-canvas" && store === "app_state") oldAppKeys = new Set(await source.keys());
            }
        }
        const smallKeys = new Set(["infinite-canvas:locale", "infinite-canvas:theme_store"]);
        const backup = instance(options.name, "local_storage");
        const app = instance("whaledraw", "app_state");
        for (const key of Object.keys(localStorage).filter((key) => key.startsWith("infinite-canvas:"))) {
            const value = localStorage.getItem(key)!;
            const saved = await backup.getItem<string>(key);
            if (saved !== null && saved !== value) throw new Error("本地配置与迁移快照冲突，已停止迁移。");
            await backup.setItem(key, value);
            const next = renameKey(key);
            if (smallKeys.has(key)) {
                const existing = localStorage.getItem(next);
                if (existing !== null && existing !== value) throw new Error("WhaleDraw 已有不同的本地配置，已停止迁移。");
                localStorage.setItem(next, value);
                if (localStorage.getItem(next) !== value) throw new Error("本地配置迁移复查失败。");
            } else if (!oldAppKeys.has(key)) {
                const existing = await app.getItem<string>(next);
                if (existing !== null && existing !== value) throw new Error("WhaleDraw 已有不同的业务数据，已停止迁移。");
                await app.setItem(next, value);
                if (await app.getItem(next) !== value) throw new Error("业务数据迁移复查失败。");
            }
            if (localStorage.getItem(key) !== value) throw new Error("旧页面仍在修改配置，请关闭后重试。");
        }
        await meta.setItem("state", { version: 1, status: "complete" });
    };
    if (!navigator.locks) throw new Error("当前浏览器不支持安全迁移，请使用支持 Web Locks 的浏览器。");
    await navigator.locks.request("whaledraw:rename-migration", migrate);
}
