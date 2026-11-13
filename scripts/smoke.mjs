#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
// Smoke-tests a VSIX (SPEC §3 "Smoke test"):
//   1. unpack the VSIX into a temporary folder (file modes kept);
//   2. it carries no runtime/ (no Python);
//   3. a platform VSIX (opentide-<target>-<version>.vsix) carries @opentide/opentide for its platform in
//      dist/opentide/, and none in the universal one; on a machine of that platform, the package's bin, run
//      as the extension runs it (`<node> dist/opentide/cli.js`), prints opentide.json's version, has the
//      commands the extension needs (`--json commands`), and `lsp start` answers `initialize`;
//   4. the engine (WASM) worker, dist/engine/worker.js, answers `initialize` with the version engine.json
//      records and no host, and the web extension is there (package.json `browser` and its Web Worker,
//      dist/web/engine-worker.js), so the Marketplace offers the package on vscode.dev and github.dev.
//   node scripts/smoke.mjs <file.vsix> [--keep]
// Exits non-zero on any failure.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { hostTarget, isMusl, napiPlatform, TARGETS } from "./opentide-lib.mjs";
import { PackageError, zipEntries, zipRead } from "./package-lib.mjs";
import {
  checkEngineInitialize,
  checkPackageCommands,
  checkPackageInitialize,
  checkPackageLayout,
  checkWebEntry,
  SmokeError,
  versionOf,
} from "./smoke-lib.mjs";

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

/** The VSIX target its file name carries (`opentide-<target>-<version>.vsix`), or undefined for universal. */
function targetOf(file) {
  const match = /^opentide-([a-z0-9]+-[a-z0-9]+)-\d/.exec(basename(file));
  return match?.[1] && Object.hasOwn(TARGETS, match[1]) ? match[1] : undefined;
}

/** `opentide lsp start` from the package: `initialize`, then `shutdown` and `exit`, over stdio. */
function packageInitialize(cli) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, "lsp", "start"], { stdio: ["pipe", "pipe", "inherit"] });
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new SmokeError(`the bundled opentide lsp start did not answer initialize in ${TIMEOUT_MS / 1000} s`),
      );
    }, TIMEOUT_MS);
    let buffer = Buffer.alloc(0);
    let response;
    const send = (message) => {
      const body = Buffer.from(JSON.stringify(message), "utf8");
      child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      child.stdin.write(body);
    };
    child.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const length = Number(/Content-Length: *(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
        if (buffer.length < end + 4 + length) return;
        const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString("utf8"));
        buffer = buffer.subarray(end + 4 + length);
        if (message.id === 1 && !response) {
          response = message;
          send({ jsonrpc: "2.0", id: 2, method: "shutdown" });
          send({ jsonrpc: "2.0", method: "exit" });
        }
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new SmokeError(`bundled opentide lsp start: ${error.message}`));
    });
    child.on("exit", () => {
      clearTimeout(timer);
      if (response) resolvePromise(response);
      else reject(new SmokeError("the bundled opentide lsp start exited before answering initialize"));
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { processId: null, rootUri: null, capabilities: {} },
    });
  });
}

/** dist/opentide/ of a platform VSIX, and none in the universal one; its bin runs on a machine of its platform. */
async function packageChecks(extension, target) {
  const dir = join(extension, "dist", "opentide");
  if (!target) {
    return existsSync(dir)
      ? ["the universal package carries dist/opentide/: it must carry no native code"]
      : [];
  }
  const platform = napiPlatform(target);
  const manifestPath = join(dir, "opentide.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : undefined;
  const errors = checkPackageLayout(manifest, platform, (file) =>
    existsSync(join(extension, ...file.split("/"))),
  );
  if (errors.length > 0) return errors;
  if (hostTarget(process.platform, process.arch, isMusl()) !== target) {
    console.log(`smoke: @opentide/opentide ${manifest.version} for ${platform}: not run on this machine`);
    return errors;
  }
  const cli = join(dir, manifest.cli);
  const run = (argv) =>
    spawnSync(process.execPath, [cli, ...argv], {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
  step("@opentide/opentide: --version");
  const version = run(["--version"]);
  if (version.status !== 0) return [`bundled opentide --version exited ${version.status}: ${version.stderr}`];
  if (versionOf(version.stdout) !== manifest.version)
    errors.push(
      `bundled opentide --version says ${version.stdout.trim()}, opentide.json ${manifest.version}`,
    );
  step("@opentide/opentide: --json commands");
  const commands = run(["--json", "commands"]);
  if (commands.status !== 0) errors.push(`bundled opentide --json commands exited ${commands.status}`);
  else errors.push(...checkPackageCommands(JSON.parse(commands.stdout)));
  step("@opentide/opentide: lsp start answers initialize");
  errors.push(...checkPackageInitialize(await packageInitialize(cli)));
  console.log(`smoke: @opentide/opentide ${manifest.version} (${platform}) runs`);
  return errors;
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

    step("@opentide/opentide in dist/opentide");
    errors.push(...(await packageChecks(extension, targetOf(vsix))));

    if (existsSync(join(extension, "runtime")))
      errors.push("the package carries runtime/: there is no Python runtime");
    console.log(`smoke: ${count} files, no runtime/`);
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
