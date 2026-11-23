// The MCP bridge's lazy start (#96): the editor starts the opentide MCP server with the window, but most windows
// never use an opentide tool, and the module behind it costs about a second and 100 MB. The bridge (src/mcp-wasi/
// main.ts) answers what an editor asks at start-up, `initialize` and the lists of tools, prompts and resources,
// from what the module said the last time for the same module and repository, and starts the module on the first
// message that needs it (a tool call). It then plays the module the `initialize` the editor sent, so the module is
// in the state the editor believes it is. A bridge with no cache starts the module at the first message, as it
// always did, and writes the cache for the next time. vscode-free.

/** The private id of the `initialize` the bridge replays to a module it started late: its answer is not the editor's. */
export const LAZY_INIT_ID = "opentide-bridge-init";

/** The lists an editor reads at start-up, which the bridge answers from the cache. */
export const LISTS: readonly string[] = [
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
];

const FORMAT = 1;

/** What the module said, for one module and one repository. */
export interface LazyCache {
  readonly format: number;
  /** The module's sha256: another module has other tools. */
  readonly module: string;
  /** The repository root the module ran for. */
  readonly root: string;
  /** The answer to `initialize`, and the protocol version it was asked for. */
  readonly initialize?: { readonly protocolVersion: string; readonly result: unknown };
  /** The `result` of each of {@link LISTS}, asked without a cursor and answered in one page. */
  readonly lists: Readonly<Record<string, unknown>>;
}

/** The cache as read from a file, or undefined when it is not one, or is for another module or repository. */
export function readCache(text: string | undefined, module: string, root: string): LazyCache | undefined {
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const cache = value as Partial<LazyCache>;
  if (cache.format !== FORMAT || cache.module !== module || cache.root !== root) return undefined;
  const lists = cache.lists;
  if (typeof lists !== "object" || lists === null || Array.isArray(lists)) return undefined;
  const initialize = cache.initialize;
  if (
    initialize !== undefined &&
    (typeof initialize !== "object" ||
      initialize === null ||
      typeof initialize.protocolVersion !== "string" ||
      !("result" in initialize))
  )
    return undefined;
  return { format: FORMAT, module, root, ...(initialize ? { initialize } : {}), lists };
}

export interface LazyIo {
  /** A line to the editor that the bridge answers itself. */
  reply(line: string): void;
  /** Start the module. Called once, before the first line for it. */
  start(): void;
  /** A line to the module, straight (the replay of the start-up the editor already did). */
  toModule(line: string): void;
  /** The cache changed. */
  save(cache: LazyCache): void;
}

interface Message {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

function parse(line: string): Message | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Message)
      : undefined;
  } catch {
    return undefined;
  }
}

const hasId = (message: Message): boolean => typeof message.id === "string" || typeof message.id === "number";

/**
 * Between the editor and the module: what the bridge answers itself, and when the module starts. Lines are the
 * editor's and the module's, one JSON message each, with or without their newline.
 */
export class LazyGate {
  private running = false;
  private initializeLine: string | undefined;
  private initialized = false;
  private cache: LazyCache;
  /** The requests passed on whose answers are worth keeping: id -> what was asked. */
  private readonly pending = new Map<string, { method: string; protocolVersion?: string }>();

  constructor(
    cache: LazyCache | undefined,
    identity: { readonly module: string; readonly root: string },
    private readonly io: LazyIo,
  ) {
    this.cache = cache ?? { format: FORMAT, module: identity.module, root: identity.root, lists: {} };
  }

  /** Whether the module has been started. */
  get started(): boolean {
    return this.running;
  }

  /**
   * A line from the editor. Returns true when the module must get it (it has been started, and told what the editor
   * said before); false when the bridge answered it, or it is of no use to a module that is not running.
   */
  fromEditor(line: string): boolean {
    const message = parse(line);
    if (this.running) {
      if (message) this.track(message);
      return true;
    }
    // Not a JSON object (a batch, or no JSON at all): the module decides what to say to it.
    if (!message) return this.wake(undefined);
    const method = typeof message.method === "string" ? message.method : undefined;
    if (method === undefined) return this.wake(message);
    if (!hasId(message)) {
      // A notification. A module that is not running has nothing to cancel or to be told, except that the editor
      // is ready: remembered, and played to the module when it starts.
      if (method === "notifications/initialized") this.initialized = true;
      return false;
    }
    if (method === "ping") {
      this.answer(message.id, {});
      return false;
    }
    if (method === "initialize") {
      const asked = protocolVersionOf(message);
      const known = this.cache.initialize;
      if (known && asked !== undefined && known.protocolVersion === asked) {
        this.initializeLine = line;
        this.answer(message.id, known.result);
        return false;
      }
      this.initializeLine = line;
      return this.wake(message, false);
    }
    if (LISTS.includes(method) && !asksForAPage(message)) {
      const result = this.cache.lists[method];
      if (result !== undefined && this.initializeLine !== undefined) {
        this.answer(message.id, result);
        return false;
      }
    }
    return this.wake(message);
  }

  /**
   * A line from the module. Returns false when it is the answer to the replayed `initialize`, which the editor
   * must not see.
   */
  fromModule(line: string): boolean {
    const message = parse(line);
    if (!message) return true;
    if (message.id === LAZY_INIT_ID && message.method === undefined) return false;
    if (hasId(message) && message.method === undefined) this.record(message);
    return true;
  }

  private answer(id: unknown, result: unknown): void {
    this.io.reply(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  /** Start the module, play it the start-up the editor did, and let the message through. */
  private wake(message: Message | undefined, replay = true): boolean {
    this.running = true;
    this.io.start();
    if (replay && this.initializeLine !== undefined) {
      const first = parse(this.initializeLine);
      if (first) this.io.toModule(`${JSON.stringify({ ...first, id: LAZY_INIT_ID })}\n`);
      if (this.initialized)
        this.io.toModule(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    }
    if (message) this.track(message);
    return true;
  }

  private track(message: Message): void {
    if (typeof message.method !== "string" || !hasId(message)) return;
    if (message.method === "notifications/initialized") return;
    const key = JSON.stringify(message.id);
    if (message.method === "initialize") {
      const protocolVersion = protocolVersionOf(message);
      if (protocolVersion !== undefined) this.pending.set(key, { method: "initialize", protocolVersion });
    } else if (LISTS.includes(message.method) && !asksForAPage(message)) {
      this.pending.set(key, { method: message.method });
    }
  }

  private record(message: Message): void {
    const key = JSON.stringify(message.id);
    const asked = this.pending.get(key);
    if (!asked) return;
    this.pending.delete(key);
    if (message.error !== undefined || message.result === undefined) return;
    if (asked.method === "initialize") {
      this.cache = {
        ...this.cache,
        initialize: { protocolVersion: asked.protocolVersion ?? "", result: message.result },
      };
    } else {
      // A page with a next page is not the list: the editor would never read the rest.
      const result = message.result as { nextCursor?: unknown } | null;
      if (typeof result === "object" && result !== null && result.nextCursor !== undefined) return;
      this.cache = { ...this.cache, lists: { ...this.cache.lists, [asked.method]: message.result } };
    }
    this.io.save(this.cache);
  }
}

function protocolVersionOf(message: Message): string | undefined {
  const params = message.params as { protocolVersion?: unknown } | null | undefined;
  return typeof params?.protocolVersion === "string" ? params.protocolVersion : undefined;
}

function asksForAPage(message: Message): boolean {
  const params = message.params as { cursor?: unknown } | null | undefined;
  return params?.cursor !== undefined && params.cursor !== null;
}
