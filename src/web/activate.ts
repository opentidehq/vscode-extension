// Web mode, shared by the browser entry (src/web/extension.ts) and the desktop's virtual workspaces
// (src/extension.ts): the engine (WASM) session, its views, the status, and an explanation instead of
// "command not found" for every command that needs opentide. No Node built-ins.
import * as vscode from "vscode";
import { ENGINE_STATUS, INSTALL_URL } from "../engine/protocol";
import {
  CONTINUE_ON_DESKTOP,
  contributedCommands,
  languageIds,
  STATUS,
  unavailableMessage,
  WEB_COMMANDS,
  WEB_DOCS_URL,
} from "./mode";
import { type EngineHost, EngineSession } from "./session";
import { registerViews } from "./views";

/** The command that opens this workspace in VS Code Desktop, where the window has one (the web). */
async function continueOnDesktop(): Promise<string | undefined> {
  if (vscode.env.uiKind !== vscode.UIKind.Web) return undefined;
  const commands = new Set(await vscode.commands.getCommands(true));
  return CONTINUE_ON_DESKTOP.find((command) => commands.has(command));
}

export function activateWeb(context: vscode.ExtensionContext, host: EngineHost): EngineSession {
  const packageJSON: unknown = context.extension.packageJSON;
  const docs = vscode.Uri.parse(WEB_DOCS_URL);
  const session = new EngineSession(host);
  context.subscriptions.push(session, registerViews(session));

  const status = vscode.languages.createLanguageStatusItem(
    "opentide.web",
    languageIds(packageJSON).map((language) => ({ language })),
  );
  status.name = STATUS.name;
  status.text = ENGINE_STATUS;
  status.detail = STATUS.detail;
  status.severity = vscode.LanguageStatusSeverity.Information;
  status.command = { title: STATUS.learnMore, command: "vscode.open", arguments: [docs] };
  const item = vscode.window.createStatusBarItem("opentide.status", vscode.StatusBarAlignment.Left, 50);
  item.name = "opentide";
  item.text = `$(shield) ${ENGINE_STATUS}`;
  item.tooltip = new vscode.MarkdownString(
    `**${ENGINE_STATUS}**\n\n${STATUS.tooltip}.\n\n[Output](command:opentide.showOutput) · [Learn More](${WEB_DOCS_URL})`,
  );
  item.tooltip.isTrusted = { enabledCommands: ["opentide.showOutput"] };
  item.command = "opentide.showOutput";
  item.show();
  context.subscriptions.push(status, item);

  const engineState = () => {
    status.severity = session.current
      ? vscode.LanguageStatusSeverity.Information
      : vscode.LanguageStatusSeverity.Warning;
    status.detail = session.current ? STATUS.detail : "the engine is not running: see the output";
  };
  context.subscriptions.push(
    session.onDidChange(engineState),
    vscode.commands.registerCommand("opentide.restartServer", () =>
      session.restart("opentide: Restart Server", false),
    ),
    vscode.commands.registerCommand("opentide.showOutput", () => session.output.show()),
    vscode.commands.registerCommand("opentide.installOpentide", () =>
      vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL)),
    ),
  );

  for (const { command, title } of contributedCommands(packageJSON)) {
    if (WEB_COMMANDS.has(command)) continue;
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async () => {
        const desktop = await continueOnDesktop();
        const choice = await vscode.window.showInformationMessage(
          unavailableMessage(title),
          ...(desktop ? [STATUS.openInDesktop] : []),
          STATUS.learnMore,
        );
        if (choice === STATUS.openInDesktop && desktop) await vscode.commands.executeCommand(desktop);
        else if (choice === STATUS.learnMore) await vscode.env.openExternal(docs);
      }),
    );
  }
  void session.restart("activation", false);
  return session;
}
