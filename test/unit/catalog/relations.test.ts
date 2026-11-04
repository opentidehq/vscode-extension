import * as assert from "node:assert/strict";
import {
  groupByKind,
  RELATION_ORDER,
  RELATION_WORDS,
  RelationIndex,
  relationLabel,
} from "../../../src/core/catalog/relations";
import { sampleCatalog, UUID } from "../catalogFixture";

describe("catalog relations", () => {
  const index = new RelationIndex(sampleCatalog());

  it("lists what a rule implements and what an objective is implemented by, both ways", () => {
    const rule = index.of(UUID.rule);
    assert.deepEqual(
      rule.outgoing.map((r) => [r.kind, r.direction, r.other]),
      [
        ["implements", "out", UUID.objective],
        ["technique", "out", "T1003.001"],
      ],
    );
    const implementers = index
      .of(UUID.objective)
      .incoming.filter((r) => r.kind === "implements")
      .map((r) => r.other);
    assert.deepEqual(implementers, [UUID.rule]);
  });

  it("lists an objective's signals as outgoing and the owner as the signal's incoming", () => {
    const signals = index
      .of(UUID.objective)
      .outgoing.filter((r) => r.kind === "signal")
      .map((r) => [r.other, r.otherKind]);
    assert.deepEqual(signals, [
      [UUID.signal, "signal"],
      [UUID.childSignal, "signal"],
    ]);
    assert.deepEqual(
      index.of(UUID.signal).incoming.map((r) => [r.kind, r.other]),
      [
        ["implements", UUID.comsvcs],
        ["signal", UUID.objective],
        ["parent", UUID.childSignal],
      ],
    );
  });

  it("keeps a dangling reference on the source and lists nothing on its missing target", () => {
    const broken = index.of(UUID.broken).outgoing;
    assert.equal(broken.length, 1);
    assert.equal(broken[0]?.missing, true);
    assert.deepEqual(index.of(UUID.missing), { outgoing: [], incoming: [] });
  });

  it("lists techniques and log sources from the object's side only", () => {
    assert.deepEqual(index.of("T1003.001"), { outgoing: [], incoming: [] });
    assert.equal(index.of(UUID.signal).outgoing[0]?.otherKind, "logsource");
  });

  it("matches ids without case and counts relations by kind in a fixed order", () => {
    assert.equal(index.of(UUID.rule.toUpperCase()).outgoing.length, 2);
    assert.deepEqual(index.counts(UUID.objective, "out"), [
      { kind: "covers", count: 1 },
      { kind: "signal", count: 2 },
      { kind: "technique", count: 1 },
    ]);
    assert.deepEqual(index.counts(UUID.objective, "in"), [{ kind: "implements", count: 1 }]);
  });

  it("orders chains with their relation and groups by kind", () => {
    const chain = index.of(UUID.threat).outgoing.find((r) => r.kind === "chains");
    assert.equal(chain?.relation, "sequence::preceeds");
    assert.deepEqual(
      groupByKind(index.of(UUID.objective).outgoing).map((g) => [g.kind, g.relations.length]),
      [
        ["covers", 1],
        ["signal", 2],
        ["technique", 1],
      ],
    );
  });

  it("labels each direction with its arrow on the other object's side", () => {
    assert.equal(relationLabel("implements", "out"), "Implements →");
    assert.equal(relationLabel("implements", "in", 3), "← Implemented by 3");
    assert.equal(relationLabel("covers", "in"), "← Covered by");
    for (const kind of RELATION_ORDER) {
      assert.ok(RELATION_WORDS[kind].out && RELATION_WORDS[kind].in && RELATION_WORDS[kind].icon, kind);
    }
  });

  it("indexes 5,000 objects in well under a frame per lookup", () => {
    const edges = [];
    for (let i = 0; i < 5000; i += 1)
      edges.push({
        from: `r-${i}`,
        to: `o-${i % 500}`,
        kind: "implements",
        field_path: "detection_model",
        relation: null,
        missing: false,
      });
    const started = performance.now();
    const big = new RelationIndex({ edges, signals: [] });
    const built = performance.now() - started;
    const lookup = performance.now();
    for (let i = 0; i < 500; i += 1) big.of(`o-${i}`);
    const perLookup = (performance.now() - lookup) / 500;
    assert.equal(big.of("o-1").incoming.length, 10);
    assert.ok(built < 500, `built in ${built} ms`);
    assert.ok(perLookup < 1, `${perLookup} ms per lookup`);
  });
});
