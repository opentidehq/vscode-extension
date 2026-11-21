// Two rules the MCP bridge (src/mcp-wasi/main.ts) keeps on top of @opentide/wasi-host's McpFetchBridge, which is
// the module's private link to its host: `opentide/fetch` requests carry tenant credentials, and their answers
// are the host's alone. vscode-free.

// The prefix of the module's tenant-request ids is `MCP_FETCH_ID_PREFIX` of @opentide/wasi-host (an ESM-only
// package, so the bridge imports it and hands it in): what follows it (a counter, or a nonce and a counter) is
// not this file's business.

// Every decision below is made on the parsed value, never on a substring of the raw line: JSON lets a key or a
// string be written with escapes (`"id":"opentide\u002dfetch-1"`, `"meth\u006fd"`), which no substring test sees.

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a line of the client's is a forged answer to a tenant request: a message with no method and a string
 * id of the private link's. Only the host answers those. A client line that is no JSON object is passed on
 * (the module rejects it); the bridge writes the host's own answers itself, not through here.
 */
export function isForgedAnswer(line: string, prefix: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return false;
  }
  // A batch is checked element by element: one forged answer among innocent messages is still one.
  const messages: unknown[] = Array.isArray(value) ? value : [value];
  return messages.some((message) => {
    if (typeof message !== "object" || message === null || Array.isArray(message)) return false;
    const { method, id } = message as { method?: unknown; id?: unknown };
    // A string method makes it a request of the client's own; anything else (none, null, a number) is no request,
    // so with the private link's id it is taken for the answer to one.
    if (typeof method === "string") return false;
    return typeof id === "string" && id.startsWith(prefix);
  });
}

/**
 * Whether a line the module wrote must not reach the client: it is not a JSON-RPC message (a log line, or a
 * request cut short, which can still hold a tenant's credentials), or it is the private link: a message whose
 * method is opentide's (`opentide/fetch`, …) or the `notifications/cancelled` that withdraws one of its
 * requests. A result that merely says "opentide/fetch" in its text is an MCP message like any other.
 */
export function leaksPrivateLink(line: string, prefix: string): boolean {
  if (line.trim() === "") return false;
  const message = parse(line);
  if (!message) return true;
  const method = message.method;
  if (typeof method !== "string") return false;
  if (method.startsWith("opentide/")) return true;
  if (method !== "notifications/cancelled") return false;
  const params = message.params;
  const id =
    typeof params === "object" && params !== null ? (params as { requestId?: unknown }).requestId : undefined;
  return typeof id === "string" && id.startsWith(prefix);
}

/**
 * What the bridge's stderr says when `McpFetchBridge` drops a line it could not handle (a line nested past the parser's
 * limit, a pipe that closed): the kind of error and its system code, never its message or the line, which may hold a
 * tenant's credentials (a parser's message quotes its input).
 */
export function describeDroppedLine(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  return `dropped a line it could not handle (${name}${typeof code === "string" ? `, ${code}` : ""})`;
}

/** Splits chunks into whole lines (each with its newline) and holds back a partial one. */
export class LineGuard {
  private partial = "";
  private readonly decoder = new TextDecoder();

  constructor(private readonly drop: (line: string) => boolean) {}

  /** The lines of `chunk` to pass on, and the number dropped. */
  push(chunk: string | Uint8Array): { lines: string[]; dropped: number } {
    this.partial += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    return this.take();
  }

  /** What is left at the end of the stream: a last line without its newline. */
  end(): { lines: string[]; dropped: number } {
    this.partial += this.decoder.decode();
    if (this.partial !== "" && !this.partial.endsWith("\n")) this.partial += "\n";
    return this.take();
  }

  private take(): { lines: string[]; dropped: number } {
    const lines: string[] = [];
    let dropped = 0;
    for (let end = this.partial.indexOf("\n"); end >= 0; end = this.partial.indexOf("\n")) {
      const line = this.partial.slice(0, end + 1);
      this.partial = this.partial.slice(end + 1);
      if (this.drop(line.trimEnd())) dropped += 1;
      else lines.push(line);
    }
    return { lines, dropped };
  }
}
