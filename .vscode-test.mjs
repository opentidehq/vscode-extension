// @vscode/test-cli configurations. `npx vscode-test --label <label>`; they need a VS Code download, so
// they run in CI, not in sandboxes without network access to update.code.visualstudio.com. The Restricted
// Mode tests are scripts/test-restricted.mjs: test-cli always launches VS Code with workspace trust off.
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { defineConfig } from "@vscode/test-cli";

const workspaceFolder = "./test/fixtures/workspace";
// The host of the WASI module, which the extension asks for when it is missing (it is no manifest dependency:
// Restricted Mode disables it). Only the `wasi` label runs the module, so only it installs it.
const installExtensions = ["ms-vscode.wasm-wasi-core"];
// The tests use mocha's describe/it (as npm test does); test-cli's runner defaults to the tdd UI.
const mocha = { ui: "bdd" };

/** PATH without the folders that hold an opentide executable: the engine (WASM) tests run with none. */
function pathWithoutOpentide() {
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const kept = (process.env[key] ?? "")
    .split(delimiter)
    .filter((dir) => !["opentide", "opentide.exe"].some((name) => dir && existsSync(join(dir, name))));
  return { [key]: kept.join(delimiter) };
}

export default defineConfig([
  {
    // The vscode-free unit tests, inside the extension host (npm test runs them in plain node).
    label: "unit",
    files: ["out/test/unit/**/*.test.js", "!out/test/unit/vscode-glue.test.js"],
    workspaceFolder,
    mocha: { ...mocha, timeout: 20000 },
  },
  {
    label: "integration",
    files: "out/test/integration/**/*.test.js",
    workspaceFolder,
    launchArgs: ["--disable-workspace-trust"],
    mocha: { ...mocha, timeout: 60000 },
    env: { OPENTIDE_TEST_BIN: process.env.OPENTIDE_TEST_BIN ?? "" },
  },
  {
    // No opentide anywhere: the WASI module the extension carries is the runtime (test/wasi/).
    label: "wasi",
    files: "out/test/wasi/**/*.test.js",
    workspaceFolder,
    launchArgs: ["--disable-workspace-trust"],
    installExtensions,
    mocha: { ...mocha, timeout: 120000 },
    env: pathWithoutOpentide(),
  },
  {
    // No opentide anywhere and the WASI module off: the engine (WASM) tier (test/engine/).
    label: "engine",
    files: "out/test/engine/**/*.test.js",
    workspaceFolder,
    launchArgs: ["--disable-workspace-trust"],
    mocha: { ...mocha, timeout: 60000 },
    env: pathWithoutOpentide(),
  },
]);
