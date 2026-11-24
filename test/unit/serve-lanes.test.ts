// The two serve lanes of a WASI runtime (tier 4), where every command goes through `opentide serve`, one request at a
// time: the interactive lane (what the editor asks while you work) and the long lane (tenant and process-of-their-own
// commands), against the fake opentide's serve started as the WASI host would start it.
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { Backend, type BackendDeps, INTERACTIVE_TIMEOUT_MS, laneFor } from "../../src/core/backend/backend";
import { fromChildProcess } from "../../src/core/backend/process";
import { BackendError } from "../../src/core/backend/types";
import { type Classification, classify } from "../../src/core/capabilities/classification";
import { CommandTree } from "../../src/core/capabilities/tree";
import type { Runtime, WasiModule } from "../../src/core/runtime/types";
import { CancellationTokenSource } from "../../src/core/util/cancellation";
import { COMMANDS_FIXTURE, FAKE_OPENTIDE, fakeRuntime, sleep } from "./helpers";

const REPO = mkdtempSync(path.join(tmpdir(), "otide-lanes-"));
const READ: Classification = { class: "read-only", writes: false, contactsTenant: false, spawn: false };
const WRITE: Classification = {
  class: "writes-workspace",
  writes: true,
  contactsTenant: false,
  spawn: false,
};
const TENANT: Classification = { class: "contacts-tenant", writes: false, contactsTenant: true, spawn: true };

function tree(): CommandTree {
  const document = JSON.parse(readFileSync(COMMANDS_FIXTURE, "utf8"));
  document.commands.push({
    path: "serve",
    name: "serve",
    summary: "",
    group: false,
    subcommands: [],
    deprecated: false,
    arguments: [],
    options: [],
  });
  return CommandTree.parse(document);
}

