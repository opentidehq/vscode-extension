// Grammar-only mode: what the extension offers where no opentide can run (vscode.dev, github.dev, and
// desktop virtual workspaces). vscode-free, and free of Node built-ins: the web bundle imports it.

/** Where the README explains what works in the browser. */
export const WEB_DOCS_URL = "https://github.com/opentidehq/vscode-extension#web-and-virtual-workspaces";

export const STATUS = {
  name: "opentide",
  text: "Highlighting only",
  detail: "No opentide runtime here: checks, commands and panels need a local folder in VS Code Desktop",
  learnMore: "Learn More",
} as const;

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
  return `${title} needs opentide, which cannot run in the browser or a virtual workspace. Open a local folder in VS Code Desktop to use it.`;
}

/**
 * True when the window has folders and none is on disk (`file:`): a desktop virtual workspace such as
 * Remote Repositories. The remote extension host sees its folders as `file:`, so SSH, WSL, Dev Containers
 * and Codespaces are not virtual.
 */
export function isVirtualOnly(schemes: readonly string[]): boolean {
  return schemes.length > 0 && !schemes.includes("file");
}
