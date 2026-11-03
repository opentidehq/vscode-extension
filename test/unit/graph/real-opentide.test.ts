// The graph and search against a real opentide, when one is given: OPENTIDE_TEST_BIN (an `opentide`
// executable) and OPENTIDE_TEST_WORKSPACE (a workspace with objects/rules). Skipped otherwise. On an
// opentide with `info catalog` the graph is built from its real output; without it (0.21.0), the graph
// says what it needs and `unreviewed:` still works through `rules unreviewed`.
import * as assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { spawnRun } from "../../../src/core/backend/spawn";
import { CommandTree } from "../../../src/core/capabilities/tree";
import { CatalogStore, INFO_CATALOG } from "../../../src/core/catalog/store";
import { isCatalogDocument } from "../../../src/core/catalog/types";
import { processEnv } from "../../../src/core/runtime/env";
import type { Runtime } from "../../../src/core/runtime/types";
import { layout } from "../../../src/features/graph/layout";
import { buildModel, OBJECT_KINDS } from "../../../src/features/graph/model";
import { graphData, ModelCache, objectAtPath } from "../../../src/features/graph/state";
import { computeView } from "../../../src/features/graph/view";
import { search } from "../../../src/features/search/match";
import { unreviewedPaths } from "../../../src/features/search/present";
import { parseQuery } from "../../../src/features/search/query";
import { buildIndex } from "../../../src/features/search/searchIndex";

const BIN = process.env.OPENTIDE_TEST_BIN;
const WORKSPACE = process.env.OPENTIDE_TEST_WORKSPACE;
const available = Boolean(BIN && WORKSPACE && existsSync(BIN) && existsSync(WORKSPACE));

describe("graph and search with a real opentide (OPENTIDE_TEST_BIN)", function () {
  this.timeout(180_000);
  let runtime: Runtime;
  let tree: CommandTree;

  const run = (argv: string[]) =>
    spawnRun({
      command: runtime.command,
      args: [...runtime.args, "--json", ...argv],
      commandName: argv[0] ?? "",
      env: processEnv(process.env, runtime, process.platform, {
        NO_COLOR: "1",
        OPENTIDE_REPO_ROOT: WORKSPACE as string,
      }),
      cwd: WORKSPACE,
      platform: process.platform,
    });

  before(async function () {
    if (!available) this.skip();
    runtime = {
      tier: 1,
      source: "path",
      kind: "opentide",
      command: BIN as string,
      args: [],
      version: "unknown",
      env: {},
      restricted: false,
      binDirs: [path.dirname(BIN as string)],
    };
    tree = CommandTree.parse((await run(["commands"])).document);
  });

  it("builds the graph from info catalog, or says it needs it", async () => {
    const store = new CatalogStore({
      availability: () => ({ available: true }),
      hasInfoCatalog: async () => tree.hasCommand(INFO_CATALOG),
      runCatalog: async () => {
        const result = await run(["info", "catalog"]);
        return { document: result.document, exitCode: result.exitCode };
      },
      symbols: async () => [],
      log: () => {},
    });
    const state = await store.refresh(WORKSPACE as string, { immediate: true });
    store.dispose();
    const data = graphData(state, "ws", new ModelCache());
    if (!tree.hasCommand(INFO_CATALOG)) {
      assert.equal(data.status, "unavailable");
      assert.equal(data.needs, INFO_CATALOG);
      return;
    }
    assert.ok(isCatalogDocument(state.catalog));
    const catalog = state.catalog;
    const model = buildModel(catalog);
    const ids = new Set(model.nodes.map((node) => node.id));
    for (const edge of model.edges) assert.ok(ids.has(edge.source) && ids.has(edge.target), edge.id);
    const rule = catalog.objects.find((object) => object.type === "rule" && object.uuid);
    if (rule) {
      assert.equal(objectAtPath(catalog, rule.file_path, process.platform), rule.uuid);
      const started = performance.now();
      const view = computeView(
        model,
        {},
        {
          mode: "focus",
          focus: [rule.uuid],
          depth: 1,
          kinds: new Set(OBJECT_KINDS),
          platforms: new Set(),
          statuses: new Set(),
          problemsOnly: false,
        },
      );
      layout(view.nodes, view.edges);
      assert.ok(performance.now() - started < 300, "focus mode within the budget");
      const objective = catalog.edges.find(
        (edge) => edge.from === rule.uuid && edge.kind === "implements",
      )?.to;
      if (objective)
        assert.ok(
          view.nodes.some((node) => node.id === objective),
          "the rule's objective is shown",
        );
    }
    const index = buildIndex([state]);
    assert.equal(index.items.length, catalog.objects.length + catalog.signals.length);
  });

  it("feeds unreviewed: from rules unreviewed", async function () {
    if (!tree.hasCommand("rules unreviewed")) this.skip();
    const result = await run(["rules", "unreviewed", "--older-than", "90d"]);
    assert.equal(result.exitCode, 0);
    const paths = unreviewedPaths(result.document);
    assert.ok(paths, "a rules list");
    for (const listed of paths) assert.match(listed, /^objects\/rules\/.+\.ya?ml$/);
    if (tree.hasCommand(INFO_CATALOG)) {
      const catalog = (await run(["info", "catalog"])).document;
      if (!isCatalogDocument(catalog)) return;
      const index = buildIndex([
        { folder: WORKSPACE as string, status: "ready", catalog, refreshing: false },
      ]);
      const found = search(index, parseQuery("unreviewed:>90d"), {
        now: Date.now(),
        unreviewed: new Map([[WORKSPACE as string, paths]]),
      }).results;
      assert.equal(found.length, paths.size);
    }
  });
});
