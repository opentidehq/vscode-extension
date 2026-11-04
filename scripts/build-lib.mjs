// Pure helpers for scripts/build.mjs.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** webview/<name>/main.ts entries, by name. */
export function webviewEntries(dir) {
  if (!existsSync(dir)) return {};
  const entries = {};
  for (const name of readdirSync(dir).sort()) {
    const main = join(dir, name, "main.ts");
    if (name !== "shared" && existsSync(main)) entries[name] = main;
  }
  return entries;
}

/** The npm packages an esbuild metafile's inputs come from: `name` -> package folder. */
export function bundledPackages(metafile, root) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input.replaceAll("\\", "/"));
    if (match?.[1]) {
      const at = input.replaceAll("\\", "/").lastIndexOf(`node_modules/${match[1]}/`);
      packages.set(match[1], join(root, input.slice(0, at), "node_modules", match[1]));
    }
  }
  return new Map([...packages].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** THIRD-PARTY-NOTICES text: each bundled package's name, version, licence and licence file. */
export function thirdPartyNotices(packages, readFile) {
  const sections = ["Third-party software bundled in dist/extension.js", ""];
  for (const [name, dir] of packages) {
    const pkg = JSON.parse(readFile(join(dir, "package.json")));
    const licenseFile = readdirSync(dir).find((file) => /^(licen[cs]e|copying)(\.md|\.txt)?$/i.test(file));
    sections.push(`${name} ${pkg.version} (${pkg.license ?? "see licence"})`, "-".repeat(40));
    sections.push(licenseFile ? readFile(join(dir, licenseFile)).trim() : `Licence: ${pkg.license}`, "");
  }
  return `${sections.join("\n")}\n`;
}
