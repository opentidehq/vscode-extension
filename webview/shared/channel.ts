// The webview's end of the message channel (see src/core/webview/protocol.ts).
import { acceptMessage, type Protocol, type Validators } from "../../src/core/webview/protocol";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

/** `acquireVsCodeApi()` may be called once per page; this caches it. */
export function vscodeApi(): VsCodeApi {
  api ??= acquireVsCodeApi();
  return api;
}

export interface WebviewChannel<P extends Protocol> {
  post<K extends Extract<keyof P["toHost"], string>>(type: K, payload: P["toHost"][K]): void;
  on<K extends Extract<keyof P["toWebview"], string>>(
    type: K,
    handler: (payload: P["toWebview"][K]) => void,
  ): () => void;
}

/** Listen for host messages, validated by `validators`; invalid ones are dropped. */
export function createChannel<P extends Protocol>(validators: Validators<P["toWebview"]>): WebviewChannel<P> {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const message = acceptMessage(event.data, validators);
    if (!message) return;
    for (const handler of handlers.get(message.type) ?? []) handler(message.payload);
  });
  return {
    post: (type, payload) => vscodeApi().postMessage({ type, payload }),
    on(type, handler) {
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
      }
      const entry = handler as (payload: unknown) => void;
      set.add(entry);
      return () => set.delete(entry);
    },
  };
}
