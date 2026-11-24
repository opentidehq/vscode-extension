#!/usr/bin/env node
// Bundles the extension host code and every webview entry.
//   src/extension.ts        -> dist/extension.js     (node, CommonJS, `vscode` external)
//   src/web/extension.ts    -> dist/web/extension.js (browser, CommonJS, `vscode` external; package.json `browser`)
//   src/web/engineWorker.ts -> dist/web/engine-worker.js (browser, classic script: the engine in a Web Worker)
//   webview/<name>/main.ts  -> dist/webview/<name>.js (browser, IIFE)
//   webview/shared/base.css -> dist/webview/base.css
//   webview/panels-kit/kit.css -> dist/webview/kit.css
//   @vscode/codicons' codicon.css and codicon.ttf -> dist/webview/codicons/ (no CDN: the page's CSP)
//   src/core/engine/worker.ts -> dist/engine/worker.js (node worker thread: the engine (WASM), with the
//                            wasm-bindgen glue of the pinned opentide-wasm-web zip bundled in)
//   the zip's opentide_wasm_bg.wasm and licence files, THIRD-PARTY-LICENSES.html -> dist/engine/, with
//                            engine.json (version and checksums, read by the runtime resolver)
//   the pinned WASI module (opentide's CLI on wasm32-wasip1, pins.json `wasi`; OPENTIDE_WASI_MODULE builds with a
//                            module made from opentide's source instead) and src/core/wasi/launcher.cjs -> dist/wasi/,
//                            with wasi.json (version and checksum, read by the runtime resolver) and the licences
//   src/mcp-wasi/main.ts    -> dist/mcp-wasi.js (node, CommonJS: the MCP bridge, with @opentide/wasi-host bundled in)
//   the npm packages bundled in any of them -> dist/THIRD-PARTY-NOTICES.txt
// Flags: --production (minify, no source maps), --watch.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

import {
  bundledPackages,
  COPIED_PACKAGES,
  commonOptions,
  copiedAssets,
  mergeMetafiles,
  thirdPartyNotices,
  webEngineWorkerOptions,
  webExtensionOptions,
  webviewEntries,
} from "./build-lib.mjs";
import { engineManifest, GLUE, prepareEngine, shippedFiles, WASM } from "./engine-lib.mjs";
import { prepareWasi, WASI_LAUNCHER, WASI_MODULE } from "./wasi-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const common = commonOptions(production);

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

const web = webExtensionOptions(root, common);

// The MCP bridge: the editor runs it with its own Node (SPEC §12).
const mcpBridge = {
  ...common,
  entryPoints: { "mcp-wasi": join(root, "src", "mcp-wasi", "main.ts") },
  outdir: join(root, "dist"),
  platform: "node",
  format: "cjs",
  target: "node20",
  mainFields: ["module", "main"],
  metafile: true,
};

// The stable launcher of the user-level MCP entries (Kiro, Devin Desktop, Windsurf): copied into the extension's
// global storage, it runs the newest installed copy's bridge. Dependency-free.
const mcpLauncher = {
  ...common,
  entryPoints: { "mcp-launcher": join(root, "src", "mcp-launcher", "main.ts") },
  outdir: join(root, "dist"),
  platform: "node",
  format: "cjs",
  target: "node20",
  metafile: true,
};

// The engine (WASM): unpacked from the pinned zip into .cache/ (downloaded once), checked by SHA-256.
const pins = JSON.parse(readFileSync(join(root, "pins.json"), "utf8"));
const engineDir = await prepareEngine(root, pins.engine);
// The WASI module: the pinned release asset, checked by SHA-256 (refused while pins.json holds a placeholder).
const wasi = await prepareWasi(root, pins.wasi);
const engineWorker = {
  ...common,
  entryPoints: { worker: join(root, "src", "core", "engine", "worker.ts") },
  outdir: join(root, "dist", "engine"),
  platform: "node",
  format: "cjs",
  target: "node20",
  alias: { "opentide-wasm-glue": join(engineDir, GLUE) },
  // The glue's default initialiser finds the module next to itself; the worker passes it the bytes.
  define: { "import.meta.url": JSON.stringify("file:///opentide_wasm.js") },
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
  // The graph's canvas glyphs: codicon SVGs imported as text (webview/graph/glyphs.ts). The codicon
  // font itself is copied to dist/webview/codicons (copiedAssets).
  loader: { ".svg": "text" },
};

if (!watch) rmSync(join(root, "dist"), { recursive: true, force: true });
mkdirSync(join(root, "dist", "webview"), { recursive: true });
for (const [from, to] of [...copiedAssets(root), ...shippedFiles(engineDir, join(root, "dist", "engine"))]) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}
writeFileSync(
  join(root, "dist", "engine", "engine.json"),
  `${JSON.stringify(engineManifest(pins.engine, readFileSync(join(engineDir, WASM))), null, 2)}\n`,
);

// dist/wasi/: the module, its launcher (MCP, terminals and tasks run through it) and the project's licences.
const wasiOut = join(root, "dist", "wasi");
mkdirSync(wasiOut, { recursive: true });
writeFileSync(join(wasiOut, WASI_MODULE), wasi.wasm);
copyFileSync(join(root, "src", "core", "wasi", "launcher.cjs"), join(wasiOut, WASI_LAUNCHER));
// The module's own licence set (pins.json wasi.licences), not the engine's: it belongs to another build.
for (const [name, text] of wasi.licences) writeFileSync(join(wasiOut, name), text);
writeFileSync(join(wasiOut, "wasi.json"), `${JSON.stringify(wasi.manifest, null, 2)}\n`);

const webEngineWorker = webEngineWorkerOptions(root, join(engineDir, GLUE), common);
const configs = [
  extension,
  mcpBridge,
  mcpLauncher,
  web,
  engineWorker,
  webEngineWorker,
  ...(Object.keys(webviews).length > 0 ? [webview] : []),
];
if (watch) {
  for (const config of configs) await (await esbuild.context(config)).watch();
} else {
  const built = await Promise.all(configs.map((config) => esbuild.build(config)));
  const metafile = mergeMetafiles(built.map((result) => result.metafile));
  const packages = bundledPackages(metafile, root, COPIED_PACKAGES);
  const notices = thirdPartyNotices(packages, (file) => readFileSync(file, "utf8"));
  writeFileSync(join(root, "dist", "THIRD-PARTY-NOTICES.txt"), notices);
}
