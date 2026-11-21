// dist/mcp-wasi.js: the opentide MCP server for editors, with no opentide installed (SPEC §12). The editor
// starts it as a stdio MCP server, with its own Node (`process.execPath`, `ELECTRON_RUN_AS_NODE=1`). It runs
// the bundled WASI module's `mcp start` in a child process (the launcher, `node:wasi`) and pipes MCP stdio
// through. A child process, not a worker thread: `node:wasi` is synchronous, so while the module waits for a
// tenant request's answer nothing in its process can do HTTP, and the child's stdio is an ordinary OS pipe
// this process reads with its event loop free. The module, started with `OPENTIDE_FETCH=stdio`
// (`MCP_FETCH_ENVIRONMENT`), asks for each tenant request as an `opentide/fetch` line among its MCP messages;
// @opentide/wasi-host's McpFetchBridge takes those lines out, answers them with its FetchHost, and passes
// every MCP message through in order, so nothing but MCP reaches the editor's stdout.
//
//   node dist/mcp-wasi.js        env: OPENTIDE_REPO_ROOT, OPENTIDE_PROXY, OPENTIDE_WASI_DIR (default: ./wasi)
import { spawn } from "node:child_process";
import * as path from "node:path";
import { describeDroppedLine, isForgedAnswer, LineGuard, leaksPrivateLink } from "../core/wasi/mcpGuard";
import { checkRoot, startupLine, withWorkspaceHint, workspaceHint } from "../core/wasi/mcpHint";

async function main(): Promise<void> {
  // The package is ESM only: loaded here, bundled into dist/mcp-wasi.js.
  const { MCP_FETCH_ENVIRONMENT, MCP_FETCH_ID_PREFIX, McpFetchBridge } = await import("@opentide/wasi-host");
  const wasiDir = process.env.OPENTIDE_WASI_DIR ?? path.join(__dirname, "wasi");
  const launcher = path.join(wasiDir, "launcher.cjs");
  const module = path.join(wasiDir, "opentide.wasm");

  // Where this server runs and which repository it will use: the first thing to read in the editor's log for it
  // when its tools say `workspace_not_found` (#86).
  const root = checkRoot(process.cwd(), process.env);
  process.stderr.write(`${startupLine(process.cwd(), root)}\n`);
  const hint = workspaceHint(process.cwd(), root);

  const child = spawn(process.execPath, [launcher, module, "mcp", "start"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...MCP_FETCH_ENVIRONMENT },
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  child.stdin.on("error", () => undefined);

  // Two rules on top of the bridge: an `opentide/fetch` line carries tenant credentials and an answer to one is
  // the host's alone. The module's private link never reaches the editor, parsed or not; and an agent's
  // message that answers a tenant request (no method, an `opentide-fetch-` id) never reaches the module: it
  // would pass for the tenant's answer.
  const note = (what: string): void => {
    process.stderr.write(`opentide mcp bridge: ${what}\n`);
  };
  const fromEditor = new LineGuard((line) => isForgedAnswer(line, MCP_FETCH_ID_PREFIX));
  const fromModule = new LineGuard((line) => leaksPrivateLink(line, MCP_FETCH_ID_PREFIX));

  // `onError` (opentide #1742): the bridge drops a line that overflows the parser or that a sink throws on, instead of
  // throwing out of `fromClient`, and tells this. Said by kind, never with the line or the error's message.
  const options = { onError: (error: unknown) => note(describeDroppedLine(error)) };
  const bridge = new McpFetchBridge(
    {
      // The editor's messages and the answers to the module's tenant requests. After the editor closed its
      // input (below) an answer has nowhere to go: the module fails the call itself.
      toServer: (line) => {
        if (child.stdin.writable) child.stdin.write(line);
      },
      toClient: (line) => {
        const { lines, dropped } = fromModule.push(line);
        if (dropped > 0) note("dropped a line of the module's private link");
        for (const out of lines) process.stdout.write(withWorkspaceHint(out, hint));
      },
    },
    // A module built before that option ignores it; the type here is the one the pinned package declares.
    options as unknown as ConstructorParameters<typeof McpFetchBridge>[1],
  );

  const toBridgeFromEditor = ({ lines, dropped }: { lines: string[]; dropped: number }): void => {
    if (dropped > 0) note(`dropped ${dropped} message(s) from the editor that answer a tenant request`);
    for (const line of lines) bridge.fromClient(line);
  };
  process.stdin.on("data", (chunk: Buffer) => {
    toBridgeFromEditor(fromEditor.push(chunk));
  });
  process.stdin.on("end", () => {
    toBridgeFromEditor(fromEditor.end());
    child.stdin.end();
  });
  child.stdout.on("data", (chunk: Buffer) => {
    bridge.fromServer(chunk);
  });

  child.on("error", (error) => {
    process.stderr.write(`opentide mcp bridge: could not start the WASI module: ${error.message}\n`);
    process.exit(1);
  });
  child.on("close", (code, signal) => {
    bridge.endServer();
    bridge.dispose();
    const { lines } = fromModule.end();
    for (const out of lines) process.stdout.write(withWorkspaceHint(out, hint));
    // Everything the module wrote is flushed before the process ends.
    process.stdout.write("", () => process.exit(code ?? (signal ? 1 : 0)));
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`opentide mcp bridge: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
