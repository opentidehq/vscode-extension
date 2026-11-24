// The deploy plan's tree: grouping, counts, ordering, icons, filters and the summary line.
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { planView } from "../../../src/features/deploy-plan/plan";
import {
  actionIcon,
  changeCounts,
  filterChoices,
  planMessage,
  planTree,
  type TreeNode,
} from "../../../src/features/deploy-plan/tree";
import { ROOT } from "../helpers";

/** `opentide --json deploy --dry-run --strategy PREVIEW --all` from opentide 0.21.0 (captured). */
const REAL = JSON.parse(
  readFileSync(path.join(ROOT, "test", "fixtures", "panels", "deploy-dry-run.json"), "utf8"),
);

function document(changes: unknown[], extra: Record<string, unknown> = {}) {
  return { ok: true, changes, payloads: {}, ...extra };
}
const change = (platform: string, tenant: string | null, name: string, action: string, extra = {}) => ({
  platform,
  tenant,
  uuid: `u-${name}`,
  name,
  status: "ACTIVE",
  action,
  ...extra,
});

describe("deploy plan tree", () => {
  it("groups the captured plan as platform → tenant → change, with each level's counts", () => {
    const plan = planView(REAL);
    const tree = planTree(plan);
    const platforms = tree.roots.filter((n) => n.kind === "platform");
    assert.deepEqual(
      platforms.map((p) => p.label),
      plan.platforms.map((p) => p.platform),
    );
    for (const platform of platforms) {
      const tenants = platform.children.filter((c) => c.kind === "tenant");
      assert.ok(tenants.length > 0);
      for (const tenant of tenants) {
        assert.ok(tenant.children.every((c) => c.kind === "change"));
        assert.equal(tenant.children.length > 0, true);
      }
    }
    const rows = [...tree.byId.values()].filter((n) => n.kind === "change");
    const planned = plan.platforms.flatMap((p) => p.tenants.flatMap((t) => t.changes)).length;
    assert.equal(rows.length, planned);
    assert.equal(
      tree.changes,
      Object.values(plan.counts).reduce((a, b) => a + b, 0),
    );
    assert.ok(tree.changes > 0);
  });

  it("counts creates, updates and deletes as +, ~ and −, and a failed rule as !", () => {
    const plan = planView(
      document([
        change("splunk", "prod", "a", "create"),
        change("splunk", "prod", "b", "update"),
        change("splunk", "prod", "c", "upsert"),
        change("splunk", "prod", "d", "delete"),
        change("splunk", "prod", "e", "disable"),
        change("splunk", "prod", "f", "create", { fails: true }),
      ]),
    );
    const [splunk] = planTree(plan).roots;
    assert.equal(splunk?.description, "+1 ~2 −2 !1");
    assert.equal(splunk?.children[0]?.description, "+1 ~2 −2 !1");
    assert.equal(changeCounts([]), "no changes");
    assert.equal(planTree(plan).changes, 5, "a rule that did not compile is not a change");
  });

  it("orders platforms as the plan does, tenants by name with none last, changes by action then name", () => {
    const plan = planView(
      document([
        change("splunk", null, "x", "create"),
        change("splunk", "prod", "z", "delete"),
        change("splunk", "prod", "b", "update"),
        change("splunk", "dev", "m", "create"),
        change("splunk", "prod", "a", "update"),
        change("splunk", "prod", "c", "create"),
        change("sentinel", "t", "q", "create"),
      ]),
    );
    const tree = planTree(plan);
    assert.deepEqual(
      tree.roots.map((r) => r.label),
      ["splunk", "sentinel"],
    );
    const tenants = tree.roots[0]?.children ?? [];
    assert.deepEqual(
      tenants.map((t) => t.label),
      ["dev", "prod", "no tenant configured"],
    );
    assert.deepEqual(
      tenants[1]?.children.map((c) => c.label),
      ["c", "a", "b", "z"],
      "creates, then updates by name, then deletes",
    );
  });

  it("gives each change its action's icon, and an error to a rule that did not compile", () => {
    assert.equal(actionIcon("create").id, "add");
    assert.equal(actionIcon("update").id, "edit");
    assert.equal(actionIcon("upsert").id, "diff-modified");
    assert.equal(actionIcon("delete").id, "trash");
    assert.equal(actionIcon("disable").id, "circle-slash");
    assert.equal(actionIcon("something-new").id, "circle-outline");
    assert.equal(actionIcon("create", true).id, "error");
    const plan = planView(document([change("splunk", "prod", "a", "update", { fails: true })]));
    const row = [...planTree(plan).byId.values()].find((n) => n.kind === "change");
    assert.equal(row?.icon.id, "error");
  });

  it("links a change to its payload, and says what opening it does", () => {
    const plan = planView({
      ...document([change("splunk", "prod", "a", "update"), change("splunk", "prod", "b", "create")]),
      payloads: {
        splunk: [
          { uuid: "u-a", name: "a", api_request: { x: 1 }, deployed: { x: 0 }, file: "objects/rules/a.yaml" },
          { uuid: "u-b", name: "b", api_request: { x: 2 } },
        ],
      },
    });
    const rows = new Map(
      [...planTree(plan).byId.values()].filter((n) => n.kind === "change").map((n) => [n.label, n]),
    );
    assert.equal(rows.get("a")?.payloadKey, "splunk/u-a");
    assert.equal(rows.get("a")?.context, "change request deployed file");
    assert.match(rows.get("a")?.tooltip ?? "", /diff against what is deployed/);
    assert.equal(rows.get("b")?.context, "change request");
    assert.match(rows.get("b")?.tooltip ?? "", /request that would be sent/);
  });

  it("keeps ids unique and the same across two builds of one plan", () => {
    const plan = planView(
      document([change("splunk", "prod", "a", "create"), change("splunk", "prod", "a", "create")]),
    );
    const first = planTree(plan);
    const second = planTree(plan);
    assert.equal(first.byId.size, [...first.byId.keys()].length);
    assert.deepEqual([...first.byId.keys()], [...second.byId.keys()]);
    assert.equal([...first.byId.values()].filter((n) => n.kind === "change").length, 2, "twins both listed");
  });

  it("shows missing tenants, skipped rules and unmatched selections beside the platforms", () => {
    const plan = planView({
      ...document([change("splunk", "prod", "a", "create")]),
      missing_tenants: { sentinel: "sentinel.toml has no [[tenants]]" },
      skipped: [{ rule: "R", uuid: "u-r", platform: "sentinel", status: "DESIGN", strategy: "INERT" }],
      unmatched: ["nope.yaml"],
    });
    const tree = planTree(plan);
    const sentinel = tree.roots.find((r) => r.label === "sentinel");
    assert.equal(sentinel?.children[0]?.kind, "missing");
    assert.match(sentinel?.children[0]?.description ?? "", /no \[\[tenants\]\]/);
    assert.deepEqual(
      tree.roots.map((r) => r.kind),
      ["platform", "platform", "skippedGroup", "unmatchedGroup"],
    );
    assert.equal(tree.roots[2]?.children[0]?.description, "sentinel · INERT");
    assert.equal(tree.roots[3]?.children[0]?.label, "nope.yaml");
  });

  it("filters by platform, and by a platform's tenant", () => {
    const plan = planView({
      ...document([
        change("splunk", "prod", "a", "create"),
        change("splunk", "dev", "b", "create"),
        change("sentinel", "t", "c", "create"),
      ]),
      skipped: [{ rule: "R", uuid: "u-r", platform: "sentinel", status: "DESIGN", strategy: "INERT" }],
    });
    const labels = (nodes: readonly TreeNode[]) => nodes.map((n) => n.label);
    assert.deepEqual(labels(planTree(plan, { platform: "sentinel" }).roots), ["sentinel", "Skipped"]);
    const splunk = planTree(plan, { platform: "splunk" }).roots;
    assert.deepEqual(labels(splunk), ["splunk"], "no skipped rule on this platform");
    assert.deepEqual(labels(splunk[0]?.children ?? []), ["dev", "prod"]);
    const prod = planTree(plan, { platform: "splunk", tenant: "prod" }).roots[0];
    assert.deepEqual(labels(prod?.children ?? []), ["prod"]);
    assert.equal(prod?.description, "+1");
    assert.deepEqual(filterChoices(plan).platforms, ["splunk", "sentinel"]);
    assert.deepEqual(
      filterChoices(plan).tenants.map((t) => `${t.platform}/${t.tenant}`),
      ["splunk/dev", "splunk/prod", "sentinel/t"],
    );
  });

  it("says in one line what the run was and what it found", () => {
    const plan = planView(REAL);
    assert.match(planMessage(plan, ["PREVIEW"]), /^Dry run · PREVIEW · /);
    assert.match(planMessage(plan, ["PREVIEW"]), /3 create or update/);
    assert.match(planMessage(plan, ["PREVIEW", "RELEASE"]), /PREVIEW \+ RELEASE/);
    assert.match(planMessage(plan, ["PREVIEW"]), /1 skipped/);
    assert.match(planMessage(plan, ["PREVIEW"], { platform: "splunk" }), /filtered: splunk$/);
    const empty = planMessage(planView(document([])), []);
    assert.equal(empty, "Dry run · PREVIEW · no changes");
    const failing = planMessage(
      planView(document([change("splunk", "prod", "a", "create", { fails: true })], { unmatched: ["x"] })),
      ["PREVIEW"],
    );
    assert.match(failing, /1 failed to compile · 1 not matched/);
  });

  it("builds a plan of 5,000 changes within 50 ms", () => {
    const platforms = ["sentinel", "splunk", "elastic", "crowdstrike"];
    const actions = ["create", "update", "upsert", "delete", "disable"];
    const changes = Array.from({ length: 5000 }, (_, i) =>
      change(
        platforms[i % platforms.length] ?? "x",
        `tenant-${i % 7}`,
        `rule-${i}`,
        actions[i % actions.length] ?? "create",
      ),
    );
    const plan = planView(document(changes));
    const SLACK = process.env.CI ? 4 : 1;
    planTree(plan); // the JIT
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      planTree(plan);
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    const median = times[2] ?? 0;
    assert.ok(median < 50 * SLACK, `the tree took ${median.toFixed(1)} ms`);
    assert.equal(planTree(plan).changes, 5000);
    const started = performance.now();
    planView(document(changes));
    assert.ok(performance.now() - started < 200 * SLACK, "reading the plan is not the slow part either");
  });
});
