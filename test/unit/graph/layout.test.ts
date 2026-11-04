import * as assert from "node:assert/strict";
import {
  bounds,
  columnLimit,
  layout,
  layoutDirection,
  NODE_BOX,
  stabilize,
  wrapRanks,
} from "../../../src/features/graph/layout";
import { buildModel, type NodeKind, OBJECT_KINDS } from "../../../src/features/graph/model";
import { computeView } from "../../../src/features/graph/view";
import { document, object, sampleCatalog, syntheticCatalog, UUID } from "../catalogFixture";

describe("graph layout", () => {
  it("lays threats, objectives and rules out left to right", () => {
    const model = buildModel(sampleCatalog());
    const positions = layout(model.nodes, model.edges);
    const x = (id: string) => positions.get(id)?.x ?? Number.NaN;
    assert.ok(x(UUID.threat) < x(UUID.objective), "threat left of objective");
    assert.ok(x(UUID.objective) < x(UUID.rule), "objective left of rule");
    assert.ok(x(UUID.objective) < x(UUID.signal), "objective left of its signal");
    assert.ok(x(UUID.signal) < x(UUID.comsvcs), "signal left of the rule implementing it");
    assert.equal(positions.size, model.nodes.length);
  });

  it("points edges the way the layers run", () => {
    assert.deepEqual(layoutDirection({ kind: "implements", source: "r", target: "o" }), ["o", "r"]);
    assert.deepEqual(layoutDirection({ kind: "covers", source: "o", target: "t" }), ["t", "o"]);
    assert.deepEqual(layoutDirection({ kind: "technique", source: "r", target: "x" }), ["r", "x"]);
    assert.deepEqual(layoutDirection({ kind: "signal", source: "o", target: "s" }), ["o", "s"]);
  });

  it("keeps the positions of nodes that stay, and moves new ones by the median shift", () => {
    const previous = new Map([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 100, y: 0 }],
    ]);
    const next = new Map([
      ["a", { x: 10, y: 5 }],
      ["b", { x: 110, y: 5 }],
      ["c", { x: 60, y: 105 }],
    ]);
    assert.deepEqual(Object.fromEntries(stabilize(previous, next)), {
      a: { x: 0, y: 0 },
      b: { x: 100, y: 0 },
      c: { x: 50, y: 100 },
    });
    assert.deepEqual(Object.fromEntries(stabilize(new Map(), next)), Object.fromEntries(next));
  });

  it("redraws a changed detection_model without moving the other nodes (issue #19)", () => {
    const objects = [
      object({ uuid: "t", type: "threat", name: "T" }),
      object({ uuid: "o1", type: "objective", name: "O1" }),
      object({ uuid: "o2", type: "objective", name: "O2" }),
      object({ uuid: "r1", type: "rule", name: "R1" }),
      object({ uuid: "r2", type: "rule", name: "R2" }),
    ];
    const edge = (from: string, to: string, kind: string) => ({
      from,
      to,
      kind,
      field_path: "",
      relation: null,
      missing: false,
    });
    const options = {
      mode: "catalogue" as const,
      focus: [],
      depth: 2,
      kinds: new Set<NodeKind>(OBJECT_KINDS),
      platforms: new Set<string>(),
      statuses: new Set<string>(),
      problemsOnly: false,
    };
    const before = computeView(
      buildModel(
        document(objects, [
          edge("o1", "t", "covers"),
          edge("o2", "t", "covers"),
          edge("r1", "o1", "implements"),
          edge("r2", "o1", "implements"),
        ]),
      ),
      {},
      options,
    );
    const after = computeView(
      buildModel(
        document(objects, [
          edge("o1", "t", "covers"),
          edge("o2", "t", "covers"),
          edge("r1", "o1", "implements"),
          edge("r2", "o2", "implements"),
        ]),
      ),
      {},
      options,
    );
    const drawn = layout(before.nodes, before.edges);
    const redrawn = stabilize(drawn, layout(after.nodes, after.edges));
    assert.notDeepEqual(
      after.edges.map((e) => e.id),
      before.edges.map((e) => e.id),
      "the edge changed",
    );
    assert.deepEqual(Object.fromEntries(redrawn), Object.fromEntries(drawn), "no node moved");
  });

  it("wraps a rank with a large fan-out into columns, and moves later ranks right", () => {
    const positions = new Map<string, { x: number; y: number }>([["o", { x: 0, y: 0 }]]);
    for (let i = 0; i < 100; i += 1) positions.set(`r${i}`, { x: 200, y: i * 60 });
    positions.set("t", { x: 400, y: 0 });
    const wrapped = wrapRanks(positions);
    const limit = columnLimit(100);
    const columns = new Set([...wrapped].filter(([id]) => id.startsWith("r")).map(([, p]) => p.x));
    assert.equal(columns.size, Math.ceil(100 / limit));
    assert.equal(wrapped.get("r0")?.x, 200);
    assert.equal(wrapped.get("o")?.x, 0, "earlier ranks stay");
    assert.equal(wrapped.get("t")?.x, 400 + (columns.size - 1) * NODE_BOX.width);
    const small = new Map([["a", { x: 5, y: 1 }]]);
    assert.deepEqual(Object.fromEntries(wrapRanks(small)), { a: { x: 5, y: 1 } });
  });

  it("pads the bounding box by half a node", () => {
    assert.deepEqual(
      bounds([
        { x: 0, y: 0 },
        { x: 100, y: 50 },
      ]),
      {
        x: -NODE_BOX.width / 2,
        y: -NODE_BOX.height / 2,
        width: 100 + NODE_BOX.width,
        height: 50 + NODE_BOX.height,
      },
    );
    assert.deepEqual(bounds([]), { x: 0, y: 0, width: 0, height: 0 });
  });
});

