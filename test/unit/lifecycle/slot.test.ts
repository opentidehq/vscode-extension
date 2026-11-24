import * as assert from "node:assert/strict";

import {
  type ProbeOptions,
  type ProbeResult,
  type ResolveInput,
  type RuntimeSettings,
  resolveRuntime,
} from "../../../src/core/runtime/resolve";
import { ResolutionSlot } from "../../../src/core/runtime/slot";

/** A resolution input with `opentide.path` set and every probe given by the test. */
function fakeInput(options: {
  path: string;
  probe: (command: string, args: readonly string[], options: ProbeOptions) => Promise<ProbeResult>;
}): ResolveInput {
  const settings: RuntimeSettings = {
    path: () => options.path,
    interpreter: () => undefined,
    uvUsePin: () => false,
    uvPath: () => undefined,
    wasi: () => false,
  };
  return {
    trusted: true,
    platform: "linux",
    folder: "/work",
    settings,
    pin: undefined,
    proxy: undefined,
    homeDir: "/home/me",
    exists: () => false,
    which: () => undefined,
    probe: options.probe,
    pythonEnvironments: async () => undefined,
    pythonExtension: async () => undefined,
  };
}

describe("a restart does not wait for a resolution in flight", () => {
  it("cancels the run in flight when another starts, and drops its result", async () => {
    const slot = new ResolutionSlot<string>();
    let release: (value: string) => void = () => undefined;
    let first: AbortSignal | undefined;
    const stale = slot.start(
      (signal) =>
        new Promise<string>((resolve) => {
          first = signal;
          release = resolve;
        }),
    );
    const fresh = slot.start(async () => "fresh");
    assert.equal(first?.aborted, true);
    // The new resolution finishes while the stale one is still running.
    assert.equal(await fresh.result, "fresh");
    release("stale");
    assert.equal(await stale.result, undefined, "its result is dropped");
    assert.equal(slot.running, false);
  });

  it("ends a probe that has minutes left as soon as its resolution is cancelled", async () => {
    const slot = new ResolutionSlot<unknown>();
    let probeEnded = false;
    const started = Date.now();
    const run = slot.start((signal) =>
      resolveRuntime({
        ...fakeInput({
          path: "/usr/bin/opentide",
          probe: (_command, _args, options) =>
            new Promise<ProbeResult>((resolve) => {
              // A `uv` probe, as long as the resolver lets it be.
              const timer = setTimeout(
                () => resolve({ code: 0, stdout: "opentide 1.0.0", stderr: "" }),
                180_000,
              );
              options.signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                probeEnded = true;
                resolve({ code: null, stdout: "", stderr: "", error: "aborted" });
              });
            }),
        }),
        signal,
      }),
    );
    setTimeout(() => slot.cancel(), 20);
    assert.equal(await run.result, undefined);
    assert.equal(probeEnded, true);
    assert.ok(Date.now() - started < 3000, "the restart is immediate");
  });

  it("stops trying tiers once the resolution is stale", async () => {
    const controller = new AbortController();
    const probed: string[] = [];
    const result = await resolveRuntime({
      ...fakeInput({
        path: "/one/opentide",
        probe: async (command) => {
          probed.push(command);
          controller.abort();
          return { code: null, stdout: "", stderr: "", error: "aborted" };
        },
      }),
      signal: controller.signal,
    });
    assert.deepEqual(probed, ["/one/opentide"], "no tier is probed after the abort");
    assert.equal(result.runtime?.tier === 1, false);
  });
});
