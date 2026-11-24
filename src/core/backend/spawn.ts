// `opentide --json <argv>` as a process of its own. vscode-free.
import * as cp from "node:child_process";

import type { CancellationToken } from "../util/cancellation";
import { type SpawnFn, terminateChild } from "./terminate";
import { BackendError, cancelledEnvelope, type Envelope, isEnvelope, type ProgressEvent } from "./types";

export type { SpawnFn } from "./terminate";

export interface SpawnRunOptions {
  readonly command: string;
  /** The full argument list: the runtime's prefix, `--json`, then the command's argv. */
  readonly args: readonly string[];
  /** The opentide command, for messages and the cancelled document (`validate`). */
  readonly commandName?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string | undefined;
  readonly platform: NodeJS.Platform;
  readonly token?: CancellationToken;
  readonly onProgress?: (event: ProgressEvent) => void;
  /** Each non-event stderr line. */
  readonly onStderr?: (line: string) => void;
  readonly spawn?: SpawnFn;
  /** How long after SIGINT a process that has not exited gets killed. */
  readonly killAfterMs?: number;
}

export interface SpawnRunResult {
  readonly document: Envelope;
  readonly exitCode: number;
  readonly cancelled: boolean;
}

export { killTree } from "./terminate";

/** Split a stream into lines, calling `onLine` for each complete one. */
export function lineSplitter(onLine: (line: string) => void): { push(chunk: string): void; end(): void } {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        onLine(buffer.slice(0, index).replace(/\r$/, ""));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    },
    end() {
      if (buffer.length > 0) onLine(buffer.replace(/\r$/, ""));
      buffer = "";
    },
  };
}

/** A progress event from one stderr line, if it is one. */
export function parseProgressLine(line: string): ProgressEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value && typeof value === "object" && typeof (value as { event?: unknown }).event === "string") {
      return value as ProgressEvent;
    }
  } catch {
    // not an event
  }
  return undefined;
}

/** The JSON document in stdout: the whole of it, else the last line that parses as an envelope. */
export function parseDocument(stdout: string): Envelope | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (isEnvelope(value)) return value;
  } catch {
    // fall through
  }
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    if (!line.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isEnvelope(value)) return value;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

export function spawnRun(options: SpawnRunOptions): Promise<SpawnRunResult> {
  const spawn = options.spawn ?? cp.spawn;
  const commandName = options.commandName ?? "";
  return new Promise<SpawnRunResult>((resolve, reject) => {
    if (options.token?.isCancellationRequested) {
      resolve({ document: cancelledEnvelope(commandName), exitCode: 130, cancelled: true });
      return;
    }
    let child: cp.ChildProcess;
    try {
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      reject(new BackendError("spawn-failed", `could not start ${options.command}: ${String(error)}`));
      return;
    }
    const stdout: string[] = [];
    const stderrTail: string[] = [];
    let cancelled = false;
    const stderr = lineSplitter((line) => {
      const event = parseProgressLine(line);
      if (event && options.onProgress) {
        options.onProgress(event);
        return;
      }
      if (event) return;
      stderrTail.push(line);
      if (stderrTail.length > 40) stderrTail.shift();
      options.onStderr?.(line);
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: string) => stderr.push(chunk));

    const subscription = options.token?.onCancellationRequested(() => {
      if (cancelled) return;
      cancelled = true;
      // Ctrl-C first (opentide ends with 130), the tree after `killAfterMs`: the one termination every path uses.
      void terminateChild(child, {
        platform: options.platform,
        spawn,
        signal: "SIGINT",
        graceMs: options.killAfterMs ?? 5000,
      });
    });

    child.on("error", (error) => {
      subscription?.dispose();
      reject(new BackendError("spawn-failed", `could not start ${options.command}: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      subscription?.dispose();
      stderr.end();
      const exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
      const document = parseDocument(stdout.join(""));
      if (document) {
        resolve({ document, exitCode, cancelled });
      } else if (cancelled) {
        resolve({ document: cancelledEnvelope(commandName), exitCode: 130, cancelled: true });
      } else {
        reject(
          new BackendError(
            "bad-output",
            `${commandName || options.command} printed no JSON document (exit ${code ?? signal})`,
            stderrTail.join("\n"),
          ),
        );
      }
    });
  });
}
