// Runtime resolution in five tiers (SPEC §4, #3): the WASI module the extension carries (opentide's CLI on
// wasm32-wasip1) is the default; the user's own install (tiers 1-3) is opt-in with `opentide.runtime: installed`, or an
// explicit `opentide.path`; the engine (WASM) is the last resort. vscode-free: every side effect is injected, so
// the tier logic is unit-tested with fakes.
//
// Tiers 1-3 are the user's own install: the extension carries no Python. Where its console script cannot
// run (not on PATH, a pip --user install, or blocked by an application-control policy that allows the
// signed python but not the unsigned opentide launcher), the same interpreter runs `python -m opentide`.
// Whichever mode comes first, the other is the fallback, with a notice: nothing falls through silently.
import * as path from "node:path";

import type { RepoPin } from "./pins";
import type { ResolveAttempt, ResolveResult, Runtime, RuntimeSource, RuntimeTier, WasiModule } from "./types";
import {
  atLeast,
  checkMinimum,
  MIN_ENGINE_VERSION,
  MIN_OPENTIDE_VERSION,
  parseEngineVersionOutput,
  parseOpentideVersionOutput,
} from "./version";

export interface ProbeResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the process could not start or timed out. */
  readonly error?: string;
}

export interface ProbeOptions {
  /** Added to the process environment (see `processEnv`). */
  readonly env: Readonly<Record<string, string>>;
  /** Restricted Mode: the probe runs with the locked-down environment (no opentide tier probes then). */
  readonly restricted: boolean;
  readonly binDirs: readonly string[];
  readonly timeoutMs: number;
  /** Aborting it ends the probe's process at once (a restart must not wait for a probe that no longer matters). */
  readonly signal?: AbortSignal | undefined;
}

/** The settings the resolver reads. Restricted keys are read only when the workspace is trusted. */
export interface RuntimeSettings {
  readonly path: () => string | undefined;
  readonly interpreter: () => string | undefined;
  readonly uvUsePin: () => boolean | undefined;
  readonly uvPath: () => string | undefined;
  /** `opentide.wasi.enabled`: false leaves the WASI module out (the engine runs when no opentide does). */
  readonly wasi: () => boolean | undefined;
  /**
   * `opentide.runtime` as the user set it: undefined when it is at its default (not set anywhere), so an explicit
   * `opentide.path` can still choose the installed runtime.
   */
  readonly runtime?: () => RuntimeMode | undefined;
}

/** Which runtimes are tried first: the one the extension carries, or the user's own install. */
export type RuntimeMode = "bundled" | "installed";

/**
 * The mode, and why. `opentide.runtime` when set; else `installed` when `opentide.path` is set (naming a
 * binary is a clear choice, and existing configurations keep working); else `bundled`.
 */
export function chooseRuntimeMode(settings: RuntimeSettings): { mode: RuntimeMode; reason: string } {
  const explicit = settings.runtime?.();
  if (explicit === "bundled" || explicit === "installed")
    return { mode: explicit, reason: `opentide.runtime is "${explicit}"` };
  if (settings.path()?.trim())
    return {
      mode: "installed",
      reason: "opentide.path is set, which selects the installed opentide (opentide.runtime is not set)",
    };
  return { mode: "bundled", reason: "opentide.runtime is at its default, bundled" };
}

export interface ResolveInput {
  readonly trusted: boolean;
  readonly platform: NodeJS.Platform;
  /** The folder the window's runtime is resolved for (the first opentide folder). */
  readonly folder: string | undefined;
  readonly settings: RuntimeSettings;
  readonly pin: RepoPin | undefined;
  /** VS Code's `http.proxy`, passed to uv. */
  readonly proxy: string | undefined;
  readonly homeDir: string;
  exists(file: string): boolean;
  which(name: string): string | undefined;
  probe(command: string, args: readonly string[], options: ProbeOptions): Promise<ProbeResult>;
  /** The interpreter the Python Environments extension picked for `folder`, when installed. */
  pythonEnvironments(): Promise<string | undefined>;
  /** The interpreter the Python extension picked for `folder`, when installed. */
  pythonExtension(): Promise<string | undefined>;
  /** Tier 4: the WASI module this build carries, from dist/wasi/wasi.json; undefined without one. */
  readonly wasi?: WasiLayout | undefined;
  /** Tier 5: the engine (WASM) this build carries, from dist/engine/engine.json; undefined without one. */
  readonly engine?: EngineLayout | undefined;
  /** Aborted when the resolution is stale: its probes end and the rest of the tiers are not tried. */
  readonly signal?: AbortSignal | undefined;
}

