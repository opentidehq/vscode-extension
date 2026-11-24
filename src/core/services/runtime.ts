// Resolves the window's runtime (SPEC §4) and keeps it current.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import type { Logger, RuntimeService } from "../context";
import { type ResolveOptions, withNotes } from "../runtime/fallback";
import { engineNotice } from "../runtime/notice";
import { detectPin, pinFileOrder, type RepoPin } from "../runtime/pins";
import { isFile, pathLookup, probe } from "../runtime/process";
import {
  type EngineLayout,
  parseEngineManifest,
  parseWasiManifest,
  resolveRuntime,
  type WasiLayout,
} from "../runtime/resolve";
import { ResolutionSlot } from "../runtime/slot";
import type { ResolveAttempt, Runtime } from "../runtime/types";
import { describeRuntime, ENGINE_LABEL } from "../runtime/types";
import { Emitter } from "../util/event";
import { pythonEnvironmentsInterpreter, pythonExtensionInterpreter } from "./python";
import { httpProxy, runtimeSettings } from "./settings";

/** A manifest the extension carries, as text; undefined when there is none (a build without that tier). */
function readManifestText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** `readManifestText` without blocking the thread. */
async function readManifestTextAsync(file: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

/** The engine (WASM) the extension carries (`dist/engine/engine.json`), if it has one; `report` hears why a manifest is unusable. */
export function readEngine(
  extensionPath: string,
  report?: (problem: string) => void,
): EngineLayout | undefined {
  const dir = path.join(extensionPath, "dist", "engine");
  const text = readManifestText(path.join(dir, "engine.json"));
  if (text === undefined) return undefined;
  const result = parseEngineManifest(text, dir);
  if ("problem" in result) {
    report?.(`${result.problem}; the engine is not available`);
    return undefined;
  }
  return result.layout;
}

/** The WASI module the extension carries (`dist/wasi/wasi.json`), if it has one; `report` hears why a manifest is unusable. */
export function readWasi(extensionPath: string, report?: (problem: string) => void): WasiLayout | undefined {
  const dir = path.join(extensionPath, "dist", "wasi");
  const text = readManifestText(path.join(dir, "wasi.json"));
  if (text === undefined) return undefined;
  const result = parseWasiManifest(text, dir, process.execPath);
  if ("problem" in result) {
    report?.(`${result.problem}; the bundled WASI runtime is not available`);
    return undefined;
  }
  return result.layout;
}

/** Read the pin files at the top of a folder, without blocking: the first resolution starts while the window activates. */
export async function readPin(folder: string | undefined): Promise<RepoPin | undefined> {
  if (!folder) return undefined;
  let names: string[];
  try {
    names = await fs.promises.readdir(folder);
  } catch {
    return undefined;
  }
  const files: Record<string, string> = {};
  for (const name of pinFileOrder(names)) {
    const text = await readManifestTextAsync(path.join(folder, name));
    if (text !== undefined) files[name] = text;
  }
  return detectPin(files);
}

/**
 * The WASI module and the engine the extension carries, read once without blocking the thread: their manifests
 * are part of the installed extension and do not change while it runs.
 */
export async function readBundledAsync(
  extensionPath: string,
  report: (problem: string) => void,
): Promise<{ wasi: WasiLayout | undefined; engine: EngineLayout | undefined }> {
  const wasiDir = path.join(extensionPath, "dist", "wasi");
  const engineDir = path.join(extensionPath, "dist", "engine");
  const [wasiText, engineText] = await Promise.all([
    readManifestTextAsync(path.join(wasiDir, "wasi.json")),
    readManifestTextAsync(path.join(engineDir, "engine.json")),
  ]);
  let wasi: WasiLayout | undefined;
  if (wasiText !== undefined) {
    const result = parseWasiManifest(wasiText, wasiDir, process.execPath);
    if ("problem" in result) report(`${result.problem}; the bundled WASI runtime is not available`);
    else wasi = result.layout;
  }
  let engine: EngineLayout | undefined;
  if (engineText !== undefined) {
    const result = parseEngineManifest(engineText, engineDir);
    if ("problem" in result) report(`${result.problem}; the engine is not available`);
    else engine = result.layout;
  }
  return { wasi, engine };
}

export class RuntimeManager implements RuntimeService, vscode.Disposable {
  private runtime: Runtime | undefined;
  private lastAttempts: readonly ResolveAttempt[] = [];
  /** The bundled WASI module's and engine's manifests, read once. */
  private bundled: ReturnType<typeof readBundledAsync> | undefined;
  /** What `noteAttempts` added after the last resolution: a language server's fallback to the engine. */
  private notes: readonly ResolveAttempt[] = [];
  private repoPin: RepoPin | undefined;
  private readonly emitter = new Emitter<Runtime | undefined>();
  private first: Promise<Runtime | undefined> | undefined;
  private resolving: Promise<Runtime | undefined> | undefined;
  /** The resolution in flight: a new one cancels it, so a restart never waits for a stale probe. */
  private readonly slot = new ResolutionSlot<Runtime | undefined>();
  private readonly warned = new Set<string>();
  /** Fallback notices already shown (once each, not on every restart). */
  private readonly noticed = new Set<string>();
  private readonly said = new Set<string>();
  restartHandler: ((reason: string) => Promise<void>) | undefined;

  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: Logger,
    private readonly primaryFolder: () => vscode.WorkspaceFolder | undefined,
  ) {}

  get current(): Runtime | undefined {
    return this.runtime;
  }

  get attempts(): readonly ResolveAttempt[] {
    return this.lastAttempts;
  }

  /**
   * Add what happened after the resolution (a language server that fell back to the engine). They stay in the
   * attempts through a resolution that keeps them (`resolveAgain({ keepNotes: true })`), until one that does not.
   */
  noteAttempts(attempts: readonly ResolveAttempt[]): void {
    this.notes = [...this.notes, ...attempts];
    this.lastAttempts = [...this.lastAttempts, ...attempts];
    for (const attempt of attempts)
      this.log.info(
        `runtime tier ${attempt.tier} (${attempt.source}): ${attempt.outcome}: ${attempt.detail}`,
      );
  }

  get pin(): RepoPin | undefined {
    return this.repoPin;
  }

  ready(): Promise<Runtime | undefined> {
    return this.first ?? this.resolve();
  }

  async restart(reason = "restart requested"): Promise<void> {
    if (this.restartHandler) await this.restartHandler(reason);
    else await this.resolve();
  }

  /**
   * Resolve again from scratch, now: the resolution in progress, if any, may predate the change that asks for this,
   * so it is cancelled (its probes end) rather than waited for. Whoever awaited it gets this one's result.
   */
  resolveAgain(options: ResolveOptions = {}): Promise<Runtime | undefined> {
    // It looks at PATH again too: the user may have installed opentide, python or uv since.
    pathLookup.clear();
    return this.begin(options);
  }

  /** Resolve the runtime again. Concurrent calls share one resolution. */
  resolve(): Promise<Runtime | undefined> {
    return this.resolving ?? this.begin({});
  }

  /** Cancel the resolution in flight, if any (shutdown). */
  cancelResolution(): void {
    this.slot.cancel();
  }

  private begin(options: ResolveOptions): Promise<Runtime | undefined> {
    const started = this.slot.start((signal) => this.doResolve(signal, options));
    const run: Promise<Runtime | undefined> = started.result
      .then((result) =>
        // Cancelled and replaced: follow the resolution that replaced it.
        started.signal.aborted
          ? this.resolving !== run
            ? (this.resolving ?? this.runtime)
            : this.runtime
          : result,
      )
      .finally(() => {
        if (this.resolving === run) this.resolving = undefined;
      });
    this.resolving = run;
    this.first ??= run;
    return run;
  }

  private async doResolve(signal: AbortSignal, options: ResolveOptions): Promise<Runtime | undefined> {
    const folder = this.primaryFolder();
    const folderPath = folder?.uri.fsPath;
    const trusted = vscode.workspace.isTrusted;
    // Read without blocking: the first resolution starts while the window activates (SPEC §14).
    const [pin, bundled] = await Promise.all([
      readPin(folderPath),
      (this.bundled ??= readBundledAsync(this.context.extensionPath, (problem) =>
        this.log.warn(`runtime: ${problem}`),
      )),
    ]);
    if (signal.aborted) return this.runtime;
    this.repoPin = pin;
    const result = await resolveRuntime({
      trusted,
      platform: process.platform,
      folder: folderPath,
      settings: runtimeSettings(folder?.uri),
      pin: this.repoPin,
      proxy: trusted ? httpProxy() : undefined,
      homeDir: os.homedir(),
      exists: isFile,
      which: (name) => pathLookup.whichAsync(name, process.env.PATH, process.platform),
      probe: (command, args, options) => probe(command, args, options),
      pythonEnvironments: () => pythonEnvironmentsInterpreter(folder?.uri),
      pythonExtension: () => pythonExtensionInterpreter(folder?.uri),
      wasi: bundled.wasi,
      engine: bundled.engine,
      signal,
    });
    // Stale (a restart came while this resolved): leave the state to the resolution that replaced it.
    if (signal.aborted) return this.runtime;
    // In one step, before anyone hears of the new runtime: the notes stay only when asked to.
    this.notes = options.keepNotes ? this.notes : [];
    this.lastAttempts = withNotes(result.attempts, this.notes);
    for (const attempt of result.attempts) {
      if (attempt.outcome !== "skipped")
        this.log.debug(
          `runtime tier ${attempt.tier} (${attempt.source}): ${attempt.outcome}: ${attempt.detail}`,
        );
    }
    for (const text of result.warnings ?? []) this.logOnce("warn", `runtime: ${text}`);
    // A tier-1 runtime that did not answer is said in the log with its path and why, not only in a notification.
    for (const attempt of result.attempts) {
      if (attempt.tier === 1 && (attempt.outcome === "failed" || attempt.outcome === "too-old"))
        this.logOnce(
          "warn",
          `runtime: opentide.path ${attempt.path ?? ""}: ${attempt.detail}; the next runtime runs instead`,
        );
    }
    for (const attempt of result.attempts) {
      if (attempt.outcome === "too-old" || (attempt.outcome === "failed" && attempt.tier === 1))
        this.warn(attempt);
      if (attempt.note) this.log.info(`runtime: ${attempt.note}`);
    }
    this.runtime = result.runtime;
    // The line the QA harness reads: `runtime: opentide <version> (tier N · <source>) …`, then why that runtime.
    const why = result.reason ? ` [${result.reason}]` : "";
    if (result.notice && !this.noticed.has(result.notice)) {
      this.noticed.add(result.notice);
      this.log.warn(`runtime: ${result.notice}`);
      void vscode.window.showInformationMessage(`opentide: ${result.notice}.`);
    }
    if (result.runtime?.kind === "engine") {
      this.log.warn(engineNotice(ENGINE_LABEL, result.runtime.version, trusted, result.attempts) + why);
    } else if (result.runtime?.wasi) {
      this.log.info(
        `runtime: opentide ${result.runtime.version} (${describeRuntime(result.runtime)}): the module the extension carries${why}. ` +
          "The editor's tenant requests are made by the extension host; a terminal or task has no network (opentide.runtime: installed runs your own opentide there).",
      );
    } else if (result.runtime) {
      this.log.info(
        `runtime: opentide ${result.runtime.version} (${describeRuntime(result.runtime)}) ${result.runtime.command}` +
          `${result.runtime.restricted ? " [Restricted Mode: language server only]" : ""}${why}`,
      );
    } else {
      this.log.warn(
        "runtime: none. Install opentide (pip install opentide) in the workspace's environment or set opentide.path." +
          why,
      );
    }
    await this.setContextKeys();
    this.emitter.fire(result.runtime);
    return result.runtime;
  }

  /** A line said once per text: the same problem on every restart is one line. */
  private logOnce(level: "warn" | "info", line: string): void {
    if (this.said.has(line)) return;
    this.said.add(line);
    this.log[level](line);
  }

  private warn(attempt: ResolveAttempt): void {
    const key = `${attempt.path}@${attempt.version ?? attempt.outcome}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    if (attempt.outcome === "too-old" && attempt.upgrade) {
      const upgrade = attempt.upgrade;
      void vscode.window
        .showWarningMessage(
          `${attempt.detail}; using the next runtime instead. Upgrade with: ${upgrade}`,
          "Copy upgrade command",
        )
        .then((choice) => {
          if (choice) void vscode.env.clipboard.writeText(upgrade);
        });
    } else {
      void vscode.window.showWarningMessage(
        `opentide.path: ${attempt.detail}. Using the next runtime instead.`,
      );
    }
  }

  /** Does the active version differ from the repository's pin? */
  get pinMismatch(): boolean {
    return Boolean(
      this.repoPin &&
      this.runtime &&
      this.runtime.kind === "opentide" &&
      this.runtime.version !== this.repoPin.version,
    );
  }

  private async setContextKeys(): Promise<void> {
    const set = (key: string, value: unknown) => vscode.commands.executeCommand("setContext", key, value);
    await Promise.all([
      set("opentide.runtimeReady", this.runtime !== undefined),
      set(
        "opentide.hasCli",
        this.runtime !== undefined && this.runtime.kind === "opentide" && !this.runtime.restricted,
      ),
      set("opentide.runtimeTier", this.runtime?.tier ?? 0),
      set("opentide.editorOnly", this.runtime !== undefined && this.runtime.kind !== "opentide"),
      set("opentide.pinMismatch", this.pinMismatch),
    ]);
  }

  dispose(): void {
    this.slot.cancel();
    this.emitter.dispose();
  }
}
