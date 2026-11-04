import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { isShutDown, ServeClient } from "../../src/core/backend/serve";
import { BackendError, type ProgressEvent } from "../../src/core/backend/types";
import { CancellationTokenSource } from "../../src/core/util/cancellation";
import { FAKE_OPENTIDE, sleep } from "./helpers";

function client(env: Record<string, string> = {}): ServeClient {
  return new ServeClient({
    start: () =>
      cp.spawn(process.execPath, [FAKE_OPENTIDE, "serve"], {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      }),
  });
}

describe("opentide serve client (against a fake server implementing CONTRACTS.md)", () => {
  let serve: ServeClient | undefined;
  afterEach(async () => {
    await serve?.stop();
    serve = undefined;
  });

  it("initializes, then runs argv with cwd and env, returning the document and exit code", async () => {
    serve = client({ FAKE_VERSION: "0.21.0" });
    const init = await serve.start();
    assert.deepEqual(init, { protocol: 1, version: "0.21.0", commands_digest: "fake-digest" });
    const result = await serve.run({
      argv: ["echo", "--file", "a.yaml"],
      cwd: "/repo",
      env: { OPENTIDE_REPO_ROOT: "/repo" },
    });
    assert.equal(result.exit_code, 0);
    assert.deepEqual(result.document.argv, ["echo", "--file", "a.yaml"]);
    assert.equal(result.document.cwd, "/repo");
    assert.equal((result.document.env as Record<string, string>).OPENTIDE_REPO_ROOT, "/repo");
  });

  it("treats a command failure as a result, not a JSON-RPC error", async () => {
    serve = client();
    const result = await serve.run({ argv: ["fail"] });
    assert.equal(result.exit_code, 1);
    assert.equal(result.document.failure?.code, "workspace_not_found");
  });

  it("rejects a protocol error (run without argv) with a protocol BackendError", async () => {
    serve = client();
    await assert.rejects(
      serve.run({} as never),
      (e: unknown) => e instanceof BackendError && e.code === "protocol",
    );
  });

  it("delivers progress notifications to the request they belong to", async () => {
    serve = client();
    const events: ProgressEvent[] = [];
    await serve.run({ argv: ["progress"] }, { onProgress: (e) => events.push(e) });
    assert.deepEqual(
      events.map((e) => e.event),
      ["progress", "tenant"],
    );
  });

  it("cancels with $/cancelRequest: the run answers with exit 130", async () => {
    serve = client();
    const source = new CancellationTokenSource();
    const pending = serve.run({ argv: ["slow", "10000"] }, { token: source.token });
    await sleep(200);
    source.cancel();
    const result = await pending;
    assert.equal(result.exit_code, 130);
  });

  it("forwards invalidate before the next run is handled", async () => {
    serve = client();
    await serve.start();
    serve.invalidate(["/repo/objects/rules/a.yaml"]);
    const result = await serve.run({ argv: ["invalidated"] });
    assert.deepEqual(result.document.paths, ["/repo/objects/rules/a.yaml"]);
  });

  it("handles requests one at a time, in order", async () => {
    serve = client();
    const slow = serve.run({ argv: ["slow", "300"] });
    const quick = serve.run({ argv: ["echo"] });
    const order: string[] = [];
    await Promise.all([slow.then(() => order.push("slow")), quick.then(() => order.push("quick"))]);
    assert.deepEqual(order, ["slow", "quick"]);
  });

  it("rejects a request a shutting-down server refused with `shut-down`, not `protocol`", async () => {
    const marker = path.join(mkdtempSync(path.join(tmpdir(), "otide-")), "shut-down");
    serve = client({ FAKE_SHUTDOWN_FILE: marker });
    await serve.start();
    await assert.rejects(
      serve.run({ argv: ["shut-down-once"], cwd: process.cwd(), env: {} }),
      (e: unknown) => e instanceof BackendError && e.code === "shut-down",
    );
  });

  it("recognises only opentide serve's shut-down answer as a refusal", () => {
    assert.equal(isShutDown({ code: -32600, message: "The server is shut down; send exit" }), true);
    assert.equal(isShutDown({ code: -32600, message: "Invalid Request" }), false);
    assert.equal(isShutDown({ code: -32602, message: "The server is shut down" }), false);
  });

  it("rejects pending requests with `crashed` when the process dies", async () => {
    serve = client();
    await assert.rejects(
      serve.run({ argv: ["crash"] }),
      (e: unknown) => e instanceof BackendError && e.code === "crashed",
    );
    assert.equal(serve.isRunning, false);
  });

  it("shuts down with shutdown and exit", async () => {
    serve = client();
    await serve.start();
    let expected = false;
    serve.onDidExit((e) => {
      expected = e.expected;
    });
    await serve.stop();
    assert.equal(serve.isRunning, false);
    assert.equal(expected, true);
  });
});
