// The resolved opentide runtime. vscode-free.
import { ENGINE_LABEL } from "../../engine/protocol";

/** Where the runtime came from. The tier is the order of SPEC §4. */
export type RuntimeSource =
  | "setting" // tier 1: opentide.path
  | "interpreter-setting" // tier 2: opentide.interpreter
  | "python-environments" // tier 2: the Python Environments extension
  | "python-extension" // tier 2: the Python extension
  | "venv" // tier 2: <folder>/.venv
  | "path" // tier 2: opentide on PATH
  | "uv" // tier 3: uv tool run --from opentide==<pin>
  | "bundled" // tier 4: <extensionPath>/runtime
  | "engine"; // tier 5: <extensionPath>/dist/engine, the language server built for WebAssembly

export type RuntimeTier = 1 | 2 | 3 | 4 | 5;

export interface Runtime {
  readonly tier: RuntimeTier;
  readonly source: RuntimeSource;
  /**
   * `opentide` runs every feature; a bare `opentide-lsp`, and the engine built for WebAssembly
   * (`engine`, run in a worker thread), serve editor features only.
   */
  readonly kind: "opentide" | "opentide-lsp" | "engine";
  /** The executable to spawn; for `engine`, the WebAssembly module. */
  readonly command: string;
  /** Arguments before opentide's own argv (`-I -m opentide` for the bundled interpreter). */
  readonly args: readonly string[];
  /** The opentide version, or the engine version for `opentide-lsp`. */
  readonly version: string;
  /** The Python interpreter, when known. */
  readonly interpreter?: string;
  /** Extra environment for every process of this runtime (uv's proxy and certificates). */
  readonly env: Readonly<Record<string, string>>;
  /** Restricted Mode: only the language server may run, with PATH limited to `binDirs`. */
  readonly restricted: boolean;
  /** The runtime's own executable folders (the bundled runtime's `bin`). */
  readonly binDirs: readonly string[];
}

export type AttemptOutcome = "ok" | "missing" | "too-old" | "failed" | "skipped";

/** One tier's answer, for the output channel and the status tooltip. */
export interface ResolveAttempt {
  readonly tier: RuntimeTier;
  readonly source: RuntimeSource;
  readonly outcome: AttemptOutcome;
  readonly detail: string;
  readonly path?: string;
  readonly version?: string;
  /** For `too-old`: the command that upgrades it. */
  readonly upgrade?: string;
  /** For `ok`: something the output channel should say (an untagged dev build used as is). */
  readonly note?: string;
}

export interface ResolveResult {
  readonly runtime: Runtime | undefined;
  readonly attempts: readonly ResolveAttempt[];
}

/** Does this runtime have the CLI (commands, backend)? */
export function hasCli(runtime: Runtime | undefined): runtime is Runtime {
  return runtime !== undefined && runtime.kind === "opentide" && !runtime.restricted;
}

/** Whether the runtime serves editor features only (a bare `opentide-lsp`, or the engine). */
export function isEditorOnly(runtime: Runtime | undefined): boolean {
  return runtime !== undefined && runtime.kind !== "opentide";
}

export { ENGINE_LABEL, ENGINE_STATUS } from "../../engine/protocol";

/** `{command, args}` that start the language server on stdio (not the engine, which runs in a worker). */
export function languageServerCommand(runtime: Runtime): { command: string; args: string[] } {
  return runtime.kind === "opentide-lsp"
    ? { command: runtime.command, args: [...runtime.args, "--stdio"] }
    : { command: runtime.command, args: [...runtime.args, "lsp", "start"] };
}

/** `{command, args}` for `opentide <argv>`. */
export function cliCommand(runtime: Runtime, argv: readonly string[]): { command: string; args: string[] } {
  return { command: runtime.command, args: [...runtime.args, ...argv] };
}

export function describeRuntime(runtime: Runtime): string {
  const names: Record<RuntimeSource, string> = {
    setting: "opentide.path",
    "interpreter-setting": "opentide.interpreter",
    "python-environments": "Python Environments",
    "python-extension": "Python extension",
    venv: ".venv",
    path: "PATH",
    uv: "uv (repository pin)",
    bundled: "bundled runtime",
    engine: ENGINE_LABEL,
  };
  return `tier ${runtime.tier} · ${names[runtime.source]}`;
}
