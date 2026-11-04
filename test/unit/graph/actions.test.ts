import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  NODE_ACTION_COMMANDS,
  NODE_ACTIONS,
  nodeActions,
  nodeCommand,
} from "../../../src/features/graph/actions";
import { hostValidators, webviewValidators } from "../../../src/features/graph/protocol";
import { ROOT } from "../helpers";

const rule = { kind: "rule", uuid: "r1", filePath: "/ws/objects/rules/r.yaml" } as const;
const objective = { kind: "objective", uuid: "o1", filePath: "/ws/objects/objectives/o.yaml" } as const;
const threat = { kind: "threat", uuid: "t1", filePath: "/ws/objects/threats/t.yaml" } as const;

describe("graph: node actions", () => {
  it("offers each object kind its owning features' actions", () => {
    assert.deepEqual(nodeActions(rule, NODE_ACTIONS), ["validate", "runQuery", "previewDeploy"]);
    assert.deepEqual(nodeActions(objective, NODE_ACTIONS), ["validate", "newRule"]);
    assert.deepEqual(nodeActions(threat, NODE_ACTIONS), ["validate", "newObjective"]);
    assert.deepEqual(nodeActions({ kind: "technique" }, NODE_ACTIONS), []);
    assert.deepEqual(nodeActions({ kind: "signal", uuid: "s1", filePath: "/ws/o.yaml" }, NODE_ACTIONS), []);
  });

  it("leaves out what the window lacks, and a rule that failed to load gets validate only", () => {
    assert.deepEqual(nodeActions(rule, ["validate", "previewDeploy"]), ["validate", "previewDeploy"]);
    assert.deepEqual(nodeActions({ ...rule, loadError: "bad yaml" }, NODE_ACTIONS), ["validate"]);
  });

  it("passes each command the argument shape it accepts", () => {
    assert.deepEqual(nodeCommand("runQuery", rule, "/ws"), {
      command: "opentide.query.run",
      args: [{ uuid: "r1", folder: "/ws" }],
    });
    assert.deepEqual(nodeCommand("previewDeploy", rule, "/ws"), {
      command: "opentide.deployPlan.open",
      args: [{ uuid: "r1", folder: "/ws" }],
    });
    assert.deepEqual(nodeCommand("newRule", objective, "/ws"), {
      command: "opentide.newObject.ruleForObjective",
      args: [{ uuid: "o1", folder: "/ws" }],
    });
    assert.deepEqual(nodeCommand("newObjective", threat, "/ws"), {
      command: "opentide.newObject.objectiveForThreat",
      args: [{ uuid: "t1", folder: "/ws" }],
    });
    assert.deepEqual(nodeCommand("validate", rule, "/ws"), {
      command: "opentide.diagnostics.validateFile",
      args: [],
      file: rule.filePath,
    });
    assert.equal(nodeCommand("runQuery", objective, "/ws"), undefined);
  });

  it("names only contributed commands", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      contributes: { commands: { command: string }[] };
    };
    const declared = new Set(pkg.contributes.commands.map((c) => c.command));
    for (const command of Object.values(NODE_ACTION_COMMANDS)) assert.ok(declared.has(command), command);
  });

  it("validates the messages", () => {
    assert.equal(hostValidators.nodeAction({ action: "runQuery", id: "r1" }), true);
    assert.equal(hostValidators.nodeAction({ action: "deploy", id: "r1" }), false);
    assert.equal(hostValidators.nodeAction({ action: "runQuery" }), false);
    assert.equal(webviewValidators.actions(["validate"]), true);
    assert.equal(webviewValidators.actions(["rm"]), false);
  });
});
