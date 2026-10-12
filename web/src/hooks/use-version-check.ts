import { useCallback, useEffect, useMemo, useState } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";
import { APP_VERSION } from "@/constant/env";
import { parseChangelog, type ReleaseInfo } from "@/lib/release";
import { fetchReleaseInfo } from "@/services/api/releases";

function readLocalReleases(): ReleaseInfo[] {
    return __APP_RELEASES__ || [];
}

function toVersionParts(version: string) {
    const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
    return match ? match.slice(1).map(Number) : null;
}

function isNewerVersion(latestVersion: string, currentVersion: string) {
    const latest = toVersionParts(latestVersion);
    const current = toVersionParts(currentVersion);
    if (!latest || !current) return false;
    return latest.some((value, index) => value > current[index] && latest.slice(0, index).every((part, prevIndex) => part === current[prevIndex]));
}

export function useVersionCheck() {
    const { t } = useTranslation();
    const currentVersion = APP_VERSION;
    const { message } = App.useApp();
    const localReleases = useMemo(readLocalReleases, []);
    const [latestVersion, setLatestVersion] = useState(currentVersion);
    const [releases, setReleases] = useState<ReleaseInfo[]>(localReleases);
    const [checking, setChecking] = useState(false);
    const [open, setOpen] = useState(false);
    const [error, setError] = useState("");
    const hasNewVersion = !error && isNewerVersion(latestVersion, currentVersion);

    const checkLatestVersion = useCallback(async () => {
        try {
            const { version } = await fetchReleaseInfo();
            if (!toVersionParts(version)) throw new Error(t("version.readFailed"));
            setLatestVersion(version);
            setError("");
            return true;
        } catch (reason) {
            setLatestVersion(currentVersion);
            setReleases(localReleases);
            setError(reason instanceof Error ? reason.message : t("version.updateFailed"));
            return false;
        }
    }, [currentVersion, localReleases, t]);

    const checkLatestRelease = useCallback(
        async (showMessage = false) => {
            setChecking(true);
            try {
                const { version, changelog } = await fetchReleaseInfo(true);
                if (!toVersionParts(version)) throw new Error(t("version.readFailed"));
                if (!changelog?.trim()) throw new Error(t("version.changelogFailed"));
                setLatestVersion(version);
                setReleases(parseChangelog(changelog));
                setError("");
                if (showMessage) message.success(t("version.updated"));
                return true;
            } catch (reason) {
                setLatestVersion(currentVersion);
                setReleases(localReleases);
                setError(reason instanceof Error ? reason.message : t("version.updateFailed"));
                if (showMessage) message.error(t("version.updateFailed"));
                return false;
            } finally {
                setChecking(false);
            }
        },
        [currentVersion, localReleases, message, t],
    );

    useEffect(() => {
        void checkLatestVersion();
    }, [checkLatestVersion]);

    const openReleaseModal = useCallback(() => {
        setOpen(true);
        void checkLatestRelease();
    }, [checkLatestRelease]);

    return {
        open,
        setOpen,
        openReleaseModal,
        latestVersion,
        releases,
        checking,
        hasNewVersion,
        error,
        checkLatestRelease,
    };
}
