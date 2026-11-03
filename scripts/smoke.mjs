#!/usr/bin/env node
// Smoke-tests a per-platform VSIX on a machine of its target (SPEC §3 "Smoke test"):
//   1. unpack the VSIX into a temporary folder (file modes kept);
//   2. the bundled `python -I -m opentide --version` is the version the runtime was built with;
//   3. `opentide setup --path <tmp> --yes`, then `opentide --json doctor --offline` in it;
//   4. `opentide lsp start`: `initialize` reports host.name "opentide" and the pinned engine.
//   node scripts/smoke.mjs <file.vsix> [--keep]
// Exits non-zero on any failure. A universal VSIX has no runtime: it only checks there is none.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PackageError, zipEntries, zipRead } from "./package-lib.mjs";
import {
  bundledPython,
  checkDoctor,
  checkInitialize,
  checkVersion,
  FrameReader,
  frame,
  opentideArgs,
  SmokeError,
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

function run(command, argv, cwd) {
  const result = spawnSync(command, argv, {
    cwd,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new SmokeError(`${argv.slice(4).join(" ")}: ${result.error.message}`);
  return result;
}

function initialize(command, argv, workspace) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, argv, { cwd: workspace, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    const reader = new FrameReader();
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new SmokeError(`no initialize response in ${TIMEOUT_MS / 1000} s; stderr:\n${stderr}`));
    }, TIMEOUT_MS);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new SmokeError(`lsp start: ${error.message}`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new SmokeError(`lsp start exited with ${code} before answering; stderr:\n${stderr}`));
    });
    child.stdout.on("data", (chunk) => {
      for (const message of reader.push(chunk)) {
        if (message.id !== 1) continue;
        clearTimeout(timer);
        child.removeAllListeners("exit");
        child.stdin.write(frame({ jsonrpc: "2.0", id: 2, method: "shutdown" }));
        child.stdin.write(frame({ jsonrpc: "2.0", method: "exit" }));
        const kill = setTimeout(() => child.kill(), 10_000);
        child.on("exit", () => {
          clearTimeout(kill);
          resolvePromise(message);
        });
      }
    });
    const uri = pathToFileURL(workspace).href;
    child.stdin.write(
      frame({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          processId: process.pid,
          rootUri: uri,
          capabilities: {},
          workspaceFolders: [{ uri, name: "smoke" }],
          clientInfo: { name: "opentide smoke test" },
        },
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
    const infoPath = join(extension, "runtime", "BUILD-INFO.json");
    if (!existsSync(infoPath)) {
      if (existsSync(join(extension, "runtime"))) throw new SmokeError("runtime/ has no BUILD-INFO.json");
      console.log(`smoke: universal package (${count} files, no runtime): nothing to run`);
      return;
    }
    const info = JSON.parse(readFileSync(infoPath, "utf8"));
    const python = bundledPython(extension, process.platform, join);
    if (!existsSync(python))
      throw new SmokeError(`no bundled interpreter at ${python} (built for ${info.target})`);
    const pycache = join(temp, "pycache");
    const opentide = (argv) => opentideArgs(pycache, argv);

    step(`${info.target}: opentide --version`);
    const version = run(python, opentide(["--version"]), temp);
    errors.push(
      ...(version.status === 0
        ? checkVersion(version.stdout, info.opentide)
        : [`--version exited ${version.status}: ${version.stderr}`]),
    );

    const workspace = join(temp, "workspace");
    step("opentide setup --path <tmp> --yes");
    const setup = run(python, opentide(["--json", "setup", "--path", workspace, "--yes"]), temp);
    if (setup.status !== 0)
      errors.push(`setup exited ${setup.status}: ${setup.stdout.slice(0, 400)} ${setup.stderr}`);

    step("opentide --json doctor --offline");
    const doctor = run(python, opentide(["--json", "doctor", "--offline"]), workspace);
    errors.push(...checkDoctor(doctor.stdout));

    step("opentide lsp start: initialize");
    const response = await initialize(python, opentide(["lsp", "start"]), workspace);
    errors.push(...checkInitialize(response, { opentide: info.opentide, engine: info.engine }));
    const host = response.result?.capabilities?.experimental?.opentide;
    if (host) console.log(`smoke: host ${host.host?.name} ${host.host?.version}, engine ${host.engine}`);
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
