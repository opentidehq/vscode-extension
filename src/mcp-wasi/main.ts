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
// The module starts when it is first needed, not with the process (#96, src/mcp-wasi/lazy.ts): with a cache file
// (OPENTIDE_MCP_CACHE) from an earlier run for the same module and repository, `initialize` and the lists of tools,
// prompts and resources are answered from it, and the module starts at the first tool call.
//
//   node dist/mcp-wasi.js        env: OPENTIDE_REPO_ROOT, OPENTIDE_PROXY, OPENTIDE_WASI_DIR (default: ./wasi),
//                                OPENTIDE_MCP_CACHE (a file this process may write: no cache without it)
import { type ChildProcessByStdio, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";
import { describeDroppedLine, isForgedAnswer, LineGuard, leaksPrivateLink } from "../core/wasi/mcpGuard";
import { checkRoot, startupLine, withWorkspaceHint, workspaceHint } from "../core/wasi/mcpHint";
import { LazyGate, readCache } from "./lazy";

async function main(): Promise<void> {
  // The package is ESM only: loaded here, bundled into dist/mcp-wasi.js.
  const { MCP_FETCH_ENVIRONMENT, MCP_FETCH_ID_PREFIX, McpFetchBridge } = await import("@opentide/wasi-host");
  const wasiDir = process.env.OPENTIDE_WASI_DIR ?? path.join(__dirname, "wasi");
  const launcher = path.join(wasiDir, "launcher.cjs");
  const module = path.join(wasiDir, "opentide.wasm");
  // The module starts at the first message that needs it (below), so a package without it is found out here, not at the
  // first tool call.
  for (const file of [launcher, module]) {
    if (!fs.existsSync(file)) {
      process.stderr.write(`opentide mcp bridge: ${file} is missing: the WASI module is not installed\n`);
      process.exit(1);
    }
  }

  // Where this server runs and which repository it will use: the first thing to read in the editor's log for it
  // when its tools say `workspace_not_found` (#86).
  const root = checkRoot(process.cwd(), process.env);
  process.stderr.write(`${startupLine(process.cwd(), root)}\n`);
  const hint = workspaceHint(process.cwd(), root);

  let child: ChildProcessByStdio<Writable, Readable, null> | undefined;

  // The cache is for this module (its sha256 in wasi.json, which the build writes) and this repository.
  const cacheFile = process.env.OPENTIDE_MCP_CACHE?.trim() || undefined;
  const moduleId = moduleIdentity(wasiDir);
  const identity = { module: moduleId ?? "", root: root.resolved ?? process.cwd() };
  const usable = cacheFile !== undefined && moduleId !== undefined;
  const gate = new LazyGate(
    usable ? readCache(readText(cacheFile), identity.module, identity.root) : undefined,
    identity,
    {
      reply: (line) => {
        process.stdout.write(line);
      },
      start: () => startModule(),
      toModule: (line) => {
        if (child?.stdin.writable) child.stdin.write(line);
      },
      save: (cache) => {
        if (!usable) return;
        try {
          fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
          const tmp = `${cacheFile}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(cache));
          fs.renameSync(tmp, cacheFile);
        } catch (error) {
          process.stderr.write(
            `opentide mcp bridge: could not write ${cacheFile}: ${(error as Error).message}\n`,
          );
        }
      },
    },
  );

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
        if (child?.stdin.writable) child.stdin.write(line);
      },
      toClient: (line) => {
        const { lines, dropped } = fromModule.push(line);
        if (dropped > 0) note("dropped a line of the module's private link");
        for (const out of lines) if (gate.fromModule(out)) process.stdout.write(withWorkspaceHint(out, hint));
      },
    },
    // A module built before that option ignores it; the type here is the one the pinned package declares.
    options as unknown as ConstructorParameters<typeof McpFetchBridge>[1],
  );

  const startModule = (): void => {
    const started = spawn(process.execPath, [launcher, module, "mcp", "start"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...MCP_FETCH_ENVIRONMENT },
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
    child = started;
    started.stdin.on("error", () => undefined);
    started.stdout.on("data", (chunk: Buffer) => {
      bridge.fromServer(chunk);
    });
    started.on("error", (error) => {
      process.stderr.write(`opentide mcp bridge: could not start the WASI module: ${error.message}\n`);
      process.exit(1);
    });
    started.on("close", (code, signal) => {
      bridge.endServer();
      bridge.dispose();
      const { lines } = fromModule.end();
      for (const out of lines) if (gate.fromModule(out)) process.stdout.write(withWorkspaceHint(out, hint));
      // Everything the module wrote is flushed before the process ends.
      process.stdout.write("", () => process.exit(code ?? (signal ? 1 : 0)));
    });
  };

  const toBridgeFromEditor = ({ lines, dropped }: { lines: string[]; dropped: number }): void => {
    if (dropped > 0) note(`dropped ${dropped} message(s) from the editor that answer a tenant request`);
    for (const line of lines) if (gate.fromEditor(line)) bridge.fromClient(line);
  };
  process.stdin.on("data", (chunk: Buffer) => {
    toBridgeFromEditor(fromEditor.push(chunk));
  });
  process.stdin.on("end", () => {
    toBridgeFromEditor(fromEditor.end());
    // A module that never started has nothing to finish.
    if (child) child.stdin.end();
    else process.stdout.write("", () => process.exit(0));
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (child) child.kill(signal);
      else process.exit(0);
    });
  }
}

/** The sha256 of the bundled module, from the wasi.json the build writes beside it; undefined when it says none. */
function moduleIdentity(wasiDir: string): string | undefined {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(wasiDir, "wasi.json"), "utf8")) as {
      moduleSha256?: unknown;
      sha256?: unknown;
    };
    const sha = info.moduleSha256 ?? info.sha256;
    return typeof sha === "string" && sha !== "" ? sha : undefined;
  } catch {
    return undefined;
  }
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`opentide mcp bridge: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
