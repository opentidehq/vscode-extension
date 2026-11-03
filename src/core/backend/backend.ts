// The backend: one `run(folder, argv)` for every opentide command (SPEC D2, #12). It answers through one
// warm `opentide serve` per window when the runtime has it, and spawns `opentide --json <argv>` otherwise
// or for commands that want a process of their own. vscode-free; core/services wires it to VS Code.
import type * as cp from "node:child_process";
import type { Classification } from "../capabilities/classification";
import type { CommandTree } from "../capabilities/tree";
import { displayArgv, processEnv, redact } from "../runtime/env";
import { cliCommand, hasCli, type Runtime } from "../runtime/types";
import type { CancellationToken } from "../util/cancellation";
import { Emitter, type Event } from "../util/event";
import { ServeClient } from "./serve";
import { type SpawnFn, spawnRun } from "./spawn";
import { BackendError, type Envelope, type ProgressEvent } from "./types";

export interface RunOptions {
  /** Cancels the run: `$/cancelRequest` under serve, SIGINT (POSIX) or a process-tree kill (Windows). */
  readonly cancellation?: CancellationToken;
  /**
   * Inject the folder's stored credentials and `opentide.envFile` variables. Default: only when the
   * command contacts a tenant (see `Classification.contactsTenant`). `false` never injects.
   */
  readonly credentials?: boolean;
  /** Progress events (opentide#756). Under spawn this sets `OPENTIDE_PROGRESS=json`. */
  readonly onProgress?: (event: ProgressEvent) => void;
  /** `spawn` forces a process of its own; `auto` (default) follows the command's classification. */
  readonly via?: "auto" | "spawn";
  /** Extra environment for this run (never logged). */
  readonly env?: Readonly<Record<string, string>>;
}

export interface RunResult {
  /** Exactly what `opentide --json <argv>` printed. */
  readonly document: Envelope;
  readonly exitCode: number;
  /** `opentide --json <argv>`, shell-quoted, secrets redacted: what the UI shows and copies. */
  readonly argvDisplay: string;
  readonly folder: string;
  readonly durationMs: number;
  readonly via: "serve" | "spawn";
  readonly cancelled: boolean;
}

export type RunStatus = "running" | "ok" | "failed" | "cancelled" | "error";

/** One run, as the Activity log and the output channel see it. Fired when it starts and when it ends. */
export interface RunRecord {
  readonly id: number;
  readonly folder: string;
  readonly argv: readonly string[];
  readonly argvDisplay: string;
  readonly startedAt: number;
  readonly status: RunStatus;
  readonly classification: Classification;
  readonly via?: "serve" | "spawn";
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly failureCode?: string;
  /** For `error`: why no document came back. */
  readonly error?: string;
}

export interface BackendDeps {
  runtime(): Runtime | undefined;
  /** The active runtime's command tree, once loaded. */
  commands(): Promise<CommandTree | undefined>;
  classify(argv: readonly string[]): Classification;
  /** `opentide.backend.serve`. */
  serveMode(): "auto" | "never";
  baseEnv(): Readonly<Record<string, string | undefined>>;
  /** VS Code's `http.proxy`, passed as `OPENTIDE_PROXY`. */
  proxy(): string | undefined;
  /** Stored credentials and `opentide.envFile` variables for a folder. */
  credentials(folder: string): Promise<Readonly<Record<string, string>>>;
  readonly platform: NodeJS.Platform;
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
  readonly spawn?: SpawnFn;
  now?(): number;
}

