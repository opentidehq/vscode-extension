// The Activity view (SPEC §9): the last 50 commands the extension ran, with status, duration and the
// command line. vscode-free.
import type { ActivityEntry } from "../../core/activity";
import type { Classification } from "../../core/capabilities/classification";
import type { TreeNode } from "./node";

const ICON: Readonly<Record<ActivityEntry["status"], [string, string | undefined]>> = {
  running: ["loading~spin", undefined],
  ok: ["pass", "testing.iconPassed"],
  failed: ["error", "problemsErrorIcon.foreground"],
  cancelled: ["circle-slash", "descriptionForeground"],
  error: ["warning", "problemsWarningIcon.foreground"],
};

const WORD: Readonly<Record<ActivityEntry["status"], string>> = {
  running: "running",
  ok: "ok",
  failed: "failed",
  cancelled: "cancelled",
  error: "did not run",
};

export function duration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function ago(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/** Can a run be repeated from Activity? Never a deploy or a share (SPEC D6). */
export function canRerun(classification: Pick<Classification, "class">): boolean {
  return classification.class !== "deploys" && classification.class !== "shares";
}

/** What Run Again does with a run: refuse it, repeat it, or ask first (`message`, the button `action`). */
export type RerunPlan =
  | { readonly kind: "refuse" }
  | { readonly kind: "run" }
  | { readonly kind: "confirm"; readonly message: string; readonly action: string };

/**
 * Run Again for an Activity entry. A deploy or share never (D6); one that contacts a tenant or writes
 * workspace files (`setup ci … --yes`, `validate --fix`) asks first in a modal, so a click on an old entry
 * cannot rewrite files or reach a tenant unseen.
 */
export function rerunPlan(
  classification: Pick<Classification, "class" | "writes" | "contactsTenant">,
  argvDisplay: string,
): RerunPlan {
  if (!canRerun(classification)) return { kind: "refuse" };
  const effects = [
    classification.contactsTenant ? "contacts a tenant" : "",
    classification.writes ? "writes files in the workspace" : "",
  ].filter(Boolean);
  if (effects.length === 0) return { kind: "run" };
  return {
    kind: "confirm",
    message: `Run again? This ${effects.join(" and ")}: ${argvDisplay}`,
    action: "Run",
  };
}

export function activityNodes(
  entries: readonly ActivityEntry[],
  now: number,
  classify: (argv: readonly string[]) => Pick<Classification, "class">,
  folderName: (folder: string) => string | undefined,
): TreeNode[] {
  return entries.map((entry): TreeNode => {
    const [icon, color] = ICON[entry.status];
    const rerun = entry.status !== "running" && canRerun(classify(entry.argv));
    const folder = folderName(entry.folder);
    return {
      id: `run:${entry.id}`,
      label: entry.argv.join(" ") || "opentide",
      description: [
        WORD[entry.status],
        entry.exitCode !== undefined && entry.exitCode !== 0 ? `exit ${entry.exitCode}` : "",
        duration(entry.durationMs),
        ago(entry.startedAt, now),
      ]
        .filter(Boolean)
        .join(" · "),
      tooltip: [
        entry.argvDisplay,
        folder ? `in ${folder}` : `in ${entry.folder}`,
        `${WORD[entry.status]}${entry.via ? ` via ${entry.via}` : ""}${entry.durationMs !== undefined ? ` in ${duration(entry.durationMs)}` : ""}`,
        entry.failureCode ? `failure: ${entry.failureCode}` : "",
        entry.error ?? "",
      ]
        .filter(Boolean)
        .join("\n"),
      icon,
      ...(color ? { iconColor: color } : {}),
      contextValue: rerun ? "run.rerunnable" : "run",
      ref: { kind: "run", entry },
      search: entry.argvDisplay.toLowerCase(),
    };
  });
}

export function runningCount(entries: readonly ActivityEntry[]): number {
  return entries.filter((e) => e.status === "running").length;
}
