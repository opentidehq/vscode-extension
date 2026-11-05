// The engine's workspace, read through VS Code (`findFiles`, `workspace.fs`), so the same code feeds the
// desktop worker and, on vscode.dev and github.dev, the Web Worker: the object files of each folder
// (`objects/` and the paths.toml object folders) and the primary folder's `visibility.toml`, kept as a
// mirror so file changes become a delta. No Node built-ins.
import * as vscode from "vscode";
import {
  type Collected,
  collectDocuments,
  isSuppliedPath,
  objectGlob,
  type SuppliedWorkspace,
  VISIBILITY,
  type WorkspaceDelta,
  WorkspaceMirror,
} from "./workspace";

/** A workspace folder the engine indexes. */
export interface FeedFolder {
  readonly uri: vscode.Uri;
  /** paths.toml object folders, workspace-relative with a trailing slash. */
  readonly objectFolders: Readonly<Record<string, string>>;
}

export interface FeedReport {
  readonly files: number;
  readonly bytes: number;
  readonly ms: number;
  readonly skipped: Collected["skipped"];
}

/** Files read at once, and the most a window feeds the engine. */
const CONCURRENCY = 32;
const MAX_FILES = 20_000;

/**
 * A URI's path with a Windows drive letter in lower case: `Uri.path` keeps the case it was made with
 * (`/D:/a` from a file watcher, `/d:/a` from the workspace folder), while `toString()` lowers it.
 */
export function comparablePath(path: string): string {
  return /^\/[A-Za-z]:/.test(path) ? `/${path.charAt(1).toLowerCase()}${path.slice(2)}` : path;
}

/** `relative` under `base`, with forward slashes, or undefined when it is not inside. */
export function relativeTo(
  base: { scheme: string; authority: string; path: string },
  uri: { scheme: string; authority: string; path: string },
): string | undefined {
  if (base.scheme !== uri.scheme || base.authority !== uri.authority) return undefined;
  const folder = comparablePath(base.path);
  const root = folder.endsWith("/") ? folder : `${folder}/`;
  const path = comparablePath(uri.path);
  return path.startsWith(root) ? path.slice(root.length) : undefined;
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

export class WorkspaceFeed {
  private mirror: WorkspaceMirror | undefined;

  constructor(
    private readonly folders: () => readonly FeedFolder[],
    private readonly log: (message: string) => void,
  ) {}

  /** The folder that holds `uri`, with its relative path. */
  private locate(uri: vscode.Uri): { folder: FeedFolder; relative: string } | undefined {
    let best: { folder: FeedFolder; relative: string } | undefined;
    for (const folder of this.folders()) {
      const relative = relativeTo(folder.uri, uri);
      if (relative !== undefined && (!best || relative.length < best.relative.length))
        best = { folder, relative };
    }
    return best;
  }

  /** Every object file and `visibility.toml`, read now: what a new server is given on `initialize`. */
  async collect(): Promise<{ workspace: SuppliedWorkspace; report: FeedReport }> {
    const started = Date.now();
    const folders = this.folders();
    const uris: vscode.Uri[] = [];
    for (const folder of folders) {
      const found = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder.uri, objectGlob(folder.objectFolders)),
        undefined,
        MAX_FILES + 1,
      );
      uris.push(...found);
    }
    const byString = new Map(uris.map((uri) => [uri.toString(), uri]));
    const collected = await collectDocuments(
      [...byString.keys()],
      async (key) => vscode.workspace.fs.readFile(byString.get(key) ?? vscode.Uri.parse(key)),
      { concurrency: CONCURRENCY, maxFiles: MAX_FILES },
    );
    const primary = folders[0];
    const visibility = primary ? await readText(vscode.Uri.joinPath(primary.uri, VISIBILITY)) : undefined;
    const workspace: SuppliedWorkspace = {
      documents: collected.documents,
      ...(visibility !== undefined ? { visibility } : {}),
    };
    this.mirror = new WorkspaceMirror(workspace);
    for (const { uri, reason } of collected.skipped.slice(0, 20))
      this.log(`engine: left out ${uri}: ${reason}`);
    if (collected.skipped.length > 20)
      this.log(`engine: left out ${collected.skipped.length - 20} more files`);
    const bytes = collected.documents.reduce((sum, document) => sum + document.text.length, 0);
    return {
      workspace,
      report: {
        files: collected.documents.length,
        bytes,
        ms: Date.now() - started,
        skipped: collected.skipped,
      },
    };
  }

  /** What the server was last given (the mirror), for a restart that need not read the files again. */
  snapshot(): SuppliedWorkspace | undefined {
    return this.mirror?.snapshot();
  }

  /**
   * Files under the folders changed (created, changed or deleted, or a folder of them): read them again
   * and return what differs from what the server has. A folder event re-reads every file, since VS Code
   * reports a deleted or moved folder as one event.
   */
  async changed(uris: readonly vscode.Uri[]): Promise<WorkspaceDelta | undefined> {
    const mirror = this.mirror;
    if (!mirror) return undefined;
    const primary = this.folders()[0];
    const files: { uri: string; text: string | undefined }[] = [];
    let visibility: { text: string | undefined } | undefined;
    let rescan = false;
    for (const uri of uris) {
      const where = this.locate(uri);
      if (!where) continue;
      if (where.relative === VISIBILITY && where.folder === primary) {
        visibility = { text: await readText(uri) };
      } else if (isSuppliedPath(where.relative, where.folder.objectFolders)) {
        files.push({ uri: uri.toString(), text: await readText(uri) });
      } else if (!/\.[A-Za-z0-9]+$/.test(where.relative)) {
        rescan = true;
      }
    }
    if (rescan) {
      const before = mirror.snapshot();
      const { workspace } = await this.collect();
      const now = new Set(workspace.documents.map((document) => document.uri));
      const fresh = new WorkspaceMirror(before);
      const delta = fresh.apply(
        [
          ...workspace.documents,
          ...before.documents.filter((d) => !now.has(d.uri)).map((d) => ({ uri: d.uri, text: undefined })),
        ],
        visibility ?? { text: workspace.visibility },
      );
      return delta;
    }
    return mirror.apply(files, visibility);
  }
}
