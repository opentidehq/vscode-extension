// dist/mcp-launcher.js (src/mcp-launcher/main.ts), built here with esbuild as `npm run build` does and run against
// a fake extensions folder: the newest installed copy's bridge runs with stdio untouched, and with none installed it
// answers the first request with an MCP error and exits.
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A bridge that says which copy it is, then echoes the lines it is sent. */
const bridgeOf = (name) => `
process.stderr.write("bridge ${name}\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => process.stdout.write("${name}:" + chunk));
`;

describe("the MCP launcher (dist/mcp-launcher.js)", function () {
  this.timeout(60_000);
  let work;
  let launcher;

  before(async () => {
    work = mkdtempSync(join(tmpdir(), "opentide-launcher-"));
    launcher = join(work, "mcp-launcher.cjs");
    await esbuild.build({
      entryPoints: [join(root, "src", "mcp-launcher", "main.ts")],
      outfile: launcher,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      logLevel: "silent",
    });
  });
  after(() => rmSync(work, { recursive: true, force: true }));

  /** An extensions folder with `copies` (folder name -> bridge name, or null for a half-deleted folder). */
  function extensions(name, copies, obsolete) {
    const dir = join(work, name);
    mkdirSync(dir, { recursive: true });
    for (const [folder, bridge] of Object.entries(copies)) {
      mkdirSync(join(dir, folder, "dist"), { recursive: true });
      writeFileSync(join(dir, folder, "package.json"), "{}");
      if (bridge) writeFileSync(join(dir, folder, "dist", "mcp-wasi.js"), bridgeOf(bridge));
    }
    if (obsolete) writeFileSync(join(dir, ".obsolete"), JSON.stringify(obsolete));
    return dir;
  }

  /** Run the launcher, write `input`, and collect what it prints until it exits (or `end` closes its input). */
  function run(dir, input, { end = true } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [launcher], {
        env: {
          ...process.env,
          OPENTIDE_EXTENSIONS_DIR: dir,
          OPENTIDE_MCP_ENTRY_FILE: "~/.kiro/settings/mcp.json",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => {
        stdout += c;
      });
      child.stderr.on("data", (c) => {
        stderr += c;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.on("error", () => undefined);
      child.stdin.write(input);
      if (end) setTimeout(() => child.stdin.end(), 300);
    });
  }

  it("runs the newest installed copy's bridge, with stdio passed through", async () => {
    const dir = extensions("newest", {
      "opentidehq.opentide-0.9.0": "old",
      "opentidehq.opentide-0.10.0": "new",
    });
    const { stdout, stderr } = await run(dir, '{"id":1}\n');
    assert.match(stderr, /bridge new/);
    assert.equal(stdout, 'new:{"id":1}\n');
  });

  it("skips a half-deleted newer folder and an obsolete one", async () => {
    const half = extensions("half", {
      "opentidehq.opentide-2.0.0": null,
      "opentidehq.opentide-1.0.0": "one",
    });
    assert.match((await run(half, "x\n")).stderr, /bridge one/);
    const obsolete = extensions(
      "obsolete",
      { "opentidehq.opentide-2.0.0": "two", "opentidehq.opentide-1.0.0": "one" },
      { "opentidehq.opentide-2.0.0": true },
    );
    assert.match((await run(obsolete, "x\n")).stderr, /bridge one/);
  });

  it("with the extension uninstalled: one stderr line, an MCP error for the first request, then it exits", async () => {
    const dir = extensions("gone", {});
    const { code, stdout, stderr } = await run(
      dir,
      '{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":3,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":4,"method":"tools/list"}\n',
      { end: false },
    );
    const message =
      "the opentide extension is not installed; remove the opentide entry from ~/.kiro/settings/mcp.json or reinstall";
    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(stdout.trim()), { jsonrpc: "2.0", id: 3, error: { code: -32603, message } });
    assert.equal(stdout.trim().split("\n").length, 1);
    assert.equal(stderr.trim().split("\n").length, 1);
    assert.match(stderr, new RegExp(message));
  });

  it("with no extensions folder at all, the same", async () => {
    const { code, stdout } = await run(
      join(work, "does-not-exist"),
      '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n',
      {
        end: false,
      },
    );
    assert.equal(code, 1);
    assert.equal(JSON.parse(stdout.trim()).id, 1);
  });
});
