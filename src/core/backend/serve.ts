// The `opentide serve` client (CONTRACTS.md): JSON-RPC 2.0, one message per line, on stdio. vscode-free.
import type * as cp from "node:child_process";
import type { CancellationToken } from "../util/cancellation";
import { Emitter, type Event } from "../util/event";
import { fromChildProcess, isServeProcess, type ServeProcess } from "./process";
import { lineSplitter } from "./spawn";
import { BackendError, type Envelope, isEnvelope, type ProgressEvent } from "./types";

export const SERVE_PROTOCOL = 1;

export interface InitializeResult {
  readonly protocol: number;
  readonly version: string;
  readonly commands_digest: string;
}

export interface RunParams {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ServeRunResult {
  readonly document: Envelope;
  readonly exit_code: number;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onProgress?: (event: ProgressEvent) => void;
}

export interface ServeClientOptions {
  /**
   * Start the `opentide serve` process: a child process (stdin, stdout and stderr piped), or a
   * `ServeProcess` such as the WASI module in the extension host, which starts asynchronously.
   */
  readonly start: () => cp.ChildProcess | ServeProcess | Promise<cp.ChildProcess | ServeProcess>;
  /** The params of `initialize` (default `{}`): `{capabilities: {fetch: true}}` asks for `opentide/fetch`. */
  readonly initializeParams?: object;
  readonly log?: (level: "debug" | "info" | "warn", message: string) => void;
  readonly initializeTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

/** One `opentide serve` process. Create a new client after it exits. */
export class ServeClient {
  private proc: ServeProcess | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private exited = false;
  private readonly exitEmitter = new Emitter<{
    code: number | null;
    signal: string | null;
    expected: boolean;
  }>();
  private stopping = false;
  private initialized: Promise<InitializeResult> | undefined;
  private readonly stderrTail: string[] = [];

  /** Fires once when the process exits; `expected` after `stop()`. */
  readonly onDidExit: Event<{ code: number | null; signal: string | null; expected: boolean }> =
    this.exitEmitter.event;

  constructor(private readonly options: ServeClientOptions) {}

