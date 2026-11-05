// The client side of the engine channel: vscode-languageclient's MessageReader and MessageWriter over a
// worker, one JSON-RPC message per worker message, as JSON text (what src/engine/host.ts reads and
// writes). The desktop's `worker_threads` Worker and the browser's Web Worker both fit `EnginePort`. No
// Node built-ins.
import {
  AbstractMessageReader,
  AbstractMessageWriter,
  type DataCallback,
  Disposable,
  type Message,
  type MessageReader,
  type MessageWriter,
} from "vscode-jsonrpc";

/** The client's end of the channel to the engine worker. */
export interface EnginePort {
  post(text: string): void;
  onMessage(listener: (data: unknown) => void): Disposable;
  /** The worker failed (it could not start, or threw outside a message). */
  onError(listener: (error: Error) => void): Disposable;
  /** The worker is gone. */
  onExit(listener: (detail: string) => void): Disposable;
  /** End the worker. */
  terminate(): void;
}

/** A message the worker sent, parsed: text is JSON, an object is taken as it is. */
export function parseMessage(data: unknown): Message {
  const value: unknown = typeof data === "string" ? JSON.parse(data) : data;
  if (typeof value !== "object" || value === null || (value as { jsonrpc?: unknown }).jsonrpc !== "2.0")
    throw new Error(
      `not a JSON-RPC message: ${String(typeof data === "string" ? data : typeof data).slice(0, 80)}`,
    );
  return value as Message;
}

export class PortMessageReader extends AbstractMessageReader implements MessageReader {
  private callback: DataCallback | undefined;
  private readonly queue: Message[] = [];
  private readonly subscriptions: Disposable[];

  constructor(port: EnginePort) {
    super();
    this.subscriptions = [
      port.onMessage((data) => {
        let message: Message;
        try {
          message = parseMessage(data);
        } catch (error) {
          this.fireError(error);
          return;
        }
        if (this.callback) this.callback(message);
        else this.queue.push(message);
      }),
      port.onError((error) => this.fireError(error)),
      port.onExit(() => this.fireClose()),
    ];
  }

  listen(callback: DataCallback): Disposable {
    this.callback = callback;
    for (const message of this.queue.splice(0)) callback(message);
    return Disposable.create(() => {
      if (this.callback === callback) this.callback = undefined;
    });
  }

  override dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    super.dispose();
  }
}

export class PortMessageWriter extends AbstractMessageWriter implements MessageWriter {
  private errors = 0;
  private closed = false;
  private readonly subscription: Disposable;

  constructor(private readonly port: EnginePort) {
    super();
    this.subscription = port.onExit(() => {
      this.closed = true;
      this.fireClose();
    });
  }

  write(message: Message): Promise<void> {
    if (this.closed) return Promise.reject(new Error("the opentide engine has exited"));
    try {
      this.port.post(JSON.stringify(message));
      this.errors = 0;
      return Promise.resolve();
    } catch (error) {
      this.errors += 1;
      this.fireError(error, message, this.errors);
      return Promise.reject(error);
    }
  }

  end(): void {
    // Nothing buffered: each write is one message.
  }

  override dispose(): void {
    this.subscription.dispose();
    super.dispose();
  }
}

/** The reader and writer for one engine worker. Whoever made the port ends it (`terminate`). */
export function engineTransports(port: EnginePort): { reader: MessageReader; writer: MessageWriter } {
  return { reader: new PortMessageReader(port), writer: new PortMessageWriter(port) };
}
