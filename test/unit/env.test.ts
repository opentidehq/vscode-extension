import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { join } from "node:path";
import { loadEnvFile, parseEnvFile, readEnvFile } from "../../src/core/envfile";
import { displayArgv, processEnv, redact, shellQuote } from "../../src/core/runtime/env";

describe("process environments", () => {
  const base = {
    PATH: "/usr/bin:/workspace/bin",
    HOME: "/home/me",
    PYTHONPATH: "/evil",
    GIT_DIR: "/x",
    LANG: "C.UTF-8",
  };

  it("locks Restricted Mode down to the runtime's bin and a few start-up variables", () => {
    const env = processEnv(
      base,
      { env: { PATH: "/ignored", PYTHONHOME: "/evil" }, restricted: true, binDirs: ["/ext/runtime/bin"] },
      "linux",
    );
    assert.deepEqual(env, { HOME: "/home/me", LANG: "C.UTF-8", PATH: "/ext/runtime/bin" });
  });

  it("keeps the environment otherwise and adds the runtime's", () => {
    const env = processEnv(base, { env: { UV_SYSTEM_CERTS: "1" }, restricted: false, binDirs: [] }, "linux", {
      NO_COLOR: "1",
    });
    assert.equal(env.PATH, base.PATH);
    assert.equal(env.UV_SYSTEM_CERTS, "1");
    assert.equal(env.NO_COLOR, "1");
  });

  it("replaces PATH case-insensitively on Windows", () => {
    const env = processEnv(
      { Path: "C:\\Windows", SystemRoot: "C:\\Windows" },
      { env: {}, restricted: true, binDirs: ["C:\\rt", "C:\\rt\\Scripts"] },
      "win32",
    );
    assert.deepEqual(Object.keys(env).sort(), ["PATH", "SystemRoot"]);
    assert.equal(env.PATH, ["C:\\rt", "C:\\rt\\Scripts"].join(path.delimiter));
  });
});

describe("command lines", () => {
  it("quotes for a POSIX shell", () => {
    assert.equal(shellQuote("objects/rules/x.yaml"), "objects/rules/x.yaml");
    assert.equal(shellQuote("a b"), "'a b'");
    assert.equal(shellQuote("it's"), "'it'\\''s'");
    assert.equal(shellQuote(""), "''");
  });

  it("shows `opentide --json …` with secret flags and known secrets redacted", () => {
    assert.equal(
      displayArgv(["validate", "--file", "x y.yaml"]),
      "opentide --json validate --file 'x y.yaml'",
    );
    assert.equal(
      displayArgv(["share", "push", "--api-key", "abcd1234"]),
      "opentide --json share push --api-key ***",
    );
    assert.equal(displayArgv(["x", "--token=abcdef"]), "opentide --json x --token=***");
    assert.equal(displayArgv(["query", "hunter22"], ["hunter22"]), "opentide --json query ***");
    assert.equal(redact("a short-secret b", ["abc"]), "a short-secret b");
  });
});

describe(".env files", () => {
  it("parses KEY=value with quotes, export and comments", () => {
    const text = [
      "# comment",
      "export AZURE_CLIENT_ID=abc",
      "AZURE_CLIENT_SECRET='li$teral # not a comment'",
      'SPLUNK_TOKEN="line1\\nline2"',
      "PLAIN=value # trailing",
      "EMPTY=",
      "not a line",
      'MULTI="a',
      'b"',
    ].join("\n");
    assert.deepEqual(parseEnvFile(text), {
      AZURE_CLIENT_ID: "abc",
      AZURE_CLIENT_SECRET: "li$teral # not a comment",
      SPLUNK_TOKEN: "line1\nline2",
      PLAIN: "value",
      EMPTY: "",
      MULTI: "a\nb",
    });
  });
});

describe("env file: an unclosed double quote", () => {
  it("drops that key and still reads the lines after it", () => {
    const text = ['TOKEN="unterminated', "AZURE_CLIENT_SECRET=s3cret", "PLAIN=ok"].join("\n");
    assert.deepEqual(readEnvFile(text), {
      variables: { AZURE_CLIENT_SECRET: "s3cret", PLAIN: "ok" },
      skipped: [1],
    });
  });

  it("reports the lines it skipped, and a file it cannot read", () => {
    const dir = mkdtempSync(join(tmpdir(), "opentide-env-"));
    try {
      const file = join(dir, ".env");
      writeFileSync(file, '# ok\n\nA=1\nnot a line\nB="open\nC=3\n');
      const warnings: string[] = [];
      assert.deepEqual(
        loadEnvFile(file, (m) => warnings.push(m)),
        { A: "1", C: "3" },
      );
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? "", /skipped lines 4, 5 of .*\.env/);
      assert.deepEqual(
        loadEnvFile(join(dir, "missing.env"), (m) => warnings.push(m)),
        {},
      );
      assert.match(warnings[1] ?? "", /could not read .*missing\.env/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
