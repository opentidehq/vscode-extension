// Quick picks before a query runs: tenants, window, and credentials a tenant still needs.
import * as vscode from "vscode";
import type { FeatureContext } from "../../core/context";
import { isDuration, type QueryWindow } from "./argv";
import { platformLabel } from "./lenses";
import { missingVariables, type TenantInfo } from "./platforms";

const ALL = "all";

/**
 * Tenants to contact. `known` are `info`'s tenants (descriptions, strategies, variables); `choices` the
 * names the CLI offered (with `all`). One tenant needs no question.
 */
export async function pickTenants(
  platform: string,
  options: { known?: readonly TenantInfo[]; choices?: readonly string[]; previous?: readonly string[] },
): Promise<readonly string[] | undefined> {
  const names = options.known?.map((t) => t.name) ?? options.choices?.filter((c) => c !== ALL) ?? [];
  if (names.length === 1) return names;
  if (names.length === 0) return undefined;
  const items = names.map((name): vscode.QuickPickItem & { name: string } => {
    const info = options.known?.find((t) => t.name === name);
    return {
      name,
      label: name,
      description: info?.description || undefined,
      detail: info
        ? [info.strategies.join(", "), info.manual ? "manual" : ""].filter(Boolean).join(" · ") || undefined
        : undefined,
      picked: options.previous?.includes(name) ?? false,
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    title: `Run on ${platformLabel(platform)} tenants`,
    placeHolder: "Pick the tenants to query (read-only). Each one is contacted.",
    canPickMany: true,
    ignoreFocusOut: true,
  });
  if (!picked || picked.length === 0) return undefined;
  return picked.length === names.length ? [ALL] : picked.map((item) => item.name);
}

const PRESETS: readonly { label: string; since: string }[] = [
  { label: "Last 15 minutes", since: "15m" },
  { label: "Last hour", since: "1h" },
  { label: "Last 24 hours", since: "24h" },
  { label: "Last 7 days", since: "7d" },
  { label: "Last 30 days", since: "30d" },
];

/** The time window: a preset, a custom look-back or an explicit range. */
export async function pickWindow(previous: QueryWindow): Promise<QueryWindow | undefined> {
  type Item = vscode.QuickPickItem & { window?: QueryWindow; custom?: "since" | "range" };
  const items: Item[] = [
    ...PRESETS.map((preset) => ({
      label: preset.label,
      description: `--since ${preset.since}`,
      window: { kind: "since", since: preset.since } as const,
    })),
    { label: "Look back…", description: "--since 2h, 3d, PT90M", custom: "since" },
    { label: "Time range…", description: "--from / --to (ISO-8601)", custom: "range" },
  ];
  const active =
    previous.kind === "since"
      ? (items.find((item) => item.window?.kind === "since" && item.window.since === previous.since) ??
        items[1])
      : items.find((item) => item.custom === "range");
  const quickPick = vscode.window.createQuickPick<Item>();
  quickPick.title = "Time window";
  quickPick.placeholder = "Which events to search";
  quickPick.items = items;
  quickPick.ignoreFocusOut = true;
  if (active) quickPick.activeItems = [active];
  const choice = await new Promise<Item | undefined>((resolve) => {
    quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0] ?? quickPick.activeItems[0]));
    quickPick.onDidHide(() => resolve(undefined));
    quickPick.show();
  });
  quickPick.dispose();
  if (!choice) return undefined;
  if (choice.window) return choice.window;
  if (choice.custom === "since") {
    const since = await vscode.window.showInputBox({
      title: "Look back",
      prompt: "A duration: 15m, 24h, 7d or ISO-8601 (PT1H)",
      value: previous.kind === "since" ? previous.since : "24h",
      validateInput: (value) =>
        isDuration(value) ? undefined : "Use a duration such as 15m, 24h, 7d or PT1H",
    });
    return since ? { kind: "since", since: since.trim() } : undefined;
  }
  const iso = (value: string) =>
    value.trim() === "" || !Number.isNaN(Date.parse(value.trim())) ? undefined : "Use an ISO-8601 time";
  const from = await vscode.window.showInputBox({
    title: "Time range: from",
    prompt: "Start, ISO-8601 (UTC unless it names an offset)",
    value: previous.kind === "range" ? previous.from : new Date(Date.now() - 86_400_000).toISOString(),
    validateInput: (value) => (value.trim() ? iso(value) : "Enter a start time"),
  });
  if (!from) return undefined;
  const to = await vscode.window.showInputBox({
    title: "Time range: to",
    prompt: "End, ISO-8601. Leave empty for now",
    value: previous.kind === "range" ? (previous.to ?? "") : "",
    validateInput: iso,
  });
  if (to === undefined) return undefined;
  return { kind: "range", from: from.trim(), ...(to.trim() ? { to: to.trim() } : {}) };
}

/**
 * Credentials the picked tenants still need. Offers to store each in SecretStorage (never a file).
 * Resolves false when the person dismissed the question.
 */
export async function ensureCredentials(
  ctx: FeatureContext,
  folder: string,
  tenants: readonly TenantInfo[],
): Promise<boolean> {
  const stored = new Set(await ctx.credentials.names(folder));
  const missing = [...new Set(tenants.flatMap((tenant) => missingVariables(tenant, stored)))];
  if (missing.length === 0) return true;
  const names = missing.map((name) => `$${name}`).join(", ");
  const answer = await vscode.window.showWarningMessage(
    `${tenants.length === 1 ? tenants[0]?.name : "These tenants"} need${tenants.length === 1 ? "s" : ""} ${names}, which is not set.`,
    "Set Credential…",
    "Run Anyway",
  );
  if (answer === "Run Anyway") return true;
  if (answer !== "Set Credential…") return false;
  for (const name of missing) {
    const value = await vscode.window.showInputBox({
      title: `Set $${name}`,
      prompt:
        "Stored in VS Code's secret storage for this folder and passed only to commands that contact a tenant",
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return false;
    if (value) await ctx.credentials.set(folder, name, value);
  }
  return true;
}
