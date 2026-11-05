// @vscode/test-cli configurations. `npx vscode-test --label <label>`; they need a VS Code download, so
// they run in CI, not in sandboxes without network access to update.code.visualstudio.com. The Restricted
// Mode tests are scripts/test-restricted.mjs: test-cli always launches VS Code with workspace trust off.
import { defineConfig } from "@vscode/test-cli";

const workspaceFolder = "./test/fixtures/workspace";
// The tests use mocha's describe/it (as npm test does); test-cli's runner defaults to the tdd UI.
const mocha = { ui: "bdd" };

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
    // The bundled runtime of a checkout whose runtime/ holds a build (npm run runtime:build): CI's
    // Windows package jobs, win32-arm64's on Windows 11 on Arm under x64 emulation.
    label: "bundled",
    files: "out/test/bundled/**/*.test.js",
    workspaceFolder,
    launchArgs: ["--disable-workspace-trust"],
    mocha: { ...mocha, timeout: 120000 },
  },
]);