  /** Started (the process may still be coming up) and not ended. */
  get isRunning(): boolean {
    return this.initialized !== undefined && !this.exited;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** Start the process and send `initialize`. Idempotent. */
  start(): Promise<InitializeResult> {
    if (this.initialized) return this.initialized;
    this.initialized = this.doStart();
    return this.initialized;
  }

  private async doStart(): Promise<InitializeResult> {
    let proc: ServeProcess;
    try {
      const started = await this.options.start();
      proc = isServeProcess(started) ? started : fromChildProcess(started);
    } catch (error) {
      this.exited = true;
      throw new BackendError("spawn-failed", `could not start opentide serve: ${String(error)}`);
    }
    this.proc = proc;
    const stdout = lineSplitter((line) => this.onLine(line));
    const stderr = lineSplitter((line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
      this.options.log?.("debug", `serve: ${line}`);
    });
    proc.onStdout((chunk) => stdout.push(chunk));
    proc.onStderr((chunk) => stderr.push(chunk));
    const startError = new Promise<never>((_, reject) => {
      proc.onError((error) => {
        this.handleExit(null, null);
        reject(new BackendError("spawn-failed", `could not start opentide serve: ${error.message}`));
      });
    });
    proc.onClose((code, signal) => this.handleExit(code, signal));

    const timeoutMs = this.options.initializeTimeoutMs ?? 30_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new BackendError("protocol", `opentide serve did not answer initialize within ${timeoutMs} ms`),
        );
      }, timeoutMs);
    });
    try {
      const result = (await Promise.race([
        this.request("initialize", this.options.initializeParams ?? {}),
        startError,
        timeout,
      ])) as InitializeResult;
      if (!result || typeof result.version !== "string") {
        throw new BackendError("protocol", "opentide serve answered initialize without a version");
      }
      if (result.protocol !== SERVE_PROTOCOL) {
        throw new BackendError(
          "protocol",
          `opentide serve speaks protocol ${result.protocol}, not ${SERVE_PROTOCOL}`,
        );
      }
      return result;
    } catch (error) {
      this.kill();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** `run`: resolves with the command's document, even when the command failed. */
  async run(
    params: RunParams,
    options: { token?: CancellationToken; onProgress?: (event: ProgressEvent) => void } = {},
  ): Promise<ServeRunResult> {
    await this.start();
    const { id, promise } = this.send("run", params, options.onProgress);
    const subscription = options.token?.onCancellationRequested(() => this.notify("$/cancelRequest", { id }));
    try {
      const result = (await promise) as { document?: unknown; exit_code?: unknown };
      if (!result || !isEnvelope(result.document) || typeof result.exit_code !== "number") {
        throw new BackendError("protocol", "opentide serve answered run without a document and exit_code");
      }
      return { document: result.document, exit_code: result.exit_code };
    } finally {
      subscription?.dispose();
    }
  }

  invalidate(paths: readonly string[]): void {
    if (paths.length > 0 && this.isRunning) this.notify("invalidate", { paths });
  }

  /** `shutdown`, then `exit`; kills the process when it does not exit in time. */
  async stop(): Promise<void> {
    if (!this.proc || this.exited) return;
    this.stopping = true;
    const exited = new Promise<void>((resolve) => this.onDidExit(() => resolve()));
    const timeoutMs = this.options.shutdownTimeoutMs ?? 2000;
    try {
      await Promise.race([
        this.request("shutdown", null),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
      this.notify("exit", null);
    } catch {
      // the process is going away either way
    }
    const timer = setTimeout(() => this.kill(), timeoutMs);
    await exited;
    clearTimeout(timer);
  }

  kill(): void {
    if (this.proc && !this.exited) this.proc.kill();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return this.send(method, params).promise;
  }

  private send(
    method: string,
    params: unknown,
    onProgress?: (event: ProgressEvent) => void,
  ): { id: number; promise: Promise<unknown> } {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      if (this.exited || !this.proc) {
        reject(new BackendError("crashed", "opentide serve is not running", this.stderrTail.join("\n")));
        return;
      }
      this.pending.set(id, { resolve, reject, ...(onProgress ? { onProgress } : {}) });
      this.write({ jsonrpc: "2.0", id, method, ...(params === null ? {} : { params }) });
    });
    return { id, promise };
  }

  private notify(method: string, params: unknown): void {
    if (this.exited) return;
    this.write({ jsonrpc: "2.0", method, ...(params === null ? {} : { params }) });
  }

  private write(message: object): void {
    this.proc?.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let message: {
      id?: number | string | null;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string };
    };
    try {
      message = JSON.parse(line);
    } catch {
      this.options.log?.("warn", `serve: not JSON on stdout: ${line.slice(0, 200)}`);
      return;
    }
    if (message.method !== undefined) {
      if (message.method === "progress") {
        const params = message.params as { id?: number; event?: ProgressEvent } | undefined;
        const target = params?.id !== undefined ? this.pending.get(Number(params.id)) : undefined;
        if (params?.event) target?.onProgress?.(params.event);
      } else if (message.id !== undefined && message.id !== null) {
        this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      }
      return;
    }
    const id = typeof message.id === "number" ? message.id : Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (message.error) {
      pending.reject(
        isShutDown(message.error)
          ? new BackendError("shut-down", `opentide serve: ${message.error.message} (${message.error.code})`)
          : new BackendError("protocol", `opentide serve: ${message.error.message} (${message.error.code})`),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private handleExit(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    const error = new BackendError(
      "crashed",
      `opentide serve exited (${signal ?? `code ${code}`}) with a request pending`,
      this.stderrTail.join("\n"),
    );
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.exitEmitter.fire({ code, signal, expected: this.stopping });
    this.exitEmitter.dispose();
  }
}

/**
 * The answer opentide serve gives a request that arrives after `shutdown` (Invalid Request, "The server
 * is shut down; send exit"). It answers before parsing or running the request, so the request never ran.
 */
export function isShutDown(error: { code: number; message: string }): boolean {
  return error.code === -32600 && /shut ?down/i.test(error.message);
}
