// The backend: one `run(folder, argv)` for every opentide command (SPEC D2, #12). It answers through one
// warm `opentide serve` per window when the runtime has it, and spawns `opentide --json <argv>` otherwise
// or for commands that want a process of their own. vscode-free; core/services wires it to VS Code.
import * as cp from "node:child_process";

import type { Classification } from "../capabilities/classification";
import type { CommandTree } from "../capabilities/tree";
import { displayArgv, processEnv, redact } from "../runtime/env";
import { cliCommand, hasCli, isWasi, type Runtime } from "../runtime/types";
import { editorOnlyText } from "../unavailable";
import { type CancellationToken, CancellationTokenSource } from "../util/cancellation";
import { Emitter, type Event } from "../util/event";
import { loadSupervisor } from "./load";
import type { ServeProcess } from "./process";
import { ServeClient } from "./serve";
import { type SpawnFn, spawnRun } from "./spawn";
import type { CrashBudget, Lane, WriteLock } from "./supervisor";
import { BackendError, cancelledEnvelope, type Envelope, type ProgressEvent } from "./types";

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
  /**
   * The runtime once a restart in progress has resolved it; the current one when none is. A request that a restart
   * cut off runs again on this: during the restart, `runtime()` is still the one it is leaving.
   */
  settledRuntime?(): Promise<Runtime | undefined>;
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
  /**
   * The WASI module's `opentide serve`, started in the extension host (src/core/services/wasi.ts): a WASI
   * runtime serves every command through it, tenant commands included (`opentide/fetch`).
   */
  readonly wasi?: {
    start(): Promise<ServeProcess>;
    /** `initialize`'s params: `{capabilities: {fetch: true}}`. */
    readonly initializeParams: object;
  };
  now?(): number;
  /**
   * A notice for the user, shown once when a WASI runtime's serve crashed past the ceiling and commands stop running
   * until "opentide: Restart Server". A native runtime spawns its commands instead, with a log line.
   */
  notify?(message: string): void;
  /** The supervisor's timings (supervisor.ts has the defaults); tests shorten them. */
  readonly supervision?: {
    readonly cancelGraceMs?: number;
    /** The interactive lane's deadline (INTERACTIVE_TIMEOUT_MS). */
    readonly interactiveTimeoutMs?: number;
    /** How long the long lane's serve stays up idle (LONG_IDLE_MS). */
    readonly longIdleMs?: number;
    readonly crashBackoffMs?: number;
    readonly crashWindowMs?: number;
  };
}

/** Why a WASI runtime's commands stopped: its serve crashed past the ceiling. */
export const SERVE_GIVEN_UP =
  "opentide serve stopped working: it crashed 4 times within 2 minutes. Run \u201copentide: Restart Server\u201d to try again.";

/**
 * A serve lane: one `opentide serve` process and its supervision. `interactive` answers what the editor asks while you
 * work (validate, the catalogue, explain); `long` runs the commands that contact a tenant or would be a process of their
 * own natively (a query, a deploy dry run, doctor), so one of those never holds the others up behind serve's one request
 * at a time (CONTRACTS.md). `long` starts with the first such command.
 */
export type LaneName = "interactive" | "long";

interface ServeLane {
  readonly name: LaneName;
  serve: ServeClient | undefined;
  /** The runtime `serve` was started for: a run for another runtime replaces the process. */
  serveRuntime: Runtime | undefined;
  /** Settles when `serve` answered `initialize`: every caller waits on the same start. */
  serveReady: Promise<ServeClient> | undefined;
  serveBrokenFor: Runtime | undefined;
  /** A WASI runtime whose serve crashed past the ceiling: its commands are refused until restart(). */
  serveGivenUpFor: Runtime | undefined;
  /** The crash ceiling of the runtime whose serve last crashed. */
  crashes: { readonly runtime: Runtime; readonly budget: CrashBudget } | undefined;
  /** No serve starts before this time: the backoff after a crash. */
  restartAt: number;
  /** Requests on the lane's serve right now. */
  inFlight: number;
  /** The long lane stops its serve once it has been idle this long (LONG_IDLE_MS). */
  idleTimer: NodeJS.Timeout | undefined;
}

