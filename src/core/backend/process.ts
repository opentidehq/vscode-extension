// The process an `opentide serve` client talks to: a child process, or the WASI module in the extension host.
// vscode-free.
import type * as cp from "node:child_process";
import { terminateChild } from "./terminate";

/** What `ServeClient` needs of the process: lines in, lines out, and how it ends. */
export interface ServeProcess {
  /** The operating system's process id; undefined for the WASI module, which has none. */
  readonly pid?: number | undefined;
  /** Write text to the process's stdin. */
  write(text: string): void;
  /** Text from its stdout, as it arrives (UTF-8, any chunking). */
  onStdout(listener: (chunk: string) => void): void;
  /** Text from its stderr. */
  onStderr(listener: (chunk: string) => void): void;
  /** The process could not run (spawn failed). */
  onError(listener: (error: Error) => void): void;
  /** The process ended: its exit code (null when a signal ended it) and the signal. */
  onClose(listener: (code: number | null, signal: string | null) => void): void;
  /** End it at once. */
  kill(): void;
}

/** A child process (stdin, stdout and stderr piped) as a `ServeProcess`. */
export function fromChildProcess(child: cp.ChildProcess): ServeProcess {
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdin?.on("error", () => {
    // EPIPE after the process died; the close handler rejects what is pending.
  });
  return {
    pid: child.pid,
    write: (text) => {
      child.stdin?.write(text);
    },
    onStdout: (listener) => {
      child.stdout?.on("data", listener);
    },
    onStderr: (listener) => {
      child.stderr?.on("data", listener);
    },
    onError: (listener) => {
      child.on("error", listener);
    },
    onClose: (listener) => {
      child.on("close", listener);
    },
    // A serve process that is being killed is past the protocol's shutdown: its tree ends at once.
    kill: () => {
      void terminateChild(child, { graceMs: 0 });
    },
  };
}

/** Whether `value` is already a `ServeProcess` (a child process has `stdin`, not `write`). */
export function isServeProcess(value: cp.ChildProcess | ServeProcess): value is ServeProcess {
  return typeof (value as ServeProcess).write === "function";
}
