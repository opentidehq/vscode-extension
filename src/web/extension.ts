// The `browser` entry (vscode.dev, github.dev), also used for desktop virtual workspaces: grammar-only
// mode. Languages, TextMate grammars, language configuration and the workspace's own snippet files are
// declarative and work without this code. It adds what the SPEC (§13, D2) asks of a session with no
// Python: a language status item that says so, and an explanation, instead of "command not found", for
// every command that needs a process.
//
// TODO(#10, SPEC §13): in this order, each behind its own work item:
//   1. Semantic tokens from the WASM highlighter: load `opentide-wasm-web` (`highlight`, `legend`) in a
//      Worker, through `@opentide/lsp-worker` once it publishes (language-server#191; copy its worker
//      until then), with the document selector widened to non-`file` schemes (language-server#197).
//   2. The wasip1 language server, experimental and behind a setting until the runtime leaves preview:
//      `opentide-lsp-wasm32-wasip1.wasm` under `ms-vscode.wasm-wasi-core` with `@vscode/wasm-wasi-lsp`,
//      reading the virtual workspace's committed catalogs.
//   3. The Catalogue, search and the graph, from the server's index (`opentide/catalog`,
//      language-server#198, SPEC §15 L4) rather than from Python.
// Keep this bundle free of Node built-ins (test/scripts/web-bundle.test.mjs) and of src/core/.
import * as vscode from "vscode";
import { contributedCommands, languageIds, STATUS, unavailableMessage, WEB_DOCS_URL } from "./mode";

export function activate(context: vscode.ExtensionContext): void {
  const packageJSON: unknown = context.extension.packageJSON;
  const docs = vscode.Uri.parse(WEB_DOCS_URL);

  const status = vscode.languages.createLanguageStatusItem(
    "opentide.web",
    languageIds(packageJSON).map((language) => ({ language })),
  );
  status.name = STATUS.name;
  status.text = STATUS.text;
  status.detail = STATUS.detail;
  status.severity = vscode.LanguageStatusSeverity.Information;
  status.command = { title: STATUS.learnMore, command: "vscode.open", arguments: [docs] };
  context.subscriptions.push(status);

  for (const { command, title } of contributedCommands(packageJSON)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async () => {
        const choice = await vscode.window.showInformationMessage(
          unavailableMessage(title),
          STATUS.learnMore,
        );
        if (choice === STATUS.learnMore) await vscode.env.openExternal(docs);
      }),
    );
  }
}

export function deactivate(): void {
  // Everything is in context.subscriptions.
}
