import { useEffect, useState, type CSSProperties } from "react";
import { App, Button, Modal, Progress, Tag, Timeline } from "antd";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useVersionCheck } from "@/hooks/use-version-check";
import { APP_VERSION, IS_DSH_PLUGIN } from "@/constant/env";
import { RELEASE_REPOSITORY, RELEASE_SOURCE_URL } from "@/services/api/releases";
import { cancelPluginUpdate, fetchPluginUpdateInfo, installPluginUpdate, type PluginUpdateInfo, type PluginUpdateProgress } from "@/services/api/dsh-updates";
import { flushCanvasStorage } from "@/stores/canvas/use-canvas-store";

function getTagColor(type: string) {
    if (type === "新增" || type === "Added") return "green";
    if (type === "修复" || type === "Fixed") return "red";
    if (type === "调整" || type === "Changed") return "blue";
    if (type === "文档" || type === "Docs") return "purple";
    return "default";
}

function releaseTypeLabel(type: string, t: TFunction) {
    const key = ({ 新增: "added", 修复: "fixed", 调整: "changed", 优化: "optimized", 文档: "docs" } as Record<string, string>)[type];
    return key ? t(`version.types.${key}`) : type;
}

type VersionReleaseModalProps = {
    className?: string;
    style?: CSSProperties;
};

function UpdateProgress({ progress, cancelling = false }: { progress: PluginUpdateProgress; cancelling?: boolean }) {
    const { t } = useTranslation();
    const completed = progress.stage === "completed";
    const downloaded = progress.stage === "downloading" && progress.totalBytes ? Math.min(1, (progress.receivedBytes || 0) / progress.totalBytes) : 0;
    const percent = completed ? 100 : progress.totalSteps ? ((progress.completedSteps || 0) + downloaded) / progress.totalSteps * 100 : 0;
    const label = t(`version.progressStages.${progress.stage}`);
    const cancellingNow = cancelling && !["completed", "cancelled", "failed"].includes(progress.stage);
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 text-sm" role="status">
                <span>{label}</span>
                {progress.totalSteps ? <span className="shrink-0 text-xs opacity-60">{t("version.progressSteps", { done: completed ? progress.totalSteps : progress.completedSteps || 0, total: progress.totalSteps })}</span> : null}
            </div>
            <Progress aria-label={t("version.progressLabel")} percent={percent} size="small" showInfo={false} status={completed ? "success" : progress.stage === "failed" ? "exception" : progress.stage === "cancelled" ? "normal" : "active"} />
            {progress.stage === "downloading" && progress.receivedBytes !== undefined ? (
                <p className="text-xs tabular-nums opacity-60">
                    {(progress.receivedBytes / 1024 / 1024).toFixed(2)} MB
                    {progress.totalBytes ? ` / ${(progress.totalBytes / 1024 / 1024).toFixed(2)} MB · ${Math.floor(downloaded * 100)}%` : ""}
                </p>
            ) : null}
            {cancellingNow || progress.disconnected ? <p className="text-xs opacity-60">{t(cancellingNow ? "version.cancelWaiting" : "version.progressDisconnected")}</p> : null}
        </div>
    );
}

