import i18n from "@/i18n";

export const RELEASE_REPOSITORY = "Prokint/WhaleDraw";
export const RELEASE_SOURCE_URL = (import.meta.env.VITE_UPDATE_SOURCE || "").replace(/\/+$/, "");

export async function fetchReleaseInfo(includeChangelog = false): Promise<{ version: string; changelog?: string }> {
    const read = async (path: string) => {
        const source = RELEASE_SOURCE_URL || `https://raw.githubusercontent.com/${RELEASE_REPOSITORY}/main`;
        const response = await fetch(`${source}/${path}`, { cache: "no-store" });
        if (!response.ok) throw new Error(i18n.t("version.repositoryUnavailable"));
        return response.text();
    };
    const [version, changelog] = await Promise.all([read("VERSION"), includeChangelog ? read("CHANGELOG.md") : undefined]);
    return { version: version.trim(), changelog };
}
