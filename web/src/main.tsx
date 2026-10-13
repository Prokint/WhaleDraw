import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "streamdown/styles.css";
import "./styles/globals.css";
import { migrateWhaleDrawStorage } from "@/services/rename-storage";
import { initAnalytics } from "@/lib/analytics";

initAnalytics();

document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

async function start() {
    await migrateWhaleDrawStorage();
    await import("@/i18n");
    const [{ AppProviders }, { router }, { RouterProvider }] = await Promise.all([
        import("@/components/layout/app-providers"), import("@/router"), import("react-router-dom"),
    ]);
    createRoot(document.getElementById("root")!).render(
        <React.StrictMode>
            <AppProviders>
                <RouterProvider router={router} />
            </AppProviders>
        </React.StrictMode>,
    );
}

void start().catch((error) => {
    document.getElementById("root")!.textContent = `WhaleDraw 数据迁移未完成，旧数据和快照已保留。请关闭旧版页面后重试。${error.message}`;
});
