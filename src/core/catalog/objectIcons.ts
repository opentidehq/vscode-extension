// The icon and colour of each kind of thing the catalogue holds, the same in every surface: the sidebar's
// tree views, the graph, hovers and CodeLens. vscode-free: a codicon id and a theme colour id, which a
// tree item turns into a ThemeIcon and a webview into `--vscode-<id with . as ->`.

/** Something a surface draws with an icon: an object type, a signal, a technique or a log source. */
export type IconKind = "threat" | "objective" | "rule" | "signal" | "technique" | "logsource";

export interface ObjectIcon {
  /** A codicon id, without `$( )`. */
  readonly codicon: string;
  /** A theme colour id (`charts.red`); in a webview, `var(--vscode-charts-red)`. */
  readonly themeColor: string;
}

/** Threat, objective, signal and rule colours are the graph's (`webview/graph`). */
export const OBJECT_ICONS: Readonly<Record<IconKind, ObjectIcon>> = {
  threat: { codicon: "flame", themeColor: "charts.red" },
  objective: { codicon: "target", themeColor: "charts.blue" },
  rule: { codicon: "shield", themeColor: "charts.green" },
  signal: { codicon: "pulse", themeColor: "charts.purple" },
  technique: { codicon: "symbol-event", themeColor: "charts.orange" },
  logsource: { codicon: "database", themeColor: "terminal.ansiCyan" },
};

/** An object of a type this map does not know (a newer schema family). */
export const OTHER_ICON: ObjectIcon = { codicon: "file", themeColor: "foreground" };

const NAMES: Readonly<Record<IconKind, readonly [one: string, many: string]>> = {
  threat: ["Threat", "threats"],
  objective: ["Objective", "objectives"],
  rule: ["Rule", "rules"],
  signal: ["Signal", "signals"],
  technique: ["Technique", "techniques"],
  logsource: ["Log source", "log sources"],
};

function known(kind: string | null | undefined): kind is IconKind {
  return typeof kind === "string" && Object.hasOwn(OBJECT_ICONS, kind);
}

/** The icon of `kind` (an object's `type`, or `signal`, `technique`, `logsource`). */
export function objectIcon(kind: string | null | undefined): ObjectIcon {
  return known(kind) ? OBJECT_ICONS[kind] : OTHER_ICON;
}

/** `Rule`: the kind's name, capitalised, for a header ("Rule · LSASS handle opened"). */
export function kindName(kind: string | null | undefined): string {
  if (known(kind)) return NAMES[kind][0];
  return kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : "Object";
}

/** `1 rule`, `3 rules`; `objects` for a mix or an unknown kind. */
export function countOf(count: number, kind: string | null | undefined): string {
  if (!known(kind)) return `${count} ${count === 1 ? "object" : "objects"}`;
  return `${count} ${count === 1 ? NAMES[kind][0].toLowerCase() : NAMES[kind][1]}`;
}

/** The CSS variable of a theme colour id: `charts.red` → `--vscode-charts-red`. */
export function themeColorVariable(themeColor: string): string {
  return `--vscode-${themeColor.replaceAll(".", "-")}`;
}
