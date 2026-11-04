import * as assert from "node:assert/strict";
import type { CatalogState } from "../../../src/core/catalog/store";
import {
  buildCatalogue,
  fromSymbols,
  isEmptyRepository,
  platformsText,
  problemBadge,
} from "../../../src/features/sidebar/catalogue";
import { filterNodes, type TreeNode, walk } from "../../../src/features/sidebar/node";
import { catalog, object, ROOT, ready } from "./fixtures";

const one = (state: CatalogState, extra: Partial<Parameters<typeof buildCatalogue>[0]> = {}) =>
  buildCatalogue({ folders: [{ path: ROOT, name: "repo", state }], groupBy: "chain", ...extra });

const labels = (nodes: readonly TreeNode[]) => nodes.map((n) => n.label);
const find = (nodes: readonly TreeNode[], label: string): TreeNode => {
  let found: TreeNode | undefined;
  walk(nodes, (node) => {
    if (!found && node.label === label) found = node;
  });
  assert.ok(found, `no node "${label}"`);
  return found;
};

describe("sidebar: catalogue", () => {
  it("nests threats → objectives → signals → rules, with the orphan groups", () => {
    const model = one(ready());
    assert.deepEqual(labels(model.nodes), [
      "Credential Dumping",
      "Objectives without a threat",
      "Rules without an objective",
      "Files that failed to load",
    ]);
    const threat = find(model.nodes, "Credential Dumping");
    assert.equal(threat.description?.startsWith("1 obj · 2 rules"), true);
    const objective = find(threat.children ?? [], "Detect LSASS access");
    assert.deepEqual(labels(objective.children ?? []), ["LSASS handle opened", "Suspicious LSASS Access"]);
    assert.deepEqual(labels(find(objective.children ?? [], "LSASS handle opened").children ?? []), [
      "LSASS dump via comsvcs",
    ]);
    // A dangling detection_model (missing: true) is a rule without an objective.
    assert.deepEqual(labels(find(model.nodes, "Rules without an objective").children ?? []), [
      "Dangling rule",
      "Orphan rule",
    ]);
    assert.equal(find(model.nodes, "Rules without an objective").description, "2");
    assert.deepEqual(labels(find(model.nodes, "Objectives without a threat").children ?? []), [
      "Detect DCSync",
    ]);
  });

  it("opens each object at its line (0-based) and carries a ref for its commands", () => {
    const rule = find(one(ready()).nodes, "Suspicious LSASS Access");
    assert.deepEqual(rule.open, { path: `${ROOT}/objects/rules/suspicious-lsass-access.yaml`, line: 2 });
    assert.equal(rule.contextValue, "object.rule");
    assert.deepEqual(rule.ref, {
      kind: "object",
      folder: ROOT,
      uuid: "r1",
      type: "rule",
      name: "Suspicious LSASS Access",
      file: `${ROOT}/objects/rules/suspicious-lsass-access.yaml`,
    });
  });

  it("lists files that failed to load at the problem's line, and badges their count", () => {
    const model = one(ready());
    const failed = find(model.nodes, "Files that failed to load");
    assert.equal(failed.children?.[0]?.label, "objects/rules/broken.yaml");
    assert.equal(failed.children?.[0]?.open?.line, 11);
    assert.deepEqual(model.badge, { value: 1, tooltip: "1 file failed to load" });
  });

  it("shows platforms, inert ones marked, and problem counts as text", () => {
    const model = one(ready(), {
      problems: (file) =>
        file.endsWith("suspicious-lsass-access.yaml") ? { errors: 2, warnings: 1 } : undefined,
    });
    const rule = find(model.nodes, "Suspicious LSASS Access");
    assert.equal(rule.description, "Sentinel · Splunk (inert)  ✗ 2 ! 1");
    assert.equal(rule.iconColor, "problemsErrorIcon.foreground");
    assert.equal(problemBadge({ errors: 0, warnings: 0 }), "");
    assert.equal(platformsText(object({ uuid: "x", type: "rule", name: "x" })), "");
  });

  it("keeps ids stable and unique (expansion survives refreshes)", () => {
    const ids = new Set<string>();
    walk(one(ready()).nodes, (node) => {
      assert.ok(!ids.has(node.id), `duplicate id ${node.id}`);
      ids.add(node.id);
    });
    const again = new Set<string>();
    walk(one(ready()).nodes, (node) => again.add(node.id));
    assert.deepEqual([...again], [...ids]);
  });

  it("groups by type, platform, status and technique", () => {
    assert.deepEqual(labels(one(ready(), { groupBy: "type" }).nodes), [
      "Threats",
      "Objectives",
      "Rules",
      "Files that failed to load",
    ]);
    const byPlatform = one(ready(), { groupBy: "platform" });
    assert.deepEqual(labels(byPlatform.nodes), [
      "Microsoft Sentinel",
      "Splunk",
      "No platform",
      "Files that failed to load",
    ]);
    assert.equal(byPlatform.description, "by platform");
    assert.deepEqual(labels(find(byPlatform.nodes, "Microsoft Sentinel").children ?? []), [
      "LSASS dump via comsvcs",
      "Suspicious LSASS Access",
    ]);
    assert.deepEqual(labels(one(ready(), { groupBy: "status" }).nodes).slice(0, 3), [
      "DESIGN",
      "PRODUCTION",
      "No status",
    ]);
    assert.deepEqual(labels(one(ready(), { groupBy: "technique" }).nodes).slice(0, 2), [
      "T1003 OS Credential Dumping",
      "T1003.001 LSASS Memory",
    ]);
  });

  it("filters by name, UUID or technique, keeping ancestors and recounting groups", () => {
    const byName = one(ready(), { filter: "comsvcs" });
    assert.deepEqual(labels(byName.nodes), ["Credential Dumping"]);
    assert.equal(byName.description, "filter: comsvcs");
    const byUuid = one(ready(), { filter: "R3" });
    assert.deepEqual(labels(byUuid.nodes), ["Rules without an objective"]);
    assert.equal(byUuid.nodes[0]?.description, "1");
    assert.equal(one(ready(), { filter: "T1003.006" }).nodes[0]?.label, "Objectives without a threat");
    assert.deepEqual(one(ready(), { filter: "nothing-matches" }).nodes, []);
    assert.equal(filterNodes([], "x").length, 0);
  });

  it("shows names from workspace/symbol until the catalogue arrives, and says why", () => {
    const state: CatalogState = {
      folder: ROOT,
      status: "unavailable",
      refreshing: false,
      unavailable: {
        reason: "needs-command",
        command: "info catalog",
        message: "The catalogue needs a newer opentide.",
      },
      symbols: [
        { name: "B rule", family: "rule", uri: "file:///repo/objects/rules/b.yaml", line: 4, character: 6 },
        {
          name: "A threat",
          family: "threat",
          uri: "file:///repo/objects/threats/a.yaml",
          line: 0,
          character: 6,
        },
      ],
    };
    const model = one(state);
    // One line with the one action first: names only, and how to get the rest.
    assert.deepEqual(labels(model.nodes), ["Names only", "Threats", "Rules"]);
    assert.deepEqual(model.nodes[0]?.command, {
      command: "opentide.switchRuntime",
      title: "Switch Runtime…",
    });
    assert.deepEqual(model.nodes[2]?.children?.[0]?.open, {
      uri: "file:///repo/objects/rules/b.yaml",
      line: 4,
      character: 6,
    });
    assert.equal(model.message, "This opentide has no `info catalog`: names from the language server.");
    const failed = one({ ...state, unavailable: undefined, status: "error", error: "boom" });
    assert.deepEqual(labels(failed.nodes), ["Threats", "Rules"]);
    assert.equal(failed.message, "The catalogue failed: boom Showing names from the language server.");
    assert.deepEqual(
      labels(fromSymbols([{ name: "x", family: "", uri: "file:///x", line: 0, character: 0 }])),
      ["Other"],
    );
  });

  it("says a newer opentide is needed when there is nothing to show yet", () => {
    const model = one({
      folder: ROOT,
      status: "unavailable",
      refreshing: false,
      unavailable: { reason: "needs-command", command: "info catalog", message: "needs" },
    });
    assert.equal(model.nodes[0]?.label, "Needs a newer opentide");
    assert.equal(model.nodes[0]?.description, "with `info catalog`");
  });

  it("shows loading, error with retry, and nothing for untrusted (the welcome view explains)", () => {
    assert.equal(one({ folder: ROOT, status: "loading", refreshing: true }).nodes[0]?.icon, "loading~spin");
    const error = one({ folder: ROOT, status: "error", error: "boom", refreshing: false });
    assert.equal(error.nodes[0]?.command?.command, "opentide.sidebar.refresh");
    const untrusted: CatalogState = {
      folder: ROOT,
      status: "unavailable",
      refreshing: false,
      unavailable: { reason: "untrusted", message: "Trust this folder to load the catalogue." },
    };
    assert.deepEqual(one(untrusted).nodes, []);
    // A failed refresh keeps the last catalogue and says so.
    const stale = one({ ...ready(), status: "error", error: "timeout" });
    assert.equal(stale.nodes[0]?.label, "Credential Dumping");
    assert.equal(stale.message, "The last refresh failed (timeout).");
  });

  it("groups by folder in a multi-root window", () => {
    const model = buildCatalogue({
      folders: [
        { path: ROOT, name: "repo", state: ready() },
        {
          path: "/other",
          name: "other",
          state: {
            folder: "/other",
            status: "unavailable",
            refreshing: false,
            unavailable: { reason: "no-runtime", message: "No runtime." },
          },
        },
      ],
      groupBy: "chain",
    });
    assert.deepEqual(labels(model.nodes), ["repo", "other"]);
    assert.equal(model.nodes[1]?.children?.[0]?.label, "No runtime.");
    assert.ok(model.nodes[0]?.children?.[0]?.id.startsWith(`${ROOT}|`));
  });

  it("knows an empty repository", () => {
    assert.equal(isEmptyRepository(ready({ ...catalog(), objects: [] })), true);
    assert.equal(isEmptyRepository(ready()), false);
  });
});
