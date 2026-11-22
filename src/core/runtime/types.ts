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
  | "python" // tier 2: python on PATH, `python -m opentide`
  | "uv" // tier 3: uv tool run --from opentide==<pin>
  | "wasi" // tier 4: <extensionPath>/dist/wasi, opentide's CLI compiled to wasm32-wasip1
  | "engine"; // tier 5: <extensionPath>/dist/engine, the language server built for WebAssembly

export type RuntimeTier = 1 | 2 | 3 | 4 | 5;

/** The WASI module a tier-4 runtime runs, and what runs it where VS Code starts a process itself. */
export interface WasiModule {
  /** `dist/wasi/opentide.wasm`. */
  readonly module: string;
  /** `dist/wasi/launcher.cjs`: runs the module under Node's WASI (MCP, terminals, tasks). */
  readonly launcher: string;
}

export interface Runtime {
  readonly tier: RuntimeTier;
  readonly source: RuntimeSource;
  /**
   * `opentide` runs every feature; a bare `opentide-lsp`, and the engine built for WebAssembly
   * (`engine`, run in a worker thread), serve editor features only.
   */
  readonly kind: "opentide" | "opentide-lsp" | "engine";
  /**
   * The executable to spawn; for `engine`, the WebAssembly module. For `wasi`, VS Code's own Node (run
   * with `ELECTRON_RUN_AS_NODE`), which runs the launcher: `serve` and the language server run in the
   * extension host instead (src/core/services/wasi.ts), and this command is for what VS Code starts.
   */
  readonly command: string;
  /** Arguments before opentide's own argv (`-m opentide` when opentide runs as a module). */
  readonly args: readonly string[];
  /** Set for tier 4: this runtime is the WASI module. */
  readonly wasi?: WasiModule;
  /** The opentide version, or the engine version for `opentide-lsp`. */
  readonly version: string;
  /** The Python interpreter, when known. */
  readonly interpreter?: string;
  /** Extra environment for every process of this runtime (uv's proxy and certificates). */
  readonly env: Readonly<Record<string, string>>;
  /** Restricted Mode: no opentide process runs; only the engine (WASM) serves editor features. */
  readonly restricted: boolean;
  /** The runtime's own executable folders. */
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
  /** `opentide.runtime`'s effect: which runtimes were tried first. */
  readonly mode?: "bundled" | "installed";
  /** Why that mode: the setting that chose it, or the default. */
  readonly reason?: string;
  /** Things to warn about in the log even though a runtime was found. */
  readonly warnings?: readonly string[];
  /** Set when the mode's own runtime was not available and another was used (shown once). */
  readonly notice?: string;
}

/** Does this runtime have the CLI (commands, backend)? */
export function hasCli(runtime: Runtime | undefined): runtime is Runtime {
  return runtime !== undefined && runtime.kind === "opentide" && !runtime.restricted;
}

/** Whether the runtime is the WASI module (tier 4): no native opentide, no network of its own. */
export function isWasi(runtime: Runtime | undefined): runtime is Runtime & { readonly wasi: WasiModule } {
  return runtime?.wasi !== undefined;
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

/** What the status bar says beside the version when the bundled WASI module is the runtime. */
export const WASI_STATUS = "bundled WASI";

export function describeRuntime(runtime: Runtime): string {
  const names: Record<RuntimeSource, string> = {
    setting: "opentide.path",
    "interpreter-setting": "opentide.interpreter",
    "python-environments": "Python Environments",
    "python-extension": "Python extension",
    venv: ".venv",
    path: "PATH",
    python: "python -m opentide",
    uv: "uv (repository pin)",
    wasi: "bundled WASI",
    engine: ENGINE_LABEL,
  };
  return `tier ${runtime.tier} · ${names[runtime.source]}`;
}
