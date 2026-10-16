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
import { journalCanvasStorage } from "@/stores/canvas/use-canvas-store";

initAnalytics();

// IndexedDB 的异步写入来不及在关闭前完成，页面隐藏/关闭时同步兜底一份未保存的改动。
window.addEventListener("pagehide", journalCanvasStorage);
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") journalCanvasStorage();
});

document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <AppProviders>
            <RouterProvider router={router} />
        </AppProviders>
    </React.StrictMode>,
);
