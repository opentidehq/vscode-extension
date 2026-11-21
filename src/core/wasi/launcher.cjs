// Runs the opentide WASI module as a command, under Node's own WASI: dist/wasi/launcher.cjs.
//
//   <node> launcher.cjs <opentide.wasm> [opentide arguments...]
//
// The extension runs `serve` and the language server in the extension host, under @vscode/wasm-wasi. VS Code
// itself starts a process where it asks for a command: an MCP server definition, a task, a terminal. This
// is that command: it runs the same module with the same arguments, exits with the module's exit code and
// speaks stdio as the native `opentide` does. The extension starts it with VS Code's own Node
// (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`).
//
// The module sees the working directory, the temporary folder and the folder `OPENTIDE_REPO_ROOT` names
// (where they are, on POSIX; the working directory is `/workspace` on Windows, where a drive path is not a
// WASI path) and the environment it is started with. It has no network: a tenant command says so and names
// the native CLI; the extension's own backend makes tenant requests through `opentide/fetch` instead.
//
// Plain CommonJS with no dependencies, so the extension, its smoke test and its tests all run it as it is.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// `node:wasi` warns on stderr that it is experimental, once per process: a line in every terminal command.
const emitWarning = process.emitWarning;
process.emitWarning = () => undefined;
const { WASI } = require("node:wasi");
process.emitWarning = emitWarning;

// Node 22's fast WASI calls can start a garbage collection inside a call, which crashes once the instance
// holds enough memory (opentide's scripts/engine/wasi-run.mjs and build-wasm.sh run theirs with this flag).
try {
  require("node:v8").setFlagsFromString("--no-turbo-fast-api-calls");
} catch {
  // a host that forbids V8 flags: the module runs as it is
}

/** The guest path of a host folder: itself on POSIX, a fixed name where a path cannot be one. */
function guestOf(folder, fallback, platform = process.platform) {
  return platform === "win32" ? fallback : folder;
}

/** Preopens and path variables for a run in `cwd`. Exported for the tests. */
function layout(cwd, env, platform = process.platform) {
  const preopens = {};
  const guest = guestOf(cwd, "/workspace", platform);
  preopens[guest] = cwd;
  const mapped = {};
  const root = env.OPENTIDE_REPO_ROOT;
  if (root && path.resolve(root) !== path.resolve(cwd) && fs.existsSync(root)) {
    const rootGuest = guestOf(root, "/repository", platform);
    preopens[rootGuest] = root;
    mapped.OPENTIDE_REPO_ROOT = rootGuest;
  } else if (root) {
    mapped.OPENTIDE_REPO_ROOT = guest;
  }
  if (platform !== "win32") preopens["/tmp"] = os.tmpdir();
  return { preopens, env: { ...mapped, PWD: guest } };
}

/** The environment the module gets: this process's, without the variable that makes Electron a Node. */
function moduleEnv(env) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && name !== "ELECTRON_RUN_AS_NODE") out[name] = value;
  }
  return out;
}

async function main(argv) {
  const [file, ...args] = argv;
  if (!file) {
    process.stderr.write("usage: launcher.cjs <opentide.wasm> [opentide arguments...]\n");
    return 2;
  }
  const base = moduleEnv(process.env);
  const placed = layout(process.cwd(), base);
  const wasi = new WASI({
    version: "preview1",
    args: ["opentide", ...args],
    env: { ...base, ...placed.env },
    preopens: placed.preopens,
    returnOnExit: true,
  });
  const module = await WebAssembly.compile(fs.readFileSync(file));
  const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
  return wasi.start(instance);
}

module.exports = { layout, moduleEnv };

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`opentide (WASI): ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
