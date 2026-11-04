// @vscode/test-cli configurations. `npx vscode-test --label <label>`; they need a VS Code download, so
// they run in CI, not in sandboxes without network access to update.code.visualstudio.com.
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
    // Restricted Mode: workspace trust on, the fixture folder untrusted.
    label: "restricted",
    files: "out/test/restricted/**/*.test.js",
    workspaceFolder,
    launchArgs: ["--user-data-dir", "./test/fixtures/restricted-user"],
    mocha: { timeout: 60000 },
  },
]);
