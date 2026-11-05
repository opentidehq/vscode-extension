import * as assert from "node:assert/strict";
import {
  type EngineModule,
  type HostPort,
  logMessage,
  requestId,
  serveEngine,
} from "../../../src/engine/host";
import { WEB_DOCUMENT_SELECTOR } from "../../../src/engine/languages";
import { engineInit, moduleUrlOf, takesWorkspaceUpdates } from "../../../src/engine/protocol";

/** A port the test drives: `send` is the client posting, `posted` what the worker posted back. */
function fakePort() {
  let listener: ((data: unknown) => void) | undefined;
  const posted: unknown[] = [];
  let closed = false;
  const port: HostPort = {
    postMessage: (message) => posted.push(JSON.parse(message)),
    onMessage: (l) => {
      listener = l;
    },
    close: () => {
      closed = true;
    },
  };
  return {
    port,
    posted,
    send: (message: unknown) => listener?.(JSON.stringify(message)),
    get closed() {
      return closed;
    },
  };
}

/** An engine that echoes each message's method back as a response, and closes on `exit`. */
function echoEngine(onHandle: (text: string) => void = () => undefined): EngineModule {
  return {
    version: () => "9.9.9",
    createSession: () => {
      let closed = false;
      return {
        get closed() {
          return closed;
        },
        handle: (text) => {
          onHandle(text);
          const message = JSON.parse(text) as { id?: number; method: string };
          if (message.method === "exit") closed = true;
          if (message.method === "trap") throw new Error("RuntimeError: unreachable");
          return message.id === undefined
            ? []
            : [JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.method })];
        },
      };
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("engine host (src/engine/host.ts)", () => {
  it("handles messages that arrive while the module loads, in order, once it has", async () => {
    const fake = fakePort();
    let resolveLoad: (module: EngineModule) => void = () => undefined;
    const handled: string[] = [];
    void serveEngine(fake.port, () => new Promise<EngineModule>((resolve) => (resolveLoad = resolve)));
    fake.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    fake.send({ jsonrpc: "2.0", method: "initialized" });
    await flush();
    assert.deepEqual(fake.posted, []);
    resolveLoad(echoEngine((text) => handled.push(JSON.parse(text).method)));
    await flush();
    assert.deepEqual(handled, ["initialize", "initialized"]);
    const loaded = fake.posted[0] as unknown as { params: { message: string } };
    assert.match(loaded.params.message, /9\.9\.9 loaded in \d+ ms/);
    assert.deepEqual(fake.posted[1], { jsonrpc: "2.0", id: 1, result: "initialize" });
  });

  it("answers every request with the reason when the module does not load", async () => {
    const fake = fakePort();
    void serveEngine(fake.port, () => {
      throw new Error("no such file");
    });
    fake.send({ jsonrpc: "2.0", id: 7, method: "initialize" });
    fake.send({ jsonrpc: "2.0", method: "initialized" });
    await flush();
    assert.equal((fake.posted[0] as { method: string }).method, "window/logMessage");
    assert.deepEqual(fake.posted[1], {
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32603, message: "the opentide engine did not load: no such file" },
    });
    assert.equal(fake.posted.length, 2, "a notification gets no answer");
  });

  it("fails the request and every later one when the module traps", async () => {
    const fake = fakePort();
    void serveEngine(fake.port, () => echoEngine());
    fake.send({ jsonrpc: "2.0", id: 1, method: "trap" });
    fake.send({ jsonrpc: "2.0", id: 2, method: "hover" });
    await flush();
    const errors = fake.posted.filter((m) => (m as { error?: unknown }).error) as {
      id: number;
      error: { message: string };
    }[];
    assert.deepEqual(
      errors.map((e) => e.id),
      [1, 2],
    );
    assert.match(errors[0]?.error.message ?? "", /stopped: RuntimeError: unreachable/);
  });

  it("closes the port and resolves after exit", async () => {
    const fake = fakePort();
    const done = serveEngine(fake.port, () => echoEngine());
    fake.send({ jsonrpc: "2.0", id: 1, method: "shutdown" });
    fake.send({ jsonrpc: "2.0", method: "exit" });
    await done;
    assert.equal(fake.closed, true);
  });

  it("reads request ids and writes log messages", () => {
    assert.equal(requestId('{"jsonrpc":"2.0","id":3,"method":"x"}'), 3);
    assert.equal(requestId('{"jsonrpc":"2.0","id":"a","method":"x"}'), "a");
    assert.equal(requestId('{"jsonrpc":"2.0","method":"x"}'), undefined);
    assert.equal(requestId('{"jsonrpc":"2.0","id":3,"result":null}'), undefined);
    assert.equal(requestId("not json"), undefined);
    assert.deepEqual(JSON.parse(logMessage(1, "boom")), {
      jsonrpc: "2.0",
      method: "window/logMessage",
      params: { type: 1, message: "boom" },
    });
  });
});

describe("the browser worker's first message (src/engine/protocol.ts)", () => {
  it("names the module, and nothing else is taken for it", () => {
    assert.equal(
      moduleUrlOf(engineInit("https://cdn/x/opentide_wasm_bg.wasm")),
      "https://cdn/x/opentide_wasm_bg.wasm",
    );
    assert.equal(moduleUrlOf('{"jsonrpc":"2.0","id":1,"method":"initialize"}'), undefined);
    assert.equal(moduleUrlOf({ opentideEngine: {} }), undefined);
    assert.equal(moduleUrlOf(null), undefined);
  });

  it("tells a server that takes workspace updates", () => {
    assert.equal(takesWorkspaceUpdates({ opentide: { workspaceUpdates: true } }), true);
    assert.equal(takesWorkspaceUpdates({ opentide: { engine: "0.10.0" } }), false);
    assert.equal(takesWorkspaceUpdates(undefined), false);
  });

  it("selects every language on any scheme on the web", () => {
    assert.ok(
      WEB_DOCUMENT_SELECTOR.some((filter) => "language" in filter && filter.language === "opentide-yaml"),
    );
    assert.ok(WEB_DOCUMENT_SELECTOR.some((filter) => "pattern" in filter && filter.pattern === "**/*.kql"));
    assert.equal(
      WEB_DOCUMENT_SELECTOR.some((filter) => "scheme" in filter),
      false,
    );
  });
});
