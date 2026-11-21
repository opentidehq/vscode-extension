// The MCP bridge's filter (SPEC §12, CONTRACTS.md "The MCP bridge"): what the WASI module's `mcp start` writes
// on stdout, line by line, becomes what the editor's MCP client reads. The module, started with
// `OPENTIDE_FETCH=stdio`, interleaves its own `opentide/fetch` requests (tenant HTTP, which WASI has no sockets
// for) with the MCP messages; the bridge answers those itself and never lets one reach the editor: MCP's stdio
// transport carries MCP messages only, and a server must not write requests of its own to stdout. vscode-free.
import type { FetchHandler } from "./wire";

/** The methods that are the module's private link to the bridge: the bridge's alone, never the editor's. */
export function isBridgeMethod(method: unknown): boolean {
  return typeof method === "string" && (method.startsWith("opentide/") || method === "$/cancelRequest");
}

export interface BridgeLine {
  /** The line to write to the editor (no newline), or undefined when nothing is. */
  readonly upstream?: string;
  /** Why a line was not forwarded, for stderr. */
  readonly dropped?: string;
}

/**
 * Filter one stdout line of the module. A message of the private link goes to `fetch` (answered there, never
 * forwarded); a line that is no JSON-RPC message is dropped with a note, since a client would fail on it; every
 * other message passes untouched, byte for byte.
 */
export function filterModuleLine(line: string, fetch: FetchHandler | undefined): BridgeLine {
  if (!line.trim()) return {};
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return { dropped: `not JSON on stdout: ${line.slice(0, 200)}` };
  }
  const isMessage = typeof message === "object" && message !== null && !Array.isArray(message);
  if (!isMessage) return { dropped: `not a JSON-RPC message on stdout: ${line.slice(0, 200)}` };
  const method = (message as { method?: unknown }).method;
  if (isBridgeMethod(method)) {
    if (!fetch?.handle(message)) {
      return { dropped: `${String(method)} with nothing to answer it` };
    }
    return {};
  }
  return { upstream: line };
}
