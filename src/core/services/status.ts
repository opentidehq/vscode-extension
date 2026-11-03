// The status bar item (`$(shield) 0.21.0 ✗ 2 ! 5 · repo pins 0.20.1`) with its menu, and the language status
// item that shows `capabilities.experimental.opentide` from initialize, inferring nothing (#3).
import * as vscode from "vscode";
import type { OpentideServerInfo, ProblemCounts, StatusMenuItem, StatusService } from "../context";
import { DOCUMENT_SELECTOR } from "../lsp";
import { describeRuntime } from "../runtime/types";
import { type StatusModel, statusText, sumCounts } from "../statusText";

export class StatusManager implements StatusService, vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    "opentide.status",
    vscode.StatusBarAlignment.Left,
    50,
  );
  private readonly language = vscode.languages.createLanguageStatusItem("opentide.server", DOCUMENT_SELECTOR);
  private readonly counts = new Map<string, ProblemCounts>();
  private readonly menu: StatusMenuItem[] = [];
  private model: Omit<StatusModel, "counts"> = {
    runtime: undefined,
    resolving: true,
    pin: undefined,
    trusted: true,
  };
  private serverInfo: OpentideServerInfo | undefined;
  private serverRunning = false;

  constructor() {
    this.item.name = "opentide";
    this.item.command = "opentide.statusMenu";
    this.language.name = "opentide";
    this.render();
    this.item.show();
  }

  setCounts(source: string, counts: ProblemCounts | undefined): void {
    if (counts) this.counts.set(source, counts);
    else this.counts.delete(source);
    this.render();
  }

  addMenuItem(item: StatusMenuItem): vscode.Disposable {
    this.menu.push(item);
    return new vscode.Disposable(() => {
      const index = this.menu.indexOf(item);
      if (index >= 0) this.menu.splice(index, 1);
    });
  }

  menuItems(): StatusMenuItem[] {
    return [...this.menu].sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  }

  update(model: Omit<StatusModel, "counts">): void {
    this.model = model;
    this.render();
  }

  setServer(info: OpentideServerInfo | undefined, running: boolean): void {
    this.serverInfo = info;
    this.serverRunning = running;
    this.render();
  }

  private render(): void {
    const counts = sumCounts(this.counts.values());
    const model = { ...this.model, counts };
    this.item.text = statusText(model);
    const runtime = model.runtime;
    const tooltip = new vscode.MarkdownString(undefined, true);
    if (runtime) {
      tooltip.appendMarkdown(`**opentide ${runtime.version}** · ${describeRuntime(runtime)}\n\n`);
      tooltip.appendText(runtime.command);
      if (runtime.restricted) tooltip.appendMarkdown("\n\nRestricted Mode: only the language server runs.");
      if (model.pin && model.pin.version !== runtime.version) {
        tooltip.appendMarkdown(
          `\n\nThe repository pins opentide ${model.pin.version} (\`${model.pin.source}\`).`,
        );
      }
    } else if (!model.resolving) {
      tooltip.appendMarkdown(
        "No opentide runtime. Install opentide in the workspace or set `opentide.path`.",
      );
    }
    this.item.tooltip = tooltip;
    this.item.backgroundColor =
      counts.errors > 0 ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;

    const info = this.serverInfo;
    if (!runtime) {
      this.language.text = "opentide: no runtime";
      this.language.detail = "Grammars only";
      this.language.severity = vscode.LanguageStatusSeverity.Warning;
      this.language.command = { title: "Show output", command: "opentide.showOutput" };
      return;
    }
    this.language.severity = this.serverRunning
      ? vscode.LanguageStatusSeverity.Information
      : vscode.LanguageStatusSeverity.Warning;
    this.language.command = { title: "Restart", command: "opentide.restartServer" };
    if (!this.serverRunning) {
      this.language.text = `opentide ${runtime.version}`;
      this.language.detail = "language server not running";
      return;
    }
    this.language.text = `opentide ${info?.host?.version ?? runtime.version}`;
    const where = `${describeRuntime(runtime)} · ${runtime.interpreter ?? runtime.command}`;
    this.language.detail = info
      ? `host ${info.host ? `${info.host.name} ${info.host.version}` : "none"} · engine ${info.engine} · catalog ${info.catalog} · ` +
        `configurationChecks ${info.configurationChecks} · configurationSchemas ${info.configurationSchemas} · ${where}`
      : `the server reports no capabilities.experimental.opentide · ${where}`;
  }

  dispose(): void {
    this.item.dispose();
    this.language.dispose();
  }
}
