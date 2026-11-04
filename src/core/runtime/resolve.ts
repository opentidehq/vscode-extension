// Runtime resolution in four tiers (SPEC §4, #3). vscode-free: every side effect is injected, so the tier
// logic is unit-tested with fakes.
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
  /** Restricted Mode: the probe runs with the locked-down environment. */
  readonly restricted: boolean;
  readonly binDirs: readonly string[];
  readonly timeoutMs: number;
}

/** The settings the resolver reads. Restricted keys are read only when the workspace is trusted. */
export interface RuntimeSettings {
  /** `opentide.runtime`: `auto` or `bundled`. Not restricted. */
  readonly runtime: () => string | undefined;
  readonly path: () => string | undefined;
  readonly interpreter: () => string | undefined;
  readonly uvUsePin: () => boolean | undefined;
  readonly uvPath: () => string | undefined;
}

export interface ResolveInput {
  readonly trusted: boolean;
  readonly platform: NodeJS.Platform;
  readonly extensionPath: string;
  readonly globalStoragePath: string;
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
}

const PROBE_TIMEOUT_MS = 20_000;
const UV_PROBE_TIMEOUT_MS = 180_000;

/** The bundled interpreter and the folders on its PATH. */
export function bundledLayout(
  extensionPath: string,
  platform: NodeJS.Platform,
): { python: string; binDirs: string[] } {
  const root = path.join(extensionPath, "runtime");
  return platform === "win32"
    ? { python: path.join(root, "python.exe"), binDirs: [root, path.join(root, "Scripts")] }
    : { python: path.join(root, "bin", "python3"), binDirs: [path.join(root, "bin")] };
}

/**
 * The arguments that make the bundled interpreter run opentide isolated, its bytecode outside the
 * extension, in UTF-8 mode (`-I` ignores `PYTHONUTF8`; without it Windows writes pipes in the ANSI code
 * page, and every non-ASCII name the extension decodes as UTF-8 becomes U+FFFD).
 */
export function bundledArgs(globalStoragePath: string): string[] {
  return [
    "-I",
    "-X",
    "utf8",
    "-X",
    `pycache_prefix=${path.join(globalStoragePath, "pycache")}`,
    "-m",
    "opentide",
  ];
}

/**
 * What every opentide process of tiers 1 to 3 gets: UTF-8 mode and UTF-8 stdio, so its output is UTF-8
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

/** The opentide executable next to an interpreter, else `python -m opentide`. */
export function opentideForInterpreter(
  python: string,
  platform: NodeJS.Platform,
  exists: (file: string) => boolean,
): { command: string; args: string[] } {
  // The paths of `platform`, which is the host's except in tests.
  const paths = platform === "win32" ? path.win32 : path.posix;
  const dir = paths.dirname(python);
  const candidates =
    platform === "win32"
      ? [paths.join(dir, "opentide.exe"), paths.join(dir, "Scripts", "opentide.exe")]
      : [paths.join(dir, "opentide")];
  const script = candidates.find(exists);
  return script ? { command: script, args: [] } : { command: python, args: ["-m", "opentide"] };
}

function upgradeHint(source: RuntimeSource, interpreter: string | undefined): string {
  const spec = `'opentide>=${MIN_OPENTIDE_VERSION}'`;
  if (interpreter) return `"${interpreter}" -m pip install --upgrade ${spec}`;
  if (source === "venv") return `uv pip install --upgrade ${spec}`;
  if (source === "path") return `uv tool install --upgrade ${spec}`;
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
    const env = { ...(lsp ? {} : OPENTIDE_ENV), ...candidate.env };
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
    const minimum = lsp ? MIN_ENGINE_VERSION : MIN_OPENTIDE_VERSION;
    const gate =
      candidate.tier === 4
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

  const bundledOnly = !input.trusted || input.settings.runtime() === "bundled";
  if (bundledOnly) {
    skip(
      1,
      "setting",
      input.trusted ? "opentide.runtime is bundled" : "Restricted Mode: only the bundled runtime",
    );
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
      const { command, args } = opentideForInterpreter(interpreter, input.platform, input.exists);
      const runtime = await check({ tier: 2, source, command, args, kind: "opentide", interpreter }, false);
      if (runtime) return { runtime, attempts };
    }
    if (!interpreterSetting) {
      if (input.folder) {
        const venvScript =
          input.platform === "win32"
            ? path.join(input.folder, ".venv", "Scripts", "opentide.exe")
            : path.join(input.folder, ".venv", "bin", "opentide");
        if (input.exists(venvScript)) {
          const runtime = await check(
            { tier: 2, source: "venv", command: venvScript, args: [], kind: "opentide" },
            false,
          );
          if (runtime) return { runtime, attempts };
        } else {
          missing(2, "venv", `${venvScript} does not exist`);
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
    }
  }

  // Tier 4: the bundled runtime. The only tier in Restricted Mode.
  const layout = bundledLayout(input.extensionPath, input.platform);
  if (!input.exists(layout.python)) {
    missing(4, "bundled", "this package has no bundled runtime (universal package)");
    return { runtime: undefined, attempts };
  }
  const runtime = await check(
    {
      tier: 4,
      source: "bundled",
      command: layout.python,
      args: bundledArgs(input.globalStoragePath),
      kind: "opentide",
      interpreter: layout.python,
      binDirs: layout.binDirs,
    },
    !input.trusted,
  );
  return { runtime, attempts };
}
