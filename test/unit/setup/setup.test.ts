import * as assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { Envelope } from "../../../src/core/backend/types";
import { CommandTree } from "../../../src/core/capabilities/tree";
import { CancellationTokenSource } from "../../../src/core/util/cancellation";
import {
  canPlan,
  defaultAnswers,
  type OptionSource,
  planArgv,
  type SetupAnswers,
  script,
  setupCommands,
  setupSupport,
  validateAnswers,
} from "../../../src/features/setup/answers";
import {
  folderKind,
  isGitRepository,
  WALKTHROUGH_COMMANDS,
  walkthroughCommand,
  walkthroughKeys,
} from "../../../src/features/setup/detect";
import { apply, commandLine, NO_PLAN_NOTE, type RunOutcome, review } from "../../../src/features/setup/flow";
import {
  appliedSteps,
  fileToOpen,
  mergePlans,
  parsePlan,
  writtenFiles,
} from "../../../src/features/setup/plan";
import { hostValidators, isAnswers, webviewValidators } from "../../../src/features/setup/protocol";
import { COMMANDS_FIXTURE, ROOT } from "../helpers";

function source(tree: CommandTree): OptionSource {
  return {
    hasCommand: (p) => tree.hasCommand(p),
    hasOption: (p, f) => tree.hasOption(p, f),
    choices: (p, f) => tree.option(p, f)?.choices ?? undefined,
  };
}

/** The pinned fixture, as the released opentide (no --plan). */
const released = () => CommandTree.parse(JSON.parse(readFileSync(COMMANDS_FIXTURE, "utf8")));

/** The same tree with opentide#751: setup --plan and the wizard's flags on setup. */
function withPlan(): CommandTree {
  const document = JSON.parse(readFileSync(COMMANDS_FIXTURE, "utf8"));
  const option = (name: string, multiple = false, choices: string[] | null = null) => ({
    name,
    flags: [`--${name}`],
    secondary_flags: [],
    type: choices ? "choice" : "boolean",
    choices,
    multiple,
    is_flag: !choices,
  });
  for (const command of document.commands) {
    if (!String(command.path).startsWith("setup")) continue;
    command.options.push(option("plan"));
    if (command.path === "setup")
      command.options.push(
        option("mcp", true, ["vscode", "cursor", "claude-code", "generic"]),
        option("skills", true, ["claude-code", "cursor", "github-copilot", "generic"]),
        option("plugin"),
        option("hooks"),
        option("env"),
      );
  }
  return CommandTree.parse(document);
}

const answers = (patch: Partial<SetupAnswers> = {}): SetupAnswers => ({
  ...defaultAnswers("detections"),
  platforms: ["sentinel"],
  ...patch,
});

const envelope = (extra: Record<string, unknown> = {}, exit = 0): Envelope => ({
  ok: exit === 0,
  status: exit === 0 ? "completed" : "failed",
  message: exit === 0 ? "done" : "failed",
  schema_version: 1,
  command: "setup",
  duration_ms: 1,
  exit_code: exit,
  summary: {},
  next_actions: [],
  failure:
    exit === 0
      ? null
      : { code: "usage_error", message: "No such option: --mcp", suggestion: "opentide setup --help" },
  ...extra,
});

