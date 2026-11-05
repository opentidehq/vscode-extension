// A runtime that answers --version but whose language server dies on start (a bundled runtime whose
// engine module does not load): the engine (WASM) serves the editor features instead.
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { processEnv } from "../../src/core/runtime/env";
import { fallbackAttempts, type ServerStart, startWithFallback } from "../../src/core/runtime/fallback";
import { probe } from "../../src/core/runtime/process";
import { engineRuntime } from "../../src/core/runtime/resolve";
import { languageServerCommand, type Runtime } from "../../src/core/runtime/types";
import { fakeRuntime } from "./helpers";

/** What the language client does with a process runtime: spawn its server and ask `initialize`. */
function startProcess(runtime: Runtime): Promise<ServerStart> {
  const { command, args } = languageServerCommand(runtime);
  const child = cp.spawn(command, args, {
    env: processEnv(process.env, runtime, process.platform),
    stdio: "pipe",
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );
  connection.listen();
  return new Promise<ServerStart>((resolve) => {
    child.on("exit", (code) => resolve({ ok: false, error: `exited with ${code}: ${stderr.trim()}` }));
    connection.sendRequest("initialize", { processId: null, rootUri: null, capabilities: {} }).then(
      () => resolve({ ok: true }),
      (error: unknown) => resolve({ ok: false, error: String(error) }),
    );
  }).finally(() => {
    connection.dispose();
    child.kill();
  });
}

const ENGINE = { module: "/ext/dist/engine/opentide_wasm_bg.wasm", version: "0.10.0" };

describe("a language server that does not start falls back to the engine (WASM)", () => {
  // The fake bundled runtime: the fake opentide answers --version, and dies on `lsp start`.
  const bundled = fakeRuntime({ tier: 4, source: "bundled" });

  it("the fake bundled runtime probes fine, and its lsp start exits", async () => {
    const version = await probe(bundled.command, [...bundled.args, "--version"], {
      env: {},
      restricted: false,
      binDirs: [],
      timeoutMs: 20_000,
    });
    assert.equal(version.code, 0);
    assert.match(version.stdout, /^opentide \d/);
    const started = await startProcess(bundled);
    assert.equal(started.ok, false);
    assert.match(started.error ?? "", /exited with 1: ImportError/);
  });

  it("starts the engine's server instead, and says why", async () => {
    const started: Runtime[] = [];
    const result = await startWithFallback(
      bundled,
      (runtime) => {
        started.push(runtime);
        return runtime.kind === "engine" ? Promise.resolve({ ok: true }) : startProcess(runtime);
      },
      (restricted) => engineRuntime(ENGINE, restricted),
    );
    assert.deepEqual(
      started.map((r) => r.kind),
      ["opentide", "engine"],
    );
    assert.equal(result.server?.kind, "engine");
    assert.equal(result.fallback?.from, bundled);
    assert.match(result.fallback?.reason ?? "", /ImportError/);
    const attempts = fallbackAttempts(
      result.fallback ?? { from: bundled, reason: "" },
      engineRuntime(ENGINE, false),
    );
    assert.deepEqual(
      attempts.map((a) => [a.tier, a.source, a.outcome]),
      [
        [4, "bundled", "failed"],
        [5, "engine", "ok"],
      ],
    );
    assert.match(attempts[0]?.detail ?? "", /did not start.*ImportError.*engine \(WASM\)/);
  });

  it("keeps Restricted Mode, and says nothing when the runtime's own server starts", async () => {
    const restricted = { ...bundled, restricted: true };
    const result = await startWithFallback(
      restricted,
      async (runtime) => ({ ok: runtime.kind === "engine" }),
      (isRestricted) => engineRuntime(ENGINE, isRestricted),
    );
    assert.equal(result.server?.restricted, true);
    const fine = await startWithFallback(
      bundled,
      async () => ({ ok: true }),
      () => undefined,
    );
    assert.deepEqual(fine, { server: bundled });
  });

  it("has nothing to fall back to without an engine, or from the engine itself", async () => {
    const none = await startWithFallback(
      bundled,
      async () => ({ ok: false, error: "boom" }),
      () => undefined,
    );
    assert.equal(none.server, undefined);
    assert.equal(none.fallback?.reason, "boom");
    const engine = engineRuntime(ENGINE, false);
    const calls: string[] = [];
    const failed = await startWithFallback(
      engine,
      async (runtime) => {
        calls.push(runtime.kind);
        return { ok: false };
      },
      () => engine,
    );
    assert.deepEqual(failed, { server: undefined });
    assert.deepEqual(calls, ["engine"]);
  });
});
