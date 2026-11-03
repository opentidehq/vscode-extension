// The query, deploy plan and matrix features against a real opentide (OPENTIDE_TEST_BIN, an `opentide`
// executable, and OPENTIDE_TEST_WORKSPACE). Skipped when either is missing.
import * as assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { Backend } from "../../src/core/backend/backend";
import { spawnRun } from "../../src/core/backend/spawn";
import { classify } from "../../src/core/capabilities/classification";
import { CommandTree } from "../../src/core/capabilities/tree";
import type { CatalogDocument } from "../../src/core/catalog/types";
import { processEnv } from "../../src/core/runtime/env";
import type { Runtime } from "../../src/core/runtime/types";
import { DeployPlanner } from "../../src/features/deploy-plan/argv";
import { planView } from "../../src/features/deploy-plan/plan";
import { buildMatrix, type Cell, DEFAULT_FILTERS } from "../../src/features/matrix/model";
import { queryArgv, validateLiveArgv } from "../../src/features/query/argv";
import { parseInfoPlatforms } from "../../src/features/query/platforms";

const BIN = process.env.OPENTIDE_TEST_BIN;
const WORKSPACE = process.env.OPENTIDE_TEST_WORKSPACE;
const available = Boolean(BIN && WORKSPACE && existsSync(BIN) && existsSync(WORKSPACE));

/** The flags of `argv` (options that start with `--`, before any `--`). */
function flags(argv: readonly string[]): string[] {
  const end = argv.indexOf("--");
  return (end < 0 ? argv : argv.slice(0, end)).filter((a) => a.startsWith("--"));
}

describe("panels against a real opentide (OPENTIDE_TEST_BIN)", function () {
  this.timeout(180_000);
  let tree: CommandTree;
  let backend: Backend;
  const workspace = WORKSPACE as string;

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
      binDirs: [path.dirname(BIN as string)],
    };
    const commands = await spawnRun({
      command: runtime.command,
      args: ["--json", "commands"],
      commandName: "commands",
      env: processEnv(process.env, runtime, process.platform, { NO_COLOR: "1" }),
      cwd: workspace,
      platform: process.platform,
    });
    tree = CommandTree.parse(commands.document);
    backend = new Backend({
      runtime: () => runtime,
      commands: async () => tree,
      classify: (argv) => classify(argv),
      serveMode: () => "auto",
      baseEnv: () => process.env,
      proxy: () => undefined,
      credentials: async () => ({}),
      platform: process.platform,
      log: () => {},
    });
  });

  after(async () => {
    await backend?.dispose();
  });

  it("has every query and validate --live flag the lenses send", () => {
    const argvs = [
      queryArgv({
        platform: "elastic",
        source: { kind: "rule", file: "r.yaml", name: "r" },
        tenants: ["a"],
        window: { kind: "range", from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" },
        limit: 10,
        language: "eql",
      }),
      queryArgv({
        platform: "splunk",
        source: { kind: "rule", uuid: "u", name: "r" },
        window: { kind: "since", since: "1h" },
        limit: 1,
      }),
      queryArgv({
        platform: "splunk",
        source: { kind: "query-file", path: "/q.spl", name: "q" },
        window: { kind: "since", since: "1h" },
        limit: 1,
      }),
    ];
    for (const argv of argvs)
      for (const flag of flags(argv).slice(0)) assert.ok(tree.hasOption("query", flag), flag);
    for (const flag of flags(validateLiveArgv("splunk", { uuid: "u" })))
      assert.ok(tree.hasOption("validate query", flag), flag);
    for (const flag of flags(validateLiveArgv("splunk", { file: "r.yaml" })))
      assert.ok(tree.hasOption("validate query", flag), flag);
    assert.equal(
      classify(
        queryArgv({
          platform: "splunk",
          source: { kind: "text", text: "x", name: "x" },
          window: { kind: "since", since: "1h" },
          limit: 1,
        }),
      ).contactsTenant,
      true,
    );
  });

  it("reads can_query and can_validate of every platform from info", async () => {
    const result = await backend.run(workspace, ["info"]);
    const caps = parseInfoPlatforms(result.document);
    assert.ok(caps);
    assert.equal(caps.get("sysdig")?.canQuery, false);
    assert.equal(caps.get("crowdstrike")?.canValidate, false);
    assert.equal(caps.get("sentinel")?.canQuery, true);
    // opentide#754 adds tenants; 0.21.0 has none, and the lenses ask the CLI instead.
    for (const platform of caps.values()) if (platform.tenants) assert.ok(Array.isArray(platform.tenants));
  });

  it("shows the plan opentide prints, through a dry run only", async () => {
    const planner = new DeployPlanner((folder: string, argv: readonly string[], _extra: undefined) =>
      backend.run(folder, argv, { credentials: false }),
    );
    const result = await planner.plan(
      workspace,
      { strategies: ["PREVIEW"], scope: { kind: "all" } },
      undefined,
    );
    const document = result.document as Record<string, unknown> & {
      changes?: unknown[];
      skipped?: unknown[];
      summary: Record<string, unknown>;
    };
    assert.equal(document.dry_run, true);
    assert.equal(document.command, "deploy");
    const plan = planView(document);
    const rows = plan.platforms.flatMap((p) => p.tenants.flatMap((t) => t.changes));
    assert.equal(rows.length, document.changes?.length ?? 0, "every change is shown");
    assert.equal(plan.skipped.length, document.skipped?.length ?? 0);
    for (const action of ["create", "update", "upsert", "disable", "delete"] as const)
      if (typeof document.summary[action] === "number")
        assert.equal(plan.counts[action], document.summary[action], action);
    assert.ok(result.argvDisplay.includes("--dry-run"));
  });

  it("counts the matrix as info coverage --technique does (own techniques), where info catalog exists", async function () {
    if (!tree.hasCommand("info catalog")) this.skip();
    const catalog = (await backend.run(workspace, ["info", "catalog"]))
      .document as unknown as CatalogDocument;
    const view = buildMatrix(catalog, { ...DEFAULT_FILTERS, inherited: false });
    const cells = new Map<string, Cell>();
    const walk = (list: readonly Cell[]) => {
      for (const cell of list) {
        cells.set(cell.id, cell);
        walk(cell.subtechniques);
      }
    };
    walk(view.columns.flatMap((c) => c.cells));
    const named = new Set(catalog.objects.flatMap((o) => o.techniques.own.map((t) => t.toUpperCase())));
    const sample = [...named].filter((id) => cells.has(id)).slice(0, 8);
    const parents = [...new Set(sample.map((id) => id.split(".")[0] ?? id))].filter((id) => cells.has(id));
    for (const technique of [...sample, ...parents, "T1059"]) {
      const coverage = await backend.run(workspace, ["info", "--technique", technique, "coverage"]);
      const count = (coverage.document.coverage as { count?: number } | undefined)?.count;
      assert.equal(cells.get(technique)?.rules ?? 0, count, technique);
    }
  });
});
