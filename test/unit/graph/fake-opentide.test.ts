// The graph and search against the fake opentide (test/fixtures/fake-opentide.mjs), through the real
// Backend, CatalogStore and command tree: `info catalog` lights up the graph, its absence shows the
// "needs a newer opentide" state, and `rules unreviewed` feeds `unreviewed:`.
import * as assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Backend } from "../../../src/core/backend/backend";
import { classify } from "../../../src/core/capabilities/classification";
import { CommandTree } from "../../../src/core/capabilities/tree";
import { CatalogStore, INFO_CATALOG } from "../../../src/core/catalog/store";
import { graphData, ModelCache } from "../../../src/features/graph/state";
import { search } from "../../../src/features/search/match";
import { parseQuery } from "../../../src/features/search/query";
import { buildIndex } from "../../../src/features/search/searchIndex";
import { UnreviewedCache } from "../../../src/features/search/unreviewed";
import { sampleCatalog, UUID } from "../catalogFixture";
import { COMMANDS_FIXTURE, fakeRuntime } from "../helpers";

const REPO = mkdtempSync(path.join(tmpdir(), "otide-graph-"));
const CATALOG_FILE = path.join(REPO, "catalog.json");
writeFileSync(CATALOG_FILE, JSON.stringify(sampleCatalog()));

function setup(withCatalog: boolean) {
  const document = JSON.parse(readFileSync(COMMANDS_FIXTURE, "utf8"));
  if (withCatalog)
    document.commands.find((c: { path: string }) => c.path === "info").arguments[0].choices.push("catalog");
  const tree = CommandTree.parse(document);
  const env = {
    ...process.env,
    FAKE_NO_SERVE: "1",
    FAKE_INFO_CATALOG: withCatalog ? "1" : "0",
    FAKE_CATALOG_FILE: CATALOG_FILE,
    FAKE_UNREVIEWED: "objects/rules/lsass-dump-via-comsvcs.yaml",
  };
  const runtime = fakeRuntime();
  const backend = new Backend({
    runtime: () => runtime,
    commands: async () => tree,
    classify: (argv) => classify(argv),
    serveMode: () => "never",
    baseEnv: () => env,
    proxy: () => undefined,
    credentials: async () => ({}),
    platform: process.platform,
    log: () => {},
  });
  const store = new CatalogStore({
    availability: () => backend.availability(),
    hasInfoCatalog: async () => tree.hasCommand(INFO_CATALOG),
    runCatalog: async (folder) => {
      const result = await backend.run(folder, ["info", "catalog"]);
      return { document: result.document, exitCode: result.exitCode };
    },
    symbols: async () => [
      {
        name: "Suspicious LSASS Access",
        family: "rule",
        uri: `file://${REPO}/objects/rules/a.yaml`,
        line: 0,
        character: 6,
      },
    ],
    log: () => {},
  });
  return { backend, store, tree };
}

describe("graph and search with the fake opentide", function () {
  this.timeout(30_000);

  it("draws the graph from info catalog", async () => {
    const { backend, store } = setup(true);
    const state = await store.refresh(REPO, { immediate: true });
    const data = graphData(state, "repo", new ModelCache());
    assert.equal(data.status, "ready");
    assert.ok(data.model?.nodes.some((node) => node.id === UUID.rule));
    assert.ok(data.model?.edges.some((edge) => edge.missing));
    store.dispose();
    await backend.dispose();
  });

  it("shows what is needed without info catalog, and searches names from symbols", async () => {
    const { backend, store } = setup(false);
    const state = await store.refresh(REPO, { immediate: true });
    const data = graphData(state, "repo", new ModelCache());
    assert.equal(data.status, "unavailable");
    assert.equal(data.needs, "info catalog");
    const index = buildIndex([state]);
    assert.ok(index.symbolsOnly);
    assert.equal(search(index, parseQuery("lsass"), { now: Date.now() }).results.length, 1);
    store.dispose();
    await backend.dispose();
  });

  it("answers unreviewed: with rules unreviewed --older-than", async () => {
    const { backend, store, tree } = setup(true);
    const state = await store.refresh(REPO, { immediate: true });
    const argvs: string[][] = [];
    const cache = new UnreviewedCache({
      hasCommand: () => tree.hasCommand("rules unreviewed"),
      run: async (folder, window) => {
        const argv = ["rules", "unreviewed", "--older-than", window];
        argvs.push(argv);
        return (await backend.run(folder, argv)).document;
      },
      log: () => {},
    });
    const answer = await new Promise<ReadonlyMap<string, ReadonlySet<string>> | undefined>((resolve) => {
      const first = cache.get("90d", [REPO], () => resolve(cache.get("90d", [REPO], () => {})));
      if (first) resolve(first);
    });
    assert.deepEqual(argvs, [["rules", "unreviewed", "--older-than", "90d"]]);
    const results = search(buildIndex([state]), parseQuery("unreviewed:>90d"), {
      now: Date.now(),
      ...(answer ? { unreviewed: answer } : {}),
    }).results;
    assert.deepEqual(
      results.map((r) => r.item.id),
      [UUID.comsvcs],
    );
    store.dispose();
    await backend.dispose();
  });
});
