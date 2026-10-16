import { Button, Modal } from "antd";
import { useTranslation } from "react-i18next";

import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { useCanvasObserverStore } from "@/stores/canvas/use-canvas-observer-store";

export function CanvasDeleteProjectsDialog() {
    const { t } = useTranslation();
    const ids = useCanvasUiStore((state) => state.deleteProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const removeSelectedIds = useCanvasUiStore((state) => state.removeSelectedProjectIds);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const cleanupImages = useAssetStore((state) => state.cleanupImages);
    const controls = useCanvasObserverStore((state) => state.controls);
    const deletableIds = ids.filter((id) => !controls.some((control) => control.projectId === id));
    const confirm = () => {
        const currentControls = useCanvasObserverStore.getState().controls;
        const removing = ids.filter((id) => !currentControls.some((control) => control.projectId === id));
        if (removing.length) {
            deleteProjects(removing);
            cleanupImages();
            removeSelectedIds(removing);
        }
        setDeleteIds([]);
    };

    return (
        <Modal
            title={t("canvas.project.deleteTitle")}
            open={ids.length > 0}
            centered
            onCancel={() => setDeleteIds([])}
            footer={
                <>
                    <Button onClick={() => setDeleteIds([])}>{t("common.cancel")}</Button>
                    <Button danger type="primary" disabled={!deletableIds.length} onClick={confirm}>
                        {t("common.delete")}
                    </Button>
                </>
            }
        >
            {deletableIds.length ? <p className="text-sm text-stone-500">{t("canvas.project.deleteDescription", { count: deletableIds.length })}</p> : null}
            {deletableIds.length !== ids.length ? <p className="text-sm text-stone-500">正在被 Agent 调用的画布不会删除。</p> : null}
        </Modal>
    );
}
