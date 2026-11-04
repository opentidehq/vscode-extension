import * as assert from "node:assert/strict";
import {
  buildCoverageView,
  computeCoverage,
  coverageNodes,
  summaryText,
} from "../../../src/features/sidebar/coverage";
import { catalog, ROOT, ready } from "./fixtures";

describe("sidebar: coverage", () => {
  it("counts rules per technique, a parent counting its sub-techniques' rules", () => {
    const coverage = computeCoverage(catalog());
    assert.equal(coverage.tactics.length, 1);
    const [t1003] = coverage.tactics[0]?.techniques ?? [];
    assert.equal(t1003?.id, "T1003");
    assert.equal(t1003?.rules.length, 2);
    // Gaps first among the sub-techniques.
    assert.deepEqual(
      t1003?.subtechniques.map((s) => [s.id, s.rules.length]),
      [
        ["T1003.006", 0],
        ["T1003.001", 2],
      ],
    );
    assert.deepEqual(coverage.summary, { techniques: 3, covered: 2 });
    assert.equal(summaryText(coverage.summary), "3 techniques · 2 covered");
  });

  it("marks gaps in text as well as colour, and lists the rules under a technique", () => {
    const nodes = coverageNodes(computeCoverage(catalog()), ROOT);
    const tactic = nodes[0];
    assert.equal(tactic?.label, "Credential Access");
    assert.equal(tactic?.description, "1 of 1 covered");
    const parent = tactic?.children?.[0];
    assert.equal(parent?.label, "T1003 OS Credential Dumping");
    const gap = parent?.children?.[0];
    assert.equal(gap?.description, "0 rules · gap");
    assert.equal(gap?.contextValue, "technique.gap");
    assert.deepEqual(gap?.ref, { kind: "technique", folder: ROOT, id: "T1003.006" });
    const covered = parent?.children?.[1];
    assert.deepEqual(
      covered?.children?.map((c) => c.label),
      ["LSASS dump via comsvcs", "Suspicious LSASS Access"],
    );
  });

  it("puts techniques the matrix does not list under Other", () => {
    const doc = catalog();
    const extra = {
      ...doc,
      objects: [
        ...doc.objects.map((o) =>
          o.uuid === "r3" ? { ...o, techniques: { own: ["T9999"], inherited: [] } } : o,
        ),
      ],
    };
    const coverage = computeCoverage(extra);
    assert.equal(coverage.tactics.at(-1)?.name, "Other techniques");
  });

  it("summarises the view, badges the gaps and flags an empty or older-opentide state", () => {
    const view = buildCoverageView([{ path: ROOT, name: "repo", state: ready() }]);
    assert.equal(view.description, "3 techniques · 2 covered");
    assert.deepEqual(view.badge, { value: 1, tooltip: "1 technique without a rule" });
    assert.equal(view.empty, false);
    const empty = buildCoverageView([
      { path: ROOT, name: "repo", state: ready({ ...catalog(), objects: [] }) },
    ]);
    assert.equal(empty.empty, true);
    assert.deepEqual(empty.nodes, []);
    const needs = buildCoverageView([
      {
        path: ROOT,
        name: "repo",
        state: {
          folder: ROOT,
          status: "unavailable",
          refreshing: false,
          unavailable: { reason: "needs-command", command: "info catalog", message: "needs" },
        },
      },
    ]);
    assert.equal(needs.needsCatalog, true);
    assert.deepEqual(needs.nodes, []);
    const loading = buildCoverageView([
      { path: ROOT, name: "repo", state: { folder: ROOT, status: "loading", refreshing: true } },
    ]);
    assert.equal(loading.nodes[0]?.icon, "loading~spin");
  });

  it("filters techniques", () => {
    const view = buildCoverageView([{ path: ROOT, name: "repo", state: ready() }], "dcsync");
    assert.equal(view.nodes[0]?.children?.[0]?.children?.[0]?.label, "T1003.006 DCSync");
    assert.equal(view.nodes[0]?.children?.[0]?.children?.length, 1);
  });
});
