import * as assert from "node:assert/strict";
import type { Message } from "vscode-jsonrpc";
import { engineTransports, parseMessage } from "../../../src/engine/transport";
import { fakeEnginePort } from "./fakes";

describe("engine transport (src/engine/transport.ts)", () => {
  it("writes one JSON text per message", async () => {
    const fake = fakeEnginePort();
    const { writer } = engineTransports(fake.port);
    await writer.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} } as Message);
    assert.deepEqual(
      fake.posted.map((text) => JSON.parse(text)),
      [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }],
    );
  });

  it("reads JSON text and objects, keeping what arrives before listen", () => {
    const fake = fakeEnginePort();
    const { reader } = engineTransports(fake.port);
    fake.message('{"jsonrpc":"2.0","method":"window/logMessage","params":{"type":3,"message":"loaded"}}');
    const got: Message[] = [];
    reader.listen((message) => got.push(message));
    fake.message({ jsonrpc: "2.0", id: 1, result: null });
    assert.deepEqual(got, [
      { jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message: "loaded" } },
      { jsonrpc: "2.0", id: 1, result: null },
    ]);
  });

  it("reports a message that is not JSON-RPC, a worker error and the worker's exit", async () => {
    const fake = fakeEnginePort();
    const { reader, writer } = engineTransports(fake.port);
    const errors: string[] = [];
    let readerClosed = 0;
    let writerClosed = 0;
    reader.onError((e) => errors.push(e.message));
    reader.onClose(() => {
      readerClosed += 1;
    });
    writer.onClose(() => {
      writerClosed += 1;
    });
    reader.listen(() => undefined);
    fake.message("{oops");
    fake.message('{"id":1}');
    fake.error(new Error("worker crashed"));
    fake.exit();
    assert.equal(errors.length, 3);
    assert.match(errors[1] ?? "", /not a JSON-RPC message/);
    assert.equal(errors[2], "worker crashed");
    assert.equal(readerClosed, 1);
    assert.equal(writerClosed, 1);
    await assert.rejects(writer.write({ jsonrpc: "2.0" } as Message), /exited/);
  });

  it("lets go of the port when disposed", () => {
    const fake = fakeEnginePort();
    const { reader, writer } = engineTransports(fake.port);
    reader.dispose();
    writer.dispose();
    assert.equal(fake.listeners.message.size + fake.listeners.error.size + fake.listeners.exit.size, 0);
  });

  it("parses messages", () => {
    assert.deepEqual(parseMessage('{"jsonrpc":"2.0","id":1,"result":1}'), {
      jsonrpc: "2.0",
      id: 1,
      result: 1,
    });
    assert.throws(() => parseMessage("[]"), /not a JSON-RPC message/);
    assert.throws(() => parseMessage(null), /not a JSON-RPC message/);
  });
});
