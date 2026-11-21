import * as assert from "node:assert/strict";
import { bundledTerminalLimit } from "../../src/core/runtime/limits";
import { engineRuntime, wasiRuntime } from "../../src/core/runtime/resolve";
import type { Runtime } from "../../src/core/runtime/types";

const wasi = wasiRuntime({
  module: "/ext/dist/wasi/opentide.wasm",
  launcher: "/ext/dist/wasi/launcher.cjs",
  version: "1.0.0-rc.3",
  execPath: "/usr/share/code/code",
});
const native: Runtime = { ...wasi, tier: 2, source: "path", command: "/usr/bin/opentide", args: [] };
delete (native as { wasi?: unknown }).wasi;

describe("what the bundled opentide cannot do in a task or terminal", () => {
  it("refuses the terminal UI and a tenant command, and names the way out", () => {
    assert.match(
      bundledTerminalLimit(wasi, "tui", false) ?? "",
      /terminal UI.*opentide\.runtime to installed/,
    );
    assert.match(
      bundledTerminalLimit(wasi, "query run", true) ?? "",
      /contacts a tenant.*no network.*opentide\.runtime to installed/,
    );
  });
  it("allows everything else on the bundled opentide", () => {
    assert.equal(bundledTerminalLimit(wasi, "validate", false), undefined);
    assert.equal(bundledTerminalLimit(wasi, "deploy", false), undefined);
  });
  it("has no limits on an installed opentide, and none to give the engine", () => {
    assert.equal(bundledTerminalLimit(native, "tui", true), undefined);
    assert.equal(
      bundledTerminalLimit(engineRuntime({ module: "/m", version: "1" }, false), "tui", true),
      undefined,
    );
    assert.equal(bundledTerminalLimit(undefined, "tui", true), undefined);
  });
});
