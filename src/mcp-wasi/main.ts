// dist/mcp-wasi.js: the opentide MCP server for editors, with no opentide installed (SPEC §12). The editor
// starts it as a stdio MCP server, with its own Node (`process.execPath`, `ELECTRON_RUN_AS_NODE=1`). It runs
// the bundled WASI module's `mcp start` in a child process (the launcher, `node:wasi`) and pipes MCP stdio
// through. A child process, not a worker thread: `node:wasi` is synchronous, so while the module waits for a
// tenant request's answer nothing in its process can do HTTP, and the child's stdio is an ordinary OS pipe
// this process reads with its event loop free. This process makes the tenant requests the module asks for
// (`OPENTIDE_FETCH=stdio`: `opentide/fetch`, answered by @opentide/wasi-host's FetchHost) and writes nothing to
// stdout but the module's MCP messages.
//
//   node dist/mcp-wasi.js        env: OPENTIDE_REPO_ROOT, OPENTIDE_PROXY, OPENTIDE_WASI_DIR (default: ./wasi)
import { spawn } from "node:child_process";
import * as path from "node:path";
import { filterModuleLine } from "../core/wasi/mcpBridge";

async function main(): Promise<void> {
  // The package is ESM only: loaded here, bundled into dist/mcp-wasi.js.
  const { FetchHost } = await import("@opentide/wasi-host");
  const wasiDir = process.env.OPENTIDE_WASI_DIR ?? path.join(__dirname, "wasi");
  const launcher = path.join(wasiDir, "launcher.cjs");
  const module = path.join(wasiDir, "opentide.wasm");

  const child = spawn(process.execPath, [launcher, module, "mcp", "start"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", OPENTIDE_FETCH: "stdio" },
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });

  const host = new FetchHost((message) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });

  // The editor's messages go to the module as they are.
  process.stdin.pipe(child.stdin);
  child.stdin.on("error", () => undefined);

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      const { upstream, dropped } = filterModuleLine(line, host);
      if (upstream !== undefined) process.stdout.write(`${upstream}\n`);
      if (dropped) process.stderr.write(`opentide mcp bridge: ${dropped}\n`);
    }
  });

  child.on("error", (error) => {
    process.stderr.write(`opentide mcp bridge: could not start the WASI module: ${error.message}\n`);
    process.exit(1);
  });
  child.on("close", (code, signal) => {
    host.dispose();
    process.exit(code ?? (signal ? 1 : 0));
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