/** A WASI backend whose serve processes are the fake opentide's; `children` are every process it started. */
function make(
  overrides: Partial<BackendDeps> = {},
  runtime: Runtime = fakeRuntime({ tier: 4, wasi: {} as WasiModule }),
) {
  const logs: string[] = [];
  const children: cp.ChildProcess[] = [];
  let current = runtime;
  const backend = new Backend({
    runtime: () => current,
    commands: async () => tree(),
    classify: (argv) => (argv.includes("--tenant") ? TENANT : argv.includes("--write") ? WRITE : READ),
    serveMode: () => "auto",
    baseEnv: () => process.env,
    proxy: () => undefined,
    credentials: async () => ({}),
    platform: process.platform,
    log: (level, message) => logs.push(`${level}: ${message}`),
    wasi: {
      start: async () => {
        const child = cp.spawn(process.execPath, [FAKE_OPENTIDE, "serve"], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        children.push(child);
        return fromChildProcess(child);
      },
      initializeParams: {},
    },
    supervision: { cancelGraceMs: 200, crashBackoffMs: 5 },
    ...overrides,
  });
  const starts = (long: boolean) =>
    logs.filter(
      (line) => /opentide serve .* started/.test(line) && line.includes("for long commands") === long,
    ).length;
  const setRuntime = (next: Runtime) => {
    current = next;
  };
  return { backend, logs, children, starts, setRuntime };
}

const exited = (child: cp.ChildProcess) => child.exitCode !== null || child.signalCode !== null;

describe("serve lanes", function () {
  this.timeout(20_000);
  const backends: Backend[] = [];
  // Every rejection of a request is observed: a lane stopping, crashing or changing runtime leaves none unhandled.
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  before(() => process.on("unhandledRejection", onUnhandled));
  after(() => process.off("unhandledRejection", onUnhandled));
  afterEach(async () => {
    for (const backend of backends.splice(0)) await backend.dispose();
    await sleep(50);
    assert.deepEqual(unhandled.splice(0).map(String), [], "a rejection nobody handled");
  });

  it("routes tenant commands and commands of their own to the long lane, the rest to the interactive one", () => {
    assert.equal(laneFor(READ), "interactive");
    assert.equal(laneFor(WRITE), "interactive");
    assert.equal(laneFor(TENANT), "long");
    // The real table: a query, a deploy dry run, doctor and generate are long; validate, info and explain are not.
    for (const argv of [
      ["query"],
      ["deploy", "--dry-run"],
      ["doctor"],
      ["doctor", "--offline"],
      ["generate", "docs"],
    ])
      assert.equal(laneFor(classify(argv)), "long", argv.join(" "));
    for (const argv of [
      ["validate"],
      ["validate", "--fix"],
      ["info", "catalog"],
      ["explain", "x"],
      ["new", "rule"],
    ])
      assert.equal(laneFor(classify(argv)), "interactive", argv.join(" "));
  });

  it("answers the editor while a slow tenant command runs on the long lane", async () => {
    const made = make();
    backends.push(made.backend);
    await made.backend.run(REPO, ["echo"]);
    const slow = made.backend.run(REPO, ["slow", "3000", "--tenant"]);
    await sleep(300);
    for (const argv of [["echo"], ["echo", "--write"]]) {
      const started = Date.now();
      const result = await made.backend.run(REPO, argv);
      assert.equal(result.exitCode, 0);
      assert.ok(Date.now() - started < 1000, `${argv.join(" ")} took ${Date.now() - started} ms`);
    }
    assert.deepEqual(made.backend.lanesRunning, { interactive: true, long: true });
    const result = await slow;
    assert.equal(result.exitCode, 0);
    assert.equal(result.via, "serve");
    assert.equal(made.starts(false), 1);
    assert.equal(made.starts(true), 1);
  });

  it("starts the long lane only with the first long command", async () => {
    const made = make();
    backends.push(made.backend);
    for (let i = 0; i < 3; i++) await made.backend.run(REPO, ["echo"]);
    assert.deepEqual(made.backend.lanesRunning, { interactive: true, long: false });
    assert.equal(made.children.length, 1);
    await made.backend.run(REPO, ["echo", "--tenant"]);
    await made.backend.run(REPO, ["echo", "--tenant"]);
    assert.equal(made.children.length, 2, "one long serve, kept warm");
  });

  it("keeps a crash on one lane to that lane: its own restarts, its own ceiling", async () => {
    const made = make();
    backends.push(made.backend);
    await made.backend.run(REPO, ["echo"]);
    const interactive = made.children[0];
    for (let i = 0; i < 2; i++)
      await assert.rejects(made.backend.run(REPO, ["crash", "--tenant"]), (error: unknown) => {
        assert.ok(error instanceof BackendError && error.code === "crashed", String(error));
        return true;
      });
    // The long lane reached its ceiling (4 starts); the interactive serve never stopped.
    assert.equal(made.starts(true), 4);
    assert.ok(interactive && !exited(interactive), "the interactive serve is the same process");
    assert.equal((await made.backend.run(REPO, ["echo"])).exitCode, 0);
    assert.equal(made.starts(false), 1);
    await assert.rejects(made.backend.run(REPO, ["echo", "--tenant"]), /crashed 4 times/);
    // A restart (opentide: Restart Server) gives both lanes a fresh start.
    await made.backend.restart();
    assert.equal((await made.backend.run(REPO, ["echo", "--tenant"])).exitCode, 0);
  });

  it("lets a long command finish when the runtime changes under it, and replaces the stale serves after", async () => {
    const wasiRuntime = fakeRuntime({ tier: 4, wasi: {} as WasiModule });
    const made = make({}, wasiRuntime);
    backends.push(made.backend);
    await made.backend.run(REPO, ["echo"]);
    // Longer than stop()'s 2 s wait for `shutdown`: a stop would end it mid-request.
    const long = made.backend.run(REPO, ["slow", "3500", "--tenant"]);
    await sleep(400);
    // Another opentide resolved (a settings change): the editor's next command meets it on the interactive lane.
    made.setRuntime(fakeRuntime({ tier: 4, wasi: {} as WasiModule, version: "0.22.0" }));
    assert.equal((await made.backend.run(REPO, ["echo"])).exitCode, 0);
    const result = await long;
    assert.equal(result.exitCode, 0, "the long command ran to its end on the serve it started on");
    assert.equal(result.cancelled, false);
    assert.ok(
      made.logs.some((line) => line.includes("stopping the interactive serve started for the previous one")),
    );
    assert.ok(!made.logs.some((line) => line.includes("crashed")), made.logs.join("\n"));
    // The next long command replaces the long lane's stale serve.
    assert.equal((await made.backend.run(REPO, ["echo", "--tenant"])).exitCode, 0);
    assert.ok(
      made.logs.some((line) => line.includes("stopping the long serve started for the previous one")),
    );
    assert.equal(made.starts(true), 2);
  });

  it("keeps both serves when the same runtime is resolved again as a new object", async () => {
    const made = make();
    backends.push(made.backend);
    for (let i = 0; i < 3; i++) {
      made.setRuntime(fakeRuntime({ tier: 4, wasi: {} as WasiModule }));
      await made.backend.run(REPO, ["echo"]);
      await made.backend.run(REPO, ["echo", "--tenant"]);
    }
    assert.equal(made.children.length, 2);
    assert.ok(!made.logs.some((line) => line.includes("the opentide runtime changed")), made.logs.join("\n"));
  });

  it("sends file changes to both lanes", async () => {
    const made = make();
    backends.push(made.backend);
    await made.backend.run(REPO, ["echo"]);
    await made.backend.run(REPO, ["echo", "--tenant"]);
    const file = path.join(REPO, "objects", "rule.yaml");
    made.backend.invalidate([file]);
    for (const argv of [["invalidated"], ["invalidated", "--tenant"]]) {
      const result = await made.backend.run(REPO, argv);
      assert.deepEqual(result.document.paths, [file], argv.join(" "));
    }
  });

  it("stops both lanes' processes on restart and on dispose, and ends every process it started", async () => {
    const made = make();
    await made.backend.run(REPO, ["echo"]);
    await made.backend.run(REPO, ["echo", "--tenant"]);
    await made.backend.restart();
    assert.deepEqual(made.backend.lanesRunning, { interactive: false, long: false });
    await made.backend.run(REPO, ["echo"]);
    await made.backend.run(REPO, ["echo", "--tenant"]);
    assert.equal(made.children.length, 4);
    await made.backend.dispose();
    await sleep(100);
    for (const child of made.children) assert.ok(exited(child), `serve pid ${child.pid} is still running`);
  });

  it("gives an interactive command 5 minutes by default: a hard stop for a hung serve, not for a long validate", () => {
    assert.equal(INTERACTIVE_TIMEOUT_MS, 300_000);
  });

  it("gives an interactive command a deadline, and a long one none", async () => {
    const made = make({ supervision: { cancelGraceMs: 200, crashBackoffMs: 5, interactiveTimeoutMs: 300 } });
    backends.push(made.backend);
    const started = Date.now();
    await assert.rejects(made.backend.run(REPO, ["hang"]), (error: unknown) => {
      assert.ok(error instanceof BackendError && error.code === "timed-out", String(error));
      assert.match(error.message, /did not answer `hang`/);
      return true;
    });
    assert.ok(Date.now() - started < 300 + 200 + 1000, `answered after ${Date.now() - started} ms`);
    // The long lane waits for its command, however long, until it is cancelled.
    const source = new CancellationTokenSource();
    let settled = false;
    const long = made.backend.run(REPO, ["hang", "--tenant"], { cancellation: source.token }).finally(() => {
      settled = true;
    });
    await sleep(800);
    assert.equal(settled, false, "a long command has no deadline");
    source.cancel();
    assert.equal((await long).cancelled, true);
    // A command the user cancels on the interactive lane is cancelled, not timed out.
    const user = new CancellationTokenSource();
    const cancelled = made.backend.run(REPO, ["slow", "5000"], { cancellation: user.token });
    await sleep(100);
    user.cancel();
    assert.equal((await cancelled).cancelled, true);
  });

  it("stops the long lane's serve once it has been idle, and starts it again with the next long command", async () => {
    const made = make({ supervision: { cancelGraceMs: 200, crashBackoffMs: 5, longIdleMs: 300 } });
    backends.push(made.backend);
    await made.backend.run(REPO, ["echo"]);
    await made.backend.run(REPO, ["echo", "--tenant"]);
    // A command in flight keeps it up past the idle time.
    const slow = made.backend.run(REPO, ["slow", "700", "--tenant"]);
    await sleep(500);
    assert.equal(made.backend.lanesRunning.long, true);
    await slow;
    await sleep(600);
    assert.deepEqual(made.backend.lanesRunning, { interactive: true, long: false });
    assert.ok(made.logs.some((line) => line.includes("stopping the serve for long commands: idle")));
    const long = made.children[1];
    assert.ok(long && exited(long), "the idle long serve's process ended");
    // Its stop is not a crash, and the next long command starts it again.
    assert.equal((await made.backend.run(REPO, ["echo", "--tenant"])).exitCode, 0);
    assert.equal(made.starts(true), 2);
    assert.equal(made.logs.filter((line) => line.includes("the next request restarts it")).length, 0);
  });

  it("routes nothing to a second lane on a native runtime, where long commands spawn", async () => {
    const made = make({ wasi: undefined }, fakeRuntime());
    backends.push(made.backend);
    const result = await made.backend.run(REPO, ["echo", "--tenant"]);
    assert.equal(result.via, "spawn");
    assert.deepEqual(made.backend.lanesRunning, { interactive: false, long: false });
  });
});