describe("setup: answers → commands", () => {
  it("reads what setup accepts from the command tree", () => {
    const old = setupSupport(source(released()));
    assert.equal(old.plan, false);
    assert.equal(old.setupFlags.mcp, false);
    assert.ok(old.platforms.includes("defender_for_endpoint"));
    assert.deepEqual(old.ciProviders, ["github", "gitlab", "azure", "none"]);
    assert.deepEqual(old.mcpHosts, ["vscode", "cursor", "claude-code", "generic"]);
    assert.equal(old.plugin, true);
    const next = setupSupport(source(withPlan()));
    assert.equal(next.plan, true);
    assert.equal(next.subcommandPlan, true);
    assert.deepEqual(next.setupFlags, { mcp: true, skills: true, plugin: true, hooks: true, env: true });
  });

  it("is one setup command with opentide#751", () => {
    const commands = setupCommands(
      answers({
        org: "Example Corp",
        mcp: ["cursor"],
        skills: ["generic"],
        plugin: true,
        pythonVersion: "3.13",
      }),
      "new",
      setupSupport(source(withPlan())),
    );
    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0]?.argv, [
      "setup",
      "--name",
      "detections",
      "--org",
      "Example Corp",
      "--platform",
      "sentinel",
      "--ci",
      "github",
      "--staging",
      "--inflight",
      "--no-sharing",
      "--no-explorer-pages",
      "--python-version",
      "3.13",
      "--env",
      "--hooks",
      "--mcp",
      "cursor",
      "--skills",
      "generic",
      "--plugin",
      "--yes",
    ]);
    assert.deepEqual(planArgv(commands[0] ?? { step: "", argv: [], summary: "" }).slice(-2), [
      "--plugin",
      "--plan",
    ]);
  });

  it("runs setup, then env, hooks, mcp and skills as subcommands on the released opentide", () => {
    const commands = setupCommands(
      answers({ ci: "none", mcp: ["cursor", "claude-code"], skills: ["generic"], plugin: true }),
      "new",
      setupSupport(source(released())),
    );
    assert.deepEqual(
      commands.map((c) => c.argv.join(" ")),
      [
        "setup --name detections --platform sentinel --yes",
        "setup env --yes",
        "setup hooks --yes",
        "setup mcp --cursor --claude-code --yes",
        "setup skills --generic --plugin --yes",
      ],
    );
    assert.match(commands[0]?.summary ?? "", /Scaffold detections .* with sentinel\./);
    assert.equal(
      canPlan(commands[0] ?? { step: "setup", argv: [], summary: "" }, setupSupport(source(released()))),
      false,
    );
  });

  it("adds only what an existing repository lacks, with subcommands", () => {
    const commands = setupCommands(
      answers({
        platforms: ["sentinel", "defender_for_endpoint"],
        ci: "gitlab",
        hooks: false,
        env: false,
        defaultBranch: "trunk",
      }),
      "existing",
      setupSupport(source(withPlan())),
      ["sentinel"],
    );
    assert.deepEqual(
      commands.map((c) => c.argv.join(" ")),
      [
        "setup platforms --defender-for-endpoint --yes",
        "setup ci gitlab --staging --inflight --no-sharing --default-branch trunk --yes",
      ],
    );
  });

  it("checks the answers per step", () => {
    assert.deepEqual(validateAnswers(answers(), "new"), []);
    assert.deepEqual(
      validateAnswers(
        answers({ name: " ", platforms: [], pythonVersion: "three", defaultBranch: "a b" }),
        "new",
      ).map((p) => p.step),
      [1, 2, 3, 3],
    );
    const nothing = answers({ platforms: ["sentinel"], ci: "none", hooks: false, env: false });
    assert.deepEqual(
      validateAnswers(nothing, "existing", ["sentinel"]).map((p) => p.step),
      [2],
    );
  });

  it("copies as a script that runs in the repository", () => {
    const commands = setupCommands(
      answers({ name: "My Detections", ci: "none", hooks: false, env: false }),
      "new",
      setupSupport(source(released())),
    );
    assert.equal(
      script(commands, "/home/me/my repo"),
      "#!/bin/sh\n# opentide setup, as the VS Code wizard ran it\nset -e\ncd '/home/me/my repo'\nopentide setup --name 'My Detections' --platform sentinel --yes\n",
    );
    assert.equal(commandLine(["setup", "env", "--yes"]), "opentide setup env --yes");
  });
});

// `opentide --json setup --plan …` on the opentide#751 branch (trimmed).
const PLAN = {
  plan: true,
  path: "/repo",
  steps: [
    {
      step: "repo",
      files: [
        { path: ".gitignore", action: "create" },
        { path: "README.md", action: "create" },
      ],
      warnings: [],
    },
    {
      step: "platforms",
      files: [{ path: ".opentide/configurations/platforms/sentinel.toml", action: "skip" }],
      warnings: [],
    },
    {
      step: "env",
      files: [
        { path: ".env.example", action: "create" },
        { path: ".gitignore", action: "merge" },
      ],
      warnings: [],
    },
    {
      step: "hooks",
      files: [{ path: ".pre-commit-config.yaml", action: "create" }],
      warnings: ["Not a Git repository; wrote hook files without installing .git/hooks."],
    },
  ],
  warnings: ["Not a Git repository; wrote hook files without installing .git/hooks."],
  summary: { create: 4, merge: 1, skip: 1, steps: 4 },
};

