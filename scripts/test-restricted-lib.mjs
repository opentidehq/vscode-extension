// Pure helpers for scripts/test-restricted.mjs: the VS Code command line and the test runner's options.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The arguments VS Code is launched with for the Restricted Mode tests. The same switches as
 * @vscode/test-electron's runTests except --disable-workspace-trust, which runTests always adds and
 * which makes every folder trusted; the user data and extensions live in the run's own folders.
 */
export function restrictedLaunchArgs({
  workspace,
  extensionDevelopmentPath,
  extensionTestsPath,
  userDataDir,
  extensionsDir,
}) {
  return [
    workspace,
    // https://github.com/microsoft/vscode/issues/84238
    "--no-sandbox",
    // https://github.com/microsoft/vscode-test/issues/221
    "--disable-gpu-sandbox",
    "--disable-updates",
    "--skip-welcome",
    "--skip-release-notes",
    "--no-cached-data",
    `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
    `--extensionTestsPath=${extensionTestsPath}`,
    "--user-data-dir",
    userDataDir,
    "--extensions-dir",
    extensionsDir,
  ];
}

/** `--code-version <v>` (or `--code-version=<v>`) from the command line; stable by default. */
export function codeVersion(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--code-version" && argv[i + 1]) return argv[i + 1];
    if (arg.startsWith("--code-version=")) return arg.slice("--code-version=".length);
  }
  return "stable";
}

/** The compiled test files under `dir` (`*.test.js`, recursively), sorted. */
export function testFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/**
 * VSCODE_TEST_OPTIONS for @vscode/test-cli's in-host runner (out/runner.cjs), the one the other labels
 * use: mocha's options, the files to load and what to require first.
 */
export function runnerOptions({ files, timeout, color }) {
  return JSON.stringify({ mochaOpts: { ui: "bdd", timeout }, colorDefault: color, preload: [], files });
}

/** The extension's log files under a user-data-dir (`logs/<session>/.../exthost/opentidehq.opentide/`). */
export function extensionLogs(userDataDir, extensionId = "opentidehq.opentide") {
  const logs = join(userDataDir, "logs");
  if (!existsSync(logs)) return [];
  return readdirSync(logs, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => file.split(/[\\/]/).includes(extensionId))
    .sort();
}

/** The exit code of a run stopped by a signal, as a shell reports it. */
export const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 };

/**
 * Run VS Code and resolve with its exit code. While it runs, SIGINT and SIGTERM (Ctrl+C, a cancelled CI
 * job) stop it instead of this process, so the caller still removes the run's folder; the result is then
 * 130 or 143. A second signal before it exits calls `forceExit` with that code: the caller removes the
 * folder and exits at once.
 */
export function runUntilSignal({ spawn, command, args, options, signals = process, forceExit, log }) {
  return new Promise((resolve) => {
    let stopping;
    let child;
    const handlers = Object.keys(SIGNAL_EXIT).map((signal) => [
      signal,
      () => {
        if (stopping) {
          forceExit(SIGNAL_EXIT[signal]);
          return;
        }
        stopping = signal;
        child?.kill(signal);
      },
    ]);
    const done = (code) => {
      for (const [signal, handler] of handlers) signals.off(signal, handler);
      resolve(stopping ? SIGNAL_EXIT[stopping] : code);
    };
    for (const [signal, handler] of handlers) signals.on(signal, handler);
    try {
      child = spawn(command, args, options);
    } catch (error) {
      log(`test-restricted: ${error.message}`);
      done(1);
      return;
    }
    child.on("error", (error) => {
      log(`test-restricted: ${error.message}`);
      done(1);
    });
    child.on("exit", (exitCode, signal) => done(signal ? 1 : (exitCode ?? 1)));
  });
}
