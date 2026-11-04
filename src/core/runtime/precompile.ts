// Compiles the bundled runtime's bytecode once per runtime build, in the background (SPEC §3 "At
// runtime"): `python -I -X pycache_prefix=<globalStorage>/pycache -m compileall -q <stdlib>`, at low
// priority and cancellable, so the first commands do not pay for it and the extension folder stays
// read-only. vscode-free: the side effects are injected.
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { processEnv } from "./env";
import type { Runtime } from "./types";

export type PrecompileOutcome = "compiled" | "already-compiled" | "not-bundled" | "cancelled" | "failed";

export interface PrecompileProcess {
  readonly pid: number | undefined;
  /** Resolves with the exit code, or null when the process was killed or could not start. */
  readonly exited: Promise<number | null>;
  kill(): void;
}

export interface PrecompileDeps {
  readonly platform: NodeJS.Platform;
  readonly extensionPath: string;
  readonly globalStoragePath: string;
  readFile(file: string): Promise<string | undefined>;
  writeFile(file: string, text: string): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  exists(file: string): boolean;
  /** The path with symbolic links resolved, or the path itself when it cannot be resolved. */
  realpath(file: string): Promise<string>;
  remove(dir: string): Promise<void>;
  spawn(command: string, args: readonly string[], runtime: Runtime): PrecompileProcess;
  lowerPriority(pid: number): void;
  log(level: "debug" | "info" | "warn", message: string): void;
  now(): number;
}

/** The bytecode cache of the bundled runtime: the `-X pycache_prefix` of `bundledArgs`. */
export function pycachePrefix(globalStoragePath: string): string {
  return path.join(globalStoragePath, "pycache");
}

/**
 * Which builds have been compiled, and from where: one entry per build and runtime folder (an update
 * with the same build moves the runtime to a new folder, whose bytecode is a new tree). Older stamp
 * files keyed an entry by its build id alone, without `buildId`.
 */
export interface PrecompileStamps {
  readonly builds: Record<
    string,
    { readonly buildId?: string; readonly root: string; readonly compiledAt: string }
  >;
}

/** The key of a build's entry in the stamps. */
export function stampKey(buildId: string, root: string): string {
  return `${buildId}@${root}`;
}

export function stampFile(prefix: string): string {
  return path.join(prefix, "compiled.json");
}

export function parseStamps(text: string | undefined): PrecompileStamps {
  if (!text) return { builds: {} };
  try {
    const value = JSON.parse(text) as { builds?: unknown };
    if (value && typeof value.builds === "object" && value.builds !== null) {
      return { builds: value.builds as PrecompileStamps["builds"] };
    }
  } catch {
    // a broken stamp file compiles again
  }
  return { builds: {} };
}

/** The runtime build id from `runtime/BUILD-INFO.json` (written by scripts/runtime-build.mjs). */
export function parseBuildId(text: string | undefined): string | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as { buildId?: unknown };
    return typeof value.buildId === "string" && /^[A-Za-z0-9._-]+$/.test(value.buildId)
      ? value.buildId
      : undefined;
  } catch {
    return undefined;
  }
}

/** The standard library folder (site-packages is inside it): `lib/python3.X`, or `Lib` on Windows. */
export function stdlibDir(
  root: string,
  platform: NodeJS.Platform,
  libEntries: readonly string[],
): string | undefined {
  if (platform === "win32") return path.win32.join(root, "Lib");
  const minor = libEntries.filter((name) => /^python3\.\d+$/.test(name)).sort();
  const last = minor[minor.length - 1];
  return last ? path.posix.join(root, "lib", last) : undefined;
}

/** `{command, args}` of the compile run. */
export function compileCommand(
  runtime: Runtime,
  dir: string,
  prefix: string,
): { command: string; args: string[] } {
  return {
    command: runtime.command,
    args: ["-I", "-X", `pycache_prefix=${prefix}`, "-m", "compileall", "-q", dir],
  };
}

/**
 * Where Python puts the bytecode of the sources under `root` for a `pycache_prefix`: the prefix joined
 * with the absolute path, its drive and leading separators removed (importlib's cache_from_source).
 */
export function pycacheTree(prefix: string, root: string, platform: NodeJS.Platform): string {
  const p = platform === "win32" ? path.win32 : path.posix;
  let head = root;
  if (platform === "win32" && /^[A-Za-z]:/.test(head)) head = head.slice(2);
  head = head.replace(platform === "win32" ? /^[\\/]+/ : /^\/+/, "");
  return p.join(prefix, head);
}

export class Precompiler {
  private running:
    | { buildId: string; promise: Promise<PrecompileOutcome>; process?: PrecompileProcess }
    | undefined;
  private cancelled = false;
  private disposed = false;

  constructor(private readonly deps: PrecompileDeps) {}

  /** The runtime's folder (`<extensionPath>/runtime`). */
  get root(): string {
    return (this.deps.platform === "win32" ? path.win32 : path.posix).join(
      this.deps.extensionPath,
      "runtime",
    );
  }

  /**
   * Compile the bundled runtime once per build. Anything but tier 4 is `not-bundled`; a call while a
   * compile of the same build runs shares it.
   */
  ensure(runtime: Runtime | undefined): Promise<PrecompileOutcome> {
    if (this.disposed || !runtime || runtime.source !== "bundled") return Promise.resolve("not-bundled");
    if (this.running) return this.running.promise;
    const state: { buildId: string; promise: Promise<PrecompileOutcome>; process?: PrecompileProcess } = {
      buildId: "",
      promise: Promise.resolve("not-bundled"),
    };
    state.promise = this.run(runtime, state).finally(() => {
      if (this.running === state) this.running = undefined;
    });
    this.running = state;
    return state.promise;
  }

