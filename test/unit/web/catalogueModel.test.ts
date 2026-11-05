import * as assert from "node:assert/strict";
import type { ServerObject } from "../../../src/engine/catalog";
import { sameUri, WebIndex, type WebNode } from "../../../src/web/catalogueModel";
import { serverObjects } from "../catalog/serverFixture";

const labels = (nodes: readonly WebNode[]): unknown[] =>
  nodes.map((node) => (node.children.length > 0 ? [node.label, labels(node.children)] : node.label));

describe("web catalogue (src/web/catalogueModel.ts)", () => {
  it("nests threats → objectives → rules by their references, and groups the rest", () => {
    const index = new WebIndex(serverObjects());
    const tree = index.catalogue();
    assert.deepEqual(labels(tree), [
      [
        "Credential Dumping",
        [["Detect LSASS access", ["LSASS dump via comsvcs", "Suspicious LSASS Access"]]],
      ],
      "Lateral Movement",
      ["Rules without an objective", ["Dangling rule"]],
    ]);
    const objective = tree[0]?.children[0];
    assert.equal(objective?.description, "2 rules");
    assert.equal(objective?.uri, "file:///w/objects/objectives/o1.yaml");
    assert.equal(objective?.family, "objective");
    assert.equal(tree[1]?.description, "no objective");
  });

  it("lists an object's relations both ways, signals as their objective", () => {
    const index = new WebIndex(serverObjects());
    const of = (uuid: string) =>
      index.relations(uuid).map((r) => [r.direction, r.kind, r.name, r.missing ? "missing" : r.family]);
    assert.deepEqual(of("o1"), [
      ["out", "covers", "Credential Dumping", "threat"],
      ["in", "implements", "Suspicious LSASS Access", "rule"],
      // Through its signal: a rule whose detection_model names one of the objective's signals.
      ["in", "implements", "LSASS dump via comsvcs", "rule"],
    ]);
    assert.deepEqual(of("r2"), [["out", "implements", "Detect LSASS access", "objective"]]);
    assert.deepEqual(of("t1"), [
      ["out", "chains", "Lateral Movement", "threat"],
      ["in", "covers", "Detect LSASS access", "objective"],
    ]);
    assert.deepEqual(of("r3"), [["out", "implements", "gone", "missing"]]);
  });

  it("finds objects by every word of a query, and the object of a file", () => {
    const index = new WebIndex(serverObjects());
    assert.deepEqual(
      index.search("lsass").map((o) => o.uuid),
      ["o1", "r2", "r1"],
    );
    assert.deepEqual(
      index.search("RULE dump").map((o) => o.uuid),
      ["r2"],
    );
    assert.equal(index.objectAt("file:///w/objects/rules/r1.yaml")?.uuid, "r1");
    assert.equal(index.objectAt("file:///w/objects/rules/nothing.yaml"), undefined);
  });

  it("keeps the URIs a virtual workspace has, and compares them whatever their encoding", () => {
    const vfs: ServerObject = {
      ...(serverObjects()[0] as ServerObject),
      uri: "vscode-vfs://github/org/repo/objects/threats/t%201.yaml",
    };
    const index = new WebIndex([vfs]);
    assert.equal(index.catalogue()[0]?.uri, vfs.uri);
    assert.equal(index.objectAt("vscode-vfs://github/org/repo/objects/threats/t 1.yaml")?.uuid, vfs.uuid);
    assert.equal(sameUri("file:///w/x.yaml", "file:///w/x.yaml/"), true);
    assert.equal(sameUri("file:///w/x.yaml", "file:///w/y.yaml"), false);
  });
});
