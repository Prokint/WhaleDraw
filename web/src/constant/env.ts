export const APP_VERSION = __APP_VERSION__ || "dev";
export const CANVAS_AGENT_COMMAND = `npx -y https://github.com/Prokint/WhaleDraw/releases/download/${APP_VERSION}/whaledraw-canvas-agent.tgz`;

export const IS_DSH_PLUGIN = import.meta.env.BASE_URL.startsWith("/plugins/dsh-infinite-canvas/app/");

export function openDshChat() {
    window.parent.postMessage({ type: "dsh-infinite-canvas:open-chat" }, window.location.origin);
}

export const DOCS_URL = import.meta.env.VITE_DOC_URL || "https://docs.canvas.best";

// Official plugin registry URL: CI publishes to plugins-dist for jsDelivr delivery; an environment variable may override it for self-hosting.
export const PLUGIN_REGISTRY_URL = import.meta.env.VITE_PLUGIN_REGISTRY_URL || "https://cdn.jsdelivr.net/gh/basketikun/infinite-canvas@plugins-dist/official-plugins.json";
