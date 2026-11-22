import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import { EventEmitter } from "node:events";
import { killTree, terminateChild } from "../../../src/core/backend/terminate";

/** A process that records what it is sent, and leaves only when told to. */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  pid: number | undefined = 4242;
  signals: (string | undefined)[] = [];
  kill(signal?: string): boolean {
    this.signals.push(signal);
    return true;
  }
  leave(): void {
    this.exitCode = 0;
    this.emit("close", 0, null);
  }
}
const as = (child: FakeChild) => child as unknown as cp.ChildProcess;

describe("terminateChild: one termination for every path", () => {
  it("asks politely first and does not kill a process that leaves in time", async () => {
    const child = new FakeChild();
    const ended = terminateChild(as(child), { platform: "linux", graceMs: 200 });
    assert.deepEqual(child.signals, ["SIGTERM"]);
    setTimeout(() => child.leave(), 20);
    await ended;
    assert.deepEqual(child.signals, ["SIGTERM"]);
  });

  it("asks with SIGINT where a Ctrl-C is wanted (a command's cancellation)", async () => {
    const child = new FakeChild();
    const ended = terminateChild(as(child), { platform: "linux", signal: "SIGINT", graceMs: 200 });
    assert.deepEqual(child.signals, ["SIGINT"]);
    child.leave();
    await ended;
  });

  it("kills the tree of a process that does not leave within the grace", async () => {
    const child = new FakeChild();
    const ended = terminateChild(as(child), { platform: "linux", graceMs: 30 });
    setTimeout(() => child.leave(), 80);
    await ended;
    assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  });

  it("kills at once with no grace (a serve process past its shutdown)", async () => {
    const child = new FakeChild();
    const ended = terminateChild(as(child), { platform: "linux", graceMs: 0 });
    assert.deepEqual(child.signals, ["SIGKILL"]);
    child.leave();
    await ended;
  });

  it("uses taskkill /T /F on Windows, where there is no polite signal", async () => {
    const child = new FakeChild();
    const calls: { command: string; args: readonly string[] }[] = [];
    const killer = new EventEmitter();
    const ended = terminateChild(as(child), {
      platform: "win32",
      spawn: (command, args) => {
        calls.push({ command, args });
        return killer as unknown as cp.ChildProcess;
      },
    });
    assert.deepEqual(calls, [{ command: "taskkill", args: ["/pid", "4242", "/T", "/F"] }]);
    assert.deepEqual(child.signals, []);
    child.leave();
    await ended;
  });

  it("returns at once for a process that has ended, and does not hang on one that cannot be killed", async () => {
    const gone = new FakeChild();
    gone.exitCode = 1;
    await terminateChild(as(gone), { platform: "linux" });
    assert.deepEqual(gone.signals, []);
    killTree(as(gone), "linux");
    assert.deepEqual(gone.signals, []);
    const stubborn = new FakeChild();
    const started = Date.now();
    await terminateChild(as(stubborn), { platform: "linux", graceMs: 10 });
    assert.ok(Date.now() - started < 3000);
    assert.deepEqual(stubborn.signals, ["SIGTERM", "SIGKILL"]);
  });

  it("ends a real process that ignores SIGTERM, within the grace", async function () {
    if (process.platform === "win32") return this.skip();
    const child = cp.spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('up')"],
      {
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    await new Promise((resolve) => child.stdout?.once("data", resolve));
    const started = Date.now();
    await terminateChild(child, { graceMs: 300 });
    assert.ok(Date.now() - started < 4000);
    assert.equal(child.signalCode, "SIGKILL");
  });
});