// `opentide --json setup --yes …` on 0.21.0 (trimmed).
const APPLIED = {
  steps: [
    {
      step: "repo",
      message: "Repository scaffold created",
      files: ["README.md", ".gitignore"],
      platform_files: [".opentide/configurations/platforms/sentinel.toml"],
    },
    { step: "platforms", message: "Platform configuration files already present", files: [], skipped: ["x"] },
  ],
};

describe("setup: plans and results", () => {
  it("parses a plan and lists exactly the files Apply writes", () => {
    const steps = parsePlan(PLAN);
    assert.ok(steps);
    const plan = mergePlans([{ steps, warnings: PLAN.warnings }]);
    assert.deepEqual(plan.summary, { create: 4, merge: 1, skip: 1 });
    assert.deepEqual(writtenFiles(plan), [
      ".gitignore",
      "README.md",
      ".env.example",
      ".pre-commit-config.yaml",
    ]);
    assert.equal(plan.warnings.length, 1);
    assert.equal(parsePlan({ steps: [] }), undefined, "not a plan without plan: true");
  });

  it("reads the steps a setup run completed, and what to open", () => {
    const steps = appliedSteps(APPLIED, "setup");
    assert.deepEqual(steps[0]?.files, [
      "README.md",
      ".gitignore",
      ".opentide/configurations/platforms/sentinel.toml",
    ]);
    assert.equal(fileToOpen(steps), "README.md");
    const sub = appliedSteps({ files: [".env.example", ".gitignore"], message: "Wrote 2 files" }, "env");
    assert.deepEqual(sub, [
      { step: "env", message: "Wrote 2 files", files: [".env.example", ".gitignore"], warnings: [] },
    ]);
    assert.equal(fileToOpen(sub), ".env.example");
  });
});

describe("setup: review and apply", () => {
  it("reviews with setup --plan, writing nothing", async () => {
    const runs: string[][] = [];
    const result = await review({
      answers: answers(),
      mode: "new",
      support: setupSupport(source(withPlan())),
      enabled: [],
      run: async (argv) => {
        runs.push([...argv]);
        return { document: envelope(PLAN), exitCode: 0, cancelled: false };
      },
    });
    assert.equal(runs.length, 1);
    assert.ok(runs[0]?.includes("--plan") && !runs[0]?.includes("--yes"));
    assert.deepEqual(result.totals, { create: 4, merge: 1, skip: 1 });
    assert.equal(result.steps[0]?.files?.[0]?.step, "repo");
    assert.equal(result.note, undefined);
  });

  it("describes the steps without running anything when this opentide cannot plan", async () => {
    const result = await review({
      answers: answers(),
      mode: "new",
      support: setupSupport(source(released())),
      enabled: [],
      run: async () => assert.fail("no command runs"),
    });
    assert.equal(result.note, NO_PLAN_NOTE);
    assert.equal(result.steps.length, 3);
    assert.equal(result.steps[0]?.files, undefined);
    assert.match(result.steps[0]?.command ?? "", /^opentide setup --name detections/);
  });

  it("reports problems before planning, and a failed plan", async () => {
    const problems = await review({
      answers: answers({ platforms: [] }),
      mode: "new",
      support: setupSupport(source(withPlan())),
      enabled: [],
      run: async () => assert.fail("no plan with problems"),
    });
    assert.equal(problems.problems[0]?.step, 2);
    const failed = await review({
      answers: answers(),
      mode: "new",
      support: setupSupport(source(withPlan())),
      enabled: [],
      run: async () => ({ document: envelope({}, 2), exitCode: 2, cancelled: false }),
    });
    assert.match(failed.error ?? "", /failed: No such option: --mcp opentide setup --help$/);
  });

  it("applies in order, showing each command's steps, and stops at the first failure", async () => {
    const support = setupSupport(source(released()));
    const commands = setupCommands(answers({ ci: "none", mcp: ["cursor"] }), "new", support);
    const seen: string[] = [];
    const progress = await apply({
      commands,
      run: async (argv): Promise<RunOutcome> => {
        seen.push(argv.join(" "));
        if (argv[1] === "hooks") return { document: envelope({}, 1), exitCode: 1, cancelled: false };
        return {
          document: envelope(
            argv[1] === "--name" ? APPLIED : { files: [".env.example"], message: "Wrote 1 file" },
          ),
          exitCode: 0,
          cancelled: false,
        };
      },
      onProgress: () => {},
    });
    assert.deepEqual(seen, [
      "setup --name detections --platform sentinel --yes",
      "setup env --yes",
      "setup hooks --yes",
    ]);
    assert.equal(progress.ok, false);
    assert.deepEqual(
      progress.commands.map((c) => c.status),
      ["ok", "ok", "failed", "pending"],
    );
    assert.equal(progress.commands[0]?.steps[0]?.files[0], "README.md");
    assert.deepEqual(progress.commands[2]?.failure, {
      message: "No such option: --mcp",
      fix: "opentide setup --help",
    });
  });

  it("stops when cancelled", async () => {
    const source1 = new CancellationTokenSource();
    const commands = setupCommands(answers({ ci: "none" }), "new", setupSupport(source(released())));
    const progress = await apply({
      commands,
      run: async () => {
        source1.cancel();
        return { document: envelope(), exitCode: 0, cancelled: false };
      },
      onProgress: () => {},
      token: source1.token,
    });
    assert.deepEqual(
      progress.commands.map((c) => c.status),
      ["ok", "cancelled", "pending"],
    );
    assert.equal(progress.done, true);
  });
});

