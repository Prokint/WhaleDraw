import type { ReactNode } from "react";
import { useLayoutEffect } from "react";

import { DshCanvasBridge } from "@/components/agent/dsh-canvas-bridge";
import { AppTopNav } from "@/components/layout/app-top-nav";
import { IS_DSH_PLUGIN } from "@/constant/env";
import { useThemeStore } from "@/stores/use-theme-store";

export default function UserLayout({ children }: { children: ReactNode }) {
    useLayoutEffect(() => {
        if (!IS_DSH_PLUGIN) return;
        try {
            const hostBody = window.parent.document.body;
            const syncTheme = () => useThemeStore.getState().setTheme(hostBody.hasAttribute("data-ds-dark-theme") ? "dark" : "light");
            syncTheme();
            const observer = new MutationObserver(syncTheme);
            observer.observe(hostBody, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
            return () => observer.disconnect();
        } catch {
            // Keep the saved plugin theme when the host document is inaccessible.
        }
    }, []);

    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <AppTopNav />
                <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
            </div>
            {IS_DSH_PLUGIN ? <DshCanvasBridge /> : null}
        </div>
    );
}