/** The WASI module in the extension: its files, its version, and the Node that runs its launcher. */
export interface WasiLayout extends WasiModule {
  readonly version: string;
  /** VS Code's own Node: `process.execPath`, run with `ELECTRON_RUN_AS_NODE=1`. */
  readonly execPath: string;
}

/** A parsed manifest, or why it is unusable (a message fit for the log). */
export type ManifestResult<T> = { readonly layout: T } | { readonly problem: string };

/** The JSON object in a manifest's text, or why it is not one. */
function manifestObject(text: string, what: string): Record<string, unknown> | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return `${what} is not valid JSON (${error instanceof Error ? error.message : String(error)})`;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return `${what} is not a JSON object`;
  return value as Record<string, unknown>;
}

/** A manifest field that must name a file next to the manifest: a non-empty string without a path in it. */
function manifestFile(
  manifest: Record<string, unknown>,
  key: string,
  what: string,
): string | { problem: string } {
  const value = manifest[key];
  if (typeof value !== "string" || value === "") return { problem: `${what} has no ${key} (a file name)` };
  if (value.includes("/") || value.includes("\\") || value === "." || value === "..")
    return { problem: `${what} names its ${key} with a path ("${value}"); it must be a file name` };
  return value;
}

/** `dist/wasi/wasi.json`'s fields, or the reason they are unusable. */
export function parseWasiManifest(text: string, dir: string, execPath: string): ManifestResult<WasiLayout> {
  const what = "dist/wasi/wasi.json";
  const manifest = manifestObject(text, what);
  if (typeof manifest === "string") return { problem: manifest };
  if (typeof manifest.version !== "string" || manifest.version === "")
    return { problem: `${what} has no version` };
  const module = manifestFile(manifest, "module", what);
  if (typeof module !== "string") return module;
  const launcher = manifestFile(manifest, "launcher", what);
  if (typeof launcher !== "string") return launcher;
  return {
    layout: {
      module: path.join(dir, module),
      launcher: path.join(dir, launcher),
      version: manifest.version,
      execPath,
    },
  };
}

/** `dist/wasi/wasi.json`'s fields, when they have the expected shape. */
export function readWasiManifest(
  text: string | undefined,
  dir: string,
  execPath: string,
): WasiLayout | undefined {
  if (!text) return undefined;
  const result = parseWasiManifest(text, dir, execPath);
  return "layout" in result ? result.layout : undefined;
}

/** The engine (WASM) in the extension: its module and version (dist/engine/engine.json). */
export interface EngineLayout {
  readonly module: string;
  readonly version: string;
}

/** `dist/engine/engine.json`'s fields, or the reason they are unusable. */
export function parseEngineManifest(text: string, dir: string): ManifestResult<EngineLayout> {
  const what = "dist/engine/engine.json";
  const manifest = manifestObject(text, what);
  if (typeof manifest === "string") return { problem: manifest };
  if (typeof manifest.version !== "string" || manifest.version === "")
    return { problem: `${what} has no version` };
  const module = manifestFile(manifest, "module", what);
  if (typeof module !== "string") return module;
  return { layout: { module: path.join(dir, module), version: manifest.version } };
}

/** `dist/engine/engine.json`'s fields, when they have the expected shape. */
export function readEngineManifest(text: string | undefined, dir: string): EngineLayout | undefined {
  if (!text) return undefined;
  const result = parseEngineManifest(text, dir);
  return "layout" in result ? result.layout : undefined;
}

const PROBE_TIMEOUT_MS = 20_000;
const UV_PROBE_TIMEOUT_MS = 180_000;

/**
 * What every opentide process gets: UTF-8 mode and UTF-8 stdio, so its output is UTF-8
 * on Windows too, where Python otherwise writes pipes in the ANSI code page. The extension decodes every
 * pipe as UTF-8. `PYTHONIOENCODING` also overrides one the user set, which UTF-8 mode does not.
 */
export const OPENTIDE_ENV: Readonly<Record<string, string>> = { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };

