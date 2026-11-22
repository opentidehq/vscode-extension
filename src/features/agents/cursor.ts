// Cursor (SPEC §12): its extension API registers an MCP server (https://cursor.com/docs/context/mcp-extension-api,
// `vscode.cursor.mcp.registerServer`), so nothing is written to ~/.cursor/mcp.json. The same stdio command as
// everywhere else. vscode-free.
import type { McpServerPlan } from "./mcp";

/** Cursor's API, as the documentation shows it; detected at run time (`vscode.cursor` is Cursor's alone). */
export interface CursorMcpApi {
  registerServer(config: {
    name: string;
    server: { command: string; args?: string[]; env?: Record<string, string> };
  }): void;
  unregisterServer(name: string): void;
}

/** The API of the host, when it is Cursor and offers it. */
export function cursorMcp(vscodeApi: unknown): CursorMcpApi | undefined {
  const api = (vscodeApi as { cursor?: { mcp?: Partial<CursorMcpApi> } } | undefined)?.cursor?.mcp;
  return typeof api?.registerServer === "function" && typeof api.unregisterServer === "function"
    ? (api as CursorMcpApi)
    : undefined;
}

/** What `registerServer` takes for a server plan. */
export function cursorRegistration(plan: McpServerPlan) {
  return {
    name: plan.label,
    server: { command: plan.command, args: [...plan.args], env: { ...plan.env } },
  };
}
