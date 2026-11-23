import * as assert from "node:assert/strict";
import { LAZY_INIT_ID, type LazyCache, LazyGate, readCache } from "../../../src/core/wasi/mcpLazy";

const identity = { module: "abc123", root: "/work/repo" };
const INIT = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {} },
};
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };
const line = (message: unknown): string => `${JSON.stringify(message)}\n`;

function cacheOf(extra: Partial<LazyCache> = {}): LazyCache {
  return {
    format: 1,
    ...identity,
    initialize: {
      protocolVersion: "2025-06-18",
      result: { protocolVersion: "2025-06-18", serverInfo: { name: "opentide" } },
    },
    lists: { "tools/list": { tools: [{ name: "deploy_rule" }] } },
    ...extra,
  };
}

function gateOf(cache: LazyCache | undefined) {
  const events: string[] = [];
  const replies: unknown[] = [];
  const toModule: unknown[] = [];
  const saved: LazyCache[] = [];
  const gate = new LazyGate(cache, identity, {
    reply: (text) => replies.push(JSON.parse(text)),
    start: () => events.push("start"),
    toModule: (text) => toModule.push(JSON.parse(text)),
    save: (value) => saved.push(value),
  });
  return { gate, events, replies, toModule, saved };
}

describe("the MCP bridge's lazy start (#96)", () => {
  describe("with what the module said last time", () => {
    it("answers initialize, the lists and ping without starting the module", () => {
      const { gate, events, replies } = gateOf(cacheOf());
      assert.equal(gate.fromEditor(line(INIT)), false);
      assert.equal(gate.fromEditor(line(INITIALIZED)), false);
      assert.equal(gate.fromEditor(line({ jsonrpc: "2.0", id: 1, method: "tools/list" })), false);
      assert.equal(gate.fromEditor(line({ jsonrpc: "2.0", id: "p", method: "ping" })), false);
      assert.deepEqual(events, []);
      assert.equal(gate.started, false);
      assert.deepEqual(replies, [
        { jsonrpc: "2.0", id: 0, result: cacheOf().initialize?.result },
        { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "deploy_rule" }] } },
        { jsonrpc: "2.0", id: "p", result: {} },
      ]);
    });

    it("starts the module at a tool call and plays it the start-up the editor did first", () => {
      const { gate, events, toModule } = gateOf(cacheOf());
      gate.fromEditor(line(INIT));
      gate.fromEditor(line(INITIALIZED));
      const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "deploy_rule" } };
      assert.equal(gate.fromEditor(line(call)), true);
      assert.deepEqual(events, ["start"]);
      assert.deepEqual(toModule, [{ ...INIT, id: LAZY_INIT_ID }, INITIALIZED]);
      assert.equal(gate.started, true);
      // From now on every line goes to the module and the module is not started again.
      assert.equal(gate.fromEditor(line({ jsonrpc: "2.0", id: 3, method: "tools/list" })), true);
      assert.deepEqual(events, ["start"]);
    });

    it("does not show the editor the module's answer to the replayed initialize", () => {
      const { gate } = gateOf(cacheOf());
      gate.fromEditor(line(INIT));
      gate.fromEditor(line({ jsonrpc: "2.0", id: 2, method: "tools/call" }));
      assert.equal(gate.fromModule(line({ jsonrpc: "2.0", id: LAZY_INIT_ID, result: {} })), false);
      assert.equal(gate.fromModule(line({ jsonrpc: "2.0", id: 2, result: { content: [] } })), true);
    });

    it("lets everything else wake the module: resources/read, a page of tools, a setting, a batch", () => {
      for (const message of [
        { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "opentide://x" } },
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: { cursor: "next" } },
        { jsonrpc: "2.0", id: 1, method: "logging/setLevel", params: { level: "debug" } },
      ]) {
        const { gate, events } = gateOf(cacheOf());
        gate.fromEditor(line(INIT));
        assert.equal(gate.fromEditor(line(message)), true, JSON.stringify(message));
        assert.deepEqual(events, ["start"]);
      }
      const batch = gateOf(cacheOf());
      assert.equal(batch.gate.fromEditor(`${JSON.stringify([INIT])}\n`), true);
      assert.deepEqual(batch.events, ["start"]);
    });

    it("starts the module when the editor asks for another protocol version", () => {
      const { gate, events, toModule } = gateOf(cacheOf());
      const other = { ...INIT, params: { protocolVersion: "2024-11-05" } };
      assert.equal(gate.fromEditor(line(other)), true);
      assert.deepEqual(events, ["start"]);
      assert.deepEqual(toModule, [], "the initialize itself goes through, not as a replay");
    });

    it("does not answer a list it has not got, and starts the module for it", () => {
      const { gate, events } = gateOf(cacheOf());
      gate.fromEditor(line(INIT));
      assert.equal(gate.fromEditor(line({ jsonrpc: "2.0", id: 1, method: "prompts/list" })), true);
      assert.deepEqual(events, ["start"]);
    });

    it("drops the editor's notifications while the module is not running", () => {
      const { gate, events } = gateOf(cacheOf());
      gate.fromEditor(line(INIT));
      assert.equal(
        gate.fromEditor(
          line({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } }),
        ),
        false,
      );
      assert.deepEqual(events, []);
    });
  });

  describe("without a cache", () => {
    it("starts the module at the first message, and writes the cache from its answers", () => {
      const { gate, events, toModule, saved } = gateOf(undefined);
      assert.equal(gate.fromEditor(line(INIT)), true);
      assert.deepEqual(events, ["start"]);
      assert.deepEqual(toModule, [], "no replay: the editor's own initialize goes through");
      gate.fromEditor(line(INITIALIZED));
      gate.fromEditor(line({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
      assert.equal(
        gate.fromModule(line({ jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18" } })),
        true,
      );
      assert.equal(
        gate.fromModule(line({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "a" }] } })),
        true,
      );
      assert.equal(saved.length, 2);
      assert.deepEqual(saved[1]?.initialize, {
        protocolVersion: "2025-06-18",
        result: { protocolVersion: "2025-06-18" },
      });
      assert.deepEqual(saved[1]?.lists, { "tools/list": { tools: [{ name: "a" }] } });
      assert.equal(saved[1]?.module, identity.module);
      assert.equal(saved[1]?.root, identity.root);
    });

    it("does not keep an error, a page with a next page, or a page that was asked for", () => {
      const { gate, saved } = gateOf(undefined);
      gate.fromEditor(line(INIT));
      gate.fromEditor(line({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
      gate.fromEditor(line({ jsonrpc: "2.0", id: 2, method: "prompts/list" }));
      gate.fromEditor(line({ jsonrpc: "2.0", id: 3, method: "resources/list", params: { cursor: "c" } }));
      gate.fromModule(line({ jsonrpc: "2.0", id: 0, error: { code: -32603, message: "no" } }));
      gate.fromModule(line({ jsonrpc: "2.0", id: 1, result: { tools: [], nextCursor: "more" } }));
      gate.fromModule(line({ jsonrpc: "2.0", id: 2, result: { prompts: [] } }));
      gate.fromModule(line({ jsonrpc: "2.0", id: 3, result: { resources: [] } }));
      assert.equal(saved.length, 1);
      assert.deepEqual(saved[0]?.lists, { "prompts/list": { prompts: [] } });
    });

    it("lets a line that is no JSON through to the module", () => {
      const { gate, events } = gateOf(undefined);
      assert.equal(gate.fromEditor("not json\n"), true);
      assert.deepEqual(events, ["start"]);
    });
  });

  describe("readCache", () => {
    const text = JSON.stringify(cacheOf());
    it("reads a cache of this module and repository", () => {
      assert.deepEqual(readCache(text, identity.module, identity.root), cacheOf());
    });
    it("ignores one of another module or repository, one that is damaged, and none", () => {
      assert.equal(readCache(text, "other", identity.root), undefined);
      assert.equal(readCache(text, identity.module, "/elsewhere"), undefined);
      assert.equal(readCache("{", identity.module, identity.root), undefined);
      assert.equal(readCache("null", identity.module, identity.root), undefined);
      assert.equal(
        readCache(JSON.stringify({ ...cacheOf(), format: 2 }), identity.module, identity.root),
        undefined,
      );
      assert.equal(
        readCache(JSON.stringify({ ...cacheOf(), lists: [] }), identity.module, identity.root),
        undefined,
      );
      assert.equal(
        readCache(
          JSON.stringify({ ...cacheOf(), initialize: { protocolVersion: 1 } }),
          identity.module,
          identity.root,
        ),
        undefined,
      );
      assert.equal(readCache(undefined, identity.module, identity.root), undefined);
    });
  });
});