/** Expand `~` and `${workspaceFolder}`, and resolve a relative path against the folder. */
export function expandPath(value: string, folder: string | undefined, homeDir: string): string {
  let out = value.trim();
  if (out === "~" || out.startsWith("~/") || out.startsWith("~\\")) out = path.join(homeDir, out.slice(1));
  // VS Code's variable syntax, matched literally
  if (folder) out = out.replaceAll("${workspaceFolder}", folder);
  if (!path.isAbsolute(out) && folder && /[\\/]/.test(out)) out = path.resolve(folder, out);
  return out;
}

/**
 * The uv to run: `opentide.uv.path` (with `~` and `${workspaceFolder}` expanded, relative to the folder),
 * else `uv` on PATH. Tier 3 and "Create .venv with the pinned version" both use it.
 */
export function uvExecutable(
  setting: string | undefined,
  folder: string | undefined,
  homeDir: string,
  which: (name: string) => string | undefined,
): string | undefined {
  const value = setting?.trim();
  return value ? expandPath(value, folder, homeDir) : which("uv");
}

/** The arguments that run opentide as a module of an interpreter: `python -m opentide`. */
export const MODULE_ARGS: readonly string[] = ["-m", "opentide"];

/**
 * How to run opentide with an interpreter, in order: its console script next to it, when there is one,
 * then `python -m opentide`, which runs where the script does not (an application-control policy that
 * blocks the unsigned launcher but allows the signed interpreter, a launcher with a stale shebang).
 */
export function opentideForInterpreter(
  python: string,
  platform: NodeJS.Platform,
  exists: (file: string) => boolean,
): { command: string; args: string[] }[] {
  // The paths of `platform`, which is the host's except in tests.
  const paths = platform === "win32" ? path.win32 : path.posix;
  const dir = paths.dirname(python);
  const candidates =
    platform === "win32"
      ? [paths.join(dir, "opentide.exe"), paths.join(dir, "Scripts", "opentide.exe")]
      : [paths.join(dir, "opentide")];
  const script = candidates.find(exists);
  const module = { command: python, args: [...MODULE_ARGS] };
  return script ? [{ command: script, args: [] }, module] : [module];
}

/** The interpreters on PATH that may have opentide installed as a module, in the order tried. */
export function pythonsOnPath(
  platform: NodeJS.Platform,
  which: (name: string) => string | undefined,
): { command: string; args: string[] }[] {
  const names: { name: string; args: string[] }[] =
    platform === "win32"
      ? [
          { name: "python", args: [] },
          { name: "py", args: ["-3"] },
        ]
      : [
          { name: "python3", args: [] },
          { name: "python", args: [] },
        ];
  const found: { command: string; args: string[] }[] = [];
  for (const { name, args } of names) {
    const command = which(name);
    if (command && !found.some((other) => other.command === command)) found.push({ command, args });
  }
  return found;
}

function upgradeHint(source: RuntimeSource, interpreter: string | undefined): string {
  const spec = `'opentide>=${MIN_OPENTIDE_VERSION}'`;
  if (interpreter) return `"${interpreter}" -m pip install --upgrade ${spec}`;
  if (source === "venv") return `uv pip install --upgrade ${spec}`;
  if (source === "path") return `uv tool install --upgrade ${spec}`;
  if (source === "python") return `python -m pip install --upgrade ${spec}`;
  return `pip install --upgrade ${spec}`;
}

interface Candidate {
  tier: RuntimeTier;
  source: RuntimeSource;
  command: string;
  args: string[];
  kind: "opentide" | "opentide-lsp";
  interpreter?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  binDirs?: string[];
}

/**
 * Why an `opentide.path` that is not named `opentide` or `opentide-lsp` (with .exe, .cmd or .bat on Windows) is a guess:
 * the name is how the extension tells a full opentide from an `opentide-lsp`, so any other name is run as a full opentide
 * (`--version`, `lsp start`, every command). If it is not one, it fails its version check and the next runtime runs.
 */
export function unusualRuntimeName(command: string): string | undefined {
  // Either separator: the path may be a Windows one whichever platform this runs on.
  const name = command.split(/[\\/]/).pop() ?? command;
  if (/^opentide(-lsp)?(\.(exe|cmd|bat))?$/i.test(name)) return undefined;
  return (
    `opentide.path ${command} is named "${name}", not opentide or opentide-lsp: it is run as a full opentide ` +
    "(opentide --version, lsp start). If it is an opentide-lsp, name it opentide-lsp; if it is neither, the next runtime runs instead"
  );
}

