import * as assert from "node:assert/strict";
import { RELATION_WORDS, relationIndexOf } from "../../../src/core/catalog/relations";
import { changedNodes, type TreeNode } from "../../../src/features/sidebar/node";
import {
  escapeMarkdown,
  graphFromCatalog,
  graphFromServer,
  History,
  lensText,
  nameLine,
  OPEN_COMMAND,
  objectTooltip,
  relationsViewModel,
} from "../../../src/features/sidebar/relationsModel";
import { serverObjects } from "../catalog/serverFixture";
import { ROOT, sampleCatalog, syntheticCatalog, UUID } from "../catalogFixture";

const labels = (nodes: readonly TreeNode[] | undefined) => (nodes ?? []).map((n) => n.label);

function ready(uuid: string, doc = sampleCatalog()) {
  const graph = graphFromCatalog(doc, ROOT, "linux");
  return relationsViewModel({ kind: "ready", graph, uuid }, false);
}

describe("Relations view", () => {
  it("heads the view with the object's type and name, then outgoing groups, then incoming", () => {
    const model = ready(UUID.objective);
    assert.deepEqual(labels(model.nodes), [
      "Objective · Detect LSASS access",
      "Covers 1 →",
      "Has signal 2 →",
      "Technique 1 →",
      "← Implemented by 1",
    ]);
    assert.equal(model.description, "Following: Detect LSASS access");
    assert.equal(model.message, undefined);
    const [head, covers, signals, technique, implemented] = model.nodes;
    assert.equal(head?.description, "objects/objectives/detect-lsass-access.yaml");
    assert.equal(head?.icon, "target");
    assert.equal(head?.iconColor, "charts.blue");
    assert.equal(covers?.icon, RELATION_WORDS.covers.icon);
    assert.deepEqual(labels(covers?.children), ["Credential Dumping"]);
    assert.equal(covers?.children?.[0]?.description, "objects/threats/credential-dumping.yaml");
    assert.equal(covers?.children?.[0]?.icon, "flame");
    assert.equal(covers?.children?.[0]?.contextValue, "object.threat");
    assert.deepEqual(labels(signals?.children), ["LSASS handle opened", "LSASS handle with VM_READ"]);
    assert.equal(signals?.children?.[0]?.description, "← Implemented by 1");
    assert.equal(technique?.children?.[0]?.label, "T1003.001");
    assert.equal(technique?.children?.[0]?.description, "LSASS Memory");
    assert.equal(technique?.children?.[0]?.command?.command, "opentide.sidebar.openMatrix");
    assert.deepEqual(labels(implemented?.children), ["Suspicious LSASS Access"]);
  });

  it("opens an object row beside the editor at its name line, and a signal in its objective", () => {
    const model = ready(UUID.rule);
    const objective = model.nodes.find((n) => n.label === "Implements 1 →")?.children?.[0];
    assert.equal(objective?.command?.command, OPEN_COMMAND);
    assert.deepEqual(objective?.command?.args, [
      { file: `${ROOT}/objects/objectives/detect-lsass-access.yaml`, line: 2 },
    ]);
    assert.deepEqual(objective?.ref, {
      kind: "object",
      folder: ROOT,
      uuid: UUID.objective,
      type: "objective",
      name: "Detect LSASS access",
      file: `${ROOT}/objects/objectives/detect-lsass-access.yaml`,
    });
    // The header opens the object itself, where it already shows.
    assert.equal((model.nodes[0]?.command?.args?.[0] as { inPlace?: boolean } | undefined)?.inPlace, true);

    const comsvcs = ready(UUID.comsvcs);
    const signal = comsvcs.nodes.find((n) => n.label === "Implements 1 →")?.children?.[0];
    assert.equal(signal?.label, "LSASS handle opened");
    assert.equal(signal?.description, "signal of Detect LSASS access");
    assert.equal(signal?.contextValue, "signal");
    assert.deepEqual(signal?.command?.args, [
      { file: `${ROOT}/objects/objectives/detect-lsass-access.yaml`, line: 2, signal: UUID.signal },
    ]);
  });

  it("shows a signal's own relations, and a missing reference as missing", () => {
    const signal = ready(UUID.signal);
    assert.deepEqual(labels(signal.nodes), [
      "Signal · LSASS handle opened",
      "Uses log source 1 →",
      "← Implemented by 1",
      "← Signal of 1",
      "← Parent of 1",
    ]);
    assert.equal(signal.nodes[0]?.description, "in Detect LSASS access");
    assert.equal(signal.nodes[1]?.children?.[0]?.icon, "database");

    const broken = ready(UUID.broken);
    const missing = broken.nodes[1]?.children?.[0];
    assert.equal(broken.nodes[1]?.label, "Implements 1 →");
    assert.equal(missing?.label, UUID.missing);
    assert.equal(missing?.description, "missing");
    assert.equal(missing?.icon, "warning");
    assert.equal(missing?.contextValue, "relation.missing");
    assert.equal(missing?.command, undefined);
  });

  it("says when an object has no relations, and names the source when it is the language server", () => {
    const orphan = ready(UUID.orphan);
    assert.deepEqual(labels(orphan.nodes), ["Objective · Orphan objective", "No relations"]);
    const graph = graphFromServer(serverObjects(), "/w", "linux");
    const model = relationsViewModel({ kind: "ready", graph, uuid: "o1" }, true);
    assert.equal(model.description, "Pinned: Detect LSASS access");
    assert.match(model.message ?? "", /language server's index/);
    assert.deepEqual(labels(model.nodes), [
      "Objective · Detect LSASS access",
      "Covers 1 →",
      "Has signal 2 →",
      "← Implemented by 1",
    ]);
    assert.equal(model.nodes[0]?.description, "objects/objectives/o1.yaml");
    assert.deepEqual(model.nodes[2]?.children?.[0]?.command?.args, [
      { file: "/w/objects/objectives/o1.yaml", line: 20, signal: "s1" },
    ]);
    // Inverted from the rules' detection_model: what points to the signal.
    const signal = relationsViewModel({ kind: "ready", graph, uuid: "s1" }, false);
    assert.deepEqual(labels(signal.nodes), [
      "Signal · Signal 1",
      "← Implemented by 1",
      "← Signal of 1",
      "← Parent of 1",
    ]);
    assert.equal(graph.objectAt("/w/objects/rules/r3.yaml")?.uuid, "r3");
    const dangling = relationsViewModel({ kind: "ready", graph, uuid: "r3" }, false);
    assert.equal(dangling.nodes[1]?.children?.[0]?.description, "missing");
  });

  it("puts multi-root folders in the header, and keeps ids stable and unique", () => {
    const graph = graphFromCatalog(sampleCatalog(), ROOT, "linux");
    const model = relationsViewModel({ kind: "ready", graph, uuid: UUID.objective, folderName: "ws" }, false);
    assert.equal(model.nodes[0]?.description, "ws · objects/objectives/detect-lsass-access.yaml");
    const ids: string[] = [];
    const visit = (nodes: readonly TreeNode[]) => {
      for (const node of nodes) {
        ids.push(node.id);
        visit(node.children ?? []);
      }
    };
    visit(model.nodes);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(
      relationsViewModel({ kind: "ready", graph, uuid: UUID.objective }, false).nodes[1]?.id,
      model.nodes[1]?.id,
    );
  });

  it("shows one line with one action when relations cannot load", () => {
    const needs = relationsViewModel(
      {
        kind: "unavailable",
        reason: "needs-newer",
        name: "Suspicious LSASS Access",
        family: "rule",
        file: "/ws/r.yaml",
      },
      false,
    );
    assert.deepEqual(labels(needs.nodes), [
      "Rule · Suspicious LSASS Access",
      "Relations need a newer opentide",
    ]);
    assert.deepEqual(needs.nodes[1]?.command, {
      command: "opentide.switchRuntime",
      title: "Switch Runtime…",
    });
    assert.equal(needs.description, "Following: Suspicious LSASS Access");
    const untrusted = relationsViewModel({ kind: "unavailable", reason: "untrusted" }, false);
    assert.equal(untrusted.nodes[0]?.command?.command, "workbench.trust.manage");
    assert.equal(
      relationsViewModel({ kind: "unavailable", reason: "no-server" }, false).nodes[0]?.command?.command,
      "opentide.switchRuntime",
    );
    assert.equal(relationsViewModel({ kind: "loading" }, false).nodes[0]?.icon, "loading~spin");
    assert.deepEqual(relationsViewModel({ kind: "none" }, false).nodes, []);
    const fresh = relationsViewModel(
      { kind: "not-indexed", name: "new.yaml", file: "/ws/new.yaml", folder: "/ws" },
      true,
    );
    assert.equal(fresh.nodes[0]?.description, "not in the catalogue yet");
    assert.equal(fresh.description, "Pinned: new.yaml");
  });

  it("builds one graph per catalogue version and finds an object by its file", () => {
    const doc = sampleCatalog();
    assert.equal(graphFromCatalog(doc, ROOT, "linux"), graphFromCatalog(doc, ROOT, "linux"));
    assert.equal(graphFromCatalog(doc, ROOT, "linux").index, relationIndexOf(doc));
    assert.notEqual(graphFromCatalog(sampleCatalog(), ROOT, "linux"), graphFromCatalog(doc, ROOT, "linux"));
    const graph = graphFromCatalog(sampleCatalog(), ROOT, "win32");
    assert.equal(graph.objectAt(`${ROOT}/OBJECTS/rules/suspicious-lsass-access.yaml`)?.uuid, UUID.rule);
    assert.equal(graphFromCatalog(doc, ROOT, "linux").objectAt(`${ROOT}/x.yaml`), undefined);
  });

  it("renders a 5,000-object catalogue's view of a busy objective in well under a frame", () => {
    const doc = syntheticCatalog(5000);
    const started = performance.now();
    const graph = graphFromCatalog(doc, ROOT, "linux");
    const built = performance.now() - started;
    const render = performance.now();
    for (let i = 0; i < 50; i += 1) relationsViewModel({ kind: "ready", graph, uuid: `o-${i}` }, false);
    const perRender = (performance.now() - render) / 50;
    assert.ok(built < 500, `built in ${built} ms`);
    assert.ok(perRender < 16, `${perRender} ms per render`);
  });
});

describe("relations CodeLens", () => {
  const graph = () => graphFromCatalog(sampleCatalog(), ROOT, "linux");

  it("sums up both ways in the shared words, outgoing first", () => {
    assert.equal(lensText(graph(), UUID.rule), "Implements → Detect LSASS access");
    assert.equal(
      lensText(graph(), UUID.objective),
      "Covers → Credential Dumping · Has signal → 2 signals · ← Implemented by 1 rule",
    );
    assert.equal(lensText(graph(), UUID.threat), "Chains to → Lateral Movement · ← Covered by 1 objective");
    assert.equal(lensText(graph(), UUID.broken), "Implements → $(warning) missing");
    assert.equal(lensText(graph(), UUID.orphan), "No relations");
  });

  it("counts by family, and says 'objects' for a mix", () => {
    const doc = syntheticCatalog(200);
    const text = lensText(graphFromCatalog(doc, ROOT, "linux"), "o-0");
    assert.match(text, /← Implemented by \d+ rules/);
  });

  it("finds the name: line, and stops looking past it", () => {
    const lines = ["# comment", "name: x", "metadata:", "  name: inner"];
    let read = 0;
    assert.equal(
      nameLine(lines.length, (i) => {
        read += 1;
        return lines[i] ?? "";
      }),
      1,
    );
    assert.equal(read, 2);
    assert.equal(
      nameLine(2, (i) => ["metadata:", "  name: x"][i] ?? ""),
      undefined,
    );
  });
});

describe("relations tooltips", () => {
  it("give name, type, path, platform statuses and counts both ways, escaped", () => {
    const doc = sampleCatalog();
    const rule = doc.objects.find((o) => o.uuid === UUID.rule);
    assert.ok(rule?.uuid && rule.type && rule.path);
    const text = objectTooltip(
      {
        uuid: rule.uuid,
        type: rule.type,
        name: "Suspicious *LSASS* $(x)",
        path: rule.path,
        platforms: rule.platforms,
      },
      relationIndexOf(doc),
    );
    const lines = text.split("\n\n");
    assert.equal(lines[0], "$(shield) **Suspicious \\*LSASS\\* \\$\\(x\\)**");
    assert.equal(lines[1], "Rule · `objects/rules/suspicious-lsass-access.yaml`");
    assert.equal(lines[2], "`Sentinel` DESIGN (inert) · `defender` PRODUCTION");
    assert.equal(lines[3], "Implements 1 → · Technique 1 →");
    const objective = objectTooltip(
      { uuid: UUID.objective, type: "objective", name: "o", path: "p", platforms: [] },
      relationIndexOf(doc),
    );
    assert.match(objective, /Covers 1 → · Has signal 2 → · Technique 1 → {2}\n← Implemented by 1$/);
    assert.match(
      objectTooltip({ uuid: "x", type: "rule", name: "x", path: "p", platforms: [] }, relationIndexOf(doc)),
      /No relations$/,
    );
    assert.equal(escapeMarkdown("a_b [c](d) <e> |f|"), "a\\_b \\[c\\]\\(d\\) \\<e\\> \\|f\\|");
  });
});

describe("relations history", () => {
  it("goes back and forward, and a new object drops what was forward", () => {
    const history = new History<string>((a, b) => a === b);
    history.push("a");
    history.push("a");
    history.push("b");
    history.push("c");
    assert.equal(history.back(), "b");
    assert.equal(history.back(), "a");
    assert.equal(history.canBack, false);
    assert.equal(history.back(), "a");
    assert.equal(history.forward(), "b");
    history.push("d");
    assert.equal(history.canForward, false);
    assert.equal(history.back(), "b");
    assert.equal(history.back(), "a");
    const short = new History<number>((a, b) => a === b, 3);
    for (const n of [1, 2, 3, 4]) short.push(n);
    assert.equal(short.back(), 3);
    assert.equal(short.back(), 2);
    assert.equal(short.canBack, false);
  });
});

describe("tree refreshes", () => {
  const node = (id: string, extra: Partial<TreeNode> = {}): TreeNode => ({ id, label: id, ...extra });

  it("refresh only the rows that changed, as the objects VS Code holds", () => {
    const before = [node("a", { children: [node("a/1"), node("a/2")] }), node("b")];
    const same = [node("a", { children: [node("a/1"), node("a/2")] }), node("b")];
    assert.deepEqual(changedNodes(before, same), []);
    const relabelled = [
      node("a", { children: [node("a/1", { description: "2 errors" }), node("a/2")] }),
      node("b"),
    ];
    const changed = changedNodes(before, relabelled);
    assert.ok(Array.isArray(changed));
    assert.equal(changed.length, 1);
    assert.equal(changed[0], before[0]?.children?.[0]);
    const regrouped = [node("a", { children: [node("a/2")] }), node("b", { description: "x" })];
    assert.deepEqual(changedNodes(before, regrouped), [before[0], before[1]]);
    assert.equal(changedNodes(before, [node("b"), node("a")]), "all");
    assert.equal(changedNodes(before, [node("a")]), "all");
  });
});