describe("graph layout: Catalogue mode at scale", () => {
  /** syntheticCatalog plus what makes dagre slow: log sources per rule and techniques per objective. */
  function dense(total: number) {
    const catalog = syntheticCatalog(total);
    const edges = [...catalog.edges];
    for (const o of catalog.objects) {
      const n = Number(o.uuid.slice(2));
      if (o.type === "rule") {
        edges.push(linkEdge(o.uuid, `source-${n % 40}`, "logsource"));
        edges.push(linkEdge(o.uuid, `source-${(n + 7) % 40}`, "logsource"));
      }
      if (o.type === "objective")
        edges.push(linkEdge(o.uuid, `T1${String(n % 600).padStart(3, "0")}`, "technique"));
    }
    return { ...catalog, edges };
  }
  function linkEdge(from: string, to: string, kind: string) {
    return { from, to, kind, field_path: "", relation: null, missing: false };
  }
  const options = {
    mode: "catalogue" as const,
    focus: [],
    depth: 2,
    kinds: new Set<NodeKind>([...OBJECT_KINDS, "technique", "logsource", "platform"]),
    platforms: new Set<string>(),
    statuses: new Set<string>(),
    problemsOnly: false,
  };

  for (const size of [500, 1000, 2000]) {
    it(`lays out ${size} objects with their techniques, log sources and platforms in seconds, not minutes`, () => {
      const view = computeView(buildModel(dense(size)), {}, options);
      const started = performance.now();
      const positions = layout(view.nodes, view.edges);
      const elapsed = performance.now() - started;
      assert.equal(positions.size, view.nodes.length);
      assert.ok(view.nodes.some((node) => node.kind === "logsource"));
      assert.ok(
        elapsed < (size > 1000 ? 5000 : 2000),
        `${view.nodes.length} nodes took ${Math.round(elapsed)} ms`,
      );
    });
  }

  it("puts techniques, log sources and platforms in columns right of the objects, without overlaps", () => {
    const view = computeView(buildModel(dense(300)), {}, options);
    const positions = layout(view.nodes, view.edges);
    const kindOf = new Map(view.nodes.map((node) => [node.id, node.kind]));
    const xs = (kind: NodeKind) =>
      [...positions].filter(([id]) => kindOf.get(id) === kind).map(([, p]) => p.x);
    const rightmostObject = Math.max(...OBJECT_KINDS.flatMap(xs));
    for (const kind of ["technique", "logsource", "platform"] as const) {
      assert.ok(Math.min(...xs(kind)) > rightmostObject, `${kind} right of every object`);
    }
    assert.ok(Math.min(...xs("logsource")) > Math.max(...xs("technique")));
    const seen = new Set<string>();
    for (const point of positions.values()) {
      const key = `${Math.round(point.x)},${Math.round(point.y)}`;
      assert.ok(!seen.has(key), `two nodes at ${key}`);
      seen.add(key);
    }
  });
});
