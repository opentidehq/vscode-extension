import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  codeVersion,
  restrictedLaunchArgs,
  runnerOptions,
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
