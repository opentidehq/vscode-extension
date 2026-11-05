// Saying that opentide cannot run something, with Install opentide and Switch Runtime… (core/unavailable).
import * as vscode from "vscode";
import {
  INSTALL_ACTION,
  INSTALL_URL,
  SWITCH_ACTION,
  type UnavailableCode,
  unavailableActions,
} from "../unavailable";

/** Run the action a user picked from a message's buttons; false when it is not one of ours. */
export async function runUnavailableAction(picked: string | undefined): Promise<boolean> {
  if (picked === INSTALL_ACTION) {
    await vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL));
    return true;
  }
  if (picked === SWITCH_ACTION) {
    await vscode.commands.executeCommand("opentide.switchRuntime");
    return true;
  }
  return false;
}

/** Show `message` with the actions `code` offers, and run the one picked. */
export async function explainUnavailable(
  code: UnavailableCode,
  message: string,
  severity: "warning" | "information" = "warning",
): Promise<void> {
  const show =
    severity === "warning" ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
  await runUnavailableAction(await show(message, ...unavailableActions(code)));
}
