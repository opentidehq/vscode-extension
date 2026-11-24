#!/usr/bin/env node
import { spawn } from "node:child_process";
// Smoke-tests a VSIX (SPEC §3 "Smoke test"):
//   1. unpack the VSIX into a temporary folder (file modes kept);
//   2. it carries no runtime/: the extension runs the user's own opentide, else its WASI module;
//      the WASI module (dist/wasi/), run through its launcher, answers `serve`: initialize with
//      opentide/fetch, and a run of `commands`;
//   3. the engine (WASM) worker, dist/engine/worker.js, answers `initialize` with the version engine.json
//      records and no host, and the web extension is there (package.json `browser` and its Web Worker,
//      dist/web/engine-worker.js), so the Marketplace offers the package on vscode.dev and github.dev.
//   node scripts/smoke.mjs <file.vsix>... [--keep]   (each store's package: package-lib STORES)
// Exits non-zero on any failure.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";

import { PackageError, zipEntries, zipRead } from "./package-lib.mjs";
import {
  checkEngineInitialize,
  checkKnowledgePackage,
  checkBackendBundle,
  checkLspBundle,
  checkMcpBridge,
  checkWasiPackage,
  checkWasiServe,
  checkWebEntry,
  SmokeError,
} from "./smoke-lib.mjs";
import { failure, runWithStandIn } from "./vscode-stand-in.mjs";

const args = process.argv.slice(2);
const vsixFiles = args.filter((arg) => !arg.startsWith("--"));
const keep = args.includes("--keep");
const TIMEOUT_MS = 180_000;

/** dist/lsp.js required as the extension does, with a stand-in for `vscode`: what it exports, and the enum values the extension uses. */
const LSP_PROBE = `
const m = require(process.argv[1]);
process.stdout.write(JSON.stringify({
  client: typeof m.LanguageClient,
  CloseAction: typeof m.CloseAction, ErrorAction: typeof m.ErrorAction,
  RevealOutputChannelOn: typeof m.RevealOutputChannelOn, State: typeof m.State,
  running: m.State?.Running, restart: m.CloseAction?.Restart, never: m.RevealOutputChannelOn?.Never,
}));
`;

/** dist/backend.js required as the extension does: what it exports, and its crash ceiling's Schedule, run. */
const BACKEND_PROBE = `
const m = require(process.argv[1]);
const budget = typeof m.makeCrashBudget === "function" ? m.makeCrashBudget() : undefined;
process.stdout.write(JSON.stringify({
  runWithGrace: typeof m.runWithGrace, makeWriteLock: typeof m.makeWriteLock, makeCrashBudget: typeof m.makeCrashBudget,
  openLane: typeof m.openLane, isWaitCancelled: typeof m.isWaitCancelled, graceMs: m.CANCEL_GRACE_MS,
  budget: budget ? [0, 0, 0, 0].map(() => budget.crashed(0) !== undefined) : null,
}));
`;

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

/**
 * `opentide serve` in the WASI module, started as VS Code starts MCP and tasks (the launcher under Node),
 * not as the extension host runs it (@vscode/wasm-wasi, which needs VS Code): the same module and protocol.
 */
