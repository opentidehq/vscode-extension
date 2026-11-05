// Web mode: what the extension offers where no opentide can run (vscode.dev, github.dev, and desktop
// virtual workspaces): the engine (WASM)'s editor features, and an explanation for every command that
// needs opentide. vscode-free, and free of Node built-ins: the web bundle imports it.

/** Where the README explains what works in the browser. */
export const WEB_DOCS_URL = "https://github.com/opentidehq/vscode-extension#web-and-virtual-workspaces";

export const STATUS = {
  name: "opentide",
  detail: "Commands, validate, deploy and query need opentide in VS Code Desktop",
  tooltip:
    "The language server built for WebAssembly runs here: checks, hover, completion, the Catalogue, Relations and Find Detection. Commands, validate and lint, deploy, query and the panels need opentide in VS Code Desktop",
  learnMore: "Learn More",
  openInDesktop: "Open in VS Code Desktop",
} as const;

/** The commands web mode implements itself; every other contributed command explains why it cannot run. */
export const WEB_COMMANDS: ReadonlySet<string> = new Set([
  "opentide.search.open",
  "opentide.relations.show",
  "opentide.sidebar.refreshCatalogue",
  "opentide.restartServer",
  "opentide.showOutput",
  "opentide.showReferences",
  "opentide.installOpentide",
]);

/**
 * The commands that open the workspace in VS Code Desktop, as vscode.dev and github.dev name them: the
 * first one the window has is offered ("Continue Working On…", whose choices include VS Code Desktop).
 */
export const CONTINUE_ON_DESKTOP = ["workbench.editSessions.actions.continueEditSession"] as const;

interface Contributions {
  contributes?: {
    languages?: readonly { id?: unknown }[];
    commands?: readonly { command?: unknown; title?: unknown; category?: unknown }[];
  };
}

const asContributions = (packageJSON: unknown): Contributions =>
  typeof packageJSON === "object" && packageJSON !== null ? (packageJSON as Contributions) : {};

/** The language ids the manifest contributes. */
export function languageIds(packageJSON: unknown): string[] {
  return (asContributions(packageJSON).contributes?.languages ?? [])
    .map((language) => language.id)
    .filter((id): id is string => typeof id === "string");
}

export interface ContributedCommand {
  readonly command: string;
  readonly title: string;
}

/** Every command the manifest contributes, with its palette title (`opentide: Restart Server`). */
export function contributedCommands(packageJSON: unknown): ContributedCommand[] {
  const out: ContributedCommand[] = [];
  for (const entry of asContributions(packageJSON).contributes?.commands ?? []) {
    if (typeof entry.command !== "string") continue;
    const title = typeof entry.title === "string" ? entry.title : entry.command;
    out.push({
      command: entry.command,
      title: typeof entry.category === "string" ? `${entry.category}: ${title}` : title,
    });
  }
  return out;
}

/** What a command says when it runs where opentide cannot. */
export function unavailableMessage(title: string): string {
  return `${title} needs opentide, which runs in VS Code Desktop on a local folder. Here the opentide engine (WASM) gives the editor features only.`;
}

/**
 * True when the window has folders and none is on disk (`file:`): a desktop virtual workspace such as
 * Remote Repositories. The remote extension host sees its folders as `file:`, so SSH, WSL, Dev Containers
 * and Codespaces are not virtual.
 */
export function isVirtualOnly(schemes: readonly string[]): boolean {
  return schemes.length > 0 && !schemes.includes("file");
}

/**
 * The language status of web mode: the engine runs; or it does not (a trap ended its worker, or it did
 * not start), a warning with Restart. Before any opentide folder is found, nothing to warn about.
 */
export function engineStatus(
  running: boolean,
  hasWorkspace: boolean,
): { severity: "information" | "warning"; detail: string; restart: boolean } {
  if (running || !hasWorkspace) return { severity: "information", detail: STATUS.detail, restart: false };
  return {
    severity: "warning",
    detail: "The opentide engine is not running: Restart, or see the output",
    restart: true,
  };
}
