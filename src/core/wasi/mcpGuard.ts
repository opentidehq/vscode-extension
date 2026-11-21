// Two rules the MCP bridge (src/mcp-wasi/main.ts) keeps on top of @opentide/wasi-host's McpFetchBridge, which is
// the module's private link to its host: `opentide/fetch` requests carry tenant credentials, and their answers
// are the host's alone. vscode-free.

/** The prefix of the module's tenant-request ids (`MCP_FETCH_ID_PREFIX` of @opentide/wasi-host). */
export const PRIVATE_ID_PREFIX = "opentide-fetch-";

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
export function isForgedAnswer(line: string): boolean {
  const message = parse(line);
  if (!message || message.method !== undefined) return false;
  return typeof message.id === "string" && message.id.startsWith(PRIVATE_ID_PREFIX);
}

/**
 * Whether a line the module wrote must not reach the client: it is not a JSON-RPC message (a log line, or a
 * request cut short, which can still hold a tenant's credentials), or it is the private link: a message whose
 * method is opentide's (`opentide/fetch`, …) or the `notifications/cancelled` that withdraws one of its
 * requests. A result that merely says "opentide/fetch" in its text is an MCP message like any other.
 */
export function leaksPrivateLink(line: string): boolean {
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
  return typeof id === "string" && id.startsWith(PRIVATE_ID_PREFIX);
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
