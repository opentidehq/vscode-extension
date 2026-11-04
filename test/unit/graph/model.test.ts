import * as assert from "node:assert/strict";
import {
  buildModel,
  edgeLabel,
  facets,
  missingId,
  objectNodeId,
  shortId,
  techniqueId,
} from "../../../src/features/graph/model";
import { document, object, sampleCatalog, UUID } from "../catalogFixture";

describe("graph model", () => {
  const model = buildModel(sampleCatalog());
  const node = (id: string) => model.nodes.find((n) => n.id === id);
  const edgesOf = (kind: string) => model.edges.filter((e) => e.kind === kind);

  it("has a node per object and signal, at the object's file and name line", () => {
    assert.equal(node(UUID.rule)?.kind, "rule");
    assert.equal(node(UUID.objective)?.line, 3);
    assert.equal(node(UUID.objective)?.filePath, "/ws/objects/objectives/detect-lsass-access.yaml");
    const signal = node(UUID.signal);
    assert.equal(signal?.kind, "signal");
    assert.equal(signal?.path, "objects/objectives/detect-lsass-access.yaml", "a signal opens its objective");
    assert.equal(signal?.objective, UUID.objective);
  });

  it("keeps a file that did not load, by its path, with the reason", () => {
    const bad = node("file:objects/rules/bad.yaml");
    assert.equal(bad?.kind, "rule");
    assert.equal(bad?.label, "objects/rules/bad.yaml");
    assert.match(bad?.loadError ?? "", /mapping values/);
    const failed = { code: "yaml_parse", message: "bad", line: null };
    assert.equal(
      objectNodeId(object({ uuid: null, type: null, name: "", path: "x.yaml", load_error: failed })),
      "file:x.yaml",
    );
  });

  it("names technique nodes from the ATT&CK skeleton and merges own and inherited techniques", () => {
    assert.equal(node(techniqueId("T1003.001"))?.label, "T1003.001 LSASS Memory");
    assert.equal(node(techniqueId("T1021"))?.label, "T1021 Remote Services");
    assert.deepEqual(node(UUID.rule)?.techniques, ["T1003.001", "T1003"]);
  });

  it("draws every edge opentide reports, with its relation", () => {
    assert.equal(edgesOf("covers")[0]?.target, UUID.threat);
    assert.equal(edgesOf("implements").length, 3);
    const chain = edgesOf("chains")[0];
    assert.equal(chain?.relation, "sequence::preceeds");
    assert.equal(
      edgeLabel(chain ?? { kind: "chains", relation: null }),
      "Precedes",
      "a chain reads as its relation",
    );
    assert.equal(edgesOf("parent")[0]?.target, UUID.signal);
    assert.equal(edgesOf("logsource")[0]?.target, "logsource:DeviceProcessEvents");
  });

  it("labels edges with the words every surface uses, read from the source", () => {
    assert.equal(edgeLabel({ kind: "implements", relation: null }), "Implements");
    assert.equal(edgeLabel({ kind: "covers", relation: null }), "Covers");
    assert.equal(edgeLabel({ kind: "signal", relation: null }), "Has signal");
    assert.equal(edgeLabel({ kind: "logsource", relation: null }), "Uses log source");
    assert.equal(edgeLabel({ kind: "technique", relation: null }), "Technique");
    assert.equal(edgeLabel({ kind: "chains", relation: null }), "Chains to");
    assert.equal(edgeLabel({ kind: "chains", relation: "sequence::unknown" }), "Chains to");
    assert.equal(edgeLabel({ kind: "actor", relation: null }), "Attributed to");
    assert.equal(edgeLabel({ kind: "platform", relation: null }), "On platform");
    assert.equal(
      edgeLabel({ kind: "future", relation: null }),
      "future",
      "a newer opentide's kind as itself",
    );
  });

  it("adds what the catalogue implies: objective → signal, threat → actor, rule → platform", () => {
    assert.deepEqual(
      edgesOf("signal").map((e) => [e.source, e.target]),
      [
        [UUID.objective, UUID.signal],
        [UUID.objective, UUID.childSignal],
      ],
    );
    assert.deepEqual(
      edgesOf("actor").map((e) => e.target),
      ["actor:att&ck::G0016"],
      "only threats name actors; objectives and rules inherit them",
    );
    assert.equal(node("actor:att&ck::G0016")?.label, "G0016");
    assert.deepEqual(
      edgesOf("platform")
        .filter((e) => e.source === UUID.rule)
        .map((e) => e.target),
      ["platform:sentinel", "platform:defender"],
    );
  });

  it("draws a dangling reference to a missing node", () => {
    const dangling = model.edges.find((e) => e.source === UUID.broken && e.kind === "implements");
    assert.equal(dangling?.target, missingId(UUID.missing));
    assert.equal(dangling?.missing, true);
    assert.equal(node(missingId(UUID.missing))?.kind, "missing");
  });

  it("treats a reference to an unknown object as missing even when not flagged", () => {
    const catalog = document(
      [object({ uuid: "r", type: "rule", name: "R" })],
      [
        {
          from: "r",
          to: "nowhere",
          kind: "implements",
          field_path: "detection_model",
          relation: null,
          missing: false,
        },
      ],
    );
    const built = buildModel(catalog);
    assert.equal(built.edges[0]?.target, "missing:nowhere");
    assert.equal(built.edges[0]?.missing, true);
  });

  it("gives duplicate references distinct edge ids, and skips edges from unknown sources", () => {
    const catalog = document(
      [object({ uuid: "r", type: "rule", name: "R" }), object({ uuid: "o", type: "objective", name: "O" })],
      [
        {
          from: "r",
          to: "o",
          kind: "implements",
          field_path: "detection_model",
          relation: null,
          missing: false,
        },
        {
          from: "r",
          to: "o",
          kind: "implements",
          field_path: "detection_model",
          relation: null,
          missing: false,
        },
        {
          from: "ghost",
          to: "o",
          kind: "implements",
          field_path: "detection_model",
          relation: null,
          missing: false,
        },
      ],
    );
    const ids = buildModel(catalog).edges.map((e) => e.id);
    assert.equal(ids.length, 2);
    assert.equal(new Set(ids).size, 2);
  });

  it("lists the platforms and statuses for the filters", () => {
    assert.deepEqual(facets(model), {
      platforms: ["defender", "sentinel", "splunk"],
      statuses: ["DESIGN", "PRODUCTION"],
    });
  });

  it("strips vocabulary prefixes for display", () => {
    assert.equal(shortId("att&ck::G0016"), "G0016");
    assert.equal(shortId("APT29"), "APT29");
  });
});
