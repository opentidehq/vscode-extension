// A runtime that answers --version but whose language server dies on start (an opentide whose
// engine module does not load): the engine (WASM) serves the editor features instead.
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";

import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

import { processEnv } from "../../src/core/runtime/env";
import {
  describeFallback,
  fallbackAttempts,
  fallbackStillInEffect,
  type ServerStart,
  startWithFallback,
} from "../../src/core/runtime/fallback";
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
  // The fake runtime: the fake opentide answers --version, and dies on `lsp start`.
  const broken = fakeRuntime({ tier: 2, source: "path" });

  it("the fake broken runtime probes fine, and its lsp start exits", async () => {
    const version = await probe(broken.command, [...broken.args, "--version"], {
      env: {},
      restricted: false,
      binDirs: [],
      timeoutMs: 20_000,
    });
    assert.equal(version.code, 0);
    assert.match(version.stdout, /^opentide \d/);
    const started = await startProcess(broken);
    assert.equal(started.ok, false);
    assert.match(started.error ?? "", /exited with 1: ImportError/);
  });

  it("starts the engine's server instead, and says why", async () => {
    const started: Runtime[] = [];
    const result = await startWithFallback(
      broken,
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
    assert.equal(result.fallback?.from, broken);
    assert.match(result.fallback?.reason ?? "", /ImportError/);
    const attempts = fallbackAttempts(
      result.fallback ?? { from: broken, reason: "" },
      engineRuntime(ENGINE, false),
    );
    assert.deepEqual(
      attempts.map((a) => [a.tier, a.source, a.outcome]),
      [
        [2, "path", "failed"],
        [5, "engine", "ok"],
      ],
    );
    assert.match(attempts[0]?.detail ?? "", /did not start.*ImportError.*engine \(WASM\)/);
  });

  it("says a server that kept crashing stopped, where one that never started did not start", () => {
    const from = fakeRuntime({ tier: 2, source: "path" });
    assert.equal(describeFallback({ from, reason: "ImportError" }), "did not start (ImportError)");
    const crashed = { from, reason: "crashed 5 times in 3 minutes", crashed: true };
    assert.equal(describeFallback(crashed), "stopped repeatedly (crashed 5 times in 3 minutes)");
    const [first] = fallbackAttempts(crashed, engineRuntime(ENGINE, false));
    assert.match(first?.detail ?? "", /stopped repeatedly \(crashed 5 times in 3 minutes\).*engine \(WASM\)/);
  });

  it("keeps a fallback in the attempts after the runtime is looked up again, while it is in effect", () => {
    const from = fakeRuntime({ tier: 4, source: "wasi" });
    const engine = engineRuntime(ENGINE, false);
    const crashed = { from, reason: "crashed 5 times in 3 minutes", crashed: true };
    assert.deepEqual(fallbackStillInEffect(crashed, engine), fallbackAttempts(crashed, engine));
    assert.deepEqual(
      fallbackStillInEffect(undefined, engine),
      [],
      "no fallback: the server is the runtime's own",
    );
    assert.deepEqual(
      fallbackStillInEffect(crashed, undefined),
      [],
      "no server runs: nothing serves in its place",
    );
  });

  it("keeps Restricted Mode, and says nothing when the runtime's own server starts", async () => {
    const restricted = { ...broken, restricted: true };
    const result = await startWithFallback(
      restricted,
      async (runtime) => ({ ok: runtime.kind === "engine" }),
      (isRestricted) => engineRuntime(ENGINE, isRestricted),
    );
    assert.equal(result.server?.restricted, true);
    const fine = await startWithFallback(
      broken,
      async () => ({ ok: true }),
      () => undefined,
    );
    assert.deepEqual(fine, { server: broken });
  });

  it("has nothing to fall back to without an engine, or from the engine itself", async () => {
    const none = await startWithFallback(
      broken,
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