/** A first-in, first-out lock: writers run one at a time. */
class Queue {
  private tail: Promise<void> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class Backend {
  private serve: ServeClient | undefined;
  private serveBrokenFor: Runtime | undefined;
  private readonly writes = new Queue();
  private nextId = 1;
  private disposed = false;
  private readonly runEmitter = new Emitter<RunRecord>();
  private readonly serveEmitter = new Emitter<{ running: boolean; version?: string; digest?: string }>();

  /** Every run, when it starts (`status: "running"`) and when it ends. */
  readonly onDidRun: Event<RunRecord> = this.runEmitter.event;
  /** The serve process started (with its `commands_digest`) or stopped. */
  readonly onDidChangeServe: Event<{ running: boolean; version?: string; digest?: string }> =
    this.serveEmitter.event;

  constructor(private readonly deps: BackendDeps) {}

  /** Whether commands can run at all, and why not. */
  availability():
    | { available: true }
    | { available: false; code: "no-runtime" | "untrusted" | "editor-only" } {
    const runtime = this.deps.runtime();
    if (!runtime) return { available: false, code: "no-runtime" };
    if (runtime.restricted) return { available: false, code: "untrusted" };
    if (runtime.kind !== "opentide") return { available: false, code: "editor-only" };
    return { available: true };
  }

  get serveRunning(): boolean {
    return this.serve?.isRunning ?? false;
  }

  async run(folder: string, argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    const runtime = this.deps.runtime();
    if (this.disposed) throw new BackendError("disposed", "the opentide backend was disposed");
    if (!hasCli(runtime)) {
      const unavailable = this.availability();
      const code = unavailable.available ? "no-runtime" : unavailable.code;
      const messages = {
        untrusted: "Trust this folder to run opentide commands.",
        "editor-only": "opentide.path names opentide-lsp, which has no commands. Point it at opentide.",
        "no-runtime": "No opentide runtime: install opentide in the workspace or set opentide.path.",
      };
      throw new BackendError(code, messages[code]);
    }
    const classification = this.deps.classify(argv);
    const task = () => this.execute(runtime, folder, argv, classification, options);
    return classification.writes ? this.writes.run(task) : task();
  }

  private async execute(
    runtime: Runtime,
    folder: string,
    argv: readonly string[],
    classification: Classification,
    options: RunOptions,
  ): Promise<RunResult> {
    const now = this.deps.now ?? Date.now;
    const inject = options.credentials ?? classification.contactsTenant;
    const credentials = inject ? await this.deps.credentials(folder) : {};
    const secrets = Object.values(credentials);
    const argvDisplay = displayArgv(argv, secrets);
    const id = this.nextId++;
    const startedAt = now();
    const base = { id, folder, argv, argvDisplay, startedAt, classification };
    this.runEmitter.fire({ ...base, status: "running" });
    this.deps.log("info", `▶ ${argvDisplay}  (in ${folder})`);

    const finish = (result: Omit<RunResult, "argvDisplay" | "folder" | "durationMs">): RunResult => {
      const durationMs = now() - startedAt;
      const failureCode = result.document.failure?.code;
      const status: RunStatus = result.cancelled ? "cancelled" : result.exitCode === 0 ? "ok" : "failed";
      this.runEmitter.fire({
        ...base,
        status,
        via: result.via,
        durationMs,
        exitCode: result.exitCode,
        ...(failureCode ? { failureCode } : {}),
      });
      this.deps.log(
        result.exitCode === 0 ? "info" : "warn",
        `${status === "ok" ? "✓" : status === "cancelled" ? "◼" : "✗"} ${argvDisplay}  exit ${result.exitCode}` +
          `${failureCode ? ` (${failureCode})` : ""} in ${durationMs} ms via ${result.via}`,
      );
      return { ...result, argvDisplay, folder, durationMs };
    };

    try {
      const useServe = options.via !== "spawn" && !classification.spawn && (await this.canServe(runtime));
      if (useServe) {
        try {
          return finish(await this.viaServe(runtime, folder, argv, credentials, options));
        } catch (error) {
          if (!(error instanceof BackendError) || error.code !== "crashed") throw error;
          // The backend died under this request. One retry on a fresh process for a read-only command;
          // a writer may have half-run, so it reports the crash instead.
          this.deps.log(
            "warn",
            `opentide serve crashed: ${error.message}${error.detail ? `\n${error.detail}` : ""}`,
          );
          this.serve = undefined;
          if (classification.writes) throw error;
          return finish(await this.viaServe(runtime, folder, argv, credentials, options));
        }
      }
      return finish(await this.viaSpawn(runtime, folder, argv, credentials, options));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.runEmitter.fire({ ...base, status: "error", durationMs: now() - startedAt, error: message });
      const detail =
        error instanceof BackendError && error.detail ? `\n${redact(error.detail, secrets)}` : "";
      this.deps.log("error", `✗ ${argvDisplay}: ${redact(message, secrets)}${detail}`);
      throw error;
    }
  }

  private async canServe(runtime: Runtime): Promise<boolean> {
    if (this.deps.serveMode() === "never" || this.serveBrokenFor === runtime) return false;
    if (this.serve?.isRunning) return true;
    const tree = await this.deps.commands();
    return tree?.hasCommand("serve") ?? false;
  }

  private async ensureServe(runtime: Runtime, folder: string): Promise<ServeClient> {
    if (this.serve?.isRunning) return this.serve;
    const env = processEnv(this.deps.baseEnv(), runtime, this.deps.platform, this.fixedEnv());
    const { command, args } = cliCommand(runtime, ["serve"]);
    const spawn = this.deps.spawn ?? (await import("node:child_process")).spawn;
    const client = new ServeClient({
      start: (): cp.ChildProcess =>
        spawn(command, args, {
          cwd: folder,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          shell: false,
        }),
      log: (level, message) => this.deps.log(level, message),
    });
    this.serve = client;
    client.onDidExit(({ code, signal, expected }) => {
      if (this.serve === client) this.serve = undefined;
      if (!expected)
        this.deps.log(
          "warn",
          `opentide serve exited (${signal ?? `code ${code}`}); the next request restarts it`,
        );
      this.serveEmitter.fire({ running: false });
    });
    try {
      const init = await client.start();
      this.deps.log("info", `opentide serve ${init.version} started (pid ${client.pid})`);
      this.serveEmitter.fire({ running: true, version: init.version, digest: init.commands_digest });
    } catch (error) {
      if (this.serve === client) this.serve = undefined;
      // A serve that cannot start falls back to spawning for this runtime, until the next restart.
      this.serveBrokenFor = runtime;
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log("warn", `opentide serve unavailable, spawning instead: ${message}`);
      throw error;
    }
    return client;
  }

  private fixedEnv(): Record<string, string> {
    const env: Record<string, string> = { NO_COLOR: "1" };
    const proxy = this.deps.proxy();
    if (proxy) env.OPENTIDE_PROXY = proxy;
    return env;
  }

  private async viaServe(
    runtime: Runtime,
    folder: string,
    argv: readonly string[],
    credentials: Readonly<Record<string, string>>,
    options: RunOptions,
  ): Promise<Omit<RunResult, "argvDisplay" | "folder" | "durationMs">> {
    let client: ServeClient;
    try {
      client = await this.ensureServe(runtime, folder);
    } catch (error) {
      if (this.serveBrokenFor === runtime) return this.viaSpawn(runtime, folder, argv, credentials, options);
      throw error;
    }
    const env: Record<string, string> = {
      OPENTIDE_REPO_ROOT: folder,
      ...credentials,
      ...(options.env ?? {}),
    };
    const result = await client.run(
      { argv, cwd: folder, env },
      {
        ...(options.cancellation ? { token: options.cancellation } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      },
    );
    return {
      document: result.document,
      exitCode: result.exit_code,
      via: "serve",
      cancelled: options.cancellation?.isCancellationRequested === true && result.exit_code === 130,
    };
  }

  private async viaSpawn(
    runtime: Runtime,
    folder: string,
    argv: readonly string[],
    credentials: Readonly<Record<string, string>>,
    options: RunOptions,
  ): Promise<Omit<RunResult, "argvDisplay" | "folder" | "durationMs">> {
    const extra: Record<string, string> = {
      ...this.fixedEnv(),
      OPENTIDE_REPO_ROOT: folder,
      ...(options.onProgress ? { OPENTIDE_PROGRESS: "json" } : {}),
      ...credentials,
      ...(options.env ?? {}),
    };
    const env = processEnv(this.deps.baseEnv(), runtime, this.deps.platform, extra);
    const { command, args } = cliCommand(runtime, ["--json", ...argv]);
    const secrets = Object.values(credentials);
    const result = await spawnRun({
      command,
      args,
      commandName: argv[0] ?? "",
      env,
      cwd: folder,
      platform: this.deps.platform,
      ...(options.cancellation ? { token: options.cancellation } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      onStderr: (line) => this.deps.log("debug", redact(line, secrets)),
      ...(this.deps.spawn ? { spawn: this.deps.spawn } : {}),
    });
    return {
      document: result.document,
      exitCode: result.exitCode,
      via: "spawn",
      cancelled: result.cancelled,
    };
  }

  /** Forward file changes to `opentide serve` (absolute paths). No-op when it is not running. */
  invalidate(paths: readonly string[]): void {
    this.serve?.invalidate(paths);
  }

  /** Stop the serve process; the next request starts a new one. */
  async restart(): Promise<void> {
    const serve = this.serve;
    this.serve = undefined;
    this.serveBrokenFor = undefined;
    await serve?.stop();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.restart();
    this.runEmitter.dispose();
    this.serveEmitter.dispose();
  }
}
