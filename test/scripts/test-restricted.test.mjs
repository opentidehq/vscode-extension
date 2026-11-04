import * as assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  codeVersion,
  extensionLogs,
  restrictedLaunchArgs,
  runnerOptions,
  runUntilSignal,
  SIGNAL_EXIT,
  testFiles,
} from "../../scripts/test-restricted-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("test-restricted: Restricted Mode tests run untrusted", () => {
  const launch = {
    workspace: "/ws",
    extensionDevelopmentPath: "/ext",
    extensionTestsPath: "/runner.cjs",
    userDataDir: "/tmp/otr-1/user",
    extensionsDir: "/tmp/otr-1/extensions",
  };

  it("never disables workspace trust", () => {
    const args = restrictedLaunchArgs(launch);
    assert.ok(!args.includes("--disable-workspace-trust"), args.join(" "));
    assert.equal(args[0], "/ws");
    assert.ok(args.includes("--extensionDevelopmentPath=/ext"));
    assert.ok(args.includes("--extensionTestsPath=/runner.cjs"));
  });

  it("uses the run's own user data and extensions folders, never the tracked fixture", () => {
    const args = restrictedLaunchArgs(launch);
    assert.equal(args[args.indexOf("--user-data-dir") + 1], "/tmp/otr-1/user");
    assert.equal(args[args.indexOf("--extensions-dir") + 1], "/tmp/otr-1/extensions");
    assert.ok(!args.some((arg) => arg.includes("restricted-user")));
  });

  it("reads --code-version as npm run passes it, stable by default", () => {
    assert.equal(codeVersion(["--code-version", "1.91.0"]), "1.91.0");
    assert.equal(codeVersion(["--code-version=insiders"]), "insiders");
    assert.equal(codeVersion([]), "stable");
  });

  it("gives test-cli's runner the bdd UI and the compiled test files", () => {
    const scratch = mkdtempSync(join(tmpdir(), "otr-test-"));
    try {
      mkdirSync(join(scratch, "nested"));
      writeFileSync(join(scratch, "b.test.js"), "");
      writeFileSync(join(scratch, "nested", "a.test.js"), "");
      writeFileSync(join(scratch, "helpers.js"), "");
      writeFileSync(join(scratch, "b.test.js.map"), "");
      const files = testFiles(scratch);
      assert.deepEqual(files, [join(scratch, "b.test.js"), join(scratch, "nested", "a.test.js")]);
      const options = JSON.parse(runnerOptions({ files, timeout: 60000, color: false }));
      assert.deepEqual(options, {
        mochaOpts: { ui: "bdd", timeout: 60000 },
        colorDefault: false,
        preload: [],
        files,
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("finds the extension's logs in a user-data-dir, and nothing when there are none", () => {
    const scratch = mkdtempSync(join(tmpdir(), "otr-logs-"));
    try {
      assert.deepEqual(extensionLogs(scratch), []);
      const exthost = join(scratch, "logs", "20261104T035700", "window1", "exthost");
      mkdirSync(join(exthost, "opentidehq.opentide"), { recursive: true });
      mkdirSync(join(exthost, "vscode.git"), { recursive: true });
      writeFileSync(join(exthost, "opentidehq.opentide", "opentide.log"), "x");
      writeFileSync(join(exthost, "vscode.git", "Git.log"), "x");
      writeFileSync(join(exthost, "exthost.log"), "x");
      assert.deepEqual(extensionLogs(scratch), [join(exthost, "opentidehq.opentide", "opentide.log")]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  /** A fake VS Code: `kill` records the signal, and the test says when it exits. */
  function fakeRun() {
    const signals = new EventEmitter();
    const child = new EventEmitter();
    const killed = [];
    const forced = [];
    child.kill = (signal) => killed.push(signal);
    const result = runUntilSignal({
      spawn: () => child,
      command: "code",
      args: [],
      options: {},
      signals,
      forceExit: (code) => forced.push(code),
      log: () => undefined,
    });
    return { signals, child, killed, forced, result };
  }

  it("stops VS Code on Ctrl+C and returns, so the run's folder is still removed", async () => {
    const run = fakeRun();
    assert.equal(run.signals.listenerCount("SIGINT"), 1, "Ctrl+C no longer ends this process at once");
    assert.equal(run.signals.listenerCount("SIGTERM"), 1);
    run.signals.emit("SIGINT");
    assert.deepEqual(run.killed, ["SIGINT"]);
    run.child.emit("exit", null, "SIGINT");
    assert.equal(await run.result, SIGNAL_EXIT.SIGINT);
    assert.equal(run.signals.listenerCount("SIGINT"), 0);
    assert.equal(run.signals.listenerCount("SIGTERM"), 0);
    assert.deepEqual(run.forced, []);
  });

  it("exits at once on a second signal, and passes VS Code's own exit code otherwise", async () => {
    const stuck = fakeRun();
    stuck.signals.emit("SIGTERM");
    stuck.signals.emit("SIGTERM");
    assert.deepEqual(stuck.forced, [SIGNAL_EXIT.SIGTERM]);
    stuck.child.emit("exit", null, "SIGKILL");
    assert.equal(await stuck.result, 143);
    const failed = fakeRun();
    failed.child.emit("exit", 3, null);
    assert.equal(await failed.result, 3);
    const errored = fakeRun();
    errored.child.emit("error", new Error("ENOENT"));
    assert.equal(await errored.result, 1);
  });

  it("removes the run's folder on every way out of the script", () => {
    const script = readFileSync(join(root, "scripts", "test-restricted.mjs"), "utf8");
    const removal = script.indexOf("} finally {\n  removeScratch();");
    assert.ok(removal > script.indexOf("cpSync(") && removal > script.indexOf("runUntilSignal({"));
    assert.ok(script.indexOf("try {") < script.indexOf("cpSync("), "a failed copy removes it too");
  });

  it("is what npm run test:restricted runs, and the fixture settings turn trust on", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.match(manifest.scripts["test:restricted"], /node scripts\/test-restricted\.mjs$/);
    const settings = JSON.parse(
      readFileSync(join(root, "test", "fixtures", "restricted-user", "User", "settings.json"), "utf8"),
    );
    assert.equal(settings["security.workspace.trust.enabled"], true);
    assert.equal(settings["security.workspace.trust.startupPrompt"], "never");
  });
});
