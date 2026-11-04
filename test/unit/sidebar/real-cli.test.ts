// The sidebar's and the setup wizard's documents against a real opentide (OPENTIDE_TEST_BIN, with
// OPENTIDE_TEST_WORKSPACE). Skipped without them. Works on 0.21.0 and lights up with info catalog,
// tenants and setup --plan.
import * as assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Backend } from "../../../src/core/backend/backend";
import { spawnRun } from "../../../src/core/backend/spawn";
import { classify } from "../../../src/core/capabilities/classification";
import { CommandTree } from "../../../src/core/capabilities/tree";
import { isCatalogDocument } from "../../../src/core/catalog/types";
import { processEnv } from "../../../src/core/runtime/env";
import type { Runtime } from "../../../src/core/runtime/types";
import {
  defaultAnswers,
  type OptionSource,
  setupCommands,
  setupSupport,
} from "../../../src/features/setup/answers";
import { apply, type Runner, review } from "../../../src/features/setup/flow";
import { mergePlans, parsePlan, writtenFiles } from "../../../src/features/setup/plan";
import { buildCatalogue } from "../../../src/features/sidebar/catalogue";
import { computeCoverage } from "../../../src/features/sidebar/coverage";
import { fixArgv, healthNodes, parseChecks } from "../../../src/features/sidebar/health";
import { parsePlatforms, platformNodes } from "../../../src/features/sidebar/platforms";

const BIN = process.env.OPENTIDE_TEST_BIN;
const WORKSPACE = process.env.OPENTIDE_TEST_WORKSPACE;
const available = Boolean(BIN && WORKSPACE && existsSync(BIN) && existsSync(WORKSPACE));

describe("sidebar and setup: real opentide (OPENTIDE_TEST_BIN)", function () {
  this.timeout(180_000);
  let tree: CommandTree;
  let backend: Backend;
  let scratch: string;

  before(async function () {
    if (!available) this.skip();
    const runtime: Runtime = {
      tier: 1,
      source: "setting",
      kind: "opentide",
      command: BIN as string,
      args: [],
      version: "",
      env: {},
      restricted: false,
      binDirs: [],
    };
    const commands = await spawnRun({
      command: runtime.command,
      args: ["--json", "commands"],
      commandName: "commands",
      env: processEnv(process.env, runtime, process.platform, { NO_COLOR: "1" }),
      cwd: WORKSPACE,
      platform: process.platform,
    });
    tree = CommandTree.parse(commands.document);
    backend = new Backend({
      runtime: () => ({ ...runtime, version: tree.version }),
      commands: async () => tree,
      classify: (argv) => classify(argv),
      serveMode: () => "auto",
      baseEnv: () => process.env,
      proxy: () => undefined,
      credentials: async () => ({}),
      platform: process.platform,
      log: () => {},
    });
    scratch = mkdtempSync(path.join(tmpdir(), "otide-setup-"));
  });

  after(async () => {
    await backend?.dispose();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("reads info's platforms (and tenants, when this opentide lists them)", async () => {
    const result = await backend.run(WORKSPACE as string, ["info"]);
    const platforms = parsePlatforms(result.document);
    assert.ok(platforms.length >= 9, JSON.stringify(result.document).slice(0, 300));
    assert.ok(platforms.some((p) => p.name === "sentinel"));
    const nodes = platformNodes(platforms, new Set(), WORKSPACE as string);
    assert.equal(nodes.length, platforms.length);
    const raw = (result.document.platforms as { tenants?: unknown }[])[0];
    assert.equal(platforms[0]?.tenants === undefined, raw?.tenants === undefined);
  });

  it("reads doctor's checks, and every fix it turns into a command is one this opentide has", async () => {
    const result = await backend.run(WORKSPACE as string, ["doctor", "--offline"]);
    const checks = parseChecks(result.document);
    assert.ok(checks.length > 5);
    assert.equal(healthNodes(checks, WORKSPACE as string).length, checks.length);
    for (const check of checks) {
      const argv = fixArgv(check.fix);
      if (argv) assert.notEqual(tree.commandPathOf(argv).path, "", `${check.code}: ${check.fix}`);
    }
  });

  it("builds the Catalogue and Coverage from info catalog, when it exists", async function () {
    if (!tree.hasCommand("info catalog")) this.skip();
    const result = await backend.run(WORKSPACE as string, ["info", "catalog"]);
    assert.ok(isCatalogDocument(result.document));
    const state = {
      folder: WORKSPACE as string,
      status: "ready" as const,
      catalog: result.document,
      refreshing: false,
    };
    const model = buildCatalogue({
      folders: [{ path: WORKSPACE as string, name: "ws", state }],
      groupBy: "chain",
    });
    assert.ok(model.nodes.length > 0);
    computeCoverage(result.document);
  });

  it("sets up an empty folder that validate passes; Review lists exactly the files Apply writes", async () => {
    const source: OptionSource = {
      hasCommand: (p) => tree.hasCommand(p),
      hasOption: (p, f) => tree.hasOption(p, f),
      choices: (p, f) => tree.option(p, f)?.choices ?? undefined,
    };
    const support = setupSupport(source);
    // No skills: they download the catalogue.
    const answers = {
      ...defaultAnswers("Tutorial Detections"),
      platforms: ["sentinel"],
      ci: "github" as const,
      mcp: ["cursor" as const],
    };
    const run: Runner = async (argv, token) =>
      backend.run(scratch, argv, token ? { cancellation: token } : {});
    const reviewed = await review({ answers, mode: "new", support, enabled: [], run });
    assert.deepEqual(reviewed.problems, []);
    assert.equal(reviewed.error, undefined);
    assert.ok(!existsSync(path.join(scratch, "README.md")), "Review writes nothing");
    const commands = setupCommands(answers, "new", support);
    let planned: string[] | undefined;
    if (support.plan) {
      const plans = await Promise.all(
        commands.map(async (c) => {
          const result = await run([...c.argv.filter((a) => a !== "--yes"), "--plan"]);
          return { steps: parsePlan(result.document) ?? [] };
        }),
      );
      planned = writtenFiles(mergePlans(plans));
      assert.ok(planned.includes("README.md"));
    } else {
      assert.ok(reviewed.note);
    }
    const progress = await apply({ commands, run, onProgress: () => {} });
    assert.equal(progress.ok, true, JSON.stringify(progress.commands.map((c) => c.failure)));
    const written = progress.commands.flatMap((c) => c.steps.flatMap((s) => s.files));
    assert.ok(written.includes("README.md"));
    if (planned)
      for (const file of planned) assert.ok(existsSync(path.join(scratch, file)), `planned ${file} exists`);
    assert.ok(readFileSync(path.join(scratch, "README.md"), "utf8").includes("Tutorial Detections"));
    const validate = await backend.run(scratch, ["validate"]);
    assert.equal(validate.exitCode, 0, JSON.stringify(validate.document.failure));
  });
});
