// dist/mcp-wasi.js (src/mcp-wasi/main.ts): the MCP bridge, built here with esbuild as `npm run build` does. A
// scripted module stands in for `mcp start` (a fake launcher in OPENTIDE_WASI_DIR) so the tenant-request
// delegation (`OPENTIDE_FETCH=stdio`) can be tested before and beyond opentide's side; the real module is run
// when there is one (OPENTIDE_WASI_MODULE, or dist/wasi/ after `npm run build`).
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL = process.env.OPENTIDE_WASI_MODULE ?? join(root, "dist", "wasi", "opentide.wasm");

/** A rule for the elastic tenant of the real-module test. */
const RULE = `name: Elastic create rule
metadata:
  uuid: 6b2e9c14-7a31-4f58-9d0c-1e8a4b7c0001
  schema: rule::1.0
  version: 1
  created: 2026-01-01
  modified: 2026-01-02
  tlp: clear
description: A rule the tenant stand-in receives in a deploy that sends.
response:
  alert_severity: High
configurations:
  elastic:
    schema: platform::elastic::1.0
    status: STAGING
    type: query
    language: kuery
    query: |
      process.name: "powershell.exe"
    scheduling:
      interval: 5m
      lookback: 1m
`;

/**
 * A fake `launcher.cjs <module> mcp start`: MCP over stdio, with `opentide/fetch` interleaved as opentide's
 * `mcp start` writes it with OPENTIDE_FETCH=stdio (docs/cli/mcp.md there): ids `opentide-fetch-<token>-N`, a client's
 * `notifications/cancelled` for the call withdrawing the request with `notifications/cancelled`, and an input
 * that ends with a request unanswered failing the call. While the call waits it reads stdin itself: the
 * client's other messages are kept and answered after it.
 */
