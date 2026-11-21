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

async function main(): Promise<void> {
  // The package is ESM only: loaded here, bundled into dist/mcp-wasi.js.
  const { MCP_FETCH_ENVIRONMENT, McpFetchBridge } = await import("@opentide/wasi-host");
  const wasiDir = process.env.OPENTIDE_WASI_DIR ?? path.join(__dirname, "wasi");
  const launcher = path.join(wasiDir, "launcher.cjs");
  const module = path.join(wasiDir, "opentide.wasm");

  const child = spawn(process.execPath, [launcher, module, "mcp", "start"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...MCP_FETCH_ENVIRONMENT },
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  child.stdin.on("error", () => undefined);

  const bridge = new McpFetchBridge({
    // The editor's messages and the answers to the module's tenant requests. After the editor closed its
    // input (below) an answer has nowhere to go: the module fails the call itself.
    toServer: (line) => {
      if (child.stdin.writable) child.stdin.write(line);
    },
    toClient: (line) => {
      process.stdout.write(line);
    },
  });

  process.stdin.on("data", (chunk: Buffer) => {
    bridge.fromClient(chunk);
  });
  process.stdin.on("end", () => {
    bridge.endClient();
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
