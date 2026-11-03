import * as assert from "node:assert/strict";
import { parseDocument, parseProgressLine, spawnRun } from "../../src/core/backend/spawn";
import { BackendError, type ProgressEvent } from "../../src/core/backend/types";
import { CancellationTokenSource } from "../../src/core/util/cancellation";
import { FAKE_OPENTIDE, sleep } from "./helpers";

const run = (argv: string[], extra: Partial<Parameters<typeof spawnRun>[0]> = {}) =>
  spawnRun({
    command: process.execPath,
    args: [FAKE_OPENTIDE, "--json", ...argv],
    commandName: argv[0] ?? "",
    env: { ...process.env, OPENTIDE_REPO_ROOT: "/repo" } as Record<string, string>,
    cwd: undefined,
    platform: process.platform,
    ...extra,
  });

describe("spawn backend", () => {
  it("returns the document and the exit code, even for a failed command", async () => {
    const ok = await run(["echo", "--file", "x.yaml"]);
    assert.equal(ok.exitCode, 0);
    assert.deepEqual(ok.document.argv, ["echo", "--file", "x.yaml"]);
    const failed = await run(["fail"]);
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.document.failure?.code, "workspace_not_found");
  });

  it("routes NDJSON progress events from stderr, and other lines to onStderr", async () => {
    const events: ProgressEvent[] = [];
    const lines: string[] = [];
    await run(["progress"], {
      env: { ...process.env, OPENTIDE_PROGRESS: "json" } as Record<string, string>,
      onProgress: (e) => events.push(e),
      onStderr: (l) => lines.push(l),
    });
    assert.deepEqual(
      events.map((e) => e.event),
      ["progress", "tenant"],
    );
    assert.deepEqual(lines, ["a log line"]);
  });

  it("rejects with bad-output, carrying stderr, when stdout has no document", async () => {
    await assert.rejects(run(["garbage"]), (error: unknown) => {
      assert.ok(error instanceof BackendError);
      assert.equal(error.code, "bad-output");
      assert.match(error.detail ?? "", /Traceback/);
      return true;
    });
  });

  it("rejects with spawn-failed when the executable does not exist", async () => {
    await assert.rejects(
      spawnRun({
        command: "/nonexistent/opentide",
        args: [],
        env: {},
        cwd: undefined,
        platform: process.platform,
      }),
      (error: unknown) => error instanceof BackendError && error.code === "spawn-failed",
    );
  });

  it("cancels with SIGINT on POSIX: exit 130 with the command's own document", async function () {
    if (process.platform === "win32") this.skip();
    const source = new CancellationTokenSource();
    const pending = run(["slow", "10000"], { token: source.token });
    await sleep(300);
    source.cancel();
    const result = await pending;
    assert.equal(result.exitCode, 130);
    assert.equal(result.cancelled, true);
  });

  it("answers a run cancelled before it starts without spawning", async () => {
    const source = new CancellationTokenSource();
    source.cancel();
    const result = await spawnRun({
      command: "/nonexistent",
      args: [],
      env: {},
      cwd: undefined,
      platform: "linux",
      token: source.token,
    });
    assert.equal(result.exitCode, 130);
    assert.equal(result.document.failure?.code, "cancelled");
  });

  it("parses a document after log noise on stdout, and progress lines", () => {
    assert.equal(parseDocument('noise\n{"exit_code":0,"ok":true}\n')?.exit_code, 0);
    assert.equal(parseDocument("[]"), undefined);
    assert.equal(parseProgressLine('{"event":"progress","step":"x"}')?.event, "progress");
    assert.equal(parseProgressLine("plain"), undefined);
  });
});