const newLane = (name: LaneName): ServeLane => ({
  name,
  serve: undefined,
  serveRuntime: undefined,
  serveReady: undefined,
  serveBrokenFor: undefined,
  serveGivenUpFor: undefined,
  crashes: undefined,
  restartAt: 0,
  inFlight: 0,
  idleTimer: undefined,
});

/**
 * How long the interactive lane waits for an answer before it cancels the command (then kills, after the grace): a hard
 * stop for a serve that hangs, far above a full `validate` of a large workspace under WASI.
 */
export const INTERACTIVE_TIMEOUT_MS = 300_000;

/**
 * How long the long lane's serve stays up after its last command: a second serve costs about 100–180 MB (SPEC §14), so it
 * is there while long commands come, not for the window's life.
 */
export const LONG_IDLE_MS = 120_000;

/**
 * Whether two runtimes are the same opentide: one object, or two resolutions of it that agree in every field (the
 * runtime is resolved again on a settings change, and a new object for the same opentide is not a reason to restart).
 */
export function sameRuntime(a: Runtime | undefined, b: Runtime | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));
}

/** The lane a command runs on, when it runs through serve. */
export function laneFor(classification: Classification): LaneName {
  return classification.spawn || classification.contactsTenant ? "long" : "interactive";
}

export class Backend {
  private readonly interactive = newLane("interactive");
  /** Made with the first long command. */
  private long: ServeLane | undefined;
  /** Bumped by restart(), so a start it overtook does not mark the new runtime broken. */
  private generation = 0;
  /** Serve processes killed on purpose (a cancel they did not answer): their exit is not a crash. */
  private readonly killed = new WeakSet<ServeClient>();
  /** Each serve process's lane: closing it stops the process (supervisor.ts openLane). */
  private readonly lanes = new WeakMap<ServeClient, Lane<ServeClient>>();
  /** Writers one at a time (supervisor.ts), made with the first writer. */
  private writes: WriteLock | undefined;
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

  /** Whether the interactive lane's serve is running (the one the status shows). */
  get serveRunning(): boolean {
    return this.interactive.serve?.isRunning ?? false;
  }

  /** Whether each lane's serve process is running: the long lane's only after a long command. */
  get lanesRunning(): Readonly<Record<LaneName, boolean>> {
    return { interactive: this.serveRunning, long: this.long?.serve?.isRunning ?? false };
  }

  private laneOf(classification: Classification): ServeLane {
    if (laneFor(classification) === "interactive") return this.interactive;
    this.long ??= newLane("long");
    return this.long;
  }

  private allLanes(): ServeLane[] {
    return this.long ? [this.interactive, this.long] : [this.interactive];
  }

  async run(folder: string, argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    const runtime = this.deps.runtime();
    if (this.disposed) throw new BackendError("disposed", "the opentide backend was disposed");
    if (!hasCli(runtime)) {
      const unavailable = this.availability();
      const code = unavailable.available ? "no-runtime" : unavailable.code;
      const messages = {
        untrusted: "Trust this folder to run opentide commands.",
        "editor-only": editorOnlyText(runtime, "this command"),
        "no-runtime": "No opentide runtime: install opentide in the workspace or set opentide.path.",
      };
      throw new BackendError(code, messages[code]);
    }
    const classification = this.deps.classify(argv);
    const task = (notStarted = false) =>
      this.execute(runtime, folder, argv, classification, options, notStarted);
    if (!classification.writes) return task();
    const supervisor = loadSupervisor();
    this.writes ??= supervisor.makeWriteLock();
    try {
      return await this.writes.run(() => task(), options.cancellation);
    } catch (error) {
      // Cancelled while it waited for the writer before it: it never ran, and says so.
      if (supervisor.isWaitCancelled(error)) return task(true);
      throw error;
    }
  }

