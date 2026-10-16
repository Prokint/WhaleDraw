import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "streamdown/styles.css";
import "./styles/globals.css";
import { RouterProvider } from "react-router-dom";

import { AppProviders } from "@/components/layout/app-providers";
import "@/i18n";
import { initAnalytics } from "@/lib/analytics";
import { router } from "@/router";
import { flushCanvasStorage } from "@/stores/canvas/use-canvas-store";

initAnalytics();

// 离页时立即尝试落盘，画布业务数据仍只写入 localforage。
const saveCanvasOnHide = () => { void flushCanvasStorage().catch(() => {}); };
window.addEventListener("pagehide", saveCanvasOnHide);
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveCanvasOnHide();
});

document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <AppProviders>
            <RouterProvider router={router} />
        </AppProviders>
    </React.StrictMode>,
);
