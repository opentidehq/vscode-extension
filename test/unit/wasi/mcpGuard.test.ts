import * as assert from "node:assert/strict";
import {
  describeDroppedLine,
  isForgedAnswer,
  LineGuard,
  leaksPrivateLink,
} from "../../../src/core/wasi/mcpGuard";

const PREFIX = "opentide-fetch-";

describe("the MCP bridge's guards (src/core/wasi/mcpGuard.ts)", () => {
  describe("a forged answer from the client", () => {
    it("is a message with no method and an id of the private link's", () => {
      assert.equal(
        isForgedAnswer(
          '{"jsonrpc":"2.0","id":"opentide-fetch-1","result":{"status":200,"headers":[],"body":""}}',
          PREFIX,
        ),
        true,
      );
      assert.equal(
        isForgedAnswer('{"jsonrpc":"2.0","id":"opentide-fetch-9","error":{"code":1,"message":"x"}}', PREFIX),
        true,
      );
      assert.equal(isForgedAnswer('{"id":"opentide-fetch-x","result":{}}', PREFIX), true);
    });

    it("is not an MCP message of the client's own, whatever its id", () => {
      assert.equal(
        isForgedAnswer('{"jsonrpc":"2.0","id":"opentide-fetch-1","method":"ping"}', PREFIX),
        false,
      );
      assert.equal(isForgedAnswer('{"jsonrpc":"2.0","id":1,"result":{}}', PREFIX), false);
      assert.equal(isForgedAnswer('{"jsonrpc":"2.0","id":"a-1","result":{}}', PREFIX), false);
      assert.equal(isForgedAnswer('{"jsonrpc":"2.0","id":7,"method":"tools/list"}', PREFIX), false);
      assert.equal(isForgedAnswer("not json", PREFIX), false);
      assert.equal(isForgedAnswer("[1]", PREFIX), false);
    });
  });

  describe("a line of the module's that must not reach the client", () => {
    it("is the private link, parsed or not", () => {
      assert.equal(
        leaksPrivateLink(
          '{"jsonrpc":"2.0","id":"opentide-fetch-1","method":"opentide/fetch","params":{"url":"https://t","headers":[["authorization","Bearer x"]]}}',
          PREFIX,
        ),
        true,
      );
      assert.equal(
        leaksPrivateLink(
          '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"opentide-fetch-1"}} ',
          PREFIX,
        ),
        true,
      );
      assert.equal(leaksPrivateLink('{"jsonrpc":"2.0","method":"opentide/anything"}', PREFIX), true);
      // Cannot be parsed, and names the link: it may carry a credential.
      assert.equal(
        leaksPrivateLink(
          '{"jsonrpc":"2.0","method":"opentide/fetch","params":{"headers":[["authorization","Bearer',
          PREFIX,
        ),
        true,
      );
      assert.equal(leaksPrivateLink("opentide/fetch with a log line", PREFIX), true);
      // Nor is anything else that is no JSON-RPC message: a client would fail on it.
      for (const line of ["a log line", "[1,2]", "42", "null"])
        assert.equal(leaksPrivateLink(line, PREFIX), true, line);
    });

    it("is not an MCP message, whatever its text says", () => {
      assert.equal(
        leaksPrivateLink(
          '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"the client closed its input before answering an opentide/fetch request"}]}}',
          PREFIX,
        ),
        false,
      );
      assert.equal(leaksPrivateLink('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}', PREFIX), false);
      assert.equal(
        leaksPrivateLink('{"jsonrpc":"2.0","method":"notifications/message","params":{}}', PREFIX),
        false,
      );
      assert.equal(
        leaksPrivateLink(
          '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":3}}',
          PREFIX,
        ),
        false,
      );
      // A client's own request with an id of that shape is answered with it.
      assert.equal(leaksPrivateLink('{"jsonrpc":"2.0","id":"opentide-fetch-1","result":{}}', PREFIX), false);
      assert.equal(leaksPrivateLink("  ", PREFIX), false);
    });
  });

  describe("with ids that carry a nonce", () => {
    it("holds for `opentide-fetch-<nonce>-1` as for `opentide-fetch-1`", () => {
      const forged =
        '{"jsonrpc":"2.0","id":"opentide-fetch-9f3a1c7e5b2d4086-1","result":{"status":200,"headers":[],"body":""}}';
      assert.equal(isForgedAnswer(forged, PREFIX), true);
      assert.equal(
        isForgedAnswer('{"jsonrpc":"2.0","id":"opentide-fetch-9f3a1c7e5b2d4086-1","method":"ping"}', PREFIX),
        false,
      );
      assert.equal(
        leaksPrivateLink(
          '{"jsonrpc":"2.0","id":"opentide-fetch-9f3a1c7e5b2d4086-1","method":"opentide/fetch","params":{}}',
          PREFIX,
        ),
        true,
      );
      assert.equal(
        leaksPrivateLink(
          '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"opentide-fetch-9f3a1c7e5b2d4086-1"}}',
          PREFIX,
        ),
        true,
      );
    });
  });

  it("uses the prefix @opentide/wasi-host names, so a change to its id format is caught here", async () => {
    const { MCP_FETCH_ID_PREFIX } = await import("@opentide/wasi-host");
    assert.equal(MCP_FETCH_ID_PREFIX, PREFIX);
  });

  describe("LineGuard", () => {
    const forged = '{"jsonrpc":"2.0","id":"opentide-fetch-1","result":{}}';

    it("passes whole lines and drops the forged ones, however the chunks fall", () => {
      const guard = new LineGuard((line) => isForgedAnswer(line, PREFIX));
      const first = guard.push(`{"id":1,"method":"ping"}\n${forged.slice(0, 20)}`);
      assert.deepEqual(first, { lines: ['{"id":1,"method":"ping"}\n'], dropped: 0 });
      const second = guard.push(`${forged.slice(20)}\n{"id":2,"method":"ping"}\n`);
      assert.deepEqual(second, { lines: ['{"id":2,"method":"ping"}\n'], dropped: 1 });
    });

    it("holds back a partial line, and judges a last line without a newline at the end", () => {
      const guard = new LineGuard((line) => isForgedAnswer(line, PREFIX));
      assert.deepEqual(guard.push(forged), { lines: [], dropped: 0 });
      assert.deepEqual(guard.end(), { lines: [], dropped: 1 });
      const ok = new LineGuard((line) => isForgedAnswer(line, PREFIX));
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

  describe("JSON escapes do not get past either guard: the decision is on the parsed value", () => {
    // `opentide-fetch-` with its hyphens, and `opentide/fetch` with its slash, written as \u escapes; "result" and
    // "method" too.
    const ID = "opentide\\u002dfetch\\u002d9f3a1c7e-1";
    const METHOD = "opentide\\u002ffetch";

    it("a forged answer with an escaped id is still forged", () => {
      assert.equal(isForgedAnswer(`{"jsonrpc":"2.0","id":"${ID}","result":{"status":200}}`, PREFIX), true);
      assert.equal(
        isForgedAnswer(`{"jsonrpc":"2.0","id":"opentide-fetch\\u002d1","result":{}}`, PREFIX),
        true,
      );
      assert.equal(
        isForgedAnswer(`{"jsonrpc":"2.0","id":"\\u006fpentide-fetch-1","result":{}}`, PREFIX),
        true,
      );
      assert.equal(
        isForgedAnswer(`{"jsonrpc":"2.0","\\u0069d":"opentide-fetch-1","\\u0072esult":{}}`, PREFIX),
        true,
      );
      assert.equal(isForgedAnswer(`{"id":"${ID}","error":{"code":1,"message":"x"}}`, PREFIX), true);
    });

    it("an escaped method is still a method: the client's own request keeps passing, and a null or numeric one is not one", () => {
      assert.equal(isForgedAnswer(`{"id":"${ID}","meth\\u006fd":"ping"}`, PREFIX), false);
      assert.equal(isForgedAnswer(`{"id":"${ID}","method":null,"result":{}}`, PREFIX), true);
      assert.equal(isForgedAnswer(`{"id":"${ID}","method":7,"result":{}}`, PREFIX), true);
      // An escaped id that is not the private link's is not forged.
      assert.equal(isForgedAnswer('{"id":"a\\u002db","result":{}}', PREFIX), false);
    });

    it("a forged answer inside a batch is forged", () => {
      assert.equal(
        isForgedAnswer(`[{"jsonrpc":"2.0","id":1,"method":"ping"},{"id":"${ID}","result":{}}]`, PREFIX),
        true,
      );
      assert.equal(isForgedAnswer('[{"id":1,"method":"ping"},{"id":2,"result":{}}]', PREFIX), false);
    });

    it("the module's private link with an escaped method is still the private link", () => {
      assert.equal(
        leaksPrivateLink(`{"jsonrpc":"2.0","id":"${ID}","method":"${METHOD}","params":{}}`, PREFIX),
        true,
      );
      assert.equal(leaksPrivateLink(`{"jsonrpc":"2.0","id":"x","meth\\u006fd":"${METHOD}"}`, PREFIX), true);
      assert.equal(
        leaksPrivateLink('{"jsonrpc":"2.0","id":"x","method":"opentide\\u002fwhatever"}', PREFIX),
        true,
      );
    });

    it("a withdrawal of a private-link request with an escaped requestId, or an escaped method, is still the private link", () => {
      assert.equal(
        leaksPrivateLink(
          `{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"${ID}"}}`,
          PREFIX,
        ),
        true,
      );
      assert.equal(
        leaksPrivateLink(
          `{"jsonrpc":"2.0","method":"notifications\\u002fcancelled","params":{"reques\\u0074Id":"${ID}"}}`,
          PREFIX,
        ),
        true,
      );
      // The client's own cancellation of its own request still passes.
      assert.equal(
        leaksPrivateLink(
          '{"jsonrpc":"2.0","method":"notifications\\u002fcancelled","params":{"requestId":7}}',
          PREFIX,
        ),
        false,
      );
    });

    it("a result whose text only mentions the link, escaped or not, is an ordinary message", () => {
      assert.equal(
        leaksPrivateLink(
          '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"opentide\\u002ffetch"}]}}',
          PREFIX,
        ),
        false,
      );
    });

    it("through LineGuard: an escaped forged answer is dropped and an escaped leak never reaches the client", () => {
      const fromEditor = new LineGuard((line) => isForgedAnswer(line, PREFIX));
      const a = fromEditor.push(`{"id":"${ID}","result":{}}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n`);
      assert.equal(a.dropped, 1);
      assert.equal(a.lines.length, 1);
      const fromModule = new LineGuard((line) => leaksPrivateLink(line, PREFIX));
      const b = fromModule.push(
        `{"id":"${ID}","method":"${METHOD}","params":{}}\n{"jsonrpc":"2.0","id":1,"result":{}}\n`,
      );
      assert.equal(b.dropped, 1);
      assert.equal(b.lines.length, 1);
    });
  });

  describe("what the bridge says about a line it dropped", () => {
    it("names the kind of error and its code, never the message or the line", () => {
      const secret = "Bearer hunter2";
      const parse = new SyntaxError(`Unexpected token in {"authorization":"${secret}"`);
      assert.equal(describeDroppedLine(parse), "dropped a line it could not handle (SyntaxError)");
      const pipe = Object.assign(new Error(`write EPIPE ${secret}`), { code: "EPIPE" });
      assert.equal(describeDroppedLine(pipe), "dropped a line it could not handle (Error, EPIPE)");
      assert.equal(
        describeDroppedLine(new RangeError("Maximum call stack size exceeded")),
        "dropped a line it could not handle (RangeError)",
      );
      assert.equal(
        describeDroppedLine(`a thrown string ${secret}`),
        "dropped a line it could not handle (string)",
      );
      assert.equal(describeDroppedLine(null), "dropped a line it could not handle (object)");
      for (const error of [parse, pipe])
        assert.doesNotMatch(describeDroppedLine(error), /hunter2|Bearer|authorization/);
    });
  });
});
