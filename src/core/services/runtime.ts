// Resolves the window's runtime (SPEC §4) and keeps it current.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Logger, RuntimeService } from "../context";
import { detectPin, pinFileOrder, type RepoPin } from "../runtime/pins";
import { isFile, probe, which } from "../runtime/process";
import { resolveRuntime } from "../runtime/resolve";
import type { ResolveAttempt, Runtime } from "../runtime/types";
import { describeRuntime } from "../runtime/types";
import { Emitter } from "../util/event";
import { pythonEnvironmentsInterpreter, pythonExtensionInterpreter } from "./python";
import { httpProxy, runtimeSettings } from "./settings";

/** Read the pin files at the top of a folder. */
export function readPin(folder: string | undefined): RepoPin | undefined {
  if (!folder) return undefined;
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return undefined;
  }
  const files: Record<string, string> = {};
  for (const name of pinFileOrder(names)) {
    try {
      files[name] = fs.readFileSync(path.join(folder, name), "utf8");
    } catch {
      // unreadable: skip
    }
  }
  return detectPin(files);
}

export class RuntimeManager implements RuntimeService, vscode.Disposable {
  private runtime: Runtime | undefined;
  private lastAttempts: readonly ResolveAttempt[] = [];
  private repoPin: RepoPin | undefined;
  private readonly emitter = new Emitter<Runtime | undefined>();
  private first: Promise<Runtime | undefined> | undefined;
  private resolving: Promise<Runtime | undefined> | undefined;
  private readonly warned = new Set<string>();
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

  /** Resolve the runtime again. Concurrent calls share one resolution. */
  resolve(): Promise<Runtime | undefined> {
    if (this.resolving) return this.resolving;
    const run = this.doResolve().finally(() => {
      if (this.resolving === run) this.resolving = undefined;
    });
    this.resolving = run;
    this.first ??= run;
    return run;
  }

  private async doResolve(): Promise<Runtime | undefined> {
    const folder = this.primaryFolder();
    const folderPath = folder?.uri.fsPath;
    const trusted = vscode.workspace.isTrusted;
    this.repoPin = readPin(folderPath);
    const result = await resolveRuntime({
      trusted,
      platform: process.platform,
      arch: process.arch,
      extensionPath: this.context.extensionPath,
      globalStoragePath: this.context.globalStorageUri.fsPath,
      folder: folderPath,
      settings: runtimeSettings(folder?.uri),
      pin: this.repoPin,
      proxy: trusted ? httpProxy() : undefined,
      homeDir: os.homedir(),
      exists: isFile,
      which: (name) => which(name, process.env.PATH, process.platform),
      probe: (command, args, options) => probe(command, args, options),
      pythonEnvironments: () => pythonEnvironmentsInterpreter(folder?.uri),
      pythonExtension: () => pythonExtensionInterpreter(folder?.uri),
    });
    this.lastAttempts = result.attempts;
    for (const attempt of result.attempts) {
      if (attempt.outcome !== "skipped")
        this.log.debug(
          `runtime tier ${attempt.tier} (${attempt.source}): ${attempt.outcome}: ${attempt.detail}`,
        );
    }
    for (const attempt of result.attempts) {
      if (attempt.outcome === "too-old" || (attempt.outcome === "failed" && attempt.tier === 1))
        this.warn(attempt);
      // A package's own runtime that does not start (Windows 10 on Arm: an x64 runtime it cannot run).
      if (attempt.outcome === "failed" && attempt.tier === 4)
        this.log.warn(`runtime: the bundled runtime did not start: ${attempt.detail}`);
      if (attempt.note) this.log.info(`runtime: ${attempt.note}`);
    }
    this.runtime = result.runtime;
    if (result.runtime) {
      this.log.info(
        `runtime: opentide ${result.runtime.version} (${describeRuntime(result.runtime)}) ${result.runtime.command}` +
          `${result.runtime.restricted ? " [Restricted Mode: language server only]" : ""}`,
      );
    } else {
      this.log.warn(
        "runtime: none. Install opentide in the workspace, set opentide.path, or use a platform package.",
      );
    }
    await this.setContextKeys();
    this.emitter.fire(result.runtime);
    return result.runtime;
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
      set("opentide.pinMismatch", this.pinMismatch),
    ]);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