  private async execute(
    runtime: Runtime,
    folder: string,
    argv: readonly string[],
    classification: Classification,
    options: RunOptions,
    notStarted = false,
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

    if (notStarted) {
      return finish({
        document: cancelledEnvelope(argv[0] ?? ""),
        exitCode: 130,
        via: isWasi(runtime) || !classification.spawn ? "serve" : "spawn",
        cancelled: true,
      });
    }

    try {
      // The WASI module has no network of its own: every command, the tenant ones too, goes through serve,
      // where the extension host makes the tenant requests (`opentide/fetch`).
      const lane = this.laneOf(classification);
      const useServe =
        options.via !== "spawn" &&
        (isWasi(runtime) || !classification.spawn) &&
        (await this.canServe(runtime, lane));
      if (useServe) {
        try {
          return finish(await this.viaServe(lane, runtime, folder, argv, credentials, options));
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
          return finish(await this.viaServe(lane, runtime, folder, argv, credentials, options));
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

  private async canServe(runtime: Runtime, lane: ServeLane): Promise<boolean> {
    if (this.deps.serveMode() === "never" || sameRuntime(lane.serveBrokenFor, runtime)) return false;
    if (lane.serve?.isRunning && sameRuntime(lane.serveRuntime, runtime)) return true;
    if (isWasi(runtime)) return this.deps.wasi !== undefined;
    const tree = await this.deps.commands();
    return tree?.hasCommand("serve") ?? false;
  }

  /** Forget `client` if it is still the current one (it exited, crashed or was replaced). */
  private dropServe(lane: ServeLane, client: ServeClient): void {
    if (lane.serve !== client) return;
    lane.serve = undefined;
    lane.serveRuntime = undefined;
    lane.serveReady = undefined;
  }

  /**
   * The serve client for `runtime`, started once however many requests ask at the same time. A client
   * started for another runtime (a run that began while the runtime was switching) is stopped first.
   */
  private ensureServe(lane: ServeLane, runtime: Runtime, folder: string): Promise<ServeClient> {
    // A serve started for another runtime (a run that began while the runtime was switching), on either lane.
    for (const other of this.allLanes()) {
      const current = other.serve;
      // The same runtime resolved again (a new object, nothing changed): keep the process.
      if (current && sameRuntime(other.serveRuntime, runtime)) other.serveRuntime = runtime;
      // Another lane's process that is answering a request finishes it; it is replaced with its lane's next request.
      else if (current && (other === lane || other.inFlight === 0)) {
        this.deps.log(
          "info",
          `the opentide runtime changed: stopping the ${other.name} serve started for the previous one ` +
            `(${processLabel(current, other)})`,
        );
        this.dropServe(other, current);
        void this.closeLane(current);
      }
    }
    if (sameRuntime(lane.serveBrokenFor, runtime)) {
      return Promise.reject(new BackendError("protocol", "opentide serve is unavailable for this runtime"));
    }
    if (sameRuntime(lane.serveGivenUpFor, runtime))
      return Promise.reject(new BackendError("crashed", SERVE_GIVEN_UP));
    if (lane.serve?.isRunning && lane.serveReady) return lane.serveReady;

    const env = processEnv(this.deps.baseEnv(), runtime, this.deps.platform, this.fixedEnv());
    const { command, args } = cliCommand(runtime, ["serve"]);
    const spawn = this.deps.spawn ?? cp.spawn;
    const wasi = isWasi(runtime) ? this.deps.wasi : undefined;
    const log = (level: "debug" | "info" | "warn", message: string) => this.deps.log(level, message);
    // The lane is the process's scope: closing it (a runtime switch, restart, dispose) stops the process.
    const scope = loadSupervisor().openLane(
      () =>
        new ServeClient(
          wasi
            ? { start: () => wasi.start(), initializeParams: wasi.initializeParams, log }
            : {
                start: (): cp.ChildProcess =>
                  spawn(command, args, {
                    cwd: folder,
                    env,
                    stdio: ["pipe", "pipe", "pipe"],
                    windowsHide: true,
                    shell: false,
                  }),
                log,
              },
        ),
      (client) => client.stop(),
    );
    const client = scope.value;
    this.lanes.set(client, scope);
    const generation = this.generation;
    lane.serve = client;
    lane.serveRuntime = runtime;
    client.onDidExit(({ code, signal, expected }) => {
      const wasCurrent = lane.serve === client || lane.serve === undefined;
      this.dropServe(lane, client);
      if (!expected && !this.killed.has(client)) {
        this.deps.log(
          "warn",
          `opentide serve exited (${signal ?? `code ${code}`}); the next request restarts it`,
        );
        if (generation === this.generation) this.recordCrash(lane, runtime);
      }
      // The status shows the interactive serve; the long lane comes and goes with long commands.
      if (wasCurrent && lane === this.interactive) this.serveEmitter.fire({ running: false });
    });
    // start() spawns synchronously, so `client.isRunning` holds before this returns: a concurrent
    // request finds this promise instead of starting a process of its own.
    const ready = client.start().then(
      (init) => {
        this.deps.log(
          "info",
          `opentide serve ${init.version} started${lane === this.interactive ? "" : ` for long commands`} (${client.pid === undefined ? "WASI, in the extension host" : `pid ${client.pid}`})`,
        );
        if (lane === this.interactive)
          this.serveEmitter.fire({ running: true, version: init.version, digest: init.commands_digest });
        return client;
      },
      (error: unknown) => {
        this.dropServe(lane, client);
        // A serve that cannot start falls back to spawning for this runtime, until the next restart.
        if (generation === this.generation) lane.serveBrokenFor = runtime;
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log("warn", `opentide serve unavailable, spawning instead: ${message}`);
        throw error;
      },
    );
    lane.serveReady = ready;
    return ready;
  }

  private fixedEnv(): Record<string, string> {
    const env: Record<string, string> = { NO_COLOR: "1" };
    const proxy = this.deps.proxy();
    if (proxy) env.OPENTIDE_PROXY = proxy;
    return env;
  }

  /** A request on `lane`, counted from before its serve starts until it settles (the idle stop, a runtime change). */
  private async viaServe(
    lane: ServeLane,
    runtime: Runtime,
    folder: string,
    argv: readonly string[],
    credentials: Readonly<Record<string, string>>,
    options: RunOptions,
  ): Promise<Omit<RunResult, "argvDisplay" | "folder" | "durationMs">> {
    this.busy(lane);
    try {
      return await this.serveRequest(lane, runtime, folder, argv, credentials, options);
    } finally {
      this.idle(lane);
    }
  }

  private async serveRequest(
    lane: ServeLane,
    runtime: Runtime,
    folder: string,
    argv: readonly string[],
    credentials: Readonly<Record<string, string>>,
    options: RunOptions,
  ): Promise<Omit<RunResult, "argvDisplay" | "folder" | "durationMs">> {
    let client: ServeClient;
    const generation = this.generation;
    // The backoff after a crash (the supervisor's Schedule): a cancel during it ends the request before it starts.
    const wait = lane.serve?.isRunning ? 0 : lane.restartAt - (this.deps.now ?? Date.now)();
    if (wait > 0 && !(await waitUnlessCancelled(wait, options.cancellation)))
      return { document: cancelledEnvelope(argv[0] ?? ""), exitCode: 130, via: "serve", cancelled: true };
    try {
      // Every caller, also one that arrived while another request was starting serve, waits on the
      // same start here, so a start that fails sends each of them to spawn.
      client = await this.ensureServe(lane, runtime, folder);
    } catch (error) {
      if (sameRuntime(lane.serveBrokenFor, runtime))
        return this.viaSpawn(runtime, folder, argv, credentials, options);
      // restart() stopped the serve this request was waiting for: it never reached a serve, so it runs
      // on the current backend whatever its class (a writer included), not as a crash.
      if (this.generation !== generation) return this.rerun(lane, folder, argv, credentials, options, error);
      throw error;
    }
    if (this.generation !== generation || !client.isRunning)
      return this.rerun(
        lane,
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
    // The interactive lane gives a command a deadline, which cancels it as the user would; the long lane has none
    // (a tenant query runs until it answers or is cancelled).
    const timeoutMs =
      lane.name === "interactive"
        ? (this.deps.supervision?.interactiveTimeoutMs ?? INTERACTIVE_TIMEOUT_MS)
        : undefined;
    const deadline = new CancellationTokenSource();
    let timedOut = false;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            deadline.cancel();
          }, timeoutMs);
    const forward = options.cancellation?.onCancellationRequested(() => deadline.cancel());
    try {
      // Cancel-then-kill: a cancel sends `$/cancelRequest`; a serve that does not answer within the grace is killed.
      const supervisor = loadSupervisor();
      const graceMs = this.deps.supervision?.cancelGraceMs ?? supervisor.CANCEL_GRACE_MS;
      const settled = await supervisor.runWithGrace(
        (token) =>
          client.run(
            { argv, cwd: folder, env },
            { token, ...(options.onProgress ? { onProgress: options.onProgress } : {}) },
          ),
        {
          token: deadline.token,
          graceMs,
          kill: () => {
            this.killed.add(client);
            this.deps.log(
              "warn",
              `opentide serve ${processLabel(client, lane)} did not answer a cancel within ${graceMs} ms ` +
                `(\`${argv[0] ?? ""}\`, ${timedOut ? "its deadline passed" : "cancelled"}): killing it`,
            );
            // Forget it before it exits, so the next request (the writer this one held up) starts a new serve.
            this.dropServe(lane, client);
            client.kill();
          },
        },
      );
      const userCancelled = options.cancellation?.isCancellationRequested === true;
      // A command that answered anyway, just as the deadline passed, keeps its answer.
      const cut =
        settled.kind === "killed" || (settled.kind === "answered" && settled.value.exit_code === 130);
      if (timedOut && !userCancelled && cut)
        throw new BackendError(
          "timed-out",
          `opentide serve did not answer \`${argv[0] ?? ""}\` within ${Math.round((timeoutMs ?? 0) / 1000)} s: it was cancelled`,
        );
      if (settled.kind === "killed")
        return { document: cancelledEnvelope(argv[0] ?? ""), exitCode: 130, via: "serve", cancelled: true };
      if (settled.kind === "failed") throw settled.error;
      result = settled.value;
    } catch (error) {
      if (error instanceof BackendError && error.code === "shut-down") {
        // The runtime restarted while this request was on its way: the old serve refused it without
        // running it, so it runs again on the backend there is now, whatever its class. A serve that
        // shut down without our stop() waits for `exit`: stop it, or its process outlives the client.
        this.dropServe(lane, client);
        void this.closeLane(client);
        return this.rerun(lane, folder, argv, credentials, options, error);
      }
      if (error instanceof BackendError && error.code === "crashed") this.dropServe(lane, client);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      forward?.dispose();
      deadline.dispose();
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
    lane: ServeLane,
    folder: string,
    argv: readonly string[],
    credentials: Readonly<Record<string, string>>,
    options: RunOptions,
    error: unknown,
  ): Promise<Omit<RunResult, "argvDisplay" | "folder" | "durationMs">> {
    // The restart that cut it off may still be resolving: run it on the runtime it lands on, not the one it leaves.
    const runtime = this.deps.settledRuntime ? await this.deps.settledRuntime() : this.deps.runtime();
    if (this.disposed || !hasCli(runtime)) throw error;
    this.deps.log(
      "info",
      `opentide serve restarted before \`${argv[0] ?? ""}\` reached it: running it again on ${runtimeLabel(runtime)}`,
    );
    return (await this.canServe(runtime, lane))
      ? this.viaServe(lane, runtime, folder, argv, credentials, options)
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

  /** Forward file changes to every running `opentide serve` (absolute paths): both lanes read the workspace. */
  invalidate(paths: readonly string[]): void {
    for (const lane of this.allLanes()) lane.serve?.invalidate(paths);
  }

  /** Stop every lane's serve process, together; the next request on a lane starts a new one. */
  async restart(): Promise<void> {
    this.generation++;
    const serves: ServeClient[] = [];
    for (const lane of this.allLanes()) {
      if (lane.serve) {
        serves.push(lane.serve);
        this.deps.log("info", `stopping opentide serve ${processLabel(lane.serve, lane)}: restart`);
      }
      if (lane.idleTimer) clearTimeout(lane.idleTimer);
      Object.assign(lane, newLane(lane.name));
    }
    await Promise.all(serves.map((serve) => this.closeLane(serve)));
  }

  private busy(lane: ServeLane): void {
    lane.inFlight += 1;
    if (lane.idleTimer) clearTimeout(lane.idleTimer);
    lane.idleTimer = undefined;
  }

  /** A request on `lane` settled: once the long lane has nothing to do for LONG_IDLE_MS, its serve stops. */
  private idle(lane: ServeLane): void {
    lane.inFlight = Math.max(0, lane.inFlight - 1);
    const client = lane.serve;
    if (lane.name !== "long" || lane.inFlight > 0 || !client) return;
    const idleMs = this.deps.supervision?.longIdleMs ?? LONG_IDLE_MS;
    lane.idleTimer = setTimeout(() => {
      lane.idleTimer = undefined;
      if (lane.serve !== client || lane.inFlight > 0) return;
      this.deps.log("info", `stopping the serve for long commands: idle for ${Math.round(idleMs / 1000)} s`);
      this.dropServe(lane, client);
      void this.closeLane(client);
    }, idleMs);
    lane.idleTimer.unref?.();
  }

  /** Stop a serve process through its lane. */
  private closeLane(client: ServeClient): Promise<void> {
    return this.lanes.get(client)?.close() ?? client.stop();
  }

  /**
   * A serve crashed (it exited on its own, not stopped or killed by us): the supervisor's Schedule says how long
   * before the next start, or that the ceiling is reached. Then a native runtime spawns its commands, and a WASI
   * runtime, which cannot, refuses them with one notice until restart().
   */
  private recordCrash(lane: ServeLane, runtime: Runtime): void {
    const now = (this.deps.now ?? Date.now)();
    if (!lane.crashes || !sameRuntime(lane.crashes.runtime, runtime)) {
      const supervision = this.deps.supervision;
      lane.crashes = {
        runtime,
        budget: loadSupervisor().makeCrashBudget({
          ...(supervision?.crashBackoffMs !== undefined ? { baseMs: supervision.crashBackoffMs } : {}),
          ...(supervision?.crashWindowMs !== undefined ? { windowMs: supervision.crashWindowMs } : {}),
        }),
      };
    }
    const next = lane.crashes.budget.crashed(now);
    if (next) {
      lane.restartAt = now + next.delayMs;
      return;
    }
    if (!isWasi(runtime)) {
      lane.serveBrokenFor = runtime;
      this.deps.log(
        "warn",
        "opentide serve keeps crashing: running each command in a process of its own instead",
      );
      return;
    }
    if (sameRuntime(lane.serveGivenUpFor, runtime)) return;
    lane.serveGivenUpFor = runtime;
    this.deps.log("error", SERVE_GIVEN_UP);
    this.deps.notify?.(SERVE_GIVEN_UP);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.restart();
    this.runEmitter.dispose();
    this.serveEmitter.dispose();
  }
}

/** Wait `ms`, unless `token` is cancelled first: whether the wait ran out. */
function waitUnlessCancelled(ms: number, token: CancellationToken | undefined): Promise<boolean> {
  if (token?.isCancellationRequested) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      subscription?.dispose();
      resolve(true);
    }, ms);
    const subscription = token?.onCancellationRequested(() => {
      clearTimeout(timer);
      subscription?.dispose();
      resolve(false);
    });
  });
}

/** A runtime as a log line names it: its version and where it comes from. */
function runtimeLabel(runtime: Runtime): string {
  return `${runtime.version} (${isWasi(runtime) ? "the bundled WASI module" : runtime.source})`;
}

/** Which serve process a log line is about: its pid, lane and runtime. */
function processLabel(client: ServeClient, lane: ServeLane): string {
  const pid = client.pid;
  const runtime = lane.serveRuntime;
  return `(${pid !== undefined ? `pid ${pid}, ` : ""}${lane.name} lane${runtime ? `, ${runtimeLabel(runtime)}` : ""})`;
}
