// Which other feature's command a sidebar action hands over to, and with what. vscode-free; index.ts
// turns `folder` into a vscode.Uri.
import type { NodeRef } from "./node";

export type Handover =
  | { readonly command: string; readonly uuid: string }
  | { readonly command: string; readonly folder: string }
  | { readonly command: string };

/**
 * New… on a node (new-object feature): a rule for an objective, an objective for a threat, an objective
 * from a coverage gap, else the generic flow in the node's folder.
 */
export function newObjectHandover(ref: NodeRef | undefined): Handover {
  if (ref?.kind === "object" && ref.type === "objective")
    return { command: "opentide.newObject.ruleForObjective", uuid: ref.uuid };
  if (ref?.kind === "object" && ref.type === "threat")
    return { command: "opentide.newObject.objectiveForThreat", uuid: ref.uuid };
  if (ref?.kind === "technique") return { command: "opentide.newObject.objective" };
  if (ref && "folder" in ref) return { command: "opentide.newObject", folder: ref.folder };
  return { command: "opentide.newObject" };
}

/** The diagnostics feature validates a file into Problems; without it the sidebar runs validate itself. */
export const VALIDATE_FILE = "opentide.diagnostics.validateFile";
/** The runner's sharing preview, for one object file. */
export const SHARE_PREVIEW = "opentide.runner.sharePreview";
