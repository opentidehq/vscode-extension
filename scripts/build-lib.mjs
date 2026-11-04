// Pure helpers for scripts/build.mjs.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The esbuild options every bundle shares. `legalComments: "eof"` keeps each bundled file's `/*!` and
 * `@license` comments, gathered at the end of the bundle: Cytoscape.js inlines code under MIT notices of
 * its own (Engelschall's Thenable, jQuery's event object, bezier-easing, Framer.js's spring), which the
 * MIT licence requires to ship with it and which THIRD-PARTY-NOTICES, built from package licence files,
 * does not carry.
 */
export function commonOptions(production) {
  return {
    bundle: true,
    sourcemap: !production,
    minify: production,
    logLevel: "info",
    legalComments: "eof",
  };
}

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

/** npm packages whose files the build copies into dist/ as they are (not bundled by esbuild). */
export const COPIED_PACKAGES = ["@vscode/codicons"];

/**
 * Licence labels where a package's `license` field names only part of it: @vscode/codicons says
 * CC-BY-4.0 (the font) and ships its code (codicon.css) under MIT in LICENSE-CODE.
 */
export const LICENCE_LABELS = { "@vscode/codicons": "CC-BY-4.0 AND MIT" };

/** The files the build copies into dist/webview: [source, destination]. */
export function copiedAssets(root) {
  const webview = join(root, "dist", "webview");
  const codicons = join(root, "node_modules", "@vscode", "codicons", "dist");
  return [
    [join(root, "webview", "shared", "base.css"), join(webview, "base.css")],
    [join(root, "webview", "panels-kit", "kit.css"), join(webview, "kit.css")],
    [join(codicons, "codicon.css"), join(webview, "codicons", "codicon.css")],
    [join(codicons, "codicon.ttf"), join(webview, "codicons", "codicon.ttf")],
  ];
}

/**
 * The npm packages an esbuild metafile's inputs come from, plus `copied` (packages whose files the build
 * copies as they are): `name` -> package folder.
 */
export function bundledPackages(metafile, root, copied = []) {
  const packages = new Map();
  for (const name of copied) packages.set(name, join(root, "node_modules", name));
  for (const input of Object.keys(metafile.inputs)) {
    const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input.replaceAll("\\", "/"));
    if (match?.[1]) {
      const at = input.replaceAll("\\", "/").lastIndexOf(`node_modules/${match[1]}/`);
      packages.set(match[1], join(root, input.slice(0, at), "node_modules", match[1]));
    }
  }
  return new Map([...packages].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** One metafile whose inputs are those of every build (the extension and the webviews). */
export function mergeMetafiles(metafiles) {
  const inputs = {};
  for (const metafile of metafiles) if (metafile) Object.assign(inputs, metafile.inputs);
  return { inputs };
}

/** THIRD-PARTY-NOTICES text: each bundled package's name, version, licence and licence file. */
export function thirdPartyNotices(packages, readFile) {
  const sections = [
    "Third-party software bundled in dist/extension.js, dist/web/extension.js and dist/webview/*.js, or copied into dist/webview",
    "",
  ];
  for (const [name, dir] of packages) {
    const pkg = JSON.parse(readFile(join(dir, "package.json")));
    // Every licence file: @vscode/codicons has LICENSE (the icons, CC BY 4.0) and LICENSE-CODE (MIT).
    const licenseFiles = readdirSync(dir)
      .filter((file) => /^(licen[cs]e|copying)(-[a-z]+)?(\.md|\.txt)?$/i.test(file))
      .sort();
    const label = LICENCE_LABELS[name] ?? pkg.license ?? "see licence";
    sections.push(`${name} ${pkg.version} (${label})`, "-".repeat(40));
    if (licenseFiles.length === 0) sections.push(`Licence: ${pkg.license}`, "");
    for (const file of licenseFiles) {
      if (licenseFiles.length > 1) sections.push(`${file}:`, "");
      sections.push(readFile(join(dir, file)).trim(), "");
    }
  }
  return `${sections.join("\n")}\n`;
}

/**
 * The esbuild options of the web extension (`browser` in package.json): src/web/extension.ts ->
 * dist/web/extension.js, CommonJS for the web worker extension host, with only `vscode` external. The
 * browser platform makes a Node built-in fail to resolve instead of being bundled.
 */
export function webExtensionOptions(root, common = {}) {
  return {
    ...common,
    bundle: true,
    entryPoints: { extension: join(root, "src", "web", "extension.ts") },
    outdir: join(root, "dist", "web"),
    platform: "browser",
    format: "cjs",
    target: "es2022",
    mainFields: ["browser", "module", "main"],
    external: ["vscode"],
    metafile: true,
  };
}
