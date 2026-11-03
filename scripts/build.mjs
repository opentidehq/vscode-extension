#!/usr/bin/env node
// Bundles the extension host code and every webview entry.
//   src/extension.ts        -> dist/extension.js     (node, CommonJS, `vscode` external)
//   webview/<name>/main.ts  -> dist/webview/<name>.js (browser, IIFE)
//   webview/shared/base.css -> dist/webview/base.css
//   the npm packages bundled in any of them -> dist/THIRD-PARTY-NOTICES.txt
// Flags: --production (minify, no source maps), --watch.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { bundledPackages, mergeMetafiles, thirdPartyNotices, webviewEntries } from "./build-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: "info",
  legalComments: "none",
};

const extension = {
  ...common,
  entryPoints: { extension: join(root, "src", "extension.ts") },
  outdir: join(root, "dist"),
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  mainFields: ["module", "main"],
  metafile: true,
};

const webviews = webviewEntries(join(root, "webview"));
const webview = {
  ...common,
  entryPoints: webviews,
  outdir: join(root, "dist", "webview"),
  platform: "browser",
  format: "iife",
  target: "es2022",
  metafile: true,
};

if (!watch) rmSync(join(root, "dist"), { recursive: true, force: true });
mkdirSync(join(root, "dist", "webview"), { recursive: true });
copyFileSync(join(root, "webview", "shared", "base.css"), join(root, "dist", "webview", "base.css"));

const configs = Object.keys(webviews).length > 0 ? [extension, webview] : [extension];
if (watch) {
  for (const config of configs) await (await esbuild.context(config)).watch();
} else {
  const built = await Promise.all(configs.map((config) => esbuild.build(config)));
  const metafile = mergeMetafiles(built.map((result) => result.metafile));
  const notices = thirdPartyNotices(bundledPackages(metafile, root), (file) => readFileSync(file, "utf8"));
  writeFileSync(join(root, "dist", "THIRD-PARTY-NOTICES.txt"), notices);
}
