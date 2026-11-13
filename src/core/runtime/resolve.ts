// Runtime resolution in four tiers (SPEC §4, #3): three that run an installed opentide, then the engine
// (WASM). vscode-free: every side effect is injected, so the tier logic is unit-tested with fakes.
//
// The extension carries opentide itself: the npm package `@opentide/opentide` (the Rust core, a Node-API
// addon) in dist/opentide, run as `<node> dist/opentide/cli.js` with the extension host's own executable
// (`ELECTRON_RUN_AS_NODE=1`), so no Python is needed. A process of its own, as every other tier, so the
// backend, the language server and MCP keep their protocols and the EUPL-1.2 core stays a separate
// program. An explicit choice wins over it (opentide.path, the repository's pin with uv, and
// opentide.interpreter); an environment the extension only discovers (Python Environments, the Python
// extension, .venv, PATH, `python -m opentide`) is used after it, on a package with no native code for
// the machine (the universal VSIX).
import * as path from "node:path";
import type { RepoPin } from "./pins";
import type { ResolveAttempt, ResolveResult, Runtime, RuntimeSource, RuntimeTier } from "./types";
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
}

/** The settings the resolver reads. Restricted keys are read only when the workspace is trusted. */
export interface RuntimeSettings {
  readonly path: () => string | undefined;
  readonly interpreter: () => string | undefined;
  readonly uvUsePin: () => boolean | undefined;
  readonly uvPath: () => string | undefined;
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
  /** Tier 4: the engine (WASM) this build carries, from dist/engine/engine.json; undefined without one. */
  readonly engine?: EngineLayout | undefined;
  /** Tier 2: the @opentide/opentide this build carries, from dist/opentide/opentide.json; undefined without one. */
  readonly package?: PackageLayout | undefined;
  /** The executable that runs the package's `cli.js`: the extension host's (`process.execPath`). */
  readonly nodeExecutable?: string | undefined;
}

/** The @opentide/opentide the extension carries (dist/opentide/opentide.json): its bin and version. */
export interface PackageLayout {
  /** The package's `cli.js`, which calls the core's `main(argv)` in its own Node.js process. */
  readonly cli: string;
  /** The native addon for this platform (`opentide.<platform>.node`). */
  readonly native: string;
  readonly version: string;
  /** The napi-rs platform the addon is for (`linux-x64-gnu`, `win32-arm64-msvc`, …). */
  readonly platform: string;
}

/**
 * The environment the package's bin runs with: the extension host's executable is Electron in VS Code
 * desktop, which runs as plain Node.js with `ELECTRON_RUN_AS_NODE` (as vscode-languageclient runs a
 * Node.js server); in a remote extension host it is Node.js, which ignores it.
 */
export const PACKAGE_ENV: Readonly<Record<string, string>> = { ELECTRON_RUN_AS_NODE: "1" };

/** `dist/opentide/opentide.json`'s fields, when they have the expected shape. */
export function readPackageManifest(text: string | undefined, dir: string): PackageLayout | undefined {
  if (!text) return undefined;
  try {
    const manifest = JSON.parse(text) as {
      version?: unknown;
      cli?: unknown;
      native?: unknown;
      platform?: unknown;
    };
    const { version, cli, native, platform } = manifest;
    if (
      typeof version !== "string" ||
      typeof cli !== "string" ||
      typeof native !== "string" ||
      typeof platform !== "string"
    )
      return undefined;
    if ([cli, native].some((name) => name.includes("/") || name.includes("\\"))) return undefined;
    return { cli: path.join(dir, cli), native: path.join(dir, native), version, platform };
  } catch {
    return undefined;
  }
}

/** The engine (WASM) in the extension: its module and version (dist/engine/engine.json). */
export interface EngineLayout {
  readonly module: string;
  readonly version: string;
}

