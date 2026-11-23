import * as assert from "node:assert/strict";
import { chooseWasiHost, exitNote, wasiHostSetting } from "../../../src/core/wasi/hostChoice";

describe("which host runs the bundled module (#100)", () => {
  it("auto runs the launcher where it can, even when ms-vscode.wasm-wasi-core is installed", () => {
    const choice = chooseWasiHost({ setting: "auto", wasmWasiInstalled: true, launcherUsable: true });
    assert.equal(choice.host, "launcher");
    assert.match(choice.note, /ms-vscode\.wasm-wasi-core is installed and not used/);
    assert.match(choice.note, /opentide\.wasi\.host/);
  });

  it("auto runs the launcher with nothing installed, saying so", () => {
    const choice = chooseWasiHost({ setting: "auto", wasmWasiInstalled: false, launcherUsable: true });
    assert.equal(choice.host, "launcher");
    assert.match(choice.note, /not installed/);
  });

  it("auto keeps @vscode/wasm-wasi for where the launcher cannot run, and only when it is installed", () => {
    assert.equal(
      chooseWasiHost({ setting: "auto", wasmWasiInstalled: true, launcherUsable: false }).host,
      "wasm-wasi",
    );
    assert.equal(
      chooseWasiHost({ setting: "auto", wasmWasiInstalled: false, launcherUsable: false }).host,
      "launcher",
    );
  });

  it("wasm-wasi asks for ms-vscode.wasm-wasi-core, and falls back to the launcher with a note when it is not installed", () => {
    const asked = chooseWasiHost({ setting: "wasm-wasi", wasmWasiInstalled: true, launcherUsable: true });
    assert.equal(asked.host, "wasm-wasi");
    const missing = chooseWasiHost({ setting: "wasm-wasi", wasmWasiInstalled: false, launcherUsable: true });
    assert.equal(missing.host, "launcher");
    assert.match(missing.note, /is not installed/);
  });

  it("launcher asks for the launcher, and gives way only where it cannot run", () => {
    assert.equal(
      chooseWasiHost({ setting: "launcher", wasmWasiInstalled: true, launcherUsable: true }).host,
      "launcher",
    );
    assert.equal(
      chooseWasiHost({ setting: "launcher", wasmWasiInstalled: true, launcherUsable: false }).host,
      "wasm-wasi",
    );
  });

  it("reads the setting: anything but launcher and wasm-wasi is auto", () => {
    assert.equal(wasiHostSetting("launcher"), "launcher");
    assert.equal(wasiHostSetting("wasm-wasi"), "wasm-wasi");
    for (const other of ["auto", "", "node", undefined, null, 3])
      assert.equal(wasiHostSetting(other), "auto");
  });
});

describe("the exit of the language server's process (#99)", () => {
  it("is no warning when the extension ended the process itself, whatever its code", () => {
    assert.deepEqual(exitNote("opentide lsp start", 1, true), {
      level: "debug",
      text: "WASI: opentide lsp start ended on request (exit code 1)",
    });
    assert.equal(exitNote("opentide lsp start", 0, true)?.level, "debug");
  });

  it("is a warning for a process nobody asked to end that exits with a code, and nothing for a clean exit", () => {
    assert.deepEqual(exitNote("opentide lsp start", 1, false), {
      level: "warn",
      text: "WASI: opentide lsp start exited with code 1",
    });
    assert.equal(exitNote("opentide lsp start", 0, false), undefined);
  });
});
