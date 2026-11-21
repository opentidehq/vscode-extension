// dist/mcp-wasi.js (src/mcp-wasi/main.ts): the MCP bridge, built here with esbuild as `npm run build` does. A
// scripted module stands in for `mcp start` (a fake launcher in OPENTIDE_WASI_DIR) so the tenant-request
// delegation (`OPENTIDE_FETCH=stdio`) can be tested before and beyond opentide's side; the real module is run
// when there is one (OPENTIDE_WASI_MODULE, or dist/wasi/ after `npm run build`).
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL = process.env.OPENTIDE_WASI_MODULE ?? join(root, "dist", "wasi", "opentide.wasm");

/** A fake `launcher.cjs <module> mcp start`: MCP over stdio, with `opentide/fetch` interleaved as opentide's does. */
const FAKE_LAUNCHER = String.raw`
const readline = require("node:readline");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const fetchTo = process.env.FAKE_FETCH_URL;
const mode = process.env.OPENTIDE_FETCH;
const waiting = new Map();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined && typeof m.id === "string" && waiting.has(m.id)) return waiting.get(m.id)(m);
  if (m.method === "initialize" || m.method === "server/discover")
    return send({ jsonrpc: "2.0", id: m.id, result: { via: m.method, fetch: mode, serverInfo: { name: "scripted" } } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "deploy" }] } });
  if (m.method === "tools/call") {
    // Noise the editor must never see: a log line, a private-link notice, a request of the module's own.
    process.stdout.write("this is not json\n");
    send({ jsonrpc: "2.0", method: "opentide/log", params: { text: "private" } });
    const id = "h1";
    new Promise((resolve) => {
      waiting.set(id, resolve);
      send({ jsonrpc: "2.0", id, method: "opentide/fetch", params: { run: null, platform: "sentinel", tenant: "lab", method: "GET", url: fetchTo, headers: [["accept", "text/plain"]], body: null, connect_timeout_ms: 2000, read_timeout_ms: 2000, tls: { verify: true, ca_bundles: [] }, proxy: null } });
    }).then((answer) => {
      const status = answer.result ? answer.result.status : "error:" + (answer.error && answer.error.data && answer.error.data.kind);
      send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "deployed with " + status }] } });
    });
  }
});
`;

/** Run the bridge, send `messages`, and collect the lines it writes until it has `expect` of them. */
function talk(bridge, env, messages, expect) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridge], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = [];
    let stderr = "";
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out; got ${JSON.stringify(lines)}\n${stderr}`));
    }, 60_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        lines.push(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
      if (lines.length >= expect) {
        clearTimeout(timer);
        child.stdin.end();
        child.once("close", () => resolve({ lines, stderr }));
      }
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

describe("the MCP bridge (dist/mcp-wasi.js)", function () {
  this.timeout(120_000);
  let dir;
  let bridge;
  let server;
  let url;
  const hits = [];

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "mcp-bridge-"));
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
    server = http.createServer((request, response) => {
      hits.push({ method: request.method, accept: request.headers.accept });
      response.writeHead(201, { "content-type": "text/plain" });
      response.end("ok");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${server.address().port}/deploy`;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  const scripted = () => ({ OPENTIDE_WASI_DIR: dir, FAKE_FETCH_URL: url });

  it("passes the editor's messages through for a legacy initialize and for server/discover, and asks the module for OPENTIDE_FETCH=stdio", async () => {
    for (const method of ["initialize", "server/discover"]) {
      const { lines } = await talk(bridge, scripted(), [{ jsonrpc: "2.0", id: 1, method, params: {} }], 1);
      const answer = JSON.parse(lines[0]);
      assert.equal(answer.id, 1);
      assert.equal(answer.result.via, method);
      assert.equal(answer.result.fetch, "stdio");
    }
  });

  it("answers the module's opentide/fetch itself and writes only MCP to the editor", async () => {
    const { lines, stderr } = await talk(
      bridge,
      scripted(),
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "deploy", arguments: {} } },
      ],
      3,
    );
    // Every line the editor got is a JSON-RPC message of the MCP server's, and none is the private link's.
    const messages = lines.map((line) => JSON.parse(line));
    assert.deepEqual(
      messages.map((message) => message.id),
      [1, 2, 3],
    );
    for (const message of messages) {
      assert.equal(message.jsonrpc, "2.0");
      assert.equal(message.method, undefined);
    }
    assert.equal(messages[2].result.content[0].text, "deployed with 201");
    // The HTTP request was made here, by FetchHost, with the module's headers.
    assert.deepEqual(hits, [{ method: "GET", accept: "text/plain" }]);
    // What was dropped is said on stderr, not stdout.
    assert.match(stderr, /not JSON on stdout: this is not json/);
    assert.match(stderr, /opentide\/log with nothing to answer it/);
  });

  it("answers a tenant that cannot be reached with the failure the module maps", async () => {
    const { lines } = await talk(
      bridge,
      { OPENTIDE_WASI_DIR: dir, FAKE_FETCH_URL: "http://127.0.0.1:9/x" },
      [{ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "deploy" } }],
      1,
    );
    assert.equal(JSON.parse(lines[0]).result.content[0].text, "deployed with error:connect");
  });

  it("exits with the module's exit code when the module is gone", async () => {
    const missing = mkdtempSync(join(tmpdir(), "mcp-bridge-none-"));
    try {
      const child = spawn(process.execPath, [bridge], {
        env: { ...process.env, OPENTIDE_WASI_DIR: missing },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const code = await new Promise((resolve) => child.on("close", resolve));
      assert.notEqual(code, 0);
    } finally {
      rmSync(missing, { recursive: true, force: true });
    }
  });

  describe("with the real module", function () {
    before(function () {
      if (!existsSync(REAL)) this.skip();
    });

    it("initializes and lists opentide's tools: nothing but MCP reaches the editor", async () => {
      // dist/wasi/ is the module's folder after `npm run build`; a bare module (OPENTIDE_WASI_MODULE) goes in a folder of its own.
      const wasi = existsSync(join(root, "dist", "wasi", "launcher.cjs"))
        ? join(root, "dist", "wasi")
        : undefined;
      if (!wasi) return this.skip();
      const workspace = mkdtempSync(join(tmpdir(), "mcp-bridge-ws-"));
      try {
        const { lines } = await talk(
          bridge,
          { OPENTIDE_WASI_DIR: wasi, OPENTIDE_REPO_ROOT: workspace },
          [
            {
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "test", version: "0" },
              },
            },
            { jsonrpc: "2.0", method: "notifications/initialized" },
            { jsonrpc: "2.0", id: 2, method: "tools/list" },
          ],
          2,
        );
        const [initialize, tools] = lines.map((line) => JSON.parse(line));
        assert.equal(initialize.result.serverInfo.name, "opentide");
        const names = tools.result.tools.map((tool) => tool.name);
        assert.ok(names.includes("search"), names.join(","));
        for (const line of lines) assert.ok(!/opentide\/fetch/.test(line));
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });
  });
});