export async function resolveRuntime(input: ResolveInput): Promise<ResolveResult> {
  const attempts: ResolveAttempt[] = [];
  /** What the log should warn about even when a runtime was found (an `opentide.path` that is not named like one). */
  const warnings: string[] = [];
  const check = async (candidate: Candidate, restricted: boolean): Promise<Runtime | undefined> => {
    if (input.signal?.aborted) return undefined;
    const lsp = candidate.kind === "opentide-lsp";
    const env = { ...(lsp ? {} : OPENTIDE_ENV), ...candidate.env };
    const probeArgs = lsp ? [...candidate.args, "--version", "--json"] : [...candidate.args, "--version"];
    const binDirs = candidate.binDirs ?? [path.dirname(candidate.command)];
    const result = await input.probe(candidate.command, probeArgs, {
      env,
      restricted,
      binDirs,
      timeoutMs: candidate.timeoutMs ?? PROBE_TIMEOUT_MS,
      signal: input.signal,
    });
    const base = { tier: candidate.tier, source: candidate.source, path: candidate.command };
    if (result.error || result.code !== 0) {
      const why = result.error ?? (result.stderr.trim().split(/\r?\n/).pop() || `exit code ${result.code}`);
      attempts.push({ ...base, outcome: "failed", detail: `${candidate.command}: ${why}` });
      return undefined;
    }
    const version = lsp ? parseEngineVersionOutput(result.stdout) : parseOpentideVersionOutput(result.stdout);
    if (!version) {
      attempts.push({
        ...base,
        outcome: "failed",
        detail: `${candidate.command}: no version in its --version output`,
      });
      return undefined;
    }
    const minimum = lsp ? MIN_ENGINE_VERSION : MIN_OPENTIDE_VERSION;
    const gate = lsp ? (atLeast(version, minimum) ? "ok" : "too-old") : checkMinimum(version, minimum);
    if (gate === "too-old") {
      attempts.push({
        ...base,
        version,
        outcome: "too-old",
        detail: `${lsp ? "opentide-lsp" : "opentide"} ${version} at ${candidate.command} is older than ${minimum}`,
        upgrade: lsp
          ? "Download a newer opentide-lsp release"
          : upgradeHint(candidate.source, candidate.interpreter),
      });
      return undefined;
    }
    attempts.push({
      ...base,
      version,
      outcome: "ok",
      detail: `${candidate.command} ${version}`,
      ...(gate === "untagged"
        ? {
            note: `opentide ${version} at ${candidate.command} is a dev build from a checkout with no release tag; its version cannot be compared with ${minimum}, so it is used as is.`,
          }
        : {}),
    });
    return {
      tier: candidate.tier,
      source: candidate.source,
      kind: candidate.kind,
      command: candidate.command,
      args: candidate.args,
      version,
      ...(candidate.interpreter ? { interpreter: candidate.interpreter } : {}),
      env,
      restricted,
      binDirs,
    };
  };
  const skip = (tier: RuntimeTier, source: RuntimeSource, detail: string): void => {
    attempts.push({ tier, source, outcome: "skipped", detail });
  };
  const missing = (tier: RuntimeTier, source: RuntimeSource, detail: string): void => {
    attempts.push({ tier, source, outcome: "missing", detail });
  };

  const tryInstalled = async (): Promise<Runtime | undefined> => {
    // Tier 1: opentide.path.
    const configured = input.settings.path()?.trim();
    if (configured) {
      const command = expandPath(configured, input.folder, input.homeDir);
      const kind = /^opentide-lsp(\.exe)?$/i.test(path.basename(command)) ? "opentide-lsp" : "opentide";
      const oddName = unusualRuntimeName(command);
      if (oddName) warnings.push(oddName);
      const runtime = await check({ tier: 1, source: "setting", command, args: [], kind }, false);
      if (runtime) return runtime;
    } else {
      missing(1, "setting", "opentide.path is not set");
    }

    // Tier 3 first when the user opted into the repository's pin: their explicit choice for this workspace.
    const tryUv = async (): Promise<Runtime | undefined> => {
      if (!input.settings.uvUsePin()) {
        skip(3, "uv", "opentide.uv.usePin is off");
        return undefined;
      }
      if (!input.pin) {
        missing(3, "uv", "the repository pins no opentide version");
        return undefined;
      }
      const uv = uvExecutable(input.settings.uvPath(), input.folder, input.homeDir, input.which);
      if (!uv) {
        missing(3, "uv", "uv is not on PATH");
        return undefined;
      }
      const env: Record<string, string> = { UV_SYSTEM_CERTS: "1" };
      if (input.proxy) {
        env.HTTPS_PROXY = input.proxy;
        env.HTTP_PROXY = input.proxy;
      }
      return check(
        {
          tier: 3,
          source: "uv",
          command: uv,
          args: ["tool", "run", "--from", `opentide==${input.pin.version}`, "opentide"],
          kind: "opentide",
          env,
          timeoutMs: UV_PROBE_TIMEOUT_MS,
        },
        false,
      );
    };
    const uvFirst = await tryUv();
    if (uvFirst) return uvFirst;

    // Tier 2: the workspace's environment.
    const interpreterSetting = input.settings.interpreter()?.trim();
    const interpreters: { source: RuntimeSource; python: () => Promise<string | undefined> }[] =
      interpreterSetting
        ? [
            {
              source: "interpreter-setting",
              python: async () => expandPath(interpreterSetting, input.folder, input.homeDir),
            },
          ]
        : [
            { source: "python-environments", python: () => input.pythonEnvironments() },
            { source: "python-extension", python: () => input.pythonExtension() },
          ];
    for (const { source, python } of interpreters) {
      let interpreter: string | undefined;
      try {
        interpreter = await python();
      } catch (error) {
        missing(2, source, `no interpreter: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (!interpreter) {
        missing(2, source, "no interpreter selected");
        continue;
      }
      for (const { command, args } of opentideForInterpreter(interpreter, input.platform, input.exists)) {
        const runtime = await check({ tier: 2, source, command, args, kind: "opentide", interpreter }, false);
        if (runtime) return runtime;
        // The module is the same install as its script: only a script that did not run is retried.
        if (attempts.at(-1)?.outcome !== "failed") break;
      }
    }
    if (!interpreterSetting) {
      if (input.folder) {
        // The paths of `platform`, as opentideForInterpreter builds the script's beside it.
        const venvPython =
          input.platform === "win32"
            ? path.win32.join(input.folder, ".venv", "Scripts", "python.exe")
            : path.posix.join(input.folder, ".venv", "bin", "python");
        if (input.exists(venvPython)) {
          for (const { command, args } of opentideForInterpreter(venvPython, input.platform, input.exists)) {
            const runtime = await check(
              { tier: 2, source: "venv", command, args, kind: "opentide", interpreter: venvPython },
              false,
            );
            if (runtime) return runtime;
            if (attempts.at(-1)?.outcome !== "failed") break;
          }
        } else {
          missing(2, "venv", `${venvPython} does not exist`);
        }
      }
      const onPath = input.which("opentide");
      if (onPath) {
        const runtime = await check(
          { tier: 2, source: "path", command: onPath, args: [], kind: "opentide" },
          false,
        );
        if (runtime) return runtime;
      } else {
        missing(2, "path", "opentide is not on PATH");
      }
      // `python -m opentide`: a pip --user install whose Scripts folder is not on PATH, or an
      // opentide launcher that a policy does not let run.
      const pythons = pythonsOnPath(input.platform, input.which);
      if (pythons.length === 0) missing(2, "python", "no python on PATH");
      for (const python of pythons) {
        const runtime = await check(
          {
            tier: 2,
            source: "python",
            command: python.command,
            args: [...python.args, ...MODULE_ARGS],
            kind: "opentide",
            interpreter: python.command,
          },
          false,
        );
        if (runtime) return runtime;
      }
    }

    return undefined;
  };

  // Tier 4: the WASI module, opentide's own CLI: every command, `serve`, the language server and MCP, with
  // no install. It runs in the extension host and reads the workspace through the mount VS Code gives it.
  const tryBundled = (): Runtime | undefined => {
    if (input.settings.wasi() === false) {
      skip(4, "wasi", "opentide.wasi.enabled is off");
      return undefined;
    }
    const wasi = input.wasi;
    if (!wasi) {
      missing(4, "wasi", "this build carries no WASI module (dist/wasi/wasi.json)");
      return undefined;
    }
    if (!input.exists(wasi.module) || !input.exists(wasi.launcher)) {
      missing(4, "wasi", `${wasi.module} or its launcher does not exist`);
      return undefined;
    }
    attempts.push({
      tier: 4,
      source: "wasi",
      outcome: "ok",
      path: wasi.module,
      version: wasi.version,
      detail: `${wasi.module} ${wasi.version}`,
    });
    return wasiRuntime(wasi);
  };

  // Restricted Mode runs no opentide, the bundled one included: the engine's editor features only.
  // No setting is read in Restricted Mode: the mode is not chosen there.
  const choice = input.trusted
    ? chooseRuntimeMode(input.settings)
    : { mode: "bundled" as const, reason: "Restricted Mode: no opentide runs, only the engine (WASM)" };
  let notice: string | undefined;
  if (!input.trusted) {
    skip(1, "setting", "Restricted Mode: no opentide runs, only the engine (WASM)");
    skip(4, "wasi", "Restricted Mode: no opentide runs, only the engine (WASM)");
  } else if (choice.mode === "installed") {
    const installed = await tryInstalled();
    if (installed)
      return { runtime: installed, attempts, mode: choice.mode, reason: choice.reason, warnings };
    const bundled = tryBundled();
    notice =
      "no installed opentide answered" +
      (bundled
        ? "; using the bundled WASI module instead (set opentide.runtime to bundled to stop looking for an installed one)"
        : "");
    if (bundled)
      return { runtime: bundled, attempts, mode: choice.mode, reason: choice.reason, warnings, notice };
  } else {
    const bundled = tryBundled();
    if (bundled) {
      skip(1, "setting", `${choice.reason}: no installed opentide is looked for`);
      return { runtime: bundled, attempts, mode: choice.mode, reason: choice.reason, warnings };
    }
    // The bundled opentide is off or missing from this build: say so, and use an installed one if there is one.
    const installed = await tryInstalled();
    notice = `the bundled WASI module is not available (${attempts.findLast((a) => a.tier === 4)?.detail ?? "unknown"})${installed ? "; using the installed opentide instead" : ""}`;
    if (installed)
      return { runtime: installed, attempts, mode: choice.mode, reason: choice.reason, warnings, notice };
  }

  // Tier 5: the engine built for WebAssembly, in a worker thread. Editor features only; it starts no
  // process and reads the workspace through VS Code, so Restricted Mode runs it too.
  const engine = input.engine;
  if (!engine) {
    missing(5, "engine", "this build carries no engine (dist/engine/engine.json)");
    return {
      runtime: undefined,
      attempts,
      mode: choice.mode,
      reason: choice.reason,
      warnings,
      ...(notice ? { notice } : {}),
    };
  }
  if (!input.exists(engine.module)) {
    missing(5, "engine", `${engine.module} does not exist`);
    return {
      runtime: undefined,
      attempts,
      mode: choice.mode,
      reason: choice.reason,
      warnings,
      ...(notice ? { notice } : {}),
    };
  }
  attempts.push({
    tier: 5,
    source: "engine",
    outcome: "ok",
    path: engine.module,
    version: engine.version,
    detail: `${engine.module} ${engine.version}`,
  });
  return {
    runtime: engineRuntime(engine, !input.trusted),
    attempts,
    mode: choice.mode,
    reason: choice.reason,
    warnings,
    ...(notice ? { notice } : {}),
  };
}

/**
 * The tier-4 runtime of a WASI layout: VS Code's Node (as Node, not Electron) running the launcher, which is
 * the command wherever VS Code starts a process itself. `serve` and the language server run in the
 * extension host, from `wasi` (src/core/services/wasi.ts).
 */
export function wasiRuntime(wasi: WasiLayout): Runtime {
  return {
    tier: 4,
    source: "wasi",
    kind: "opentide",
    command: wasi.execPath,
    args: [wasi.launcher, wasi.module],
    version: wasi.version,
    env: { ELECTRON_RUN_AS_NODE: "1" },
    restricted: false,
    binDirs: [],
    wasi: { module: wasi.module, launcher: wasi.launcher },
  };
}

/** The tier-5 runtime of an engine layout. */
export function engineRuntime(engine: EngineLayout, restricted: boolean): Runtime {
  return {
    tier: 5,
    source: "engine",
    kind: "engine",
    command: engine.module,
    args: [],
    version: engine.version,
    env: {},
    restricted,
    binDirs: [],
  };
}
