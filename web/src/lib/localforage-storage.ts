import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";

localforage.config({
    name: "infinite-canvas",
    storeName: "app_state",
});

// 不回退到 localStorage：画布库整串远超 localStorage 配额，降级要么直接抛错，要么让后续读取拿到与
// IndexedDB 不同的旧快照，而调用方看到的是「保存成功」。异常在这里原样抛出，由调用方提示并保留待写入数据。
export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        return (await localforage.getItem<string>(name)) || null;
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        await localforage.setItem(name, value);
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        await localforage.removeItem(name);
    },
};
