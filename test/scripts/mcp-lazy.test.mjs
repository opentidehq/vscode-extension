// dist/mcp-wasi.js (src/mcp-wasi/main.ts) starts the WASI module when it is first needed (#96): with a cache of what
// the module said last time (OPENTIDE_MCP_CACHE), `initialize`, the lists and `ping` are answered by the bridge and
// no module runs until a tool call. A scripted module (a fake launcher in OPENTIDE_WASI_DIR) logs every start and every
// line it receives, so the test can tell a module that never ran from one that did.
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const FAKE_LAUNCHER = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const log = process.env.FAKE_LOG;
fs.appendFileSync(log, JSON.stringify({ started: true }) + "\n");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  fs.appendFileSync(log, JSON.stringify({ got: m.method, id: m.id }) + "\n");
  if (m.method === "initialize")
    return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, serverInfo: { name: "scripted" } } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "deploy" }] } });
  if (m.method === "tools/call")
    return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "deployed" }] } });
  if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
`;

const INIT = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {} },
};
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };

/** Run the bridge, write `messages`, wait for `expect` answers, end its input, and wait for it to exit. */
function talk(bridge, env, messages, expect) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridge], {
      env: { ...process.env, ...env },
      cwd: env.OPENTIDE_REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = [];
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out; got ${JSON.stringify(lines)}\n${stderr}`));
    }, 30_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        lines.push(JSON.parse(buffer.slice(0, i)));
        buffer = buffer.slice(i + 1);
      }
      if (lines.length >= expect) child.stdin.end();
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ lines, code, stderr });
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    if (expect === 0) child.stdin.end();
  });
}

describe("the MCP bridge starts the module when it is first needed (#96)", function () {
  this.timeout(120_000);
  let dir;
  let bridge;
  let log;
  let cache;
  let env;

  const events = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "mcp-lazy-"));
    bridge = join(dir, "mcp-wasi.js");
    await esbuild.build({
      entryPoints: [join(root, "src", "mcp-wasi", "main.ts")],
      outfile: bridge,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      mainFields: ["module", "main"],
      logLevel: "silent",
    });
    writeFileSync(join(dir, "launcher.cjs"), FAKE_LAUNCHER);
    writeFileSync(join(dir, "opentide.wasm"), "\0asm");
    writeFileSync(join(dir, "wasi.json"), JSON.stringify({ moduleSha256: "aaaa" }));
    log = join(dir, "module.log");
    cache = join(dir, "cache", "folder.json");
    env = {
      OPENTIDE_WASI_DIR: dir,
      OPENTIDE_MCP_CACHE: cache,
      FAKE_LOG: log,
    };
  });

  beforeEach(() => {
    rmSync(log, { force: true });
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("starts the module at once when there is no cache, and writes the cache from its answers", async () => {
    rmSync(join(dir, "cache"), { recursive: true, force: true });
    const { lines, code } = await talk(
      bridge,
      { ...env, OPENTIDE_REPO_ROOT: dir },
      [INIT, INITIALIZED, { jsonrpc: "2.0", id: 1, method: "tools/list" }],
      2,
    );
    assert.equal(code, 0);
    assert.deepEqual(
      lines.map((l) => l.id),
      [0, 1],
    );
    assert.deepEqual(events().filter((e) => e.started).length, 1);
    const saved = JSON.parse(readFileSync(cache, "utf8"));
    assert.equal(saved.module, "aaaa");
    assert.deepEqual(saved.lists["tools/list"], { tools: [{ name: "deploy" }] });
  });

  it("answers the start-up from the cache and never starts the module for it", async () => {
    const { lines, code } = await talk(
      bridge,
      { ...env, OPENTIDE_REPO_ROOT: dir },
      [
        INIT,
        INITIALIZED,
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: 2, method: "ping" },
      ],
      3,
    );
    assert.equal(code, 0);
    assert.equal(lines[0].result.serverInfo.name, "scripted");
    assert.deepEqual(lines[1].result, { tools: [{ name: "deploy" }] });
    assert.deepEqual(lines[2], { jsonrpc: "2.0", id: 2, result: {} });
    assert.deepEqual(events(), [], "the module did not run");
  });

  it("starts the module at a tool call, tells it the start-up first, and hides that answer", async () => {
    const { lines, code } = await talk(
      bridge,
      { ...env, OPENTIDE_REPO_ROOT: dir },
      [
        INIT,
        INITIALIZED,
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "deploy" } },
      ],
      3,
    );
    assert.equal(code, 0);
    assert.deepEqual(
      lines.map((l) => l.id),
      [0, 1, 2],
      "the editor sees one answer for each request it made",
    );
    assert.equal(lines[2].result.content[0].text, "deployed");
    assert.deepEqual(events(), [
      { started: true },
      { got: "initialize", id: "opentide-bridge-init" },
      { got: "notifications/initialized" },
      { got: "tools/call", id: 2 },
    ]);
  });

  it("ignores a cache of another module and starts it", async () => {
    writeFileSync(join(dir, "wasi.json"), JSON.stringify({ moduleSha256: "bbbb" }));
    try {
      const { lines } = await talk(bridge, { ...env, OPENTIDE_REPO_ROOT: dir }, [INIT, INITIALIZED], 1);
      assert.equal(lines.length, 1);
      assert.equal(events().filter((e) => e.started).length, 1);
      assert.equal(JSON.parse(readFileSync(cache, "utf8")).module, "bbbb");
    } finally {
      writeFileSync(join(dir, "wasi.json"), JSON.stringify({ moduleSha256: "aaaa" }));
    }
  });

  it("starts the module at the first message when no cache file is named", async () => {
    const { OPENTIDE_MCP_CACHE: _omit, ...without } = env;
    const { lines } = await talk(bridge, { ...without, OPENTIDE_REPO_ROOT: dir }, [INIT, INITIALIZED], 1);
    assert.equal(lines.length, 1);
    assert.equal(events().filter((e) => e.started).length, 1);
  });

  it("exits at once, with nothing started, when the editor closes its input first", async () => {
    const { code } = await talk(bridge, { ...env, OPENTIDE_REPO_ROOT: dir }, [], 0);
    assert.equal(code, 0);
    assert.deepEqual(events(), []);
  });
});
