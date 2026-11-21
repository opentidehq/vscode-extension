import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Backend, type BackendDeps } from "../../../src/core/backend/backend";
import { fromChildProcess, type ServeProcess } from "../../../src/core/backend/process";
import type { Classification } from "../../../src/core/capabilities/classification";
import { CommandTree } from "../../../src/core/capabilities/tree";
import { GuestPaths } from "../../../src/core/wasi/paths";
import { type FetchHandler, wasiServeWire } from "../../../src/core/wasi/wire";
import { COMMANDS_FIXTURE, FAKE_OPENTIDE, fakeRuntime } from "../helpers";

const REPO = mkdtempSync(path.join(tmpdir(), "otide-wasi-"));
const GUEST = new GuestPaths(
  [{ host: REPO, hostUri: `file://${REPO}`, guest: "/workspace", guestUri: "file:///workspace" }],
  "linux",
);

const READ: Classification = { class: "read-only", writes: false, contactsTenant: false, spawn: false };
/** A command the native backend runs as a process of its own, and that contacts a tenant. */
const TENANT: Classification = { class: "contacts-tenant", writes: false, contactsTenant: true, spawn: true };

const wasiRuntime = () =>
  fakeRuntime({
    tier: 4,
    source: "wasi",
    version: "1.0.0-rc.3",
    wasi: { module: "/ext/dist/wasi/opentide.wasm", launcher: "/ext/dist/wasi/launcher.cjs" },
  });

function fetchHandler(requests: unknown[]) {
  return (send: (message: object) => void): FetchHandler => ({
    handle: (message) => {
      const request = message as { id?: unknown; method?: unknown; params?: unknown };
      if (request.method !== "opentide/fetch") return false;
      requests.push(request.params);
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { status: 204, headers: [], url: "https://t.invalid", body: "" },
      });
      return true;
    },
    dispose: () => undefined,
  });
}

function backend(
  starts: { count: number },
  requests: unknown[],
  overrides: Partial<BackendDeps> = {},
  startFails = false,
) {
  const logs: string[] = [];
  const runtime = wasiRuntime();
  const instance = new Backend({
    runtime: () => runtime,
    // The tree of an opentide with no serve: a WASI runtime serves whatever the tree says.
    commands: async () => undefined,
    classify: (argv) => (argv[0] === "fetch-tenant" ? TENANT : READ),
    serveMode: () => "auto",
    baseEnv: () => process.env,
    proxy: () => undefined,
    credentials: async () => ({}),
    platform: process.platform,
    log: (level, message) => logs.push(`${level}: ${message}`),
    wasi: {
      initializeParams: { capabilities: { fetch: true } },
      start: async (): Promise<ServeProcess> => {
        starts.count += 1;
        if (startFails) throw new Error("the WASM WASI Core extension did not load");
        const child = cp.spawn(process.execPath, [FAKE_OPENTIDE, "serve"], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        return wasiServeWire(fromChildProcess(child), GUEST, fetchHandler(requests));
      },
    },
    ...overrides,
  });
  return { instance, logs };
}

describe("the backend on the WASI runtime", () => {
  const instances: Backend[] = [];
  const make = (...args: Parameters<typeof backend>) => {
    const made = backend(...args);
    instances.push(made.instance);
    return made;
  };
  afterEach(async () => {
    for (const instance of instances.splice(0)) await instance.dispose();
  });

  it("serves every command through the module's serve, with the workspace's paths in host form", async () => {
    const starts = { count: 0 };
    const { instance, logs } = make(starts, []);
    const result = await instance.run(REPO, ["echo", "--file", path.join(REPO, "objects", "a.yaml")]);
    assert.equal(result.via, "serve");
    assert.equal(result.exitCode, 0);
    assert.equal(result.argvDisplay, `opentide --json echo --file ${path.join(REPO, "objects", "a.yaml")}`);
    assert.equal(result.document.cwd, REPO);
    assert.equal((result.document.env as Record<string, string>).OPENTIDE_REPO_ROOT, REPO);
    assert.equal(instance.serveRunning, true);
    assert.ok(
      logs.some((line) => /started \(WASI, in the extension host\)/.test(line)),
      logs.join("\n"),
    );
  });

  it("makes a tenant command's requests through opentide/fetch: it runs on serve, not as a process of its own", async () => {
    const starts = { count: 0 };
    const requests: unknown[] = [];
    const { instance } = make(starts, requests);
    const result = await instance.run(REPO, ["fetch-tenant"]);
    assert.equal(result.via, "serve");
    assert.equal(requests.length, 1);
    assert.equal((result.document as { fetch?: { status?: number } }).fetch?.status, 204);
  });

  it("starts one serve for requests that arrive together", async () => {
    const starts = { count: 0 };
    const { instance } = make(starts, []);
    await Promise.all([
      instance.run(REPO, ["echo", "1"]),
      instance.run(REPO, ["echo", "2"]),
      instance.run(REPO, ["echo", "3"]),
    ]);
    assert.equal(starts.count, 1);
  });

  it("runs a process of its own through the launcher when the host cannot start the module", async () => {
    const starts = { count: 0 };
    const { instance, logs } = make(starts, [], {}, true);
    const result = await instance.run(REPO, ["echo"]);
    assert.equal(result.via, "spawn");
    assert.equal(result.exitCode, 0);
    assert.ok(logs.some((line) => /opentide serve unavailable, spawning instead.*did not load/.test(line)));
    // It does not try again until the next restart.
    await instance.run(REPO, ["echo"]);
    assert.equal(starts.count, 1);
  });

  it("a native runtime still runs the commands it classifies as spawn in a process of its own", async () => {
    const starts = { count: 0 };
    const native = fakeRuntime();
    const { instance } = make(starts, [], {
      runtime: () => native,
      commands: async () => CommandTree.parse(JSON.parse(readFileSync(COMMANDS_FIXTURE, "utf8"))),
    });
    const result = await instance.run(REPO, ["fetch-tenant"]);
    assert.equal(result.via, "spawn");
    assert.equal(starts.count, 0);
  });
});
