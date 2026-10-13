import i18n from "@/i18n";

export const RELEASE_REPOSITORY = "Prokint/WhaleDraw";

export async function fetchReleaseInfo(includeChangelog = false): Promise<{ version: string; changelog?: string }> {
    const read = async (path: string) => {
        const response = await fetch(`https://raw.githubusercontent.com/${RELEASE_REPOSITORY}/main/${path}`, { cache: "no-store" });
        if (!response.ok) throw new Error(i18n.t("version.repositoryUnavailable"));
        return response.text();
    };
    const [version, changelog] = await Promise.all([read("VERSION"), includeChangelog ? read("CHANGELOG.md") : undefined]);
    return { version: version.trim(), changelog };
}
