import * as assert from "node:assert/strict";
import { DetailsIndex, detailTargets } from "../../../src/features/graph/details";
import { buildModel, missingId, techniqueId } from "../../../src/features/graph/model";
import { sampleCatalog, UUID } from "../catalogFixture";

describe("graph details pane", () => {
  const index = new DetailsIndex(buildModel(sampleCatalog()));
  const headers = (id: string, direction: "outgoing" | "incoming") =>
    index.details(id)?.[direction].map((g) => g.header);

  it("describes a rule: its icon, kind, and what it implements, with the shared words and arrows", () => {
    const rule = index.details(UUID.rule);
    assert.equal(rule?.kindLabel, "Rule");
    assert.equal(rule?.icon, "shield");
    assert.equal(rule?.themeColor, "charts.green");
    assert.deepEqual(headers(UUID.rule, "outgoing"), ["Implements 1 →", "Technique 1 →", "On platform 2 →"]);
    assert.deepEqual(
      rule?.outgoing[0]?.items.map((i) => [i.id, i.label, i.kind]),
      [[UUID.objective, "Detect LSASS access", "objective"]],
    );
    assert.deepEqual(headers(UUID.rule, "incoming"), []);
  });

  it("lists an objective's incoming implementers and its signals, sorted by name", () => {
    assert.deepEqual(headers(UUID.objective, "incoming"), ["← Implemented by 1"]);
    const signals = index.details(UUID.objective)?.outgoing.find((g) => g.kind === "signal");
    assert.deepEqual(
      signals?.items.map((i) => i.label),
      ["LSASS handle opened", "LSASS handle with VM_READ"],
    );
    assert.equal(signals?.icon, "pulse");
  });

  it("lists a technique's users and a threat's chaining, with the relation as a note", () => {
    assert.deepEqual(headers(techniqueId("T1003.001"), "incoming"), ["← Used by 2"]);
    const chain = index.details(UUID.threat)?.outgoing.find((g) => g.kind === "chains");
    assert.equal(chain?.header, "Chains to 1 →");
    assert.equal(chain?.items[0]?.note, "preceeds");
    assert.deepEqual(headers(UUID.lateral, "incoming"), ["← Chained from 1"]);
  });

  it("marks a dangling reference missing, and lists who names a missing node", () => {
    const broken = index.details(UUID.broken);
    const item = broken?.outgoing[0]?.items[0];
    assert.equal(item?.missing, true);
    assert.equal(item?.kind, "missing");
    assert.deepEqual(headers(missingId(UUID.missing), "incoming"), ["← Implemented by 1"]);
    assert.equal(index.details(missingId(UUID.missing))?.icon, "warning");
  });

  it("answers nothing for an unknown node, and lists every link target in pane order", () => {
    assert.equal(index.details("nope"), undefined);
    const targets = detailTargets(index.details(UUID.rule) ?? assert.fail("rule"));
    assert.equal(targets[0], UUID.objective);
    assert.equal(index.degree(UUID.rule), targets.length);
  });
});
