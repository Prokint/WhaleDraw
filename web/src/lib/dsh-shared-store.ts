import { useStore, type ExtractState, type StoreApi, type UseBoundStore } from "zustand";

type Store = Pick<StoreApi<unknown>, "getState" | "getInitialState" | "subscribe">;
type DshWindow = Window & { __whaledrawStores?: Map<string, Store> };

// Share data APIs across DSH iframes; each iframe keeps its own React hook instance.
export function createDshSharedStore<S extends Store>(key: string, create: () => S): S {
    if (!import.meta.env.BASE_URL.startsWith("/plugins/dsh-infinite-canvas/app/") || window.parent === window) return create();
    const host = window.parent as DshWindow;
    const stores = host.__whaledrawStores ||= new Map();
    let api = stores.get(key) as S | undefined;
    if (!api) { api = create(); stores.set(key, api); }
    const store = api;
    const hook = ((selector?: (state: ExtractState<S>) => unknown) => selector ? useStore(store, selector) : useStore(store)) as UseBoundStore<S>;
    return Object.assign(hook, store) as S;
}