function wasiServe(extension) {
  const dir = join(extension, "dist", "wasi");
  const manifestPath = join(dir, "wasi.json");
  if (!existsSync(manifestPath)) throw new SmokeError("the package has no dist/wasi/wasi.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["--no-turbo-fast-api-calls", join(dir, manifest.launcher), join(dir, manifest.module), "serve"],
      { cwd: dir, stdio: ["pipe", "pipe", "inherit"] },
    );
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new SmokeError(`the WASI module did not answer in ${TIMEOUT_MS / 1000} s`));
    }, TIMEOUT_MS);
    const answers = new Map();
    let buffer = "";
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        answers.set(message.id, message);
        if (message.id === 1) send({ jsonrpc: "2.0", id: 2, method: "run", params: { argv: ["commands"] } });
        if (message.id === 2) {
          send({ jsonrpc: "2.0", id: 3, method: "shutdown" });
          send({ jsonrpc: "2.0", method: "exit" });
        }
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new SmokeError(`the WASI module: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ initialize: answers.get(1), run: answers.get(2), manifest, exitCode: code });
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: { fetch: true } } });
  });
}

/** The MCP bridge as an editor starts it: initialize and tools/list over stdio, then the input ends. */
function mcpBridge(extension) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(extension, "dist", "mcp-wasi.js")], {
      cwd: extension,
      env: { ...process.env, OPENTIDE_REPO_ROOT: extension },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new SmokeError(`the MCP bridge did not answer in ${TIMEOUT_MS / 1000} s`));
    }, TIMEOUT_MS);
    const lines = [];
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        lines.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
      if (lines.length >= 2) child.stdin.end();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new SmokeError(`the MCP bridge: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ lines, exitCode: code });
    });
    for (const message of [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "smoke", version: "0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ])
      child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

/** Smoke-test one package; returns its failures. */
async function smoke(vsix) {
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

    step("agent knowledge: the skills and instructions package.json contributes");
    errors.push(
      ...checkKnowledgePackage(JSON.parse(readFileSync(join(extension, "package.json"), "utf8")), (file) =>
        existsSync(join(extension, ...file.split("/"))),
      ),
    );

    step("engine (WASM): initialize in a worker thread");
    const engine = await engineInitialize(extension);
    errors.push(...checkEngineInitialize(engine.response, engine.manifest.version, engine.exitCode));
    console.log(`smoke: engine ${engine.response.result?.capabilities?.experimental?.opentide?.engine}`);

    step("WASI module: serve, through the launcher");
    const missing = checkWasiPackage((file) => existsSync(join(extension, ...file.split("/"))));
    errors.push(...missing);
    const wasi = await wasiServe(extension);
    errors.push(...checkWasiServe(wasi.initialize, wasi.run, wasi.manifest, wasi.exitCode));
    console.log(`smoke: WASI opentide ${wasi.initialize?.result?.version} (${wasi.manifest.source})`);

    step("language client: dist/lsp.js, as the extension loads it on the first start");
    const lspExists = (file) => existsSync(join(extension, ...file.split("/")));
    const lsp = lspExists("dist/lsp.js")
      ? runWithStandIn(LSP_PROBE, join(extension, "dist", "lsp.js"))
      : { status: 1, stdout: "", stderr: "" };
    errors.push(...checkLspBundle(lspExists, lsp.status === 0 ? lsp.stdout : failure(lsp)));

    step("serve supervisor: dist/backend.js, as the extension loads it with the first command");
    const backend = lspExists("dist/backend.js")
      ? runWithStandIn(BACKEND_PROBE, join(extension, "dist", "backend.js"))
      : { status: 1, stdout: "", stderr: "" };
    errors.push(...checkBackendBundle(lspExists, backend.status === 0 ? backend.stdout : failure(backend)));

    step("MCP bridge: initialize and tools/list");
    const mcp = await mcpBridge(extension);
    errors.push(...checkMcpBridge(mcp.lines, mcp.exitCode));

    if (existsSync(join(extension, "runtime")))
      errors.push("the package carries runtime/: the extension runs the user's own opentide");
    console.log(
      `smoke: ${count} files, no runtime: the user's opentide, else the WASI module, else the engine`,
    );
  } finally {
    if (keep) console.log(`smoke: kept ${temp}`);
    else rmSync(temp, { recursive: true, force: true });
  }
  return errors;
}

async function main() {
  if (vsixFiles.length === 0) throw new SmokeError("usage: npm run smoke -- <file.vsix>... [--keep]");
  let failed = false;
  for (const vsix of vsixFiles) {
    const errors = await smoke(vsix);
    for (const error of errors) console.error(`smoke: FAIL ${vsix}: ${error}`);
    if (errors.length > 0) failed = true;
    else console.log(`smoke: OK ${vsix}`);
  }
  if (failed) process.exit(1);
  console.log(`smoke: OK (${vsixFiles.length} package${vsixFiles.length === 1 ? "" : "s"})`);
}

main().catch((error) => {
  if (error instanceof SmokeError || error instanceof PackageError) {
    console.error(`smoke: ${error.message}`);
    process.exit(1);
  }
  throw error;
});
