// Load-error rows in `info catalog` (opentide's output_schema): `uuid`, `type`, `schema` and the paths
// may be null, and a broken copy of a file can carry a loaded object's UUID. Every consumer must cope.
import * as assert from "node:assert/strict";
import { findByUuid, isLoaded, loadedObjects, rowKey } from "../../src/core/catalog/rows";
import type { CatalogState } from "../../src/core/catalog/store";
import type { CatalogDocument, CatalogObject } from "../../src/core/catalog/types";
import { activeObjectPayload } from "../../src/features/agents/tools";
import { buildModel } from "../../src/features/graph/model";
import { objectAtPath } from "../../src/features/graph/state";
import { buildMatrix } from "../../src/features/matrix/model";
import { choicesFromCatalog } from "../../src/features/new-object/flow";
import { linkedObject } from "../../src/features/runner/links";
import { buildIndex } from "../../src/features/search/searchIndex";
import { buildCatalogue } from "../../src/features/sidebar/catalogue";
import { computeCoverage } from "../../src/features/sidebar/coverage";
import { document, object, ROOT, sampleCatalog, UUID } from "./catalogFixture";

const failure = { code: "yaml_parse", message: "mapping values are not allowed here", line: 4 };

/** A row as opentide prints a file that did not load and has no readable UUID. */
const nameless = (path: string): CatalogObject =>
  object({ uuid: null, type: null, schema: null, name: "", path, load_error: failure });

/** A broken copy of the rule: it still carries the rule's UUID. */
const brokenCopy = object({
  uuid: UUID.rule,
  type: "rule",
  name: "Suspicious LSASS Access",
  path: "objects/rules/suspicious-lsass-access-copy.yaml",
  load_error: failure,
});

/** The sample catalogue with a nameless broken file first and a broken copy of the rule last. */
function withBrokenRows(): CatalogDocument {
  const sample = sampleCatalog();
  return document(
    [nameless("objects/rules/early.yaml"), ...sample.objects, brokenCopy],
    [...sample.edges],
    [...sample.signals],
  );
}

describe("catalogue rows", () => {
  it("tells loaded objects from files that did not load", () => {
    const rows = withBrokenRows().objects;
    assert.equal(isLoaded(brokenCopy), false);
    assert.equal(isLoaded(nameless("x.yaml")), false);
    assert.equal(loadedObjects(rows).length, sampleCatalog().objects.length - 1);
    assert.equal(rowKey(brokenCopy), "file:objects/rules/suspicious-lsass-access-copy.yaml");
    assert.equal(rowKey(nameless("x.yaml")), "file:x.yaml");
    assert.equal(rowKey(rows.find((o) => o.uuid === UUID.threat) as CatalogObject), UUID.threat);
  });

  it("finds a UUID in any case past rows without one, the loaded object first", () => {
    const rows = withBrokenRows().objects;
    assert.equal(findByUuid(rows, UUID.rule.toUpperCase())?.load_error, null);
    assert.equal(findByUuid([brokenCopy], UUID.rule)?.path, brokenCopy.path);
    assert.equal(findByUuid(rows, UUID.missing), undefined);
  });

  it("terminal links skip rows without a UUID and open the loaded object", () => {
    const rows = withBrokenRows().objects;
    const target = linkedObject([undefined, rows], UUID.rule);
    assert.equal(target?.file_path, `${ROOT}/objects/rules/suspicious-lsass-access.yaml`);
    assert.equal(linkedObject([[nameless("a.yaml")]], UUID.rule), undefined);
  });

  it("the graph keeps the loaded object's node and edges, and the copy at its path", () => {
    const model = buildModel(withBrokenRows());
    const rule = model.nodes.find((n) => n.id === UUID.rule);
    assert.equal(rule?.loadError, undefined);
    assert.equal(rule?.path, "objects/rules/suspicious-lsass-access.yaml");
    const copy = model.nodes.find((n) => n.id === `file:${brokenCopy.path}`);
    assert.equal(copy?.loadError, failure.message);
    assert.ok(model.nodes.some((n) => n.id === "file:objects/rules/early.yaml"));
    assert.ok(model.edges.some((e) => e.source === UUID.rule && e.target === UUID.objective));
    assert.equal(
      objectAtPath(withBrokenRows(), `${ROOT}/objects/rules/suspicious-lsass-access.yaml`, "linux"),
      UUID.rule,
    );
  });

  it("search keeps the loaded object and lists the copy by path, without its UUID", () => {
    const ready: CatalogState = {
      folder: ROOT,
      status: "ready",
      catalog: withBrokenRows(),
      refreshing: false,
    };
    const items = buildIndex([ready]).items;
    const rule = items.filter((item) => item.id === UUID.rule);
    assert.equal(rule.length, 1);
    assert.equal(rule[0]?.loadError, undefined);
    const copy = items.find((item) => item.id === `file:${brokenCopy.path}`);
    assert.equal(copy?.uuid, undefined);
    assert.equal(copy?.keys.uuid, UUID.rule, "still found by its UUID");
  });

  it("the active-object tool gives a broken copy its load error and none of the loaded object's edges", () => {
    const catalog = withBrokenRows();
    const copy = activeObjectPayload(`${ROOT}/${brokenCopy.path}`, catalog, undefined, false);
    assert.ok("neighbours" in copy);
    assert.deepEqual(copy.neighbours, []);
    assert.equal(copy.object.load_error?.code, "yaml_parse");
    const rule = activeObjectPayload(
      `${ROOT}/objects/rules/suspicious-lsass-access.yaml`,
      catalog,
      undefined,
      false,
    );
    assert.ok("neighbours" in rule && rule.neighbours.length > 0);
    assert.equal(rule.object.load_error, null);
  });

  it("the sidebar, coverage, matrix and new-object choices count only loaded objects", () => {
    const catalog = withBrokenRows();
    const state: CatalogState = { folder: ROOT, status: "ready", catalog, refreshing: false };
    const tree = buildCatalogue({ folders: [{ path: ROOT, name: "ws", state }], groupBy: "type" });
    const json = JSON.stringify(tree);
    assert.match(json, /early\.yaml/);
    assert.match(json, /suspicious-lsass-access-copy\.yaml/);
    const coverage = computeCoverage(catalog);
    const ruleUuids = coverage.tactics.flatMap((t) =>
      t.techniques.flatMap((c) => c.rules.map((r) => r.uuid)),
    );
    assert.ok(ruleUuids.every((uuid) => typeof uuid === "string"));
    assert.equal(buildMatrix(catalog).rules, 3, "the three rules that loaded");
    assert.deepEqual(
      choicesFromCatalog(catalog.objects, "rule").map((c) => c.uuid),
      choicesFromCatalog(sampleCatalog().objects, "rule").map((c) => c.uuid),
    );
  });
});
