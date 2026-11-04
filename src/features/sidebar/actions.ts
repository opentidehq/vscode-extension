// Which other feature's command a sidebar action hands over to, and with what. vscode-free; index.ts
// turns `folder` into a vscode.Uri.
import type { NodeRef } from "./node";

export type Handover =
  | { readonly command: string; readonly folder: string }
  | { readonly command: string; readonly args: { readonly uuid?: string; readonly folder: string } }
  | { readonly command: string };

/**
 * New… on a node (new-object feature): a rule for an objective, an objective for a threat, an objective
 * from a coverage gap, else the generic flow in the node's folder.
 */
export function newObjectHandover(ref: NodeRef | undefined): Handover {
  // `{uuid, folder}`: in a multi-root window the new object goes in its parent's folder.
  if (ref?.kind === "object" && ref.type === "objective")
    return { command: "opentide.newObject.ruleForObjective", args: { uuid: ref.uuid, folder: ref.folder } };
  if (ref?.kind === "object" && ref.type === "threat")
    return { command: "opentide.newObject.objectiveForThreat", args: { uuid: ref.uuid, folder: ref.folder } };
  // `{folder}`, not a folder URI: a URI is where to write (`--path`), and the repository root is no
  // objective folder. `opentide new objective` takes no technique.
  if (ref?.kind === "technique")
    return { command: "opentide.newObject.objective", args: { folder: ref.folder } };
  if (ref && "folder" in ref) return { command: "opentide.newObject", folder: ref.folder };
  return { command: "opentide.newObject" };
}

/** The diagnostics feature validates a file into Problems; without it the sidebar runs validate itself. */
export const VALIDATE_FILE = "opentide.diagnostics.validateFile";
/** The runner's sharing preview, for one object file. */
export const SHARE_PREVIEW = "opentide.runner.sharePreview";

/** The query feature's runner, for a rule (`{uuid, folder}`). */
export const RUN_QUERY = "opentide.query.run";
/** The deploy plan, for a rule (`{uuid, folder}`). */
export const PREVIEW_DEPLOY = "opentide.deployPlan.open";

/** Run query / Preview Deploy on a rule node: the rule's UUID and folder; nothing for other nodes. */
export function ruleHandover(ref: NodeRef | undefined, command: string): Handover | undefined {
  if (ref?.kind !== "object" || ref.type !== "rule") return undefined;
  return { command, args: { uuid: ref.uuid, folder: ref.folder } };
}
