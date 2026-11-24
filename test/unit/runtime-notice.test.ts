import * as assert from "node:assert/strict";

import { engineNotice } from "../../src/core/runtime/notice";

describe("engineNotice (#90: why the engine is the runtime)", () => {
  const skipped = (detail: string) => [{ tier: 4 as const, outcome: "skipped" as const, detail }];

  it("says Restricted Mode runs no opentide, instead of asking to install one", () => {
    const text = engineNotice(
      "engine",
      "1.0.0",
      false,
      skipped("Restricted Mode: no opentide runs, only the engine (WASM)"),
    );
    assert.match(text, /Restricted Mode/);
    assert.match(text, /Trust the folder/);
    assert.doesNotMatch(text, /install opentide|is not available/);
  });

  it("says the module is switched off when opentide.wasi.enabled is", () => {
    const text = engineNotice("engine", "1.0.0", true, skipped("opentide.wasi.enabled is off"));
    assert.match(text, /bundled WASI module is off \(opentide\.wasi\.enabled is off\)/);
  });

  it("says the module is not available, with why, when this build lacks it", () => {
    const text = engineNotice("engine", "1.0.0", true, [
      {
        tier: 4 as const,
        outcome: "missing" as const,
        detail: "this build carries no WASI module (dist/wasi/wasi.json)",
      },
    ]);
    assert.match(text, /No opentide answered/);
    assert.match(text, /not available \(this build carries no WASI module/);
    assert.match(text, /install opentide/);
  });
});
