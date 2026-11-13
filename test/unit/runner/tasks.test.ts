import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { classify } from "../../../src/core/capabilities/classification";
import {
  cmdQuote,
  launcherDir,
  launcherFiles,
  msysPath,
  needsLauncher,
  prependPath,
  runsAsModule,
  shouldAddToPath,
  shQuote,
} from "../../../src/features/runner/launcher";
import { terminalMatches } from "../../../src/features/runner/links";
import {
  isTaskDefinition,
  providedTasks,
  taskArgv,
  taskEnv,
  taskName,
  taskPlan,
  whenTaskReady,
} from "../../../src/features/runner/tasks";
import { fakeRuntime, ROOT } from "../helpers";
import { matchProblems } from "./matcher";

describe("runner tasks", () => {
  it("provides validate, lint, generate, the deploy dry run and validate query, when opentide has them", () => {
    assert.deepEqual(
      providedTasks(() => true).map((t) => t.name),
      ["validate", "lint", "generate", "deploy --dry-run", "validate query"],
    );
    assert.deepEqual(
      providedTasks((p) => p === "lint").map((t) => t.name),
      ["lint"],
    );
  });

  it("reads tasks.json definitions", () => {
    assert.ok(isTaskDefinition({ type: "opentide", command: "validate", args: ["--strict"] }));
    assert.ok(!isTaskDefinition({ type: "opentide", command: "" }));
    assert.ok(!isTaskDefinition({ type: "shell", command: "validate" }));
    assert.ok(!isTaskDefinition({ type: "opentide", command: "lint", args: [1] }));
    const definition = { type: "opentide" as const, command: "validate  query", args: ["--live"] };
    assert.deepEqual(taskArgv(definition), ["validate", "query", "--live"]);
    assert.equal(taskName(definition), "validate query --live");
  });

  it("never deploys from a task: a deploy runs as its dry run, and what has none is refused", () => {
    const deploy = { type: "opentide" as const, command: "deploy", args: ["--platform", "sentinel"] };
    assert.deepEqual(taskPlan(deploy, classify(taskArgv(deploy)), true), {
      kind: "confirm",
      argv: ["deploy", "--platform", "sentinel", "--dry-run"],
      dryRunAdded: true,
    });
    const migrate = { type: "opentide" as const, command: "deploy migrate-state" };
    assert.equal(taskPlan(migrate, classify(taskArgv(migrate)), false).kind, "refuse");
    const validate = { type: "opentide" as const, command: "validate" };
    assert.deepEqual(taskPlan(validate, classify(["validate"]), false), { kind: "run", argv: ["validate"] });
  });

  it("gives tasks whole code frames and the folder, plus credentials when given", () => {
    assert.deepEqual(taskEnv("/ws", { UV_X: "1" }, undefined, { SECRET: "s" }), {
      UV_X: "1",
      OPENTIDE_REPO_ROOT: "/ws",
      OPENTIDE_LINKS: "none",
      COLUMNS: "4096",
      SECRET: "s",
    });
  });

  it("passes VS Code's http.proxy to tasks and terminal runs as OPENTIDE_PROXY", () => {
    assert.equal(taskEnv("/ws", {}, "http://proxy:3128").OPENTIDE_PROXY, "http://proxy:3128");
    assert.equal(
      taskEnv("/ws", {}, "http://proxy:3128", { OPENTIDE_PROXY: "http://env-file:8080" }).OPENTIDE_PROXY,
      "http://env-file:8080",
      "the env file's own OPENTIDE_PROXY wins, as in the backend",
    );
    assert.ok(!("OPENTIDE_PROXY" in taskEnv("/ws", {}, undefined)));
  });

  it("$opentide reads opentide's code frames, notes and the ASCII fallback included", () => {
    const text = readFileSync(path.join(ROOT, "test", "fixtures", "runner", "frames.txt"), "utf8");
    assert.deepEqual(matchProblems(text), [
      {
        severity: "error",
        code: "vocab_unknown",
        message: "'ambr' is not a TLP value",
        file: "objects/rules/suspicious-lsass-access-0.yaml",
        line: 9,
        column: 8,
      },
      {
        severity: "error",
        code: "kql_parse_error",
        message: "KQL syntax error",
        file: "objects/rules/suspicious-lsass-access-0.yaml",
        line: 60,
        column: 7,
      },
      {
        severity: "note",
        code: "metadata_recommended",
        message: "Recommended metadata missing: organisation",
        file: "objects/objectives/detect-lsass-access.yaml",
        line: 3,
        column: 1,
      },
      {
        severity: "warning",
        code: "placeholder",
        message: "priority holds a placeholder value written by opentide new",
        file: "objects/objectives/detect-lsass-access.yaml",
        line: 17,
        column: 13,
      },
      {
        severity: "warning",
        code: "filename_mismatch",
        message: "file name does not match the object name",
        file: "objects/rules/x.yaml",
        line: 1,
      },
      {
        severity: "error",
        code: "configuration_invalid",
        message: "a configuration file does not parse",
        file: ".opentide/configurations/platforms/sentinel.toml",
        line: 4,
        column: 1,
      },
    ]);
    assert.deepEqual(matchProblems("✗ 4 errors in 3 files\n→ opentide explain vocab_unknown"), []);
  });

  it("matches Windows paths", () => {
    assert.deepEqual(matchProblems("error[schema]: bad\n  ╭─▶ C:\\ws\\objects\\r.yaml:2:3\n"), [
      {
        severity: "error",
        code: "schema",
        message: "bad",
        file: "C:\\ws\\objects\\r.yaml",
        line: 2,
        column: 3,
      },
    ]);
  });
});

