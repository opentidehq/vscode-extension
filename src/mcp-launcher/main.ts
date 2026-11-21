// dist/mcp-launcher.js: the stable launcher the extension copies into its global storage and a user-level MCP
// entry (Kiro, Devin Desktop, Windsurf) points at. The entry names this file, the editor's own binary and two
// variables, so it stays byte-identical across extension updates; at start the launcher finds the newest
// installed copy of the extension and runs its bridge (dist/mcp-wasi.js), with stdio untouched.
//
//   ELECTRON_RUN_AS_NODE=1 <editor> mcp-launcher.cjs
//   env: OPENTIDE_EXTENSIONS_DIR  the editor's extensions folder (where `opentidehq.opentide-<version>` live)
//        OPENTIDE_MCP_ENTRY_FILE  the user-level MCP file that holds the entry, named in the error below
//
// With no copy installed (the extension was uninstalled): one line on stderr, an MCP error for the first
// request, then it exits.
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { errorForFirstRequest, type Files, newestInstalled, notInstalledMessage } from "./pick";

const files: Files = {
  list: (dir) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  },
  exists: (file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  },
  read: (file) => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  },
  join: (...parts) => path.join(...parts),
};

function main(): void {
  const dir = process.env.OPENTIDE_EXTENSIONS_DIR;
  const entryFile = process.env.OPENTIDE_MCP_ENTRY_FILE;
  const installed = dir ? newestInstalled(dir, files) : undefined;
  if (installed) {
    process.stderr.write(`opentide mcp launcher: running ${installed.folder}\n`);
    // The bridge starts itself when loaded and keeps this process alive; its stdio is ours.
    createRequire(__filename)(installed.bridge);
    return;
  }
  const message = notInstalledMessage(entryFile);
  process.stderr.write(`opentide mcp launcher: ${message}${dir ? ` (looked in ${dir})` : ""}\n`);
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const reply = errorForFirstRequest(buffer.slice(0, index), message);
      buffer = buffer.slice(index + 1);
      if (reply !== undefined) {
        process.stdout.write(reply, () => process.exit(1));
        return;
      }
      index = buffer.indexOf("\n");
    }
  });
  process.stdin.on("end", () => process.exit(1));
}

main();
