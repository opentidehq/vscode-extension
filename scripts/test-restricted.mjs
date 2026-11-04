#!/usr/bin/env node
// Restricted Mode tests (#8): VS Code with workspace trust on and test/fixtures/workspace untrusted.
//   node scripts/test-restricted.mjs [--code-version <stable|insiders|x.y.z>]
// @vscode/test-electron's runTests always passes --disable-workspace-trust, so with it every folder is
// trusted and these tests cannot run: this downloads VS Code the same way and launches it without that
// switch. Each run gets a fresh user-data-dir (test/fixtures/restricted-user's settings copied in,
// the fixture itself is never written) and extensions-dir, removed afterwards. The tests run with
// @vscode/test-cli's in-host runner, as the integration label's do. Run `npm run test:restricted`, which
// builds first; it needs a VS Code download, so it runs in CI.
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codeVersion, restrictedLaunchArgs, runnerOptions, testFiles } from "./test-restricted-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const electron = require("@vscode/test-electron");
const runner = join(dirname(require.resolve("@vscode/test-cli")), "runner.cjs");

const version = codeVersion(process.argv.slice(2));
const files = testFiles(join(root, "out", "test", "restricted"));
if (files.length === 0) {
  console.error("test-restricted: no out/test/restricted/**/*.test.js: run npm run compile-tests first");
  process.exit(1);
}

const executable = await electron.downloadAndUnzipVSCode({ version, cachePath: join(root, ".vscode-test") });
// Short: on macOS the main IPC socket lives in the user-data-dir, and socket paths are limited.
const scratch = mkdtempSync(join(tmpdir(), "otr-"));
const userDataDir = join(scratch, "user");
cpSync(join(root, "test", "fixtures", "restricted-user"), userDataDir, { recursive: true });

const args = restrictedLaunchArgs({
  workspace: join(root, "test", "fixtures", "workspace"),
  extensionDevelopmentPath: root,
  extensionTestsPath: runner,
  userDataDir,
  extensionsDir: join(scratch, "extensions"),
});
const env = {
  ...process.env,
  VSCODE_TEST_OPTIONS: runnerOptions({ files, timeout: 60_000, color: Boolean(process.stdout.isTTY) }),
};
delete env.ELECTRON_RUN_AS_NODE;

const code = await new Promise((resolve) => {
  const child = spawn(executable, args, { env, stdio: "inherit" });
  child.on("error", (error) => {
    console.error(`test-restricted: ${error.message}`);
    resolve(1);
  });
  child.on("exit", (exitCode, signal) => resolve(signal ? 1 : (exitCode ?? 1)));
});

try {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
} catch (error) {
  console.warn(`test-restricted: could not remove ${scratch}: ${error.message}`);
}
if (code !== 0) console.error(`test-restricted: VS Code exited with ${code}`);
process.exit(code);
