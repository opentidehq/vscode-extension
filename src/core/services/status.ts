// The status bar item (`$(shield) 0.21.0 $(zap) ✗ 2 ! 5 · repo pins 0.20.1`: runtime, warm backend, problems)
// with its menu, and the language status item that shows `capabilities.experimental.opentide` from
// initialize, inferring nothing (#3).
import * as vscode from "vscode";
import type { OpentideServerInfo, ProblemCounts, StatusMenuItem, StatusService } from "../context";
import { DOCUMENT_SELECTOR } from "../lsp";
import type { Fallback } from "../runtime/fallback";
import { describeRuntime, ENGINE_LABEL, ENGINE_STATUS } from "../runtime/types";
import { problemsText, type StatusModel, serveText, statusLabel, statusText, sumCounts } from "../statusText";

export class StatusManager implements StatusService, vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    "opentide.status",
    vscode.StatusBarAlignment.Left,
    50,
  );
  private readonly language = vscode.languages.createLanguageStatusItem("opentide.server", DOCUMENT_SELECTOR);
  private readonly counts = new Map<string, ProblemCounts>();
  private readonly menu: StatusMenuItem[] = [];
  private serve = false;
  private model: Omit<StatusModel, "counts" | "serve"> = {
    runtime: undefined,
    resolving: true,
    pin: undefined,
    trusted: true,
  };
  private serverInfo: OpentideServerInfo | undefined;
  private serverRunning = false;
  private fallback: Fallback | undefined;

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

  update(model: Omit<StatusModel, "counts" | "serve">): void {
    this.model = model;
    this.render();
  }

  /** The warm backend (`opentide serve`) started or stopped. */
  setServe(running: boolean): void {
    this.serve = running;
    this.render();
  }

  /** The problems the item counts, for the menu. */
  problemCounts(): ProblemCounts {
    return sumCounts(this.counts.values());
  }

  /** The runtime's own language server did not start: the engine serves the editor features. */
  setFallback(fallback: Fallback | undefined): void {
    this.fallback = fallback;
    this.render();
  }

  setServer(info: OpentideServerInfo | undefined, running: boolean): void {
    this.serverInfo = info;
    this.serverRunning = running;
    this.render();
  }

  private render(): void {
    const counts = sumCounts(this.counts.values());
    const model = { ...this.model, counts, serve: this.serve };
    this.item.text = statusText(model);
    this.item.accessibilityInformation = { label: statusLabel(model), role: "button" };
    const runtime = model.runtime;
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.isTrusted = {
      enabledCommands: [
        "workbench.actions.view.problems",
        "opentide.switchRuntime",
        "opentide.restartServer",
        "opentide.showOutput",
        "opentide.installOpentide",
      ],
    };
    if (runtime?.kind === "engine") {
      tooltip.appendMarkdown(`**${ENGINE_STATUS}** · engine ${runtime.version}\n\n`);
      tooltip.appendMarkdown(
        "No opentide answered (`opentide.path`, the workspace's environment, `python -m opentide`), so the " +
          "language server built for WebAssembly runs in the extension: diagnostics, hover, completion, " +
          "code actions, navigation, the Catalogue and Relations. Commands, validate and lint, deploy, query, " +
          "setup and MCP need opentide.",
      );
      tooltip.appendMarkdown(
        `\n\n$(${counts.errors ? "error" : counts.warnings ? "warning" : "pass"}) ${problemsText(counts)}`,
      );
      if (runtime.restricted) tooltip.appendMarkdown("\n\nRestricted Mode: only the language server runs.");
      tooltip.appendMarkdown(
        "\n\n---\n\n[Install opentide](command:opentide.installOpentide) · [Switch Runtime…](command:opentide.switchRuntime) · [Restart](command:opentide.restartServer) · [Output](command:opentide.showOutput)",
      );
    } else if (runtime) {
      tooltip.appendMarkdown(`**opentide ${runtime.version}** · ${describeRuntime(runtime)}\n\n`);
      tooltip.appendText(runtime.command);
      tooltip.appendMarkdown(`\n\n${model.serve ? "$(zap)" : "$(circle-large-outline)"} ${serveText(model)}`);
      tooltip.appendMarkdown(
        `\n\n$(${counts.errors ? "error" : counts.warnings ? "warning" : "pass"}) ${problemsText(counts)} in opentide's checks` +
          (counts.errors || counts.warnings
            ? " · [Show Problems](command:workbench.actions.view.problems)"
            : ""),
      );
      if (runtime.restricted) tooltip.appendMarkdown("\n\nRestricted Mode: only the language server runs.");
      if (this.fallback)
        tooltip.appendMarkdown(
          `\n\n$(warning) Its language server did not start (${this.fallback.reason}): the ${ENGINE_LABEL} serves the editor features.`,
        );
      if (model.pin && model.pin.version !== runtime.version) {
        tooltip.appendMarkdown(
          `\n\nThe repository pins opentide ${model.pin.version} (\`${model.pin.source}\`).`,
        );
      }
      tooltip.appendMarkdown(
        "\n\n---\n\n[Switch Runtime…](command:opentide.switchRuntime) · [Restart](command:opentide.restartServer) · [Output](command:opentide.showOutput)",
      );
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
    if (runtime.kind === "engine") {
      this.language.text = ENGINE_STATUS;
      this.language.detail = this.serverRunning
        ? `engine ${info?.engine ?? runtime.version} in a worker thread · catalog ${info?.catalog ?? "bundled"} · commands need opentide`
        : "the engine is not running: see the output";
      this.language.command = this.serverRunning
        ? { title: "Install opentide", command: "opentide.installOpentide" }
        : { title: "Restart", command: "opentide.restartServer" };
      return;
    }
    if (this.fallback) {
      this.language.text = `opentide ${runtime.version} · language server: ${ENGINE_LABEL}`;
      this.language.detail = `its own language server did not start (${this.fallback.reason}) · ${describeRuntime(runtime)}`;
      this.language.severity = vscode.LanguageStatusSeverity.Warning;
      return;
    }
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
