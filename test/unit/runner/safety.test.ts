import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classify } from "../../../src/core/capabilities/classification";
import { CommandTree } from "../../../src/core/capabilities/tree";
import { fieldsOf } from "../../../src/features/runner/form";
import {
  DRY_RUN,
  flagValues,
  planRun,
  platformsOf,
  selectedRuleCount,
} from "../../../src/features/runner/safety";
import { COMMANDS_FIXTURE } from "../helpers";

const tree = CommandTree.parse(JSON.parse(readFileSync(COMMANDS_FIXTURE, "utf8")));
const plan = (argv: string[]) => {
  const { path } = tree.commandPathOf(argv);
  return planRun(argv, path, classify(argv), tree.hasOption(path, DRY_RUN));
};

describe("runner safety (D6)", () => {
  it("runs read-only, writing and tenant commands as picked", () => {
    assert.deepEqual(plan(["validate"]), { kind: "run", argv: ["validate"] });
    assert.deepEqual(plan(["validate", "--fix"]), { kind: "run", argv: ["validate", "--fix"] });
    assert.deepEqual(plan(["deploy", "--dry-run"]), { kind: "run", argv: ["deploy", "--dry-run"] });
    assert.equal(plan(["query", "--platform", "sentinel", "x"]).kind, "run");
  });

  it("turns a deploy into its dry run, behind a confirmation", () => {
    assert.deepEqual(plan(["deploy", "--platform", "sentinel"]), {
      kind: "confirm",
      argv: ["deploy", "--platform", "sentinel", "--dry-run"],
      dryRunAdded: true,
    });
  });

  it("drops --yes from a share and runs its dry run", () => {
    assert.deepEqual(plan(["share", "push", "--yes"]), {
      kind: "confirm",
      argv: ["share", "push", "--dry-run"],
      dryRunAdded: true,
    });
    assert.deepEqual(plan(["share", "push", "--dry-run"]), {
      kind: "confirm",
      argv: ["share", "push", "--dry-run"],
      dryRunAdded: false,
    });
  });

  it("refuses what has no dry run, and offers share preview for a share", () => {
    const migrate = plan(["deploy", "migrate-state"]);
    assert.equal(migrate.kind, "refuse");
    assert.ok(migrate.kind === "refuse" && !migrate.alternative);
    const retract = plan(["share", "retract", "--uuid", "x", "--yes"]);
    assert.equal(retract.kind, "refuse");
    assert.ok(retract.kind === "refuse" && retract.alternative === "opentide share preview");
  });

  it("never lets a deploy or share command of the pinned tree run without --dry-run", () => {
    for (const command of tree.commands) {
      const argv = command.path.split(" ");
      const cls = classify(argv).class;
      if (cls !== "deploys" && cls !== "shares") continue;
      const result = plan(argv);
      assert.ok(
        result.kind === "refuse" || (result.kind === "confirm" && result.argv.includes(DRY_RUN)),
        command.path,
      );
      // Every flag the form can add keeps it that way.
      const flags = fieldsOf(command).flatMap((f) => (f.kind === "flag" && f.flag ? [f.flag] : []));
      const withFlags = plan([...argv, ...flags]);
      assert.ok(
        withFlags.kind === "refuse" || withFlags.argv.includes(DRY_RUN),
        `${command.path} ${flags.join(" ")}`,
      );
    }
  });

  it("reads platforms and rule selections from the argv", () => {
    assert.deepEqual(flagValues(["deploy", "--platform", "a", "--platform=b"], "--platform"), ["a", "b"]);
    assert.deepEqual(platformsOf(["query", "--platform", "splunk"]), ["splunk"]);
    assert.deepEqual(platformsOf(["generate", "extract", "defender"]), ["defender_for_endpoint"]);
    assert.deepEqual(platformsOf(["generate", "extract", "sentinel"]), ["sentinel"]);
    assert.equal(platformsOf(["doctor"]), undefined);
    assert.equal(selectedRuleCount(["deploy", "--uuid", "a", "--file", "b"]), 2);
    assert.equal(selectedRuleCount(["deploy"]), undefined);
  });
});
