// The workspace the engine (WASM) indexes. It has no filesystem, so the client supplies the object files
// and `visibility.toml` on `initialize` (`initializationOptions.workspace`, language-server docs/EDITORS.md)
// and keeps them current. vscode-free and free of Node built-ins: the desktop and the web extension share
// it.

/** An object file as the server indexes it. */
export interface SuppliedDocument {
  readonly uri: string;
  readonly text: string;
}

/** `initializationOptions.workspace`. */
export interface SuppliedWorkspace {
  readonly documents: readonly SuppliedDocument[];
  /** The text of the primary folder's `.opentide/configurations/visibility.toml`. */
  readonly visibility?: string;
}

/** What changed since the server was given the workspace (`opentide/didChangeWorkspace`). */
export interface WorkspaceDelta {
  readonly documents: readonly SuppliedDocument[];
  readonly removed: readonly string[];
  /** Present when it changed: the new text, or null when the file is gone. */
  readonly visibility?: string | null;
}

export const VISIBILITY = ".opentide/configurations/visibility.toml";

/** The folders a workspace folder's object files live in: `objects/` and each paths.toml object folder. */
export function objectRoots(objectFolders: Readonly<Record<string, string>>): string[] {
  const roots = new Set<string>(["objects/"]);
  for (const value of Object.values(objectFolders)) {
    const folder = value.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!folder || folder.startsWith("/") || folder.split("/").includes("..")) continue;
    roots.add(folder.endsWith("/") ? folder : `${folder}/`);
  }
  // A folder inside another is covered by it.
  const sorted = [...roots].sort();
  return sorted.filter((root) => !sorted.some((other) => other !== root && root.startsWith(other)));
}

/** One glob for a folder's object files, relative to the folder: `{objects/,detections/rules/}**` YAML. */
export function objectGlob(objectFolders: Readonly<Record<string, string>>): string {
  const roots = objectRoots(objectFolders).map((root) => root.replace(/\/$/, ""));
  const base = roots.length === 1 ? roots[0] : `{${roots.join(",")}}`;
  return `${base}/**/*.{yaml,yml}`;
}

/** Whether a folder-relative path (forward slashes) is an object file the engine is given. */
export function isSuppliedPath(relative: string, objectFolders: Readonly<Record<string, string>>): boolean {
  if (!/\.ya?ml$/i.test(relative)) return false;
  return objectRoots(objectFolders).some((root) => relative.startsWith(root));
}

export interface CollectOptions {
  /** Files read at once. */
  readonly concurrency?: number;
  /** A larger file is left out (logged). */
  readonly maxFileBytes?: number;
  /** Stop once this many files are read (logged). */
  readonly maxFiles?: number;
  /** After each batch: how many are read, of how many. */
  readonly onProgress?: (done: number, total: number) => void;
}

export interface Collected {
  readonly documents: SuppliedDocument[];
  /** Files left out, with why. */
  readonly skipped: { readonly uri: string; readonly reason: string }[];
}

/**
 * Read `uris` in batches of `concurrency`, yielding between batches, so a few thousand files never block
 * the extension host. A file that cannot be read, or is too large, is left out and reported.
 */
export async function collectDocuments(
  uris: readonly string[],
  read: (uri: string) => Promise<Uint8Array>,
  options: CollectOptions = {},
): Promise<Collected> {
  const concurrency = Math.max(1, options.concurrency ?? 32);
  const maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
  const limit = options.maxFiles ?? 20_000;
  const decoder = new TextDecoder("utf-8");
  const documents: SuppliedDocument[] = [];
  const skipped: { uri: string; reason: string }[] = [];
  const wanted = uris.slice(0, limit);
  for (const uri of uris.slice(limit)) skipped.push({ uri, reason: `more than ${limit} object files` });
  for (let start = 0; start < wanted.length; start += concurrency) {
    const batch = wanted.slice(start, start + concurrency);
    const read_ = await Promise.all(
      batch.map(async (uri) => {
        try {
          return { uri, bytes: await read(uri) };
        } catch (error) {
          return { uri, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    for (const entry of read_) {
      if ("error" in entry) skipped.push({ uri: entry.uri, reason: entry.error ?? "unreadable" });
      else if (entry.bytes.byteLength > maxFileBytes)
        skipped.push({ uri: entry.uri, reason: `larger than ${maxFileBytes} bytes` });
      else documents.push({ uri: entry.uri, text: decoder.decode(entry.bytes) });
    }
    options.onProgress?.(Math.min(start + batch.length, wanted.length), wanted.length);
    // Let the host run between batches.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  documents.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
  return { documents, skipped };
}

/**
 * What the server was given, kept so a change can be told as a delta, or found to change nothing (a
 * save of a file whose text the server already has).
 */
export class WorkspaceMirror {
  private readonly texts = new Map<string, string>();
  private visibilityText: string | undefined;

  constructor(initial: SuppliedWorkspace) {
    for (const document of initial.documents) this.texts.set(document.uri, document.text);
    this.visibilityText = initial.visibility;
  }

  get size(): number {
    return this.texts.size;
  }

  has(uri: string): boolean {
    return this.texts.has(uri);
  }

  /** The workspace as it stands, for a new server. */
  snapshot(): SuppliedWorkspace {
    return {
      documents: [...this.texts].map(([uri, text]) => ({ uri, text })),
      ...(this.visibilityText !== undefined ? { visibility: this.visibilityText } : {}),
    };
  }

  /**
   * Apply what the files hold now (`undefined`: the file is gone) and return what differs from what the
   * server has, or undefined when nothing does.
   */
  apply(
    files: readonly { readonly uri: string; readonly text: string | undefined }[],
    visibility?: { readonly text: string | undefined },
  ): WorkspaceDelta | undefined {
    const documents: SuppliedDocument[] = [];
    const removed: string[] = [];
    for (const { uri, text } of files) {
      const known = this.texts.get(uri);
      if (text === undefined) {
        if (known !== undefined) {
          this.texts.delete(uri);
          removed.push(uri);
        }
      } else if (text !== known) {
        this.texts.set(uri, text);
        documents.push({ uri, text });
      }
    }
    let changedVisibility: { visibility: string | null } | undefined;
    if (visibility && visibility.text !== this.visibilityText) {
      this.visibilityText = visibility.text;
      changedVisibility = { visibility: visibility.text ?? null };
    }
    if (documents.length === 0 && removed.length === 0 && !changedVisibility) return undefined;
    return { documents, removed, ...(changedVisibility ?? {}) };
  }
}
