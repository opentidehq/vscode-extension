import * as assert from "node:assert/strict";
import {
  applyPatch,
  diffModels,
  ModelReceiver,
  ModelSender,
  patchSize,
} from "../../../src/features/graph/diff";
import { buildModel, type GraphModel } from "../../../src/features/graph/model";
import { outgoingData } from "../../../src/features/graph/state";
import { object, sampleCatalog, syntheticCatalog, UUID } from "../catalogFixture";

function renamed(model: GraphModel, id: string, label: string): GraphModel {
  return { ...model, nodes: model.nodes.map((n) => (n.id === id ? { ...n, label } : n)) };
}

describe("graph model patches", () => {
  const model = buildModel(sampleCatalog());

  it("sends what changed: a renamed node, a removed edge, an added node", () => {
    const next: GraphModel = {
      nodes: [
        ...renamed(model, UUID.rule, "Renamed").nodes,
        { id: "new", kind: "rule", label: "New", platforms: [], techniques: [] },
      ],
      edges: model.edges.filter((e) => e.kind !== "chains"),
    };
    const patch = diffModels(model, next, 1, 2);
    assert.deepEqual(
      patch.nodes.map((n) => n.id),
      [UUID.rule, "new"],
    );
    assert.deepEqual(patch.removedNodes, []);
    assert.deepEqual(patch.edges, []);
    assert.equal(patch.removedEdges.length, 1);
    const applied = applyPatch(model, patch);
    assert.deepEqual(applied, next, "the patch makes the next model, order kept");
  });

  it("posts the whole model first, then patches, nothing for no change, and again after a reset", () => {
    const sender = new ModelSender();
    const first = sender.next(model);
    assert.equal(first.kind, "full");
    assert.equal(sender.next(model).kind, "same");
    assert.equal(sender.next(buildModel(sampleCatalog())).kind, "same", "an equal model is no change");
    const changed = sender.next(renamed(model, UUID.rule, "Renamed"));
    assert.equal(changed.kind, "patch");
    if (changed.kind === "patch") {
      assert.equal(changed.patch.from, first.revision);
      assert.equal(changed.patch.to, changed.revision);
      assert.equal(patchSize(changed.patch), 1);
    }
    sender.reset();
    assert.equal(sender.next(model).kind, "full");
  });

  it("sends a model whose patch would be larger than half of it whole", () => {
    const sender = new ModelSender();
    sender.next(model);
    const other = buildModel({
      ...sampleCatalog(),
      objects: [object({ uuid: "x", type: "rule", name: "X" })],
      edges: [],
      signals: [],
    });
    assert.equal(sender.next(other).kind, "full");
  });

  it("turns graphData's model into what one webview needs", () => {
    const sender = new ModelSender();
    const data = { status: "ready" as const, folder: "ws", refreshing: false, model };
    const full = outgoingData(data, sender);
    assert.ok(full.model && full.revision === 1 && !full.patch);
    const same = outgoingData({ ...data, refreshing: true }, sender);
    assert.ok(!same.model && !same.patch && same.revision === 1 && same.refreshing);
    const patched = outgoingData({ ...data, model: renamed(model, UUID.rule, "R") }, sender);
    assert.ok(!patched.model && patched.patch && patched.revision === 2);
    const loading = { status: "loading" as const, folder: "ws", refreshing: true };
    assert.deepEqual(outgoingData(loading, sender), loading);
    const resent = outgoingData(data, sender);
    assert.ok(resent.model, "after a status without a model, the webview has none: it gets it whole");
  });

  it("posts a few nodes, not 5,000, when one rule changes in a large catalogue", () => {
    const catalog = syntheticCatalog(5000);
    const before = buildModel(catalog);
    const after = renamed(before, "r-7", "Rule 7 renamed");
    const started = performance.now();
    const patch = diffModels(before, after, 1, 2);
    const took = performance.now() - started;
    assert.equal(patchSize(patch), 1);
    assert.ok(JSON.stringify(patch).length < 2000, "the message is small");
    assert.ok(took < 500, `the diff took ${Math.round(took)} ms`);
  });
});

describe("graph model patches: the webview's end", () => {
  const model = buildModel(sampleCatalog());
  const ready = { status: "ready" };

  it("takes the whole model, then patches in order", () => {
    const sender = new ModelSender();
    const receiver = new ModelReceiver();
    const first = sender.next(model);
    assert.equal(first.kind, "full");
    const got = receiver.receive({ ...ready, model, revision: first.revision });
    assert.equal(got.kind, "model");
    assert.equal(got.kind === "model" && got.first, true);
    const next = renamed(model, UUID.rule, "Renamed");
    const patched = sender.next(next);
    assert.equal(patched.kind, "patch");
    if (patched.kind !== "patch") return;
    const applied = receiver.receive({ ...ready, patch: patched.patch, revision: patched.revision });
    assert.equal(applied.kind, "model");
    assert.deepEqual(receiver.model, next);
    assert.equal(receiver.revision, patched.revision);
    assert.equal(receiver.receive({ ...ready, revision: patched.revision }).kind, "same");
  });

  it("asks for the whole model for a patch out of order, and keeps what it has", () => {
    const receiver = new ModelReceiver();
    receiver.receive({ ...ready, model, revision: 1 });
    const skipped = diffModels(model, renamed(model, UUID.rule, "R"), 2, 3);
    assert.equal(receiver.receive({ ...ready, patch: skipped, revision: 3 }).kind, "resync");
    assert.equal(receiver.revision, 1, "it does not claim revision 3");
    assert.equal(receiver.model, model);
  });

  it("asks for the whole model when a message names a revision it has no payload for", () => {
    const receiver = new ModelReceiver();
    receiver.receive({ ...ready, model, revision: 1 });
    // A model or patch lost on the way, then a status-only message at the host's new revision.
    assert.equal(receiver.receive({ ...ready, revision: 2 }).kind, "resync");
    assert.equal(receiver.revision, 1, "it still says it holds revision 1");
    assert.equal(new ModelReceiver().receive({ ...ready, revision: 1 }).kind, "resync", "no model yet");
  });

  it("asks once per desync: more messages before the whole model arrives wait for it", () => {
    const receiver = new ModelReceiver();
    receiver.receive({ ...ready, model, revision: 1 });
    const skipped = diffModels(model, renamed(model, UUID.rule, "R"), 2, 3);
    assert.equal(receiver.receive({ ...ready, patch: skipped, revision: 3 }).kind, "resync");
    assert.equal(receiver.receive({ ...ready, revision: 3 }).kind, "waiting");
    assert.equal(
      receiver.receive({ ...ready, patch: { ...skipped, from: 3, to: 4 }, revision: 4 }).kind,
      "waiting",
    );
    assert.equal(receiver.receive({ ...ready, model, revision: 5 }).kind, "model");
    assert.equal(receiver.receive({ ...ready, revision: 6 }).kind, "resync", "a new desync asks again");
  });

  it("drops its model when the host is not ready, and takes a resent model after a resync", () => {
    const receiver = new ModelReceiver();
    receiver.receive({ ...ready, model, revision: 1 });
    assert.equal(receiver.receive({ status: "loading" }).kind, "cleared");
    assert.equal(receiver.model, undefined);
    const again = receiver.receive({ ...ready, model, revision: 5 });
    assert.equal(again.kind === "model" && again.first, true);
    assert.equal(receiver.revision, 5);
  });
});