  /** Stop a running compile; it starts again with the next `ensure`. */
  cancel(): void {
    if (!this.running?.process) return;
    this.cancelled = true;
    this.running.process.kill();
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private async run(
    runtime: Runtime,
    state: { buildId: string; process?: PrecompileProcess },
  ): Promise<PrecompileOutcome> {
    const { deps } = this;
    const p = deps.platform === "win32" ? path.win32 : path.posix;
    // The resolved folder: Python imports from the real path of a symlinked extension folder, so
    // bytecode compiled under the link's path would never be read, and its cleanup would miss.
    const root = await deps.realpath(this.root);
    const prefix = pycachePrefix(deps.globalStoragePath);
    const buildId =
      parseBuildId(await deps.readFile(p.join(root, "BUILD-INFO.json"))) ??
      `opentide-${runtime.version}-${root.replace(/[^A-Za-z0-9]+/g, "_")}`;
    state.buildId = buildId;
    const stamps = parseStamps(await deps.readFile(stampFile(prefix)));
    const compiled = Object.entries(stamps.builds).some(
      ([key, build]) => (build.buildId ?? key) === buildId && build.root === root,
    );
    if (compiled) return "already-compiled";

    const dir = stdlibDir(
      root,
      deps.platform,
      deps.platform === "win32" ? [] : await deps.readdir(p.join(root, "lib")),
    );
    if (!dir) {
      deps.log("warn", `bytecode: no standard library under ${root}`);
      return "failed";
    }
    if (this.disposed) return "cancelled";
    const { command, args } = compileCommand(runtime, dir, prefix);
    const started = deps.now();
    deps.log("info", `bytecode: compiling the bundled runtime (build ${buildId}) in the background`);
    this.cancelled = false;
    const child = deps.spawn(command, args, runtime);
    state.process = child;
    if (child.pid !== undefined) {
      try {
        deps.lowerPriority(child.pid);
      } catch {
        // a priority the OS refuses leaves it at normal priority
      }
    }
    const code = await child.exited;
    if (this.cancelled || this.disposed) {
      deps.log("info", "bytecode: compile cancelled");
      return "cancelled";
    }
    // compileall exits 1 when some file does not compile (a module for another Python): still done.
    if (code !== 0 && code !== 1) {
      deps.log("warn", `bytecode: compileall exited with ${code}`);
      return "failed";
    }
    const builds: PrecompileStamps["builds"] = {
      [stampKey(buildId, root)]: { buildId, root, compiledAt: new Date(deps.now()).toISOString() },
    };
    // Drop the bytecode of builds whose runtime folder is gone (an older extension version, with this
    // build id or another). An entry for this folder is superseded: its tree is the one just compiled.
    for (const [key, build] of Object.entries(stamps.builds)) {
      if (build.root === root) continue;
      if (!deps.exists(build.root)) {
        await deps.remove(pycacheTree(prefix, build.root, deps.platform)).catch(() => undefined);
      } else {
        builds[key] = build;
      }
    }
    await deps.writeFile(stampFile(prefix), `${JSON.stringify({ builds }, null, 2)}\n`);
    deps.log("info", `bytecode: compiled in ${((deps.now() - started) / 1000).toFixed(1)} s`);
    return "compiled";
  }
}

/** The Node implementations of the precompiler's side effects. */
export function nodePrecompileDeps(
  extensionPath: string,
  globalStoragePath: string,
  log: PrecompileDeps["log"],
): PrecompileDeps {
  return {
    platform: process.platform,
    extensionPath,
    globalStoragePath,
    readFile: (file) => fs.promises.readFile(file, "utf8").catch(() => undefined),
    writeFile: async (file, text) => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, text);
    },
    readdir: (dir) => fs.promises.readdir(dir).catch(() => []),
    exists: (file) => fs.existsSync(file),
    realpath: (file) => fs.promises.realpath(file).catch(() => file),
    remove: (dir) => fs.promises.rm(dir, { recursive: true, force: true }),
    spawn: (command, args, runtime) => {
      let child: cp.ChildProcess | undefined;
      const exited = new Promise<number | null>((resolve) => {
        try {
          child = cp.spawn(command, [...args], {
            env: processEnv(process.env, runtime, process.platform, { NO_COLOR: "1" }),
            stdio: ["ignore", "ignore", "pipe"],
            windowsHide: true,
          });
        } catch (error) {
          log("warn", `bytecode: could not start ${command}: ${String(error)}`);
          resolve(null);
          return;
        }
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          if (stderr.length < 4096) stderr += chunk.toString("utf8");
        });
        child.on("error", (error) => {
          log("warn", `bytecode: ${String(error)}`);
          resolve(null);
        });
        child.on("exit", (code) => {
          if (stderr.trim()) log("debug", `bytecode: ${stderr.trim()}`);
          resolve(code);
        });
      });
      return {
        get pid() {
          return child?.pid;
        },
        exited,
        kill: () => child?.kill(),
      };
    },
    lowerPriority: (pid) => os.setPriority(pid, os.constants.priority.PRIORITY_LOW),
    log,
    now: () => Date.now(),
  };
}