const FAKE_LAUNCHER = String.raw`
const readline = require("node:readline");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const fetchTo = process.env.FAKE_FETCH_URL;
const mode = process.env.OPENTIDE_FETCH;
// opentide chooses 128 random bits at start; the bridge only knows the prefix.
const TOKEN = "9f3a1c7e5b2d4086a1b2c3d4e5f60718";
let counter = 0;
let call; // { id, fetchId, finish }
const kept = [];
const answer = (m) => {
  if (m.method === "initialize" || m.method === "server/discover")
    return send({ jsonrpc: "2.0", id: m.id, result: { via: m.method, fetch: mode, serverInfo: { name: "scripted" } } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "deploy" }] } });
  if (m.method === "ping") return send({ jsonrpc: "2.0", id: m.id, result: {} });
  if (m.method === "test/notfound")
    return send({ jsonrpc: "2.0", id: m.id, result: { isError: true, content: [{ type: "text", text: "workspace_not_found: no detection workspace here" }] } });
  if (m.method === "test/leak") {
    // A private-link line cut short, then the answer: the first must never reach the editor.
    process.stdout.write('{"jsonrpc":"2.0","id":"opentide-fetch-99","method":"opentide/fetch","params":{"headers":[["authorization","Bearer hunter2"]]\n');
    send({ jsonrpc: "2.0", method: "opentide/log", params: { authorization: "Bearer hunter2" } });
    return send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
  if (m.method === "tools/call") {
    const fetchId = "opentide-fetch-" + TOKEN + "-" + ++counter;
    const text = (t) => send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: t }] } });
    call = {
      id: m.id,
      fetchId,
      finish: (reply) => {
        call = undefined;
        const status = reply.result ? reply.result.status : "error:" + (reply.error && reply.error.data && reply.error.data.kind);
        text("deployed with " + status);
        while (kept.length > 0 && !call) answer(kept.shift());
      },
      cancel: () => {
        send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: fetchId, reason: "the call was cancelled" } });
        call = undefined;
        text("cancelled");
      },
    };
    send({ jsonrpc: "2.0", id: fetchId, method: "opentide/fetch", params: { run: String(m.id), platform: "sentinel", tenant: "lab", method: "GET", url: fetchTo + (m.params.arguments && m.params.arguments.path || ""), headers: [["accept", "text/plain"]], body: null, connect_timeout_ms: 5000, read_timeout_ms: 5000, tls: { verify: true, ca_bundles: [] }, proxy: null } });
  }
};
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const m = JSON.parse(line);
  if (call && m.id === call.fetchId && m.method === undefined) return call.finish(m);
  if (call && m.method === "notifications/cancelled" && m.params.requestId === call.id) return call.cancel();
  if (call) return void kept.push(m);
  answer(m);
});
lines.on("close", () => {
  if (call) {
    process.stderr.write("the client closed its input before answering an opentide/fetch request\n");
    process.exitCode = 3;
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

/** An open conversation with the bridge: `send` a message, `next` line, `end` the input. */
function session(bridge, env) {
  const child = spawn(process.execPath, [bridge], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = [];
  const waiters = [];
  let stderr = "";
  let buffer = "";
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
    while (lines.length > 0 && waiters.length > 0) waiters.shift()(lines.shift());
  });
  const closed = new Promise((resolve) => child.once("close", (code) => resolve(code)));
  return {
    // An object is one JSON line; a string is written as it is (a line with JSON escapes the guard must see through).
    send: (message) =>
      child.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`),
    next: () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no line in 20 s\n${stderr}`)), 20_000);
        const take = (line) => {
          clearTimeout(timer);
          resolve(line);
        };
        if (lines.length > 0) take(lines.shift());
        else waiters.push(take);
      }),
    end: () => child.stdin.end(),
    closed,
    kill: () => child.kill("SIGKILL"),
    stderr: () => stderr,
  };
}

describe("the MCP bridge (dist/mcp-wasi.js)", function () {
  this.timeout(120_000);
  let dir;
  let bridge;
  let server;
  let url;
  const hits = [];
  const slow = { started: 0, aborted: 0 };

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
      if (request.url.endsWith("/delayed")) {
        // A tenant that answers after the agent has had its say.
        setTimeout(() => {
          response.writeHead(201, { "content-type": "text/plain" });
          response.end("ok");
        }, 800);
        return;
      }
      if (request.url.endsWith("/slow")) {
        // A tenant that never answers: the call ends by the client's own doing.
        slow.started += 1;
        response.on("close", () => {
          if (!response.writableEnded) slow.aborted += 1;
        });
        return;
      }
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
    const { lines } = await talk(
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

  it("passes everything else through byte for byte, a tenant request's id never reaching the editor", async () => {
    const { lines } = await talk(
      bridge,
      scripted(),
      [
        { jsonrpc: "2.0", id: "opentide-fetch-1", method: "ping" },
        { jsonrpc: "2.0", id: 5, method: "ping" },
      ],
      2,
    );
    assert.deepEqual(lines, [
      '{"jsonrpc":"2.0","id":"opentide-fetch-1","result":{}}',
      '{"jsonrpc":"2.0","id":5,"result":{}}',
    ]);
  });

  it("cancels a call mid-tenant-request: the request is aborted, the withdrawal stays between the two, and the next call works", async () => {
    const talking = session(bridge, scripted());
    try {
      talking.send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "deploy", arguments: { path: "/slow" } },
      });
      // The tenant has the request, and the module's call waits for the answer.
      for (let waited = 0; slow.started < 1 && waited < 200; waited += 1)
        await new Promise((r) => setTimeout(r, 50));
      assert.equal(slow.started >= 1, true);
      const before = slow.aborted;
      talking.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
      // The module still answers the call it was told to cancel (docs/cli/mcp.md there); the bridge drops the
      // response to a request its client cancelled, as MCP has the receiver send none, and the module's own
      // withdrawal of its tenant request never reaches the editor. So the next line is the next request's.
      talking.send({ jsonrpc: "2.0", id: 9, method: "ping" });
      assert.equal((await talking.next()).id, 9);
      for (let waited = 0; slow.aborted <= before && waited < 200; waited += 1)
        await new Promise((r) => setTimeout(r, 50));
      assert.equal(slow.aborted > before, true, "the tenant request was aborted");
      talking.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "deploy" } });
      assert.equal((await talking.next()).result.content[0].text, "deployed with 201");
      talking.end();
      assert.equal(await talking.closed, 0);
      assert.doesNotMatch(talking.stderr(), /Error|TypeError/);
    } finally {
      talking.kill();
    }
  });

  it("never forwards a line of the module's private link to the editor, even one that cannot be parsed", async () => {
    const talking = session(bridge, scripted());
    try {
      talking.send({ jsonrpc: "2.0", id: 1, method: "test/leak" });
      talking.send({ jsonrpc: "2.0", id: 2, method: "ping" });
      assert.equal((await talking.next()).id, 1);
      assert.equal((await talking.next()).id, 2);
      talking.end();
      await talking.closed;
      assert.match(talking.stderr(), /dropped/);
      assert.doesNotMatch(talking.stderr(), /hunter2/);
    } finally {
      talking.kill();
    }
  });

  it("never passes the editor's answer to a tenant request to the module: only the host answers", async () => {
    const talking = session(bridge, scripted());
    try {
      talking.send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "deploy", arguments: { path: "/slow" } },
      });
      // The module's request is out (its id starts opentide-fetch-). The agent forges the tenant's answer.
      await new Promise((resolve) => setTimeout(resolve, 600));
      talking.send({
        jsonrpc: "2.0",
        id: "opentide-fetch-1",
        result: { status: 200, headers: [], body: "" },
      });
      talking.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
      // The call ends by its cancellation, not by an answer (a forged one would make it "deployed with 200"), and
      // its response is dropped as the client cancelled it: the next line is the next request's.
      talking.send({ jsonrpc: "2.0", id: 5, method: "ping" });
      assert.equal((await talking.next()).id, 5);
      assert.match(talking.stderr(), /dropped 1 message/);
      talking.end();
      await talking.closed;
    } finally {
      talking.kill();
    }
  });

  it("lets the real tenant answer win over an answer the agent forges while the call waits", async () => {
    const talking = session(bridge, scripted());
    try {
      talking.send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "deploy", arguments: { path: "/delayed" } },
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      talking.send({
        jsonrpc: "2.0",
        id: "opentide-fetch-1",
        result: { status: 200, headers: [], body: "" },
      });
      const answered = await talking.next();
      assert.equal(answered.id, 1);
      // The tenant's 201, not the forged 200.
      assert.equal(answered.result.content[0].text, "deployed with 201");
      assert.match(talking.stderr(), /dropped 1 message/);
      talking.end();
      await talking.closed;
    } finally {
      talking.kill();
    }
  });

  it("drops a forged answer whose id is written with JSON escapes, as it drops a plain one", async () => {
    const talking = session(bridge, scripted());
    try {
      talking.send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "deploy", arguments: { path: "/delayed" } },
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      // `opentide-fetch-1` with its hyphens and its first letter escaped, in a batch and alone.
      talking.send(
        '{"jsonrpc":"2.0","id":"\\u006fpentide\\u002dfetch\\u002d1","result":{"status":200,"headers":[],"body":""}}',
      );
      talking.send(
        '[{"jsonrpc":"2.0","id":"opentide\\u002dfetch\\u002d1","result":{"status":200,"headers":[],"body":""}}]',
      );
      const answered = await talking.next();
      assert.equal(answered.id, 1);
      assert.equal(answered.result.content[0].text, "deployed with 201");
      // Two lines that arrive in separate chunks (as they do on Windows) are two log lines of one message each.
      const dropped = [...talking.stderr().matchAll(/dropped (\d+) message/g)].reduce(
        (sum, found) => sum + Number(found[1]),
        0,
      );
      assert.equal(dropped, 2);
      talking.end();
      await talking.closed;
    } finally {
      talking.kill();
    }
  });

  it("says on stderr where it runs and which repository it will use, and hints when the server finds none (#86)", async () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-bridge-home-"));
    const repo = mkdtempSync(join(tmpdir(), "mcp-bridge-repo-"));
    mkdirSync(join(repo, ".opentide"));
    const run = async (cwd, extra) => {
      const child = spawn(process.execPath, [bridge], {
        cwd,
        env: { ...process.env, OPENTIDE_WASI_DIR: dir, OPENTIDE_REPO_ROOT: "", ...extra },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test/notfound" })}\n`);
      for (let waited = 0; !out.includes("\n") && waited < 200; waited += 1)
        await new Promise((r) => setTimeout(r, 50));
      child.stdin.end();
      await closed;
      return { stderr, answer: JSON.parse(out.split("\n")[0]) };
    };
    try {
      const lost = await run(home, {});
      assert.match(
        lost.stderr,
        new RegExp(
          `cwd=${home.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}; OPENTIDE_REPO_ROOT not set; repository root: none found`,
        ),
      );
      const parts = lost.answer.result.content;
      assert.equal(parts.length, 2, "the module's text, then the hint");
      assert.match(parts[0].text, /^workspace_not_found/);
      assert.match(parts[1].text, /started this server in .* not inside a detection repository/);
      assert.match(parts[1].text, /set OPENTIDE_REPO_ROOT to its absolute path/);
      const found = await run(join(repo), {});
      assert.match(found.stderr, /repository root: .*mcp-bridge-repo-/);
      const named = await run(home, { OPENTIDE_REPO_ROOT: repo });
      assert.match(
        named.stderr,
        /OPENTIDE_REPO_ROOT=.*mcp-bridge-repo-.*; repository root: .*mcp-bridge-repo-/,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps the editor's other messages until the call returns, in order", async () => {
    const talking = session(bridge, scripted());
    try {
      talking.send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "deploy", arguments: { path: "/ok" } },
      });
      talking.send({ jsonrpc: "2.0", id: 2, method: "ping" });
      talking.send({ jsonrpc: "2.0", id: 3, method: "ping" });
      const ids = [(await talking.next()).id, (await talking.next()).id, (await talking.next()).id];
      assert.deepEqual(ids, [1, 2, 3]);
      talking.end();
      await talking.closed;
    } finally {
      talking.kill();
    }
  });

  it("when the editor closes its input mid-request: the request is aborted, the module's call fails, and the bridge exits with its code", async () => {
    const talking = session(bridge, scripted());
    try {
      const before = slow.aborted;
      const started = slow.started;
      talking.send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "deploy", arguments: { path: "/slow" } },
      });
      for (let waited = 0; slow.started <= started && waited < 200; waited += 1)
        await new Promise((r) => setTimeout(r, 50));
      talking.end();
      assert.equal(await talking.closed, 3);
      assert.match(talking.stderr(), /closed its input before answering an opentide\/fetch request/);
      assert.doesNotMatch(talking.stderr(), /ERR_STREAM|write after end|TypeError/);
      for (let waited = 0; slow.aborted <= before && waited < 200; waited += 1)
        await new Promise((r) => setTimeout(r, 50));
      assert.equal(slow.aborted > before, true, "the tenant request was aborted");
    } finally {
      talking.kill();
    }
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

  describe("with the real module", () => {
    before(function () {
      if (!existsSync(REAL)) this.skip();
    });

    describe("a tenant tool, when the module asks its client to make the request (opentide#1742)", () => {
      let wasi;
      let workspace;
      let tenant;
      const seen = { requests: [], aborted: 0 };

      before(async function () {
        wasi = existsSync(join(root, "dist", "wasi", "launcher.cjs"))
          ? join(root, "dist", "wasi")
          : undefined;
        // A module without the delegation (before opentide 1.0.0-rc.3) answers `network_unavailable`.
        if (!wasi || !readFileSync(join(wasi, "opentide.wasm")).includes("OPENTIDE_FETCH")) this.skip();
        workspace = mkdtempSync(join(tmpdir(), "mcp-bridge-tenant-"));
        mkdirSync(join(workspace, ".opentide", "configurations", "platforms"), { recursive: true });
        mkdirSync(join(workspace, "objects", "rules"), { recursive: true });
        writeFileSync(join(workspace, "objects", "rules", "elastic-create.yaml"), RULE);
        tenant = http.createServer((request, response) => {
          seen.requests.push(`${request.method} ${request.url}`);
          if (holding) {
            response.on("close", () => {
              if (!response.writableEnded) seen.aborted += 1;
            });
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: "r1", rule_id: "r1" }));
        });
        await new Promise((resolve) => tenant.listen(0, "127.0.0.1", resolve));
        writeFileSync(
          join(workspace, ".opentide", "configurations", "platforms", "elastic.toml"),
          `[platform]\nenabled = true\nname = "Elastic Security"\n\n[[tenants]]\nname = "soc"\nstrategies = ["PREVIEW", "RELEASE"]\n[tenants.setup]\nssl = false\nurl = "http://127.0.0.1:${tenant.address().port}"\nelasticsearch_url = "http://127.0.0.1:${tenant.address().port}"\napi_key = "$ELASTIC_API_KEY"\nspace = "soc"\nindex = ["logs-*"]\n`,
        );
      });
      after(async () => {
        if (tenant) await new Promise((resolve) => tenant.close(resolve));
        if (workspace) rmSync(workspace, { recursive: true, force: true });
      });

      let holding = false;
      const DEPLOY = {
        name: "deploy_rule",
        arguments: { uuid: "6b2e9c14-7a31-4f58-9d0c-1e8a4b7c0001", platform: "elastic", dry_run: false },
      };
      const start = () =>
        session(bridge, {
          OPENTIDE_WASI_DIR: wasi,
          OPENTIDE_REPO_ROOT: workspace,
          ELASTIC_API_KEY: "stand-in",
        });
      const initialize = async (talking) => {
        talking.send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test", version: "0" },
          },
        });
        talking.send({ jsonrpc: "2.0", method: "notifications/initialized" });
        await talking.next();
      };

      it("is deployed through the bridge: the extension makes the tenant's requests, and only MCP reaches the editor", async () => {
        seen.requests.length = 0;
        holding = false;
        const talking = start();
        try {
          await initialize(talking);
          talking.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: DEPLOY });
          const answered = await talking.next();
          assert.equal(answered.id, 2);
          const text = answered.result.content.map((part) => part.text).join("\n");
          assert.match(text, /Deployed 1 rule to 1 tenant/, text);
          assert.ok(
            seen.requests.some((line) => line.startsWith("POST /s/soc/api/detection_engine/rules")),
            seen.requests.join("\n"),
          );
          assert.doesNotMatch(JSON.stringify(answered), /opentide-fetch-|"opentide\/fetch"/);
          talking.end();
          assert.equal(await talking.closed, 0);
        } finally {
          talking.kill();
        }
      });

      it("a cancelled call aborts the tenant's request and the server goes on", async () => {
        seen.requests.length = 0;
        seen.aborted = 0;
        holding = true;
        const talking = start();
        try {
          await initialize(talking);
          talking.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: DEPLOY });
          for (let waited = 0; seen.requests.length === 0 && waited < 200; waited += 1)
            await new Promise((r) => setTimeout(r, 50));
          assert.ok(seen.requests.length > 0, "the tenant received the request");
          talking.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } });
          talking.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
          // The cancelled call's response is dropped (the client cancelled it): the next line is the list.
          const listed = await talking.next();
          assert.equal(listed.id, 3);
          assert.ok(Array.isArray(listed.result.tools));
          for (let waited = 0; seen.aborted === 0 && waited < 100; waited += 1)
            await new Promise((r) => setTimeout(r, 50));
          assert.ok(seen.aborted > 0, "the tenant request was aborted");
          talking.end();
          assert.equal(await talking.closed, 0);
        } finally {
          holding = false;
          talking.kill();
        }
      });

      it("an input closed with the request unanswered fails the call, aborts the request and ends the bridge", async () => {
        seen.requests.length = 0;
        seen.aborted = 0;
        holding = true;
        const talking = start();
        try {
          await initialize(talking);
          talking.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: DEPLOY });
          for (let waited = 0; seen.requests.length === 0 && waited < 200; waited += 1)
            await new Promise((r) => setTimeout(r, 50));
          talking.end();
          assert.equal(await talking.closed, 0);
          for (let waited = 0; seen.aborted === 0 && waited < 100; waited += 1)
            await new Promise((r) => setTimeout(r, 50));
          assert.ok(seen.aborted > 0, "the tenant request was aborted");
          assert.doesNotMatch(talking.stderr(), /write after end|ERR_STREAM|TypeError/);
        } finally {
          holding = false;
          talking.kill();
        }
      });
    });

    it("initializes and lists opentide's tools: nothing but MCP reaches the editor", async function () {
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
