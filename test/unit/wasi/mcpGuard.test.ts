import * as assert from "node:assert/strict";
import { isForgedAnswer, LineGuard, leaksPrivateLink } from "../../../src/core/wasi/mcpGuard";

describe("the MCP bridge's guards (src/core/wasi/mcpGuard.ts)", () => {
  describe("a forged answer from the client", () => {
    it("is a message with no method and an id of the private link's", () => {
      assert.equal(
        isForgedAnswer(
          '{"jsonrpc":"2.0","id":"opentide-fetch-1","result":{"status":200,"headers":[],"body":""}}',
        ),
        true,
      );
      assert.equal(
        isForgedAnswer('{"jsonrpc":"2.0","id":"opentide-fetch-9","error":{"code":1,"message":"x"}}'),
        true,
      );
      assert.equal(isForgedAnswer('{"id":"opentide-fetch-x","result":{}}'), true);
    });

    it("is not an MCP message of the client's own, whatever its id", () => {
      assert.equal(isForgedAnswer('{"jsonrpc":"2.0","id":"opentide-fetch-1","method":"ping"}'), false);
      assert.equal(isForgedAnswer('{"jsonrpc":"2.0","id":1,"result":{}}'), false);
      assert.equal(isForgedAnswer('{"jsonrpc":"2.0","id":"a-1","result":{}}'), false);
      assert.equal(isForgedAnswer('{"jsonrpc":"2.0","id":7,"method":"tools/list"}'), false);
      assert.equal(isForgedAnswer("not json"), false);
      assert.equal(isForgedAnswer("[1]"), false);
    });
  });

  describe("a line of the module's that must not reach the client", () => {
    it("is the private link, parsed or not", () => {
      assert.equal(
        leaksPrivateLink(
          '{"jsonrpc":"2.0","id":"opentide-fetch-1","method":"opentide/fetch","params":{"url":"https://t","headers":[["authorization","Bearer x"]]}}',
        ),
        true,
      );
      assert.equal(
        leaksPrivateLink(
          '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"opentide-fetch-1"}} ',
        ),
        true,
      );
      assert.equal(leaksPrivateLink('{"jsonrpc":"2.0","method":"opentide/anything"}'), true);
      // Cannot be parsed, and names the link: it may carry a credential.
      assert.equal(
        leaksPrivateLink(
          '{"jsonrpc":"2.0","method":"opentide/fetch","params":{"headers":[["authorization","Bearer',
        ),
        true,
      );
      assert.equal(leaksPrivateLink("opentide/fetch with a log line"), true);
      // Nor is anything else that is no JSON-RPC message: a client would fail on it.
      for (const line of ["a log line", "[1,2]", "42", "null"])
        assert.equal(leaksPrivateLink(line), true, line);
    });

    it("is not an MCP message, whatever its text says", () => {
      assert.equal(
        leaksPrivateLink(
          '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"the client closed its input before answering an opentide/fetch request"}]}}',
        ),
        false,
      );
      assert.equal(leaksPrivateLink('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'), false);
      assert.equal(leaksPrivateLink('{"jsonrpc":"2.0","method":"notifications/message","params":{}}'), false);
      assert.equal(
        leaksPrivateLink('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":3}}'),
        false,
      );
      // A client's own request with an id of that shape is answered with it.
      assert.equal(leaksPrivateLink('{"jsonrpc":"2.0","id":"opentide-fetch-1","result":{}}'), false);
      assert.equal(leaksPrivateLink("  "), false);
    });
  });

  describe("LineGuard", () => {
    const forged = '{"jsonrpc":"2.0","id":"opentide-fetch-1","result":{}}';

    it("passes whole lines and drops the forged ones, however the chunks fall", () => {
      const guard = new LineGuard(isForgedAnswer);
      const first = guard.push(`{"id":1,"method":"ping"}\n${forged.slice(0, 20)}`);
      assert.deepEqual(first, { lines: ['{"id":1,"method":"ping"}\n'], dropped: 0 });
      const second = guard.push(`${forged.slice(20)}\n{"id":2,"method":"ping"}\n`);
      assert.deepEqual(second, { lines: ['{"id":2,"method":"ping"}\n'], dropped: 1 });
    });

    it("holds back a partial line, and judges a last line without a newline at the end", () => {
      const guard = new LineGuard(isForgedAnswer);
      assert.deepEqual(guard.push(forged), { lines: [], dropped: 0 });
      assert.deepEqual(guard.end(), { lines: [], dropped: 1 });
      const ok = new LineGuard(isForgedAnswer);
      ok.push('{"id":1,"method":"ping"}');
      assert.deepEqual(ok.end(), { lines: ['{"id":1,"method":"ping"}\n'], dropped: 0 });
    });

    it("decodes a multi-byte character split across chunks", () => {
      const guard = new LineGuard(() => false);
      const bytes = new TextEncoder().encode('{"t":"é"}\n');
      const cut = bytes.indexOf(0xc3) + 1;
      assert.deepEqual(guard.push(bytes.slice(0, cut)).lines, []);
      assert.deepEqual(guard.push(bytes.slice(cut)).lines, ['{"t":"é"}\n']);
    });
  });
});