describe("runner launcher", () => {
  const runtime = {
    command: "/ext/runtime/bin/python3",
    args: ["-I", "-m", "opentide"],
    env: { UV_CACHE: "it's" },
  };

  it("writes a POSIX script that runs the runtime as the extension does", () => {
    const [file] = launcherFiles(runtime, "linux");
    assert.equal(file?.name, "opentide");
    assert.equal(file?.mode, 0o755);
    assert.equal(
      file?.content,
      [
        "#!/bin/sh",
        "# Generated by the opentide VS Code extension: runs the opentide runtime it uses.",
        "UV_CACHE='it'\\''s'; export UV_CACHE",
        `exec '/ext/runtime/bin/python3' '-I' '-m' 'opentide' "$@"`,
        "",
      ].join("\n"),
    );
  });

  it("writes a batch file on Windows, with % never expanded", () => {
    const [file] = launcherFiles(
      {
        command: "C:\\Users\\me\\.vscode\\ext\\runtime\\python.exe",
        args: ["-I", "-X", "pycache_prefix=C:\\100%"],
        env: { A: "1" },
      },
      "win32",
    );
    assert.equal(file?.name, "opentide.cmd");
    assert.deepEqual(
      launcherFiles(
        { command: "C:\\Users\\me\\python.exe", args: ["-I", "-m", "opentide"], env: { A: "1" } },
        "win32",
      ).map((f) => [f.name, f.content])[1],
      [
        "opentide",
        [
          "#!/bin/sh",
          "# Generated by the opentide VS Code extension: runs the opentide runtime it uses.",
          "A='1'; export A",
          `exec 'C:/Users/me/python.exe' '-I' '-m' 'opentide' "$@"`,
          "",
        ].join("\n"),
      ],
      "Git Bash, which ignores PATHEXT, finds an extensionless sh launcher with an MSYS path",
    );
    assert.ok(file?.content.includes('set "A=1"\r\n'));
    assert.ok(
      file?.content.endsWith(
        '"C:\\Users\\me\\.vscode\\ext\\runtime\\python.exe" "-I" "-X" "pycache_prefix=C:\\100%%" %*\r\n',
      ),
    );
    assert.throws(() => cmdQuote('a"b'));
    assert.equal(shQuote("a b"), "'a b'");
  });

  it("reads a non-ASCII path in UTF-8 on Windows, and restores the code page and exit code", () => {
    const command = "C:\\Users\\Jörg & ^x %y\\.vscode\\ext\\runtime\\python.exe";
    const [file] = launcherFiles({ command, args: ["-I", "-m", "opentide"], env: { A: "1" } }, "win32");
    const lines = file?.content.split("\r\n") ?? [];
    const switchAt = lines.indexOf("chcp 65001 >nul");
    const commandAt = lines.findIndex((line) => line.includes("Jörg"));
    assert.ok(switchAt > 0 && switchAt < commandAt, "cmd.exe switches to UTF-8 before the path");
    assert.ok(
      lines.slice(0, switchAt).every((line) => /^[ -~]*$/.test(line)),
      "ASCII before the switch",
    );
    assert.ok(
      lines
        .slice(0, switchAt)
        .some((line) => line.includes("('chcp')") && line.includes("OPENTIDE_LAUNCHER_CP")),
      "the console's code page is saved first",
    );
    // One variable per token, NAME=value in one quoted region: `&` and `^` stay literal, `%` is doubled.
    assert.deepEqual(lines.slice(commandAt), [
      'set "OPENTIDE_LAUNCHER_ARG0=C:\\Users\\Jörg & ^x %%y\\.vscode\\ext\\runtime\\python.exe"',
      'set "OPENTIDE_LAUNCHER_ARG1=-I"',
      'set "OPENTIDE_LAUNCHER_ARG2=-m"',
      'set "OPENTIDE_LAUNCHER_ARG3=opentide"',
      // The code page is back before opentide runs: Ctrl+C at "Terminate batch job" cannot skip it.
      "if defined OPENTIDE_LAUNCHER_CP chcp %OPENTIDE_LAUNCHER_CP% >nul",
      'set "OPENTIDE_LAUNCHER_CP="',
      'set "OPENTIDE_LAUNCHER_ARG0=" & set "OPENTIDE_LAUNCHER_ARG1=" & set "OPENTIDE_LAUNCHER_ARG2=" & ' +
        'set "OPENTIDE_LAUNCHER_ARG3=" & "%OPENTIDE_LAUNCHER_ARG0%" "%OPENTIDE_LAUNCHER_ARG1%" ' +
        '"%OPENTIDE_LAUNCHER_ARG2%" "%OPENTIDE_LAUNCHER_ARG3%" %*',
      "",
    ]);
    const [ascii] = launcherFiles({ command: "C:\\Users\\me\\python.exe", args: [], env: {} }, "win32");
    assert.ok(!ascii?.content.includes("chcp"), "an ASCII launcher leaves the code page alone");
  });

  it("runs a non-ASCII launcher in cmd.exe with its arguments, variables and exit code", function () {
    if (process.platform !== "win32") this.skip();
    const dir = mkdtempSync(path.join(os.tmpdir(), "otl-"));
    try {
      // cmd.exe's special characters too: `&` splits a command, `^` escapes, `%` expands.
      const folder = path.join(dir, "Jörg & ^x %y");
      mkdirSync(folder);
      const probe = path.join(folder, "probe.js");
      writeFileSync(
        probe,
        "process.stdout.write(JSON.stringify([process.env.A, process.argv.slice(1), Object.keys(process.env).filter((k) => k.startsWith('OPENTIDE_LAUNCHER'))])); process.exit(7);",
      );
      const [file] = launcherFiles(
        { command: process.execPath, args: [probe], env: { A: "Zoë & ^x %y" } },
        "win32",
      );
      const launcher = path.join(dir, "opentide.cmd");
      writeFileSync(launcher, file?.content ?? "");
      const run = spawnSync("cmd.exe", ["/d", "/c", launcher, "x y"], { encoding: "utf8" });
      assert.equal(run.status, 7, run.stderr);
      assert.deepEqual(
        JSON.parse(run.stdout),
        ["Zoë & ^x %y", [probe, "x y"], []],
        "the path and variable as written, and the launcher's own variables cleared",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves PATH and names that are not variables out of the script", () => {
    const [file] = launcherFiles(
      { command: "/x", args: [], env: { PATH: "/evil", "BAD NAME": "x", OK: "y" } },
      "darwin",
    );
    assert.ok(!file?.content.includes("/evil"));
    assert.ok(!file?.content.includes("BAD NAME"));
    assert.ok(file?.content.includes("OK='y'; export OK"));
  });

  it("writes Windows paths the way MSYS bash takes them, and leaves the rest", () => {
    assert.equal(msysPath("C:\\a b\\py.exe"), "C:/a b/py.exe");
    assert.equal(msysPath("\\\\server\\share\\py.exe"), "//server/share/py.exe");
    assert.equal(msysPath("-I"), "-I");
    assert.equal(msysPath("pycache_prefix=C:\\x"), "pycache_prefix=C:\\x");
  });

  it("puts each runtime's launcher in a folder of its own", () => {
    const a = launcherDir("/gs", runtime);
    assert.equal(a, launcherDir("/gs", { ...runtime }));
    assert.notEqual(a, launcherDir("/gs", { ...runtime, command: "/other/python3" }));
    assert.ok(a.startsWith(path.join("/gs", "bin")));
  });

  it("prepends to PATH, as Windows spells it", () => {
    assert.deepEqual(prependPath({ Path: "C:\\Windows" }, "C:\\gs\\bin", "win32"), {
      key: "Path",
      value: "C:\\gs\\bin;C:\\Windows",
    });
    assert.deepEqual(prependPath({ PATH: "/usr/bin" }, "/gs/bin", "linux"), {
      key: "PATH",
      value: "/gs/bin:/usr/bin",
    });
    assert.deepEqual(prependPath({}, "/gs/bin", "linux"), { key: "PATH", value: "/gs/bin" });
  });

  it("adds an opentide command to terminals only for `python -m opentide`, when nothing else provides one", () => {
    const base = { module: true, restricted: false, setting: true, opentideOnPath: false };
    assert.ok(shouldAddToPath(base));
    assert.ok(shouldAddToPath({ ...base, setting: undefined }), "default on");
    assert.ok(!shouldAddToPath({ ...base, setting: false }));
    assert.ok(!shouldAddToPath({ ...base, restricted: true }));
    assert.ok(!shouldAddToPath({ ...base, opentideOnPath: true }));
    assert.ok(!shouldAddToPath({ ...base, module: false }));
  });

  it("writes a launcher for the bundled @opentide/opentide, which has no opentide command of its own", () => {
    const runtime = {
      source: "package",
      command: "/opt/code/code",
      args: ["/ext/dist/opentide/cli.js"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
    assert.ok(needsLauncher(runtime));
    assert.ok(needsLauncher({ source: "python", args: ["-m", "opentide"] }));
    assert.ok(!needsLauncher({ source: "path", args: [] }));
    assert.ok(!needsLauncher(undefined));
    const [file] = launcherFiles(runtime, "linux");
    assert.equal(
      file?.content,
      "#!/bin/sh\n# Generated by the opentide VS Code extension: runs the opentide runtime it uses.\n" +
        "ELECTRON_RUN_AS_NODE='1'; export ELECTRON_RUN_AS_NODE\n" +
        "exec '/opt/code/code' '/ext/dist/opentide/cli.js' \"$@\"\n",
    );
  });

  it("knows a runtime that runs opentide as a module", () => {
    assert.ok(runsAsModule(["-m", "opentide"]));
    assert.ok(runsAsModule(["-3", "-m", "opentide"]));
    assert.ok(!runsAsModule([]));
    assert.ok(!runsAsModule(["tool", "run", "--from", "opentide==0.22.0", "opentide"]));
    assert.ok(!runsAsModule(undefined));
  });

  it("runs opentide --version through the generated script", function () {
    if (process.platform === "win32") this.skip();
    const dir = mkdtempSync(path.join(os.tmpdir(), "opentide-launcher-"));
    try {
      const fake = fakeRuntime();
      for (const file of launcherFiles(fake, process.platform)) {
        writeFileSync(path.join(dir, file.name), file.content, { mode: file.mode });
      }
      const result = spawnSync("sh", ["-c", "opentide --version"], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), "opentide 0.21.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runner terminal links", () => {
  it("finds object UUIDs and diagnostic codes", () => {
    const line = "error[vocab_unknown]: in 5F0C2D9A-1111-4222-8333-444455556666 (help[x_y])";
    assert.deepEqual(terminalMatches(line), [
      { start: 0, length: 20, kind: "code", value: "vocab_unknown" },
      { start: 25, length: 36, kind: "uuid", value: "5f0c2d9a-1111-4222-8333-444455556666" },
      { start: 63, length: 9, kind: "code", value: "x_y" },
    ]);
    assert.deepEqual(terminalMatches("nothing here: error[] or 1234-5678"), []);
  });
});

describe("runner: resolving a tasks.json task at window open", () => {
  it("waits for the runtime, then its command tree, before the task is built", async () => {
    const order: string[] = [];
    let current: ReturnType<typeof fakeRuntime> | undefined;
    let resolveRuntime: () => void = () => undefined;
    const runtime = {
      get current() {
        return current;
      },
      ready: () =>
        new Promise<void>((resolve) => {
          resolveRuntime = () => {
            current = fakeRuntime();
            order.push("runtime");
            resolve();
          };
        }),
    };
    const capabilities = {
      ready: async () => {
        order.push("commands");
      },
    };
    const waiting = whenTaskReady({ trusted: true, runtime, capabilities }).then(() => order.push("build"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(order, [], "nothing is built while the runtime resolves");
    resolveRuntime();
    await waiting;
    assert.deepEqual(order, ["runtime", "commands", "build"]);
  });

  it("does not wait for commands without a runtime, nor for anything in Restricted Mode", async () => {
    const seen: string[] = [];
    const runtime = { current: undefined, ready: async () => void seen.push("runtime") };
    const capabilities = { ready: async () => void seen.push("commands") };
    await whenTaskReady({ trusted: true, runtime, capabilities });
    await whenTaskReady({ trusted: false, runtime, capabilities });
    assert.deepEqual(seen, ["runtime"]);
  });
});
