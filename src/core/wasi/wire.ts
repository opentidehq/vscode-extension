// The WASI `opentide serve` as a `ServeProcess` (SPEC §4, CONTRACTS.md): the wire between `ServeClient` and
// the module, one JSON message per line. It maps paths (host to guest going in, guest to host coming out)
// and answers the server's `opentide/fetch` requests with `@opentide/wasi-host`'s `FetchHost`, so the client
// above it sees what it would see of a native `opentide serve`. vscode-free: the module's process and the
// fetch handler are injected.
import type { ServeProcess } from "../backend/process";
import { lineSplitter } from "../backend/spawn";
import type { GuestPaths } from "./paths";

/** What answers `opentide/fetch`: `@opentide/wasi-host`'s `FetchHost`, or a stand-in in tests. */
export interface FetchHandler {
  /** Takes the server's `opentide/fetch` request or its `$/cancelRequest`; whether it did. */
  handle(message: unknown): boolean;
  /** Withdraws every request in flight: the server has gone. */
  dispose(): void;
}

/** Makes the handler; `send` writes one JSON-RPC message to the server (the fetch answer, bypassing maps). */
export type FetchHandlerFactory = (send: (message: object) => void) => FetchHandler;

/** A JSON object (not an array or null). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Wrap `raw` (the module's `serve`): `write` maps a message's host paths to guest paths; stdout lines are
 * mapped back, except `opentide/fetch` requests (and the server's withdrawals of them), which `fetch`
 * answers and the client never sees.
 */
export function wasiServeWire(
  raw: ServeProcess,
  paths: GuestPaths,
  fetch?: FetchHandlerFactory,
): ServeProcess {
  const rawWrite = (message: object): void => raw.write(`${JSON.stringify(message)}\n`);
  const handler = fetch?.(rawWrite);
  const listeners: ((chunk: string) => void)[] = [];
  const splitter = lineSplitter((line) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      for (const listener of listeners) listener(`${line}\n`);
      return;
    }
    if (handler?.handle(message)) return;
    const mapped = paths.documentToHost(message);
    for (const listener of listeners) listener(`${JSON.stringify(mapped)}\n`);
  });
  raw.onStdout((chunk) => splitter.push(chunk));
  return {
    pid: raw.pid,
    write: (text) => {
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          raw.write(`${line}\n`);
          continue;
        }
        if (isObject(message) && "params" in message) {
          rawWrite({ ...message, params: paths.paramsToGuest(message.params) });
        } else {
          raw.write(`${line}\n`);
        }
      }
    },
    onStdout: (listener) => {
      listeners.push(listener);
    },
    onStderr: (listener) => raw.onStderr((chunk) => listener(chunk)),
    onError: (listener) => raw.onError(listener),
    onClose: (listener) =>
      raw.onClose((code, signal) => {
        splitter.end();
        handler?.dispose();
        listener(code, signal);
      }),
    kill: () => {
      handler?.dispose();
      raw.kill();
    },
  };
}
