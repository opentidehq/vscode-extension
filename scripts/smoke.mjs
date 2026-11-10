#!/usr/bin/env node
// Smoke-tests a VSIX (SPEC §3 "Smoke test"):
//   1. unpack the VSIX into a temporary folder (file modes kept);
//   2. it carries no runtime/: the extension runs the user's own opentide;
//   3. the engine (WASM) worker, dist/engine/worker.js, answers `initialize` with the version engine.json
//      records and no host, and the web extension is there (package.json `browser` and its Web Worker,
//      dist/web/engine-worker.js), so the Marketplace offers the package on vscode.dev and github.dev.
//   node scripts/smoke.mjs <file.vsix> [--keep]
// Exits non-zero on any failure.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { PackageError, zipEntries, zipRead } from "./package-lib.mjs";
import { checkEngineInitialize, checkWebEntry, SmokeError } from "./smoke-lib.mjs";

const args = process.argv.slice(2);
const vsix = args.find((arg) => !arg.startsWith("--"));
const keep = args.includes("--keep");
const TIMEOUT_MS = 180_000;

function step(name) {
  console.log(`smoke: ${name}`);
}

function unpack(file, into) {
  const buffer = readFileSync(file);
  const entries = zipEntries(buffer);
  for (const entry of entries) {
    const out = join(into, ...entry.name.split("/"));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, zipRead(buffer, entry));
    if (entry.mode && process.platform !== "win32") chmodSync(out, entry.mode);
  }
  return entries.length;
}

/** The engine (WASM) worker as the extension starts it: `initialize`, then `shutdown` and `exit`. */
function engineInitialize(extension) {
  const dir = join(extension, "dist", "engine");
  const manifestPath = join(dir, "engine.json");
  if (!existsSync(manifestPath)) throw new SmokeError("the package has no dist/engine/engine.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(join(dir, "worker.js"), { workerData: { module: join(dir, manifest.module) } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new SmokeError(`the engine did not answer initialize in ${TIMEOUT_MS / 1000} s`));
    }, TIMEOUT_MS);
    let response;
    worker.on("error", (error) => {
      clearTimeout(timer);
      reject(new SmokeError(`engine worker: ${error.message}`));
    });
    worker.on("exit", (code) => {
      clearTimeout(timer);
      if (response) resolvePromise({ response, manifest, exitCode: code });
      else reject(new SmokeError(`the engine worker exited with ${code} before answering`));
    });
    worker.on("message", (text) => {
      const message = JSON.parse(text);
      if (message.id === 1) {
        response = message;
        worker.postMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "shutdown" }));
        worker.postMessage(JSON.stringify({ jsonrpc: "2.0", method: "exit" }));
      }
    });
    worker.postMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { processId: null, rootUri: null, capabilities: {} },
      }),
    );
  });
}

async function main() {
  if (!vsix) throw new SmokeError("usage: npm run smoke -- <file.vsix> [--keep]");
  const temp = mkdtempSync(join(tmpdir(), "opentide-smoke-"));
  const errors = [];
  try {
    step(`unpacking ${vsix}`);
    const count = unpack(resolve(vsix), join(temp, "vsix"));
    const extension = join(temp, "vsix", "extension");

    step("the web extension: package.json browser and the engine's Web Worker");
    errors.push(
      ...checkWebEntry(JSON.parse(readFileSync(join(extension, "package.json"), "utf8")), (file) =>
        existsSync(join(extension, ...file.split("/"))),
      ),
    );

    step("engine (WASM): initialize in a worker thread");
    const engine = await engineInitialize(extension);
    errors.push(...checkEngineInitialize(engine.response, engine.manifest.version, engine.exitCode));
    console.log(`smoke: engine ${engine.response.result?.capabilities?.experimental?.opentide?.engine}`);

    if (existsSync(join(extension, "runtime")))
      errors.push("the package carries runtime/: the extension runs the user's own opentide");
    console.log(`smoke: ${count} files, no runtime: the user's opentide, else the engine`);
  } finally {
    if (keep) console.log(`smoke: kept ${temp}`);
    else rmSync(temp, { recursive: true, force: true });
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`smoke: FAIL ${error}`);
    process.exit(1);
  }
  console.log("smoke: OK");
}

main().catch((error) => {
  if (error instanceof SmokeError || error instanceof PackageError) {
    console.error(`smoke: ${error.message}`);
    process.exit(1);
  }
  throw error;
});