describe("setup: folders, walkthrough and messages", () => {
  it("knows an opentide repository, a legacy layout and an empty folder", () => {
    const dir = (name: string) => ({ name, directory: true });
    const file = (name: string) => ({ name, directory: false });
    assert.equal(folderKind([dir(".opentide")]), "opentide");
    assert.equal(folderKind([dir("objects"), file("x")]), "opentide");
    assert.equal(folderKind([dir("Configurations"), dir("Objects")]), "legacy");
    // CoreTIDE is not supported (0.21.0): any of its markers is enough to say so.
    assert.equal(folderKind([dir("Objects")]), "legacy");
    assert.equal(folderKind([file("global.toml")]), "legacy");
    assert.equal(folderKind([dir("objects"), dir("Objects")]), "opentide");
    assert.equal(folderKind([dir(".git"), file("README.md"), file(".DS_Store")]), "empty");
    assert.equal(folderKind([]), "empty");
    assert.equal(folderKind([dir("src")]), "other");
    assert.equal(isGitRepository([dir(".git")]), true);
    assert.equal(isGitRepository([file(".git")]), true, "a worktree's .git is a file");
  });

  it("completes walkthrough steps from the runs that do them", () => {
    assert.deepEqual(walkthroughKeys({ argv: ["validate"], status: "failed" }), ["opentide.setup.validated"]);
    assert.deepEqual(walkthroughKeys({ argv: ["validate", "query"], status: "ok" }), []);
    assert.deepEqual(walkthroughKeys({ argv: ["deploy", "--dry-run"], status: "ok" }), [
      "opentide.setup.deployPreviewed",
    ]);
    assert.deepEqual(walkthroughKeys({ argv: ["deploy"], status: "ok" }), []);
    assert.deepEqual(walkthroughKeys({ argv: ["new", "rule", "--name", "x"], status: "ok" }), [
      "opentide.setup.created",
    ]);
    assert.deepEqual(
      walkthroughKeys({ argv: ["setup", "--name", "x", "--mcp", "cursor", "--yes"], status: "ok" }),
      ["opentide.setup.done", "opentide.setup.agentReady"],
    );
    assert.deepEqual(walkthroughKeys({ argv: ["setup", "--plan", "--name", "x"], status: "ok" }), []);
    assert.deepEqual(walkthroughKeys({ argv: ["setup", "mcp", "--cursor", "--yes"], status: "ok" }), [
      "opentide.setup.agentReady",
    ]);
    assert.deepEqual(walkthroughKeys({ argv: ["setup", "--name", "x"], status: "failed" }), []);
    assert.deepEqual(walkthroughKeys({ argv: ["validate"], status: "running" }), []);
  });

  it("validates the webview's messages", () => {
    assert.equal(isAnswers(answers()), true);
    assert.equal(isAnswers({ ...answers(), ci: "jenkins" }), false);
    assert.equal(isAnswers({ ...answers(), platforms: ["Sentinel; rm"] }), false);
    assert.equal(isAnswers({ ...answers(), mcp: ["emacs"] }), false);
    assert.equal(hostValidators.openFile("README.md"), true);
    assert.equal(hostValidators.openFile("../secrets"), false);
    assert.equal(hostValidators.openFile("/etc/passwd"), false);
    assert.equal(hostValidators.openFile("C:\\x"), false);
    assert.equal(webviewValidators.review({ steps: [], problems: [] }), true);
    assert.equal(webviewValidators.progress({}), false);
  });
});

