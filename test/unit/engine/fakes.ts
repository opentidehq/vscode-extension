// Test doubles for the engine channel.
import { Disposable } from "vscode-jsonrpc";
import type { EnginePort } from "../../../src/engine/transport";

/** A port with hooks the test fires. */
export function fakeEnginePort() {
  const listeners = {
    message: new Set<(data: unknown) => void>(),
    error: new Set<(e: Error) => void>(),
    exit: new Set<(d: string) => void>(),
  };
  const posted: string[] = [];
  let terminated = 0;
  const on = <T>(set: Set<T>, listener: T) => {
    set.add(listener);
    return Disposable.create(() => set.delete(listener));
  };
  const port: EnginePort = {
    post: (text) => posted.push(text),
    onMessage: (l) => on(listeners.message, l),
    onError: (l) => on(listeners.error, l),
    onExit: (l) => on(listeners.exit, l),
    terminate: () => {
      terminated += 1;
    },
  };
  return {
    port,
    posted,
    message: (data: unknown) => {
      for (const l of listeners.message) l(data);
    },
    error: (e: Error) => {
      for (const l of listeners.error) l(e);
    },
    exit: () => {
      for (const l of listeners.exit) l("exited");
    },
    listeners,
    get terminated() {
      return terminated;
    },
  };
}
