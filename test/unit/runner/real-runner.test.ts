// The runner against a real opentide: OPENTIDE_TEST_BIN and OPENTIDE_TEST_WORKSPACE (see
// test/unit/real-opentide.test.ts). Skipped when either is missing.
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnRun } from "../../../src/core/backend/spawn";
import type { Envelope } from "../../../src/core/backend/types";
import { classify } from "../../../src/core/capabilities/classification";
import { CommandTree } from "../../../src/core/capabilities/tree";
import { processEnv } from "../../../src/core/runtime/env";
import type { Runtime } from "../../../src/core/runtime/types";
import {
  explainEntries,
  explainMarkdown,
  generateChoices,
  generatePhases,
  unreviewedRules,
  vocabularies,
  vocabularyMarkdown,
} from "../../../src/features/runner/bespoke";
import { runnableCommands } from "../../../src/features/runner/commands";
import { buildArgv, fieldsOf, requiredFields } from "../../../src/features/runner/form";
import { launcherFiles } from "../../../src/features/runner/launcher";
import { explainCodes, summarize } from "../../../src/features/runner/result";
import { DRY_RUN, planRun } from "../../../src/features/runner/safety";
import { taskEnv } from "../../../src/features/runner/tasks";
import { reachOf } from "../../../src/features/runner/tenants";
import { matchProblems } from "./matcher";

const BIN = process.env.OPENTIDE_TEST_BIN;
const WORKSPACE = process.env.OPENTIDE_TEST_WORKSPACE;
const available = Boolean(BIN && WORKSPACE && existsSync(BIN) && existsSync(WORKSPACE));

describe("runner against a real opentide (OPENTIDE_TEST_BIN)", function () {
  this.timeout(120_000);
  let runtime: Runtime;
  let tree: CommandTree;
  let workspace: string;

  const json = async (argv: string[]): Promise<{ document: Envelope; exitCode: number }> => {
    const result = await spawnRun({
      command: runtime.command,
      args: [...runtime.args, "--json", ...argv],
      commandName: argv[0] ?? "",
      env: processEnv(process.env, runtime, process.platform, {
        NO_COLOR: "1",
        OPENTIDE_REPO_ROOT: workspace,
      }),
      cwd: workspace,
      platform: process.platform,
    });
    return { document: result.document, exitCode: result.exitCode };
  };

  before(async function () {
    if (!available) this.skip();
    workspace = WORKSPACE as string;
    const version = spawnSync(BIN as string, ["--version"], { encoding: "utf8" })
      .stdout.trim()
      .split(/\s+/)
      .pop();
    runtime = {
      tier: 1,
      source: "setting",
      kind: "opentide",
      command: BIN as string,
      args: [],
      version: version ?? "",
      env: {},
      restricted: false,
      binDirs: [path.dirname(BIN as string)],
    };
    tree = CommandTree.parse((await json(["commands"])).document);
  });

  it("builds a form for every runnable command, all of them classified", () => {
    const entries = runnableCommands(tree, (argv) => classify(argv));
    assert.ok(entries.length > 30);
    for (const entry of entries) {
      assert.ok(!entry.classification.unclassified, entry.command.path);
      const fields = fieldsOf(entry.command);
      const values = new Map(requiredFields(fields).map((f) => [f.id, [f.choices[0] ?? "x"]] as const));
      const argv = buildArgv(entry.command, fields, values);
      assert.deepEqual(tree.commandPathOf(argv).path, entry.command.path);
    }
  });

  it("never runs a deploy or share without --dry-run", () => {
    for (const command of tree.commands) {
      const argv = command.path.split(" ");
      const plan = planRun(argv, command.path, classify(argv), tree.hasOption(command.path, DRY_RUN));
      const cls = classify(argv).class;
      if (cls === "deploys" || cls === "shares")
        assert.ok(plan.kind === "refuse" || plan.argv.includes(DRY_RUN), command.path);
    }
  });

  it("reads generate's phases and subcommands", () => {
    assert.deepEqual(generatePhases(tree.command("generate")?.help), [
      "schemas",
      "templates",
      "vocabs",
      "snippets",
    ]);
    assert.ok(generateChoices(tree).some((c) => c.id === "docs"));
  });

  it("knows the explainable codes and renders one", async () => {
    const list = await json(["explain"]);
    const codes = explainCodes(list.document);
    assert.ok(codes.has("vocab_unknown") && codes.has("workspace_not_found"));
    assert.equal(explainEntries(list.document).length, codes.size);
    const one = await json(["explain", "vocab_unknown"]);
    assert.ok(explainMarkdown(one.document).startsWith("# vocab_unknown"));
  });

  it("shows a vocabulary as Markdown", async () => {
    const list = await json(["info", "vocab"]);
    assert.ok(vocabularies(list.document).some((v) => v.name === "tlp"));
    const tlp = await json(["info", "vocab", "tlp"]);
    const markdown = vocabularyMarkdown(tlp.document, "opentide --json info vocab tlp");
    assert.match(markdown, /^# tlp: Traffic Light Protocol/);
    assert.match(markdown, /## Revisions/);
  });

  it("lists unreviewed rules and platforms", async () => {
    const result = await json(["rules", "unreviewed"]);
    assert.equal(result.exitCode, 0);
    const rules = unreviewedRules(result.document);
    assert.equal(rules.length, Number((result.document as { count?: unknown }).count));
    assert.equal(
      summarize({ ...result, cancelled: false, argvDisplay: "opentide --json rules unreviewed" }).level,
      "info",
    );
    const info = await json(["info"]);
    const all = reachOf(info.document, ["sentinel", "splunk"]);
    assert.deepEqual(
      all.map((r) => r.platform),
      ["sentinel", "splunk"],
    );
  });

  it("fills Problems from validate's human output with $opentide", () => {
    const rules = path.join(workspace, "objects", "rules");
    const file = readdirSync(rules)
      .filter((n) => n.endsWith(".yaml"))
      .sort()[0] as string;
    const result = spawnSync(
      runtime.command,
      [...runtime.args, "validate", "--file", path.join(rules, file)],
      {
        cwd: workspace,
        env: { ...process.env, ...taskEnv(workspace, runtime.env, undefined) },
        encoding: "utf8",
      },
    );
    const problems = matchProblems(`${result.stdout}\n${result.stderr}`);
    if (result.status === 0 && problems.length === 0) return;
    assert.ok(problems.length > 0, `${result.stdout}\n${result.stderr}`);
    for (const problem of problems) {
      assert.ok(existsSync(path.resolve(workspace, problem.file)), problem.file);
      assert.ok(problem.line >= 1);
    }
  });

  it("runs opentide --version through the generated launcher", function () {
    if (process.platform === "win32") this.skip();
    const dir = mkdtempSync(path.join(os.tmpdir(), "opentide-launcher-"));
    try {
      for (const file of launcherFiles(runtime, process.platform))
        writeFileSync(path.join(dir, file.name), file.content, { mode: file.mode });
      const result = spawnSync("sh", ["-c", "opentide --version"], {
        env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(runtime.version));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
