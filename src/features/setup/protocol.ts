// The setup wizard's messages and the answers it gathers, shared by the host and webview/setup (no
// vscode, no DOM, no node).
import { is, type Protocol, type Validators } from "../../core/webview/protocol";

export type CiProvider = "github" | "gitlab" | "azure" | "none";
export const CI_PROVIDERS: readonly CiProvider[] = ["github", "gitlab", "azure", "none"];
export const MCP_HOSTS = ["vscode", "cursor", "claude-code", "generic"] as const;
export const SKILLS_HOSTS = ["claude-code", "cursor", "github-copilot", "generic"] as const;
export type McpHost = (typeof MCP_HOSTS)[number];
export type SkillsHost = (typeof SKILLS_HOSTS)[number];

export interface SetupAnswers {
  readonly name: string;
  readonly org: string;
  readonly description: string;
  readonly platforms: readonly string[];
  readonly ci: CiProvider;
  readonly staging: boolean;
  readonly inflight: boolean;
  readonly sharing: boolean;
  /** Undefined keeps the repository's setting. */
  readonly promotion?: boolean;
  readonly explorerPages: boolean;
  readonly pythonVersion: string;
  readonly defaultBranch: string;
  readonly mcp: readonly McpHost[];
  readonly skills: readonly SkillsHost[];
  readonly plugin: boolean;
  readonly hooks: boolean;
  readonly env: boolean;
}

/** `new`: scaffold a repository. `existing`: add to one (steps ②–⑤ only). */
export type SetupMode = "new" | "existing";

export interface PlatformChoice {
  readonly id: string;
  readonly label: string;
  readonly languages?: string;
  readonly canDeploy?: boolean;
  readonly canValidate?: boolean;
  readonly canQuery?: boolean;
  /** Already enabled in this repository. */
  readonly enabled: boolean;
}

export interface WizardInit {
  readonly mode: SetupMode;
  readonly folderName: string;
  readonly answers: SetupAnswers;
  readonly platforms: readonly PlatformChoice[];
  readonly ciProviders: readonly CiProvider[];
  readonly mcpHosts: readonly McpHost[];
  readonly skillsHosts: readonly SkillsHost[];
  readonly plugin: boolean;
  readonly hooks: boolean;
  readonly env: boolean;
  readonly explorerPages: boolean;
  /** Review can list files (`setup --plan`). */
  readonly plan: boolean;
  readonly gitRepository: boolean;
  /** The VS Code MCP provider serves opentide already (SPEC §12). */
  readonly mcpProvided: boolean;
  /** The step to open on (0-based: 3 is Agents), when a command asked for one. */
  readonly startStep?: number;
}

export interface ReviewFile {
  readonly path: string;
  readonly action: "create" | "merge" | "skip" | "delete";
}

export interface ReviewStep {
  /** `opentide setup …`, as Apply runs it. */
  readonly command: string;
  readonly summary: string;
  /** Undefined: this opentide cannot plan (no `--plan`); the summary describes it. */
  readonly files?: readonly { readonly step: string; readonly files: readonly ReviewFile[] }[];
  readonly warnings: readonly string[];
}

export interface Review {
  readonly problems: readonly { readonly step: number; readonly message: string }[];
  readonly steps: readonly ReviewStep[];
  /** Why there are no file lists, when there are none. */
  readonly note?: string;
  readonly error?: string;
  readonly totals?: {
    readonly create: number;
    readonly merge: number;
    readonly skip: number;
    readonly delete: number;
  };
}

/** "4 new files, 1 merged, 1 unchanged, 1 to remove. Nothing is written until you apply." */
export function reviewTotals(totals: NonNullable<Review["totals"]>): string {
  const removed = totals.delete > 0 ? `, ${totals.delete} to remove` : "";
  return `${totals.create} new file${totals.create === 1 ? "" : "s"}, ${totals.merge} merged, ${totals.skip} unchanged${removed}. Nothing is written until you apply.`;
}

export type CommandStatus = "pending" | "running" | "ok" | "failed" | "cancelled";

export interface ApplyProgress {
  readonly commands: readonly {
    readonly command: string;
    readonly status: CommandStatus;
    readonly steps: readonly {
      readonly step: string;
      readonly message: string;
      readonly files: readonly string[];
    }[];
    readonly failure?: { readonly message: string; readonly fix?: string };
  }[];
  readonly done: boolean;
  readonly ok: boolean;
}

export interface WizardProtocol extends Protocol {
  toWebview: { init: WizardInit; review: Review; reviewing: undefined; progress: ApplyProgress };
  toHost: {
    ready: undefined;
    review: SetupAnswers;
    apply: SetupAnswers;
    copyScript: SetupAnswers;
    cancel: undefined;
    gitInit: undefined;
    openFile: string;
    close: undefined;
  };
}

const oneOf =
  <T extends string>(values: readonly T[]) =>
  (value: unknown): value is T =>
    typeof value === "string" && (values as readonly string[]).includes(value);

const listOf =
  <T extends string>(values: readonly T[]) =>
  (value: unknown): value is T[] =>
    Array.isArray(value) && value.every(oneOf(values));

/** Strict: every key typed, nothing else needed. */
export function isAnswers(value: unknown): value is SetupAnswers {
  if (!is.object(value)) return false;
  const v = value;
  return (
    is.string(v.name) &&
    v.name.length < 200 &&
    is.string(v.org) &&
    v.org.length < 200 &&
    is.string(v.description) &&
    v.description.length < 500 &&
    is.stringArray(v.platforms) &&
    v.platforms.every((p) => /^[a-z][a-z0-9_]*$/.test(p)) &&
    oneOf(CI_PROVIDERS)(v.ci) &&
    is.boolean(v.staging) &&
    is.boolean(v.inflight) &&
    is.boolean(v.sharing) &&
    (v.promotion === undefined || is.boolean(v.promotion)) &&
    is.boolean(v.explorerPages) &&
    is.string(v.pythonVersion) &&
    v.pythonVersion.length < 20 &&
    is.string(v.defaultBranch) &&
    v.defaultBranch.length < 200 &&
    listOf(MCP_HOSTS)(v.mcp) &&
    listOf(SKILLS_HOSTS)(v.skills) &&
    is.boolean(v.plugin) &&
    is.boolean(v.hooks) &&
    is.boolean(v.env)
  );
}

export const hostValidators: Validators<WizardProtocol["toHost"]> = {
  ready: is.nothing,
  review: isAnswers,
  apply: isAnswers,
  copyScript: isAnswers,
  cancel: is.nothing,
  gitInit: is.nothing,
  openFile: (value): value is string =>
    is.string(value) &&
    value.length < 1000 &&
    !value.split(/[\\/]/).includes("..") &&
    !/^([a-z]:|[\\/])/i.test(value),
  close: is.nothing,
};

export const webviewValidators: Validators<WizardProtocol["toWebview"]> = {
  init: (value): value is WizardInit =>
    is.object(value) && isAnswers(value.answers) && Array.isArray(value.platforms),
  review: (value): value is Review =>
    is.object(value) && Array.isArray(value.steps) && Array.isArray(value.problems),
  reviewing: is.nothing,
  progress: (value): value is ApplyProgress => is.object(value) && Array.isArray(value.commands),
};
