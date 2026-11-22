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

/** The variable that names the folders to mount, as the extension host chooses their guest paths. */
const MOUNTS = "OPENTIDE_WASI_MOUNTS";

/** `OPENTIDE_WASI_MOUNTS`: a JSON list of `{host, guest}`, or undefined when it is unset or not one. */
function mountsOf(env) {
  try {
    const list = JSON.parse(env[MOUNTS] ?? "null");
    if (!Array.isArray(list) || list.length === 0) return undefined;
    const mounts = list.filter(
      (entry) =>
        entry &&
        typeof entry.host === "string" &&
        typeof entry.guest === "string" &&
        entry.guest.startsWith("/"),
    );
    return mounts.length > 0 ? mounts : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Preopens and path variables for a run in `cwd`. Exported for the tests. With `OPENTIDE_WASI_MOUNTS` the
 * extension host chooses the mounts (every folder of its window; `serve` and the language server run this
 * way, and map paths as they do under @vscode/wasm-wasi); without it, the working directory and
 * `OPENTIDE_REPO_ROOT` are mounted as below.
 */
function layout(cwd, env, platform = process.platform) {
  const chosen = mountsOf(env);
  if (chosen) {
    const preopens = {};
    for (const { host, guest } of chosen) preopens[guest] = host;
    if (platform !== "win32") preopens["/tmp"] = os.tmpdir();
    return { preopens, env: { PWD: chosen[0].guest } };
  }
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

const ESUCCESS = 0;
const ENOSYS = 52;
/** WASI `filetype`s of a directory entry. */
const FILETYPE = { unknown: 0, directory: 3, file: 4, symlink: 7 };

/**
 * Node's WASI answers `fd_readdir` with ENOSYS on Windows (uvwasi has no directory listing there): the module
 * cannot read a folder, `.opentide/configurations` or the object folders, and `validate` fails with "Function not
 * implemented (os error 52)". Where the host says ENOSYS, this lists the folder itself: it follows the paths the
 * module opens (`path_open` and `fd_close`, from the preopens, which Node numbers from 3 in their order) and
 * writes the `dirent` records WASI defines. Anything else is Node's own. `memory()` is the instance's memory as a
 * DataView. Exported for the tests, which run it on POSIX with a host that answers ENOSYS.
 */
function withDirectoryListing(imports, hostPreopens, memory, fsImpl = fs) {
  const ns = imports.wasi_snapshot_preview1;
  const folders = new Map();
  hostPreopens.forEach((host, index) => {
    folders.set(3 + index, host);
  });
  const { path_open: pathOpen, fd_close: fdClose, fd_readdir: fdReaddir } = ns;
  ns.path_open = (
    dirfd,
    dirflags,
    pathPtr,
    pathLen,
    oflags,
    rightsBase,
    rightsInheriting,
    fdflags,
    outPtr,
  ) => {
    const result = pathOpen(
      dirfd,
      dirflags,
      pathPtr,
      pathLen,
      oflags,
      rightsBase,
      rightsInheriting,
      fdflags,
      outPtr,
    );
    const base = folders.get(dirfd);
    if (result === ESUCCESS && base !== undefined) {
      const view = memory();
      const relative = Buffer.from(view.buffer, view.byteOffset + pathPtr, pathLen).toString("utf8");
      folders.set(view.getUint32(outPtr, true), path.join(base, relative));
    }
    return result;
  };
  ns.fd_close = (fd) => {
    const result = fdClose(fd);
    if (result === ESUCCESS) folders.delete(fd);
    return result;
  };
  ns.fd_readdir = (fd, bufPtr, bufLen, cookie, usedPtr) => {
    const result = fdReaddir(fd, bufPtr, bufLen, cookie, usedPtr);
    const folder = folders.get(fd);
    if (result !== ENOSYS || folder === undefined) return result;
    let entries;
    try {
      entries = fsImpl.readdirSync(folder, { withFileTypes: true });
    } catch {
      return result;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const records = [
      { name: ".", type: FILETYPE.directory },
      { name: "..", type: FILETYPE.directory },
    ].concat(
      entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory()
          ? FILETYPE.directory
          : entry.isFile()
            ? FILETYPE.file
            : entry.isSymbolicLink()
              ? FILETYPE.symlink
              : FILETYPE.unknown,
      })),
    );
    const view = memory();
    const out = Buffer.from(view.buffer, view.byteOffset + bufPtr, bufLen);
    let used = 0;
    for (let index = Number(cookie); index < records.length && used < bufLen; index += 1) {
      const name = Buffer.from(records[index].name, "utf8");
      const record = Buffer.alloc(24 + name.length);
      record.writeBigUInt64LE(BigInt(index + 1), 0); // d_next: where to resume
      record.writeBigUInt64LE(0n, 8); // d_ino
      record.writeUInt32LE(name.length, 16); // d_namlen
      record.writeUInt8(records[index].type, 20); // d_type
      name.copy(record, 24);
      const taken = Math.min(record.length, bufLen - used);
      record.copy(out, used, 0, taken);
      used += taken;
      if (taken < record.length) break;
    }
    view.setUint32(usedPtr, used, true);
    return ESUCCESS;
  };
  return imports;
}

/** The environment the module gets: this process's, without the variable that makes Electron a Node. */
function moduleEnv(env) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && name !== "ELECTRON_RUN_AS_NODE" && name !== MOUNTS) out[name] = value;
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
  const placed = layout(process.cwd(), process.env);
  const wasi = new WASI({
    version: "preview1",
    args: ["opentide", ...args],
    env: { ...base, ...placed.env },
    preopens: placed.preopens,
    returnOnExit: true,
  });
  const module = await WebAssembly.compile(fs.readFileSync(file));
  let instance;
  const imports = withDirectoryListing(
    wasi.getImportObject(),
    Object.values(placed.preopens),
    () => new DataView(instance.exports.memory.buffer),
  );
  instance = await WebAssembly.instantiate(module, imports);
  return wasi.start(instance);
}

module.exports = { layout, moduleEnv, withDirectoryListing, MOUNTS };

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
