// The worker side of the opentide engine (WASM): the language server (`opentide-wasm`'s `LanguageServer`,
// the server `opentide-lsp --stdio` runs) answering one JSON-RPC message per message on a port, as JSON
// text without a `Content-Length` header. The Node worker (src/core/engine/worker.ts) and the browser's
// Web Worker serve it the same way. No Node built-ins, no vscode.
//
// Adapted from `serveLanguageServer` in language-server's packages/lsp-worker (MIT, opentide
// contributors), which is not on npm (language-server#191).

/** One session of the language server, as a new `--stdio` process would be. */
export interface EngineSession {
  /** One JSON-RPC message in, as JSON text; the messages the server sends back, in order. */
  handle(message: string): string[];
  /** Whether the client has sent `exit`. */
  readonly closed: boolean;
  /** Release the session's memory in the module. */
  free?(): void;
}

/** The loaded module. */
export interface EngineModule {
  createSession(): EngineSession;
  /** The engine version (the crates' shared version). */
  version(): string;
}

/** The worker's end of the channel: `parentPort` in Node, `self` in a Web Worker. */
export interface HostPort {
  postMessage(message: string): void;
  onMessage(listener: (data: unknown) => void): void;
  /** Called once the client has sent `exit`. */
  close(): void;
}

/** The id of a JSON-RPC request (a message with a method and an id), if `text` is one. */
export function requestId(text: string): string | number | undefined {
  try {
    const message = JSON.parse(text) as { id?: unknown; method?: unknown } | null;
    const id = message?.id;
    return typeof message?.method === "string" && (typeof id === "string" || typeof id === "number")
      ? id
      : undefined;
  } catch {
    return undefined;
  }
}

/** `window/showMessage` (type 1 error) as JSON text. */
export function showMessage(type: 1, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", method: "window/showMessage", params: { type, message } });
}

/** `window/logMessage` (type 3 info, 1 error) as JSON text. */
export function logMessage(type: 1 | 3, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", method: "window/logMessage", params: { type, message } });
}

/**
 * Serve the engine on `port` until the client sends `exit`. Messages that arrive while `load` runs wait
 * for it, in order. If it fails to load, every request is answered with an error saying so (so the
 * client's `initialize` fails at once instead of timing out); nothing is answered empty. If the module
 * traps, the request gets that error, the user is told (`window/showMessage`), and the port is closed:
 * the worker ends, and the language client restarts it under its crash ceiling instead of talking to a
 * dead module. Resolves when the session ends.
 */
export function serveEngine(
  port: HostPort,
  load: () => EngineModule | Promise<EngineModule>,
  now: () => number = () => Date.now(),
): Promise<void> {
  let session: EngineSession | undefined;
  let failure: string | undefined;
  let waiting: string[] | undefined = [];
  let finished: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });

  const refuse = (text: string): void => {
    const id = requestId(text);
    if (id !== undefined)
      port.postMessage(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: failure } }));
  };
  const handle = (text: string): void => {
    if (!session || failure !== undefined) {
      refuse(text);
      return;
    }
    let replies: string[];
    try {
      replies = session.handle(text);
    } catch (error) {
      failure = `the opentide engine stopped: ${error instanceof Error ? error.message : String(error)}`;
      port.postMessage(logMessage(1, failure));
      port.postMessage(
        showMessage(1, `${failure}. It restarts; Restart Server starts it again if it does not.`),
      );
      refuse(text);
      session = undefined;
      port.close();
      finished();
      return;
    }
    for (const reply of replies) port.postMessage(reply);
    if (session.closed) {
      session.free?.();
      session = undefined;
      failure = "the opentide engine has exited";
      port.close();
      finished();
    }
  };

  port.onMessage((data) => {
    const text = typeof data === "string" ? data : JSON.stringify(data);
    if (waiting) waiting.push(text);
    else handle(text);
  });
  const started = now();
  Promise.resolve()
    .then(load)
    .then(
      (module) => {
        session = module.createSession();
        port.postMessage(
          logMessage(
            3,
            `opentide engine (WASM) ${module.version()} loaded in ${Math.round(now() - started)} ms`,
          ),
        );
      },
      (error: unknown) => {
        failure = `the opentide engine did not load: ${error instanceof Error ? error.message : String(error)}`;
        port.postMessage(logMessage(1, failure));
      },
    )
    .then(() => {
      const queued = waiting ?? [];
      waiting = undefined;
      for (const text of queued) handle(text);
    });
  return done;
}
