// The Health view (SPEC §9): `opentide doctor` checks, pass/warn/fail/skip, each with its fix; a fix
// that is an opentide command can run from the view. vscode-free.
import { branch, type TreeNode } from "./node";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  readonly code: string;
  readonly status: CheckStatus;
  readonly message: string;
  readonly fix: string | null;
  readonly subject: string | null;
}

export interface HealthSummary {
  readonly passed: number;
  readonly warnings: number;
  readonly failed: number;
  readonly skipped: number;
}

const STATUSES: readonly CheckStatus[] = ["pass", "warn", "fail", "skip"];

export function parseChecks(document: unknown): DoctorCheck[] {
  const checks = (document as { checks?: unknown } | undefined)?.checks;
  if (!Array.isArray(checks)) return [];
  return checks.flatMap((raw): DoctorCheck[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const c = raw as Record<string, unknown>;
    if (typeof c.code !== "string" || !STATUSES.includes(c.status as CheckStatus)) return [];
    return [
      {
        code: c.code,
        status: c.status as CheckStatus,
        message: typeof c.message === "string" ? c.message : "",
        fix: typeof c.fix === "string" && c.fix.trim() ? c.fix : null,
        subject: typeof c.subject === "string" ? c.subject : null,
      },
    ];
  });
}

export function summarize(checks: readonly DoctorCheck[]): HealthSummary {
  const n = (status: CheckStatus) => checks.filter((c) => c.status === status).length;
  return { passed: n("pass"), warnings: n("warn"), failed: n("fail"), skipped: n("skip") };
}

/** `✓ 15  ! 2  ✗ 1`, as the SPEC's sidebar sketch shows it. */
export function summaryText(summary: HealthSummary): string {
  return [
    `✓ ${summary.passed}`,
    summary.warnings ? `! ${summary.warnings}` : "",
    summary.failed ? `✗ ${summary.failed}` : "",
  ]
    .filter(Boolean)
    .join("  ");
}

const SHELL = /[|;&<>`$\\]/;

/**
 * The argv of a fix that is an opentide command: `opentide generate schemas` → `["generate", "schemas"]`.
 * Stops at a parenthesised aside (`opentide setup mcp --vscode (or --cursor, …)`). Undefined for prose
 * ("add a [[tenants]] entry …"), other programs (`git init ./`) and anything with shell syntax.
 */
export function fixArgv(fix: string | null): string[] | undefined {
  if (!fix) return undefined;
  const words = fix.trim().split(/\s+/);
  if (words[0] !== "opentide") return undefined;
  const argv: string[] = [];
  for (const word of words.slice(1)) {
    if (word.startsWith("(")) break;
    if (SHELL.test(word) || word.includes("'") || word.includes('"')) return undefined;
    if (word === "--json") continue;
    argv.push(word);
  }
  return argv.length > 0 && /^[a-z]/.test(argv[0] ?? "") ? argv : undefined;
}

const ICON: Readonly<Record<CheckStatus, [string, string]>> = {
  fail: ["error", "problemsErrorIcon.foreground"],
  warn: ["warning", "problemsWarningIcon.foreground"],
  pass: ["pass", "testing.iconPassed"],
  skip: ["circle-slash", "descriptionForeground"],
};

const RANK: Readonly<Record<CheckStatus, number>> = { fail: 0, warn: 1, pass: 2, skip: 3 };

const STATUS_WORD: Readonly<Record<CheckStatus, string>> = {
  fail: "Failed",
  warn: "Warning",
  pass: "Passed",
  skip: "Skipped",
};

/** Tree nodes: failures, then warnings, passes and skips, each in doctor's order. */
export function healthNodes(checks: readonly DoctorCheck[], folder: string, prefix = ""): TreeNode[] {
  return checks
    .map((check, index) => ({ check, index }))
    .sort((a, b) => RANK[a.check.status] - RANK[b.check.status] || a.index - b.index)
    .map(({ check, index }) => {
      const [icon, color] = ICON[check.status];
      const runnable = fixArgv(check.fix) !== undefined;
      const node = {
        id: `${prefix}check:${check.code}:${check.subject ?? ""}:${index}`,
        label: check.message || check.code,
        description: [check.code, check.subject].filter(Boolean).join(" · "),
        tooltip: [
          `${STATUS_WORD[check.status]}: ${check.message}`,
          check.fix ? `Fix: ${check.fix}` : "",
          `Check: ${check.code}`,
        ]
          .filter(Boolean)
          .join("\n"),
        icon,
        iconColor: color,
        contextValue: check.fix ? (runnable ? "check.runnable" : "check.fix") : "check",
        ref: { kind: "check" as const, folder, check },
        search: `${check.code}\n${check.message}\n${check.subject ?? ""}`.toLowerCase(),
      };
      if (!check.fix || check.status === "pass") return node;
      return branch(
        node,
        [
          {
            id: `${node.id}/fix`,
            label: check.fix,
            icon: runnable ? "play" : "lightbulb",
            tooltip: runnable ? `Run: ${check.fix}` : check.fix,
            contextValue: runnable ? "check.fixLine.runnable" : "check.fixLine",
            ref: { kind: "check" as const, folder, check },
            ...(runnable
              ? {
                  command: {
                    command: "opentide.sidebar.runFix",
                    title: "Run Fix",
                    args: [{ kind: "check", folder, check }],
                  },
                }
              : {}),
          },
        ],
        check.status === "fail" ? "expanded" : "collapsed",
      );
    });
}

export interface ReportContext {
  readonly opentide?: string;
  readonly editor?: string;
  readonly os?: string;
  /** Replaced by `~`. */
  readonly home?: string;
  /** Replaced by `<workspace>`. */
  readonly folder?: string;
  /** Secret values that must not appear (stored credentials); replaced by `***`. */
  readonly secrets?: readonly string[];
}

/** A plain-text report for a bug report, with paths and secrets redacted. */
export function report(checks: readonly DoctorCheck[], context: ReportContext): string {
  const summary = summarize(checks);
  const lines = [
    "opentide doctor",
    [context.opentide && `opentide ${context.opentide}`, context.editor, context.os]
      .filter(Boolean)
      .join(" · "),
    "",
    ...checks.flatMap((c) => [
      `${{ pass: "✓", warn: "!", fail: "✗", skip: "○" }[c.status]} ${c.message} · ${c.code}${c.subject ? ` (${c.subject})` : ""}`,
      ...(c.fix ? [`  → ${c.fix}`] : []),
    ]),
    "",
    `${summary.failed} failed · ${summary.warnings} warnings · ${summary.passed} passed · ${summary.skipped} skipped`,
  ].filter((line, i) => i !== 1 || line);
  return redact(lines.join("\n"), context);
}

export function redact(text: string, context: Pick<ReportContext, "home" | "folder" | "secrets">): string {
  let out = text;
  for (const secret of context.secrets ?? []) if (secret.length >= 4) out = out.split(secret).join("***");
  // The folder first: it is usually under home.
  if (context.folder) out = out.split(context.folder).join("<workspace>");
  if (context.home && context.home.length > 1) out = out.split(context.home).join("~");
  return out;
}
