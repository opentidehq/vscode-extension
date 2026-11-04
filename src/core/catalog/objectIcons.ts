// The icon and colour of each kind of catalogue object, the same in the sidebar, the graph and every
// panel: a codicon id (without `$( )`) and a theme colour id (`charts.red`, as vscode.ThemeColor takes;
// a webview reads it as `--vscode-charts-red`). vscode-free.

export type ObjectIconKind = "threat" | "objective" | "rule" | "signal" | "technique" | "logsource";

export interface ObjectIcon {
  readonly codicon: string;
  readonly themeColor: string;
}

export const OBJECT_ICONS: Readonly<Record<ObjectIconKind, ObjectIcon>> = {
  threat: { codicon: "flame", themeColor: "charts.red" },
  objective: { codicon: "target", themeColor: "charts.blue" },
  rule: { codicon: "shield", themeColor: "charts.green" },
  signal: { codicon: "pulse", themeColor: "charts.purple" },
  technique: { codicon: "symbol-event", themeColor: "charts.orange" },
  logsource: { codicon: "database", themeColor: "terminal.ansiCyan" },
};
