window.__ModuleLoader__.load({
    id: "dsh-infinite-canvas",
    factory: (require) => {
        const { createElement: h } = require("react");
        const panelId = "infinite-canvas";

        function CanvasPage() {
            return h("iframe", {
                src: "/plugins/dsh-infinite-canvas/app/",
                title: "无限画布",
                allow: "clipboard-read; clipboard-write; fullscreen",
                style: { display: "block", width: "100%", height: "100%", flex: 1, minHeight: 0, border: 0 },
            });
        }

        function CanvasIcon() {
            return h("svg", {
                width: 20, height: 20, viewBox: "0 0 24 24", fill: "none",
                stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round",
                "aria-hidden": true,
            }, h("rect", { x: 3, y: 3, width: 18, height: 18, rx: 3 }),
            h("path", { d: "M7 9h4v4H7zM13 15h4M15 13v4" }));
        }

        return {
            inject: ["slots"],
            apply(ctx) {
                ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: panelId }, CanvasPage));
                ctx.slots.inject("sidebar.panellist", () => ctx.slots.register(
                    { name: "sidebar.panellist", id: panelId, order: 21, label: () => "无限画布" },
                    CanvasIcon,
                ));
            },
        };
    },
});
