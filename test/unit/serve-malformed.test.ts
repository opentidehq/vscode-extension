import * as assert from "node:assert/strict";

import type { ServeProcess } from "../../src/core/backend/process";
import { ServeClient, serveMessage } from "../../src/core/backend/serve";
import { BackendError, envelopeProblem, isEnvelope } from "../../src/core/backend/types";

/** A scripted `opentide serve`: `reply` turns each request into the lines it prints. */
function scripted(reply: (request: { id: number; method: string }) => unknown[]): {
  client: ServeClient;
  logs: string[];
} {
  const logs: string[] = [];
  let stdout: (chunk: string) => void = () => undefined;
  let closed: (code: number | null, signal: string | null) => void = () => undefined;
  const proc: ServeProcess = {
    write: (text) => {
      for (const line of text.split("\n").filter(Boolean)) {
        const request = JSON.parse(line) as { id?: number; method: string };
        if (request.method === "exit") setImmediate(() => closed(0, null));
        if (request.id === undefined) continue;
        const lines =
          request.method === "initialize"
            ? [
                {
                  jsonrpc: "2.0",
                  id: request.id,
                  result: { protocol: 1, version: "1.0.0", commands_digest: "d" },
                },
              ]
            : reply({ id: request.id, method: request.method });
        setImmediate(() => {
          for (const out of lines) stdout(`${typeof out === "string" ? out : JSON.stringify(out)}\n`);
        });
      }
    },
    onStdout: (listener) => {
      stdout = listener;
    },
    onStderr: () => undefined,
    onError: () => undefined,
    onClose: (listener) => {
      closed = listener;
    },
    kill: () => closed(null, "SIGKILL"),
  };
  return { client: new ServeClient({ start: () => proc, log: (_l, m) => logs.push(m) }), logs };
}

const good = { ok: true, status: "ok", message: "m", command: "echo", schema_version: 1, exit_code: 0 };

describe("envelope validation", () => {
  it("accepts a minimal envelope and one with a well-formed failure", () => {
    assert.equal(isEnvelope({ exit_code: 0 }), true);
    assert.equal(isEnvelope({ ...good, failure: null }), true);
    assert.equal(isEnvelope({ ...good, failure: { code: "workspace_not_found", message: "no" } }), true);
  });

  const bad: [string, unknown, RegExp][] = [
    ["a string", "{}", /not a JSON object/],
    ["an array", [], /not a JSON object/],
    ["no exit_code", { ok: true }, /exit_code/],
    ["a NaN exit_code", { exit_code: Number.NaN }, /exit_code/],
    ["a failure that is a string", { exit_code: 1, failure: "boom" }, /failure/],
    ["a failure with no code", { exit_code: 1, failure: { message: "m" } }, /string code/],
    ["a failure with a numeric code", { exit_code: 1, failure: { code: 7, message: "m" } }, /string code/],
    ["a failure with no message", { exit_code: 1, failure: { code: "c" } }, /string message/],
    [
      "a failure whose suggestion is a number",
      { exit_code: 1, failure: { code: "c", message: "m", suggestion: 3 } },
      /suggestion/,
    ],
    ["a non-boolean ok", { exit_code: 0, ok: "yes" }, /ok/],
    ["a non-object summary", { exit_code: 0, summary: [] }, /summary/],
    ["a non-array next_actions", { exit_code: 0, next_actions: {} }, /next_actions/],
  ];
  for (const [name, value, pattern] of bad) {
    it(`rejects ${name}`, () => {
      assert.equal(isEnvelope(value), false);
      assert.match(envelopeProblem(value) ?? "", pattern);
    });
  }
});

describe("serve message validation", () => {
  it("rejects lines that are not JSON-RPC messages", () => {
    for (const value of [
      null,
      3,
      "x",
      [],
      { id: {} },
      { id: true },
      { method: 4 },
      { id: 1, error: "boom" },
      { id: 1, error: { code: "x", message: "m" } },
    ]) {
      assert.ok("problem" in serveMessage(value), JSON.stringify(value));
    }
  });
  it("keeps a well-formed message", () => {
    const checked = serveMessage({ jsonrpc: "2.0", id: 3, error: { code: -32600, message: "m" } });
    assert.deepEqual("message" in checked && checked.message, {
      id: 3,
      error: { code: -32600, message: "m" },
    });
  });
});

describe("opentide serve client with malformed output", () => {
  it("rejects a run whose document has a failure without a code, as a protocol error", async () => {
    const { client } = scripted(({ id }) => [
      {
        jsonrpc: "2.0",
        id,
        result: { exit_code: 1, document: { exit_code: 1, failure: { message: "no code" } } },
      },
    ]);
    await assert.rejects(
      client.run({ argv: ["x"] }),
      (e: unknown) => e instanceof BackendError && e.code === "protocol" && /string code/.test(e.message),
    );
    await client.stop();
  });

  it("rejects a run answered with a null result", async () => {
    const { client } = scripted(({ id }) => [{ jsonrpc: "2.0", id, result: null }]);
    await assert.rejects(
      client.run({ argv: ["x"] }),
      (e: unknown) => e instanceof BackendError && e.code === "protocol",
    );
    await client.stop();
  });

  it("ignores a line with a non-scalar id or a malformed error and still answers the run", async () => {
    const { client, logs } = scripted(({ id }) => [
      { jsonrpc: "2.0", id: { nested: true }, result: {} },
      { jsonrpc: "2.0", id: 99, error: "boom" },
      "[1,2]",
      { jsonrpc: "2.0", id, result: { exit_code: 0, document: good } },
    ]);
    const result = await client.run({ argv: ["x"] });
    assert.equal(result.exit_code, 0);
    assert.equal(logs.filter((m) => m.startsWith("serve:")).length, 3);
    await client.stop();
  });

  it("ignores a progress notification with the wrong shape", async () => {
    const { client } = scripted(({ id }) => [
      { jsonrpc: "2.0", method: "progress", params: "nope" },
      { jsonrpc: "2.0", method: "progress", params: { id, event: 3 } },
      { jsonrpc: "2.0", id, result: { exit_code: 0, document: good } },
    ]);
    const events: unknown[] = [];
    await client.run({ argv: ["x"] }, { onProgress: (e) => events.push(e) });
    assert.deepEqual(events, []);
    await client.stop();
  });
});
