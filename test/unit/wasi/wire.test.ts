import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import { fromChildProcess, type ServeProcess } from "../../../src/core/backend/process";
import { ServeClient } from "../../../src/core/backend/serve";
import { BackendError } from "../../../src/core/backend/types";
import { GuestPaths } from "../../../src/core/wasi/paths";
import { type FetchHandler, wasiServeWire } from "../../../src/core/wasi/wire";
import { FAKE_OPENTIDE, until } from "../helpers";

const PATHS = new GuestPaths(
  [
    {
      host: "/home/me/detections",
      hostUri: "file:///home/me/detections",
      guest: "/workspace",
      guestUri: "file:///workspace",
    },
  ],
  "linux",
);

/** The fake `opentide serve` as a `ServeProcess`, with the lines the wire wrote to it recorded. */
function fake(wrote: string[]): ServeProcess {
  const child = cp.spawn(process.execPath, [FAKE_OPENTIDE, "serve"], { stdio: ["pipe", "pipe", "pipe"] });
  const raw = fromChildProcess(child);
  return {
    ...raw,
    write: (text) => {
      wrote.push(text);
      raw.write(text);
    },
  };
}

/** A fetch handler standing in for `@opentide/wasi-host`'s `FetchHost`: it answers every request 200. */
function answering(log: { requests: unknown[]; disposed: number }) {
  return (send: (message: object) => void): FetchHandler => ({
    handle: (message) => {
      const request = message as { id?: unknown; method?: unknown; params?: unknown };
      if (request.method !== "opentide/fetch") return false;
      log.requests.push(request.params);
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          status: 200,
          headers: [["content-type", "text/plain"]],
          url: "https://tenant.invalid/api",
          body: "b2s=",
          elapsed_ms: 3,
        },
      });
      return true;
    },
    dispose: () => {
      log.disposed += 1;
    },
  });
}

describe("the WASI serve wire (src/core/wasi/wire.ts), against the fake opentide serve", () => {
  let client: ServeClient | undefined;
  afterEach(async () => {
    await client?.stop();
    client = undefined;
  });

  it("gives the module guest paths and the client host paths", async () => {
    const wrote: string[] = [];
    client = new ServeClient({ start: () => wasiServeWire(fake(wrote), PATHS) });
    const result = await client.run({
      argv: ["echo", "--file", "/home/me/detections/objects/a.yaml"],
      cwd: "/home/me/detections",
      env: { OPENTIDE_REPO_ROOT: "/home/me/detections" },
    });
    // What the module was sent.
    const run = wrote.map((line) => JSON.parse(line)).find((message) => message.method === "run");
    assert.deepEqual(run.params, {
      argv: ["echo", "--file", "/workspace/objects/a.yaml"],
      cwd: "/workspace",
      env: { OPENTIDE_REPO_ROOT: "/workspace" },
    });
    // What the client got: the document the module printed, in host paths.
    assert.deepEqual(result.document.argv, ["echo", "--file", "/home/me/detections/objects/a.yaml"]);
    assert.equal(result.document.cwd, "/home/me/detections");
    assert.equal((result.document.env as Record<string, string>).OPENTIDE_REPO_ROOT, "/home/me/detections");
  });

  it("maps the paths invalidate names", async () => {
    const wrote: string[] = [];
    client = new ServeClient({ start: () => wasiServeWire(fake(wrote), PATHS) });
    await client.start();
    client.invalidate(["/home/me/detections/objects/rules/a.yaml", "/elsewhere/b.yaml"]);
    const result = await client.run({ argv: ["invalidated"] });
    assert.deepEqual(
      result.document.paths,
      ["/workspace/objects/rules/a.yaml", "/elsewhere/b.yaml"].map((p) => PATHS.toHost(p)),
    );
  });

  it("answers the server's opentide/fetch requests itself: the client never sees them", async () => {
    const log = { requests: [] as unknown[], disposed: 0 };
    client = new ServeClient({
      start: () => wasiServeWire(fake([]), PATHS, answering(log)),
      initializeParams: { capabilities: { fetch: true } },
    });
    const result = await client.run({ argv: ["fetch-tenant"], cwd: "/home/me/detections" });
    assert.equal(result.exit_code, 0);
    assert.deepEqual(result.document.fetch, {
      status: 200,
      headers: [["content-type", "text/plain"]],
      url: "https://tenant.invalid/api",
      body: "b2s=",
      elapsed_ms: 3,
    });
    assert.equal(log.requests.length, 1);
    // The request is the server's own message: the handler gets it as written (the cwd it carried is its own).
    assert.equal((log.requests[0] as { platform: string }).platform, "sentinel");
    assert.equal(log.disposed, 0);
    await client.stop();
    await until(() => log.disposed > 0);
    assert.equal(log.disposed, 1);
  });

  it("a server that was not asked for opentide/fetch has no network: the command fails, naming the CLI", async () => {
    client = new ServeClient({ start: () => wasiServeWire(fake([]), PATHS) });
    const result = await client.run({ argv: ["fetch-tenant"] });
    assert.equal(result.exit_code, 1);
    assert.equal(result.document.failure?.code, "network_unavailable");
    assert.match(result.document.failure?.message ?? "", /run the opentide CLI/);
  });

  it("a process that fails to start is a spawn-failed BackendError", async () => {
    client = new ServeClient({
      start: async () => {
        throw new Error("the WASM WASI Core extension did not load");
      },
    });
    await assert.rejects(client.start(), (error: unknown) => {
      assert.ok(error instanceof BackendError);
      assert.equal(error.code, "spawn-failed");
      assert.match(error.message, /did not load/);
      return true;
    });
    assert.equal(client.isRunning, false);
  });

  it("is running as soon as it is started, while its process comes up", async () => {
    let release: (process: ServeProcess) => void = () => undefined;
    const slow = new Promise<ServeProcess>((resolve) => {
      release = resolve;
    });
    client = new ServeClient({ start: () => slow });
    const started = client.start();
    assert.equal(client.isRunning, true);
    release(wasiServeWire(fake([]), PATHS));
    assert.equal((await started).protocol, 1);
  });
});
