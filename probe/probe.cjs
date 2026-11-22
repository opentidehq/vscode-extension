// Windows probe: run the opentide WASI module under node:wasi as src/core/wasi/launcher.cjs does, and log every
// WASI call that returns an error (ENOSYS=52 first), with its arguments. Investigation only.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { WASI } = require("node:wasi");

const ERRNO = { 0: "ESUCCESS", 8: "EBADF", 20: "ENOTDIR", 28: "EINVAL", 44: "ENOENT", 52: "ENOSYS", 54: "ENOTCAPABLE", 58: "ENOTSUP", 63: "EPERM" };
const wasmFile = process.argv[2];
const args = process.argv.slice(3);
const cwd = process.cwd();

async function run(label, preopens, env, argv) {
  console.log(`\n===== ${label}: opentide ${argv.join(" ")}`);
  console.log(`preopens: ${JSON.stringify(preopens)}`);
  const wasi = new WASI({ version: "preview1", args: ["opentide", ...argv], env: { ...process.env, ...env }, preopens, returnOnExit: true });
  const imports = wasi.getImportObject();
  const ns = imports.wasi_snapshot_preview1;
  const seen = new Map();
  let memory;
  for (const [name, fn] of Object.entries(ns)) {
    if (typeof fn !== "function") continue;
    ns[name] = (...a) => {
      const r = fn(...a);
      if (r !== 0) {
        const key = `${name} -> ${ERRNO[r] ?? r}`;
        const entry = seen.get(key) ?? { count: 0, first: a };
        entry.count += 1;
        seen.set(key, entry);
      }
      return r;
    };
  }
  const module = await WebAssembly.compile(fs.readFileSync(wasmFile));
  const instance = await WebAssembly.instantiate(module, imports);
  const code = wasi.start(instance);
  console.log(`exit code ${code}`);
  for (const [key, { count, first }] of seen) console.log(`  ${key} x${count} first args ${JSON.stringify(first, (k, v) => (typeof v === "bigint" ? `${v}n` : v))}`);
}

(async () => {
  const guest = "/workspace";
  await run("cwd mount at /workspace (launcher default on win32)", { [guest]: cwd }, { PWD: guest, OPENTIDE_REPO_ROOT: guest }, args);
  await run("workspace mounted at the drive path's posix form", { "/w": cwd }, { PWD: "/w", OPENTIDE_REPO_ROOT: "/w" }, args);
  await run("config dir listing", { [guest]: cwd }, { PWD: guest, OPENTIDE_REPO_ROOT: guest }, ["--json", "info", "catalog"]);
})().catch((e) => { console.error(e); process.exitCode = 1; });