describe("setup: manifest", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    contributes: {
      commands: { command: string }[];
      walkthroughs: {
        id: string;
        steps: {
          id: string;
          description: string;
          media: { markdown?: string; svg?: string; altText?: string };
          completionEvents: string[];
        }[];
      }[];
      viewsWelcome: { view: string; contents: string }[];
    };
    files?: string[];
  };
  const declared = new Set(pkg.contributes.commands.map((c) => c.command));
  const links = (text: string) => [...text.matchAll(/\(command:([\w.]+)/g)].map((m) => m[1] ?? "");
  const builtIn = new Set(["vscode.openFolder", "workbench.trust.manage"]);

  it("has the seven walkthrough steps of SPEC §8, with media that exists and real completion events", () => {
    const walkthrough = pkg.contributes.walkthroughs.find((w) => w.id === "opentide.gettingStarted");
    // "fit" comes in two variants: with `info catalog`, and without (it leads to a newer opentide);
    // "agent" too: VS Code, which gets the MCP server from the extension, and a fork, which needs it added.
    assert.deepEqual(
      walkthrough?.steps.map((s) => s.id),
      ["ready", "setup", "create", "validate", "fit", "fitNeedsCatalog", "deploy", "agent", "agentFork"],
    );
    for (const step of walkthrough?.steps ?? []) {
      const media = step.media.markdown ?? step.media.svg ?? "";
      assert.ok(media.startsWith("media/walkthrough/"), step.id);
      assert.ok(existsSync(path.join(ROOT, media)), media);
      if (step.media.svg) assert.ok(step.media.altText, `${step.id} has alt text`);
      assert.ok(step.completionEvents.length > 0);
      for (const event of step.completionEvents) assert.match(event, /^on(Command|Context):[\w.]+$/);
      for (const command of links(step.description))
        assert.ok(declared.has(command), `${step.id}: ${command}`);
    }
  });

  it("runs each walkthrough button's real command (no guessed ids)", () => {
    for (const command of Object.values(WALKTHROUGH_COMMANDS)) assert.ok(declared.has(command), command);
    assert.equal(walkthroughCommand("deploy"), "opentide.deployPlan.open");
    assert.equal(walkthroughCommand("graph"), "opentide.graph.open");
    assert.equal(walkthroughCommand("toString"), undefined);
    const walkthrough = pkg.contributes.walkthroughs.find((w) => w.id === "opentide.gettingStarted");
    for (const step of walkthrough?.steps ?? [])
      for (const m of step.description.matchAll(/command:opentide\.setup\.step\?([^)]+)\)/g)) {
        const [id] = JSON.parse(decodeURIComponent(m[1] ?? "")) as string[];
        assert.ok(walkthroughCommand(id ?? ""), `${step.id}: ${id}`);
      }
  });

  it("links welcome views only to commands that exist", () => {
    for (const welcome of pkg.contributes.viewsWelcome)
      for (const command of links(welcome.contents))
        assert.ok(declared.has(command) || builtIn.has(command), `${welcome.view}: ${command}`);
  });

  it("offers no migration: opentide 0.21.0 removed migrate objects", () => {
    assert.ok(!declared.has("opentide.setup.migrate"));
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      activationEvents: string[];
    };
    assert.deepEqual(
      manifest.activationEvents.filter((event) => event.includes("Objects/")),
      [],
    );
    for (const welcome of pkg.contributes.viewsWelcome)
      assert.doesNotMatch(welcome.contents, /migrat(e|ion)\]/i);
    const legacy = pkg.contributes.viewsWelcome.find((w) => w.contents.includes("CoreTIDE"));
    assert.ok(legacy?.contents.includes("does not support"));
  });

  it("ships the walkthrough media in the VSIX", () => {
    assert.ok(readFileSync(path.join(ROOT, ".vscodeignore"), "utf8").includes("!media/walkthrough/**"));
  });
});
