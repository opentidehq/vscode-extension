// Shared helpers for unit tests.
import * as path from "node:path";
import type { Runtime } from "../../src/core/runtime/types";

/** The repository root (tests run from out/test/unit). */
export const ROOT = path.resolve(__dirname, "..", "..", "..");

export const FAKE_OPENTIDE = path.join(ROOT, "test", "fixtures", "fake-opentide.mjs");

export const COMMANDS_FIXTURE = path.join(ROOT, "test", "fixtures", "commands-0.20.1.json");

/** A runtime that runs test/fixtures/fake-opentide.mjs with this node. */
export function fakeRuntime(overrides: Partial<Runtime> = {}): Runtime {
  return {
    tier: 2,
    source: "path",
    kind: "opentide",
    command: process.execPath,
    args: [FAKE_OPENTIDE],
    version: "0.21.0",
    env: {},
    restricted: false,
    binDirs: [path.dirname(process.execPath)],
    ...overrides,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve when `predicate` holds, polling every 5 ms, or fail after `timeoutMs`. */
export async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await sleep(5);
  }
}