export function VersionReleaseModal({ className, style }: VersionReleaseModalProps) {
    const { t } = useTranslation();
    const { open, setOpen, openReleaseModal, latestVersion, releases, checking, hasNewVersion, checkLatestRelease, error } = useVersionCheck();
    const { message, modal } = App.useApp();
    const [updateInfo, setUpdateInfo] = useState<PluginUpdateInfo | null>(null);
    const [updateError, setUpdateError] = useState("");
    const [updating, setUpdating] = useState(false);
    const [updateProgress, setUpdateProgress] = useState<PluginUpdateProgress | null>(null);
    useEffect(() => {
        if (!open || checking || !IS_DSH_PLUGIN || error) return;
        const controller = new AbortController();
        setUpdateInfo(null);
        setUpdateError("");
        void fetchPluginUpdateInfo(latestVersion, controller.signal).then(setUpdateInfo).catch((reason) => {
            if (!controller.signal.aborted) setUpdateError(reason instanceof Error ? reason.message : t("version.installFailed"));
        });
        return () => controller.abort();
    }, [open, checking, latestVersion, error, t]);
    const update = () => {
        if (!updateInfo?.available || updating) return;
        let started = false, submitted = false, cancelRequested = false;
        let currentProgress: PluginUpdateProgress = { stage: "saving" };
        const showProgress = (progress: PluginUpdateProgress) => {
            if (!started) return;
            currentProgress = progress;
            setUpdateProgress(progress);
            confirmation.update({ content: <UpdateProgress progress={progress} cancelling={cancelRequested} /> });
        };
        const confirmation = modal.confirm({
            title: t("version.installConfirm", { version: `v${updateInfo.version}` }),
            content: t("version.installDescription"),
            okText: t("version.installNow"), cancelText: t("common.cancel"),
            onCancel(close) {
                if (!started) { close(); return; }
                if (cancelRequested) return;
                cancelRequested = true;
                confirmation.update({ cancelText: t("version.cancelling"), cancelButtonProps: { disabled: true } });
                showProgress(currentProgress);
                if (submitted) void cancelPluginUpdate(updateInfo).catch((reason) => {
                    if (!started) return;
                    cancelRequested = false;
                    const error = reason instanceof Error ? reason.message : t("version.cancelFailed");
                    confirmation.update({ cancelText: t("common.cancel"), cancelButtonProps: { disabled: false }, content: <div className="space-y-2"><UpdateProgress progress={currentProgress} /><p className="text-xs opacity-60">{error}</p></div> });
                    setUpdateError(error);
                });
            },
            async onOk() {
                started = true;
                setUpdating(true);
                setUpdateError("");
                confirmation.update({ keyboard: false });
                showProgress({ stage: "saving" });
                try {
                    await flushCanvasStorage();
                    if (cancelRequested) { showProgress({ stage: "cancelled" }); message.info(t("version.cancelled")); return; }
                    submitted = true;
                    showProgress({ stage: "checking" });
                    const result = await installPluginUpdate(updateInfo, showProgress);
                    setUpdateError("");
                    if ("cancelled" in result) { showProgress({ ...currentProgress, stage: "cancelled", disconnected: false }); message.info(t("version.cancelled")); return; }
                    showProgress({ ...currentProgress, stage: "completed", disconnected: false });
                    setUpdateInfo({ ...updateInfo, available: false, installed: true });
                    message.success(t("version.installedRestart"));
                } catch (reason) {
                    showProgress({ ...currentProgress, stage: "failed", disconnected: false });
                    setUpdateError(reason instanceof Error ? reason.message : t("version.installFailed"));
                } finally {
                    started = false;
                    setUpdating(false);
                }
            },
        });
    };

    return (
        <>
            <button
                type="button"
                className={className || "shrink-0 cursor-pointer text-xs font-medium text-stone-500 transition hover:text-stone-950 dark:text-stone-400 dark:hover:text-white"}
                style={style}
                onClick={openReleaseModal}
                title={t("version.viewUpdates")}
            >
                <span className="relative inline-flex">
                    {APP_VERSION}
                    {hasNewVersion ? <span className="absolute -right-1.5 -top-1 size-1.5 rounded-full bg-green-500" /> : null}
                </span>
            </button>
            <Modal title={t("version.title")} open={open} width={680} centered footer={null} closable={!updating} maskClosable={!updating} keyboard={!updating} onCancel={() => { if (!updating) setOpen(false); }}>
                <div className="mb-5 grid grid-cols-2 gap-3">
                    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="text-xs text-stone-500 dark:text-stone-400">{t("version.currentVersion")}</div>
                        <div className="mt-1 text-base font-semibold text-stone-950 dark:text-stone-100">{APP_VERSION}</div>
                    </div>
                    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="flex items-center justify-between gap-3">
                            <div className="text-xs text-stone-500 dark:text-stone-400">{t("version.latestVersion")}</div>
                            <button
                                type="button"
                                className="cursor-pointer bg-transparent p-0 text-[11px] font-normal text-stone-400 underline-offset-2 transition hover:text-stone-700 hover:underline dark:text-stone-500 dark:hover:text-stone-300"
                                disabled={updating || checking}
                                onClick={() => void checkLatestRelease(true)}
                            >
                                {t(checking ? "version.checking" : "version.checkUpdates")}
                            </button>
                        </div>
                        <div className="mt-1 text-base font-semibold text-stone-950 dark:text-stone-100">{error ? t("version.unknown") : latestVersion}</div>
                    </div>
                </div>
                <p className="mb-4 text-xs text-stone-500 dark:text-stone-400">
                    {t("version.source")}: <a href={RELEASE_SOURCE_URL || `https://github.com/${RELEASE_REPOSITORY}`} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{RELEASE_SOURCE_URL || RELEASE_REPOSITORY}</a>
                </p>
                {error ? <p role="status" className="mb-4 text-xs text-stone-500 dark:text-stone-400">{error} {t("version.localFallback")}</p> : null}
                <div className="mb-5 flex items-center gap-3">
                    <Button type="primary" loading={updating} disabled={!IS_DSH_PLUGIN || checking || Boolean(error) || !hasNewVersion || !updateInfo?.available || updateInfo.installing} onClick={update}>
                        {t(updating ? "version.installing" : updateInfo?.installed ? "version.installedPendingRestart" : "version.installNow")}
                    </Button>
                    <p role="status" className="text-xs text-stone-500 dark:text-stone-400">
                        {updateError || (!IS_DSH_PLUGIN ? t("version.pluginOnly") : updateInfo?.installed ? t("version.installedRestart") : updateInfo?.reason || (updating ? t("version.installing") : ""))}
                    </p>
                </div>
                {updateProgress ? <div className="mb-5"><UpdateProgress progress={updateProgress} /></div> : null}
                <div className="max-h-[56vh] overflow-y-auto pr-2">
                    <Timeline
                        items={releases.map((release) => ({
                            content: (
                                <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-sm font-semibold text-stone-950 dark:text-stone-100">{release.version === "Unreleased" ? t("version.unreleased") : release.version}</span>
                                        <span className="text-xs text-stone-500 dark:text-stone-400">{release.date}</span>
                                        <div className="flex min-w-0 items-center gap-1.5">
                                            {release.version === latestVersion ? <Tag color="green">{t("version.latest")}</Tag> : null}
                                            {release.version === APP_VERSION ? <Tag>{t("version.current")}</Tag> : null}
                                        </div>
                                    </div>
                                    <div className="mt-2 space-y-1.5">
                                        {release.items.map((item, index) => (
                                            <div key={`${release.version}-${index}`} className="flex items-start gap-2 text-sm leading-6 text-stone-700 dark:text-stone-300">
                                                <Tag color={getTagColor(item.type)} className="m-0 mt-0.5 shrink-0 whitespace-nowrap">
                                                    {releaseTypeLabel(item.type, t)}
                                                </Tag>
                                                <span className="min-w-0 flex-1">{item.content}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ),
                        }))}
                    />
                </div>
            </Modal>
        </>
    );
}
