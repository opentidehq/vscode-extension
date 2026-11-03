import * as assert from "node:assert/strict";
import type { CatalogState } from "../../../src/core/catalog/store";
import { buildIndex, IndexCache, relativePath } from "../../../src/features/search/searchIndex";
import { ROOT, sampleCatalog, UUID } from "../catalogFixture";

describe("search index", () => {
  const catalog = sampleCatalog();
  const ready: CatalogState = { folder: ROOT, status: "ready", catalog, refreshing: false };

  it("has one item per object and signal, with lower-cased keys", () => {
    const index = buildIndex([ready]);
    assert.equal(index.items.length, catalog.objects.length + catalog.signals.length);
    const rule = index.items.find((item) => item.id === UUID.rule);
    assert.equal(rule?.keys.name, "suspicious lsass access");
    assert.deepEqual([...(rule?.keys.techniques ?? [])], ["t1003.001", "t1003"]);
    assert.deepEqual(rule?.keys.tactics, ["credential-access", "ta0006", "credential-access"]);
    assert.equal(rule?.deployed, true);
    assert.equal(rule?.filePath, `${ROOT}/objects/rules/suspicious-lsass-access.yaml`);
  });

  it("places a signal in its objective's file", () => {
    const signal = buildIndex([ready]).items.find((item) => item.id === UUID.signal);
    assert.equal(signal?.type, "signal");
    assert.equal(signal?.path, "objects/objectives/detect-lsass-access.yaml");
    assert.equal(signal?.line, 3);
    assert.ok(signal?.keys.techniques.has("t1003"));
  });

  it("falls back to workspace symbols, 0-based lines made 1-based", () => {
    const index = buildIndex([
      {
        folder: ROOT,
        status: "unavailable",
        refreshing: false,
        unavailable: { reason: "needs-command", command: "info catalog", message: "needs" },
        symbols: [
          { name: "R", family: "Rule", uri: "file:///ws/objects/rules/r%20x.yaml", line: 4, character: 6 },
        ],
      },
    ]);
    assert.ok(index.symbolsOnly);
    assert.equal(index.items[0]?.type, "rule");
    assert.equal(index.items[0]?.line, 5);
    assert.equal(index.items[0]?.path, "objects/rules/r x.yaml");
    assert.equal(index.unavailable.get(ROOT), "needs");
    assert.equal(relativePath(ROOT, "file:///elsewhere/x.yaml"), "file:///elsewhere/x.yaml");
  });

  it("rebuilds a folder's items only when its document changes", () => {
    const cache = new IndexCache();
    const first = cache.build([ready]).items[0];
    assert.equal(cache.build([{ ...ready, refreshing: true }]).items[0], first);
    assert.notEqual(cache.build([{ ...ready, catalog: sampleCatalog() }]).items[0], first);
  });

  it("reports folders still loading", () => {
    const index = buildIndex([{ folder: "/b", status: "loading", refreshing: true }, ready]);
    assert.deepEqual(index.loading, ["/b"]);
    assert.ok(!index.symbolsOnly);
  });
});