/** `dist/engine/engine.json`'s fields, when they have the expected shape. */
export function readEngineManifest(text: string | undefined, dir: string): EngineLayout | undefined {
  if (!text) return undefined;
  try {
    const manifest = JSON.parse(text) as { version?: unknown; module?: unknown };
    if (typeof manifest.version !== "string" || typeof manifest.module !== "string") return undefined;
    if (manifest.module.includes("/") || manifest.module.includes("\\")) return undefined;
    return { module: path.join(dir, manifest.module), version: manifest.version };
  } catch {
    return undefined;
  }
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
  // biome-ignore lint/suspicious/noTemplateCurlyInString: VS Code's variable syntax, matched literally
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

export async function resolveRuntime(input: ResolveInput): Promise<ResolveResult> {
  const attempts: ResolveAttempt[] = [];
  const check = async (candidate: Candidate, restricted: boolean): Promise<Runtime | undefined> => {
    const lsp = candidate.kind === "opentide-lsp";
    const packaged = candidate.source === "package";
    // OPENTIDE_ENV is for a Python opentide; the Rust core writes UTF-8 itself.
    const env = { ...(lsp || packaged ? {} : OPENTIDE_ENV), ...candidate.env };
    const probeArgs = lsp ? [...candidate.args, "--version", "--json"] : [...candidate.args, "--version"];
    const binDirs = candidate.binDirs ?? [path.dirname(candidate.command)];
    const result = await input.probe(candidate.command, probeArgs, {
      env,
      restricted,
      binDirs,
      timeoutMs: candidate.timeoutMs ?? PROBE_TIMEOUT_MS,
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
    if (packaged && input.package && version !== input.package.version) {
      attempts.push({
        ...base,
        version,
        outcome: "failed",
        detail: `${candidate.command}: reports opentide ${version}, its opentide.json says ${input.package.version}`,
      });
      return undefined;
    }
    const minimum = lsp ? MIN_ENGINE_VERSION : MIN_OPENTIDE_VERSION;
    // The package is the extension's own pin: its version is the one the extension was tested with.
    const gate = packaged
      ? "ok"
      : lsp
        ? atLeast(version, minimum)
          ? "ok"
          : "too-old"
        : checkMinimum(version, minimum);
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
  /** Tier 2's interpreters, in order: each one's `opentide` script, then `python -m opentide`. */
  const tryInterpreters = async (
    interpreters: readonly { source: RuntimeSource; python: () => Promise<string | undefined> }[],
  ): Promise<Runtime | undefined> => {
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
    return undefined;
  };

  if (!input.trusted) {
    skip(1, "setting", "Restricted Mode: no opentide runs, only the engine (WASM)");
  } else {
    // Tier 1: opentide.path.
    const configured = input.settings.path()?.trim();
    if (configured) {
      const command = expandPath(configured, input.folder, input.homeDir);
      const kind = /^opentide-lsp(\.exe)?$/i.test(path.basename(command)) ? "opentide-lsp" : "opentide";
      const runtime = await check({ tier: 1, source: "setting", command, args: [], kind }, false);
      if (runtime) return { runtime, attempts };
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
    if (uvFirst) return { runtime: uvFirst, attempts };

    // Tier 2: opentide.interpreter (an explicit choice), then the package the extension carries, then the
    // environment the extension discovers.
    const interpreterSetting = input.settings.interpreter()?.trim();
    const settingInterpreters: { source: RuntimeSource; python: () => Promise<string | undefined> }[] =
      interpreterSetting
        ? [
            {
              source: "interpreter-setting",
              python: async () => expandPath(interpreterSetting, input.folder, input.homeDir),
            },
          ]
        : [];
    const fromSetting = await tryInterpreters(settingInterpreters);
    if (fromSetting) return { runtime: fromSetting, attempts };

    const pkg = input.package;
    if (!pkg) {
      missing(
        2,
        "package",
        "this build carries no @opentide/opentide (dist/opentide/opentide.json): the universal package",
      );
    } else if (!input.nodeExecutable) {
      missing(2, "package", "no executable to run @opentide/opentide with");
    } else if (!input.exists(pkg.cli) || !input.exists(pkg.native)) {
      missing(2, "package", `${input.exists(pkg.cli) ? pkg.native : pkg.cli} does not exist`);
    } else {
      const runtime = await check(
        {
          tier: 2,
          source: "package",
          command: input.nodeExecutable,
          args: [pkg.cli],
          kind: "opentide",
          env: { ...PACKAGE_ENV },
          binDirs: [path.dirname(pkg.cli)],
        },
        false,
      );
      if (runtime) return { runtime, attempts };
    }

    if (!interpreterSetting) {
      const discovered = await tryInterpreters([
        { source: "python-environments", python: () => input.pythonEnvironments() },
        { source: "python-extension", python: () => input.pythonExtension() },
      ]);
      if (discovered) return { runtime: discovered, attempts };
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
            if (runtime) return { runtime, attempts };
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
        if (runtime) return { runtime, attempts };
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
        if (runtime) return { runtime, attempts };
      }
    }
  }

  // Tier 4: the engine built for WebAssembly, in a worker thread. Editor features only; it starts no
  // process and reads the workspace through VS Code, so Restricted Mode runs it too.
  const engine = input.engine;
  if (!engine) {
    missing(4, "engine", "this build carries no engine (dist/engine/engine.json)");
    return { runtime: undefined, attempts };
  }
  if (!input.exists(engine.module)) {
    missing(4, "engine", `${engine.module} does not exist`);
    return { runtime: undefined, attempts };
  }
  attempts.push({
    tier: 4,
    source: "engine",
    outcome: "ok",
    path: engine.module,
    version: engine.version,
    detail: `${engine.module} ${engine.version}`,
  });
  return { runtime: engineRuntime(engine, !input.trusted), attempts };
}

/** The tier-4 runtime of an engine layout. */
export function engineRuntime(engine: EngineLayout, restricted: boolean): Runtime {
  return {
    tier: 4,
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
