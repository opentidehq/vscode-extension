// What a graph node's context menu hands to the features that own each action. vscode-free; index.ts
// turns `file` into a vscode.Uri and checks which commands the window has.
import type { GraphNode } from "./model";

/** Node actions the webview may ask for; each is another feature's command. */
export const NODE_ACTIONS = ["validate", "runQuery", "previewDeploy", "newRule", "newObjective"] as const;
export type NodeAction = (typeof NODE_ACTIONS)[number];

/** The command each action runs. */
export const NODE_ACTION_COMMANDS: Readonly<Record<NodeAction, string>> = {
  validate: "opentide.diagnostics.validateFile",
  runQuery: "opentide.query.run",
  previewDeploy: "opentide.deployPlan.open",
  newRule: "opentide.newObject.ruleForObjective",
  newObjective: "opentide.newObject.objectiveForThreat",
};

export const NODE_ACTION_LABELS: Readonly<Record<NodeAction, string>> = {
  validate: "Validate file",
  runQuery: "Run query on tenants…",
  previewDeploy: "Preview deploy",
  newRule: "New rule for this objective…",
  newObjective: "New objective for this threat…",
};

export function isNodeAction(value: unknown): value is NodeAction {
  return typeof value === "string" && (NODE_ACTIONS as readonly string[]).includes(value);
}

/** The actions that make sense on a node, of those the window has (`available`), in menu order. */
export function nodeActions(
  node: Pick<GraphNode, "kind" | "uuid" | "filePath" | "loadError">,
  available: readonly NodeAction[],
): NodeAction[] {
  const wanted: NodeAction[] = [];
  const object = node.kind === "rule" || node.kind === "objective" || node.kind === "threat";
  if (object && node.filePath) wanted.push("validate");
  if (node.uuid && !node.loadError) {
    if (node.kind === "rule") wanted.push("runQuery", "previewDeploy");
    if (node.kind === "objective") wanted.push("newRule");
    if (node.kind === "threat") wanted.push("newObjective");
  }
  return wanted.filter((action) => available.includes(action));
}

/** The command and arguments for an action on a node in `folder`; undefined when it does not apply. */
export function nodeCommand(
  action: NodeAction,
  node: Pick<GraphNode, "kind" | "uuid" | "filePath" | "loadError">,
  folder: string,
): { readonly command: string; readonly args: readonly unknown[]; readonly file?: string } | undefined {
  if (!nodeActions(node, NODE_ACTIONS).includes(action)) return undefined;
  const command = NODE_ACTION_COMMANDS[action];
  switch (action) {
    case "validate":
      return node.filePath ? { command, args: [], file: node.filePath } : undefined;
    case "runQuery":
    case "previewDeploy":
      return { command, args: [{ uuid: node.uuid, folder }] };
    case "newRule":
    case "newObjective":
      return { command, args: [node.uuid] };
  }
}
