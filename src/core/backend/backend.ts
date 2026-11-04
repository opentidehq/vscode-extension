// The backend: one `run(folder, argv)` for every opentide command (SPEC D2, #12). It answers through one
// warm `opentide serve` per window when the runtime has it, and spawns `opentide --json <argv>` otherwise
// or for commands that want a process of their own. vscode-free; core/services wires it to VS Code.
import * as cp from "node:child_process";
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
  /** The runtime `serve` was started for: a run for another runtime replaces the process. */
  private serveRuntime: Runtime | undefined;
  /** Settles when `serve` answered `initialize`: every caller waits on the same start. */
  private serveReady: Promise<ServeClient> | undefined;
  /** Bumped by restart(), so a start it overtook does not mark the new runtime broken. */
  private generation = 0;
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
          // a writer may have half-run, so it reports the crash instead. viaServe already dropped the
          // client that crashed (and only that one).
          this.deps.log(
            "warn",
            `opentide serve crashed: ${error.message}${error.detail ? `\n${error.detail}` : ""}`,
          );
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
    if (this.serve?.isRunning && this.serveRuntime === runtime) return true;
    const tree = await this.deps.commands();
    return tree?.hasCommand("serve") ?? false;
  }

  /** Forget `client` if it is still the current one (it exited, crashed or was replaced). */
  private dropServe(client: ServeClient): void {
    if (this.serve !== client) return;
    this.serve = undefined;
    this.serveRuntime = undefined;
    this.serveReady = undefined;
  }

  /**
   * The serve client for `runtime`, started once however many requests ask at the same time. A client
   * started for another runtime (a run that began while the runtime was switching) is stopped first.
   */
  private ensureServe(runtime: Runtime, folder: string): Promise<ServeClient> {
    const current = this.serve;
    if (current && this.serveRuntime !== runtime) {
      this.dropServe(current);
      this.deps.log("info", "the opentide runtime changed: stopping the serve started for the previous one");
      void current.stop();
    }
    if (this.serveBrokenFor === runtime) {
      return Promise.reject(new BackendError("protocol", "opentide serve is unavailable for this runtime"));
    }
    if (this.serve?.isRunning && this.serveReady) return this.serveReady;

    const env = processEnv(this.deps.baseEnv(), runtime, this.deps.platform, this.fixedEnv());
    const { command, args } = cliCommand(runtime, ["serve"]);
    const spawn = this.deps.spawn ?? cp.spawn;
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
    const generation = this.generation;
    this.serve = client;
    this.serveRuntime = runtime;
    client.onDidExit(({ code, signal, expected }) => {
      const wasCurrent = this.serve === client || this.serve === undefined;
      this.dropServe(client);
      if (!expected)
        this.deps.log(
          "warn",
          `opentide serve exited (${signal ?? `code ${code}`}); the next request restarts it`,
        );
      if (wasCurrent) this.serveEmitter.fire({ running: false });
    });
    // start() spawns synchronously, so `client.isRunning` holds before this returns: a concurrent
    // request finds this promise instead of starting a process of its own.
    const ready = client.start().then(
      (init) => {
        this.deps.log("info", `opentide serve ${init.version} started (pid ${client.pid})`);
        this.serveEmitter.fire({ running: true, version: init.version, digest: init.commands_digest });
        return client;
      },
      (error: unknown) => {
        this.dropServe(client);
        // A serve that cannot start falls back to spawning for this runtime, until the next restart.
        if (generation === this.generation) this.serveBrokenFor = runtime;
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log("warn", `opentide serve unavailable, spawning instead: ${message}`);
        throw error;
      },
    );
    this.serveReady = ready;
    return ready;
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
    const generation = this.generation;
    try {
      // Every caller, also one that arrived while another request was starting serve, waits on the
      // same start here, so a start that fails sends each of them to spawn.
      client = await this.ensureServe(runtime, folder);
    } catch (error) {
      if (this.serveBrokenFor === runtime) return this.viaSpawn(runtime, folder, argv, credentials, options);
      // restart() stopped the serve this request was waiting for: it never reached a serve, so it runs
      // on the current backend whatever its class (a writer included), not as a crash.
      if (this.generation !== generation) return this.rerun(folder, argv, credentials, options, error);
      throw error;
    }
    if (this.generation !== generation || !client.isRunning)
      return this.rerun(
        folder,
        argv,
        credentials,
        options,
        new BackendError("crashed", "opentide serve stopped"),
      );
    const env: Record<string, string> = {
      OPENTIDE_REPO_ROOT: folder,
      ...credentials,
      ...(options.env ?? {}),
    };
    let result: Awaited<ReturnType<ServeClient["run"]>>;
    try {
      result = await client.run(
        { argv, cwd: folder, env },
        {
          ...(options.cancellation ? { token: options.cancellation } : {}),
          ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        },
      );
    } catch (error) {
      if (error instanceof BackendError && error.code === "crashed") this.dropServe(client);
      throw error;
    }
    return {
      document: result.document,
      exitCode: result.exit_code,
      via: "serve",
      cancelled: options.cancellation?.isCancellationRequested === true && result.exit_code === 130,
    };
  }

  /** Run a request that never reached a serve on the backend there is now (after a restart). */
  private async rerun(
    folder: string,
    argv: readonly string[],
    credentials: Readonly<Record<string, string>>,
    options: RunOptions,
    error: unknown,
  ): Promise<Omit<RunResult, "argvDisplay" | "folder" | "durationMs">> {
    const runtime = this.deps.runtime();
    if (this.disposed || !hasCli(runtime)) throw error;
    this.deps.log("info", "opentide serve restarted before the request reached it: running it again");
    return (await this.canServe(runtime))
      ? this.viaServe(runtime, folder, argv, credentials, options)
      : this.viaSpawn(runtime, folder, argv, credentials, options);
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

  /**
   * The environment a run of `folder` that contacts a tenant gets: stored credentials over
   * `opentide.envFile` variables. For processes the extension starts itself (a task or a terminal running
   * such a command). Never log or display the values; empty when commands cannot run.
   */
  async credentialEnv(folder: string): Promise<Readonly<Record<string, string>>> {
    if (!hasCli(this.deps.runtime())) return {};
    return this.deps.credentials(folder);
  }

  /** Forward file changes to `opentide serve` (absolute paths). No-op when it is not running. */
  invalidate(paths: readonly string[]): void {
    this.serve?.invalidate(paths);
  }

  /** Stop the serve process; the next request starts a new one. */
  async restart(): Promise<void> {
    const serve = this.serve;
    this.generation++;
    this.serve = undefined;
    this.serveRuntime = undefined;
    this.serveReady = undefined;
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
