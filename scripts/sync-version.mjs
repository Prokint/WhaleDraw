import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const version = (await readFile(new URL("VERSION", root), "utf8")).trim().replace(/^v/, "");

for (const [path, indent] of [["web/package.json", 4], ["web/package-lock.json", 4], ["plugins/dsh-whaledraw/package.json", 2]]) {
    const file = new URL(path, root);
    const source = await readFile(file, "utf8");
    const manifest = JSON.parse(source);
    if (manifest.version === version && (!manifest.packages || manifest.packages[""].version === version)) continue;
    manifest.version = version;
    if (manifest.packages) manifest.packages[""].version = version;
    await writeFile(file, JSON.stringify(manifest, null, indent) + "\n");
}
