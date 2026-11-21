import * as assert from "node:assert/strict";
import { filterModuleLine, isBridgeMethod } from "../../../src/core/wasi/mcpBridge";
import type { FetchHandler } from "../../../src/core/wasi/wire";

function handler(taken: unknown[]): FetchHandler {
  return {
    handle: (message) => {
      const method = (message as { method?: string }).method;
      if (method !== "opentide/fetch" && method !== "$/cancelRequest") return false;
      taken.push(message);
      return true;
    },
    dispose: () => undefined,
  };
}

describe("the MCP bridge's filter (src/core/wasi/mcpBridge.ts)", () => {
  it("passes an MCP message untouched, byte for byte", () => {
    const line = '{"jsonrpc":"2.0","id":1,"result":{"tools":[ ]}}';
    assert.deepEqual(filterModuleLine(line, handler([])), { upstream: line });
    const notification = '{"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}';
    assert.deepEqual(filterModuleLine(notification, handler([])), { upstream: notification });
  });

  it("hands the private link to FetchHost and never forwards it", () => {
    const taken: unknown[] = [];
    const fetch = '{"jsonrpc":"2.0","id":"h1","method":"opentide/fetch","params":{"url":"https://t"}}';
    assert.deepEqual(filterModuleLine(fetch, handler(taken)), {});
    const cancel = '{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":"h1"}}';
    assert.deepEqual(filterModuleLine(cancel, handler(taken)), {});
    assert.equal(taken.length, 2);
  });

  it("drops a private-link message nothing answers, and anything that is no JSON-RPC message, saying why", () => {
    const unanswered = filterModuleLine('{"jsonrpc":"2.0","method":"opentide/log"}', handler([]));
    assert.equal(unanswered.upstream, undefined);
    assert.match(unanswered.dropped ?? "", /opentide\/log with nothing to answer it/);
    assert.equal(
      filterModuleLine('{"jsonrpc":"2.0","method":"opentide/fetch"}', undefined).upstream,
      undefined,
    );
    for (const line of ["a log line", "[1,2]", "42", "null"]) {
      const result = filterModuleLine(line, handler([]));
      assert.equal(result.upstream, undefined, line);
      assert.ok(result.dropped, line);
    }
    assert.deepEqual(filterModuleLine("   ", handler([])), {});
  });

  it("names the private link's methods", () => {
    assert.equal(isBridgeMethod("opentide/fetch"), true);
    assert.equal(isBridgeMethod("opentide/anything"), true);
    assert.equal(isBridgeMethod("$/cancelRequest"), true);
    assert.equal(isBridgeMethod("tools/call"), false);
    assert.equal(isBridgeMethod(undefined), false);
  });
});
