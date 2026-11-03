// The language server's workspace symbols of one folder: the catalogue's fallback when the runtime has no
// `info catalog`. vscode-free.
//
// The server writes symbol URIs with url::Url::from_file_path (`file:///C:/repo/x.yaml`, `(` and `@`
// left as they are), while VS Code's Uri.toString() percent-encodes them (`file:///c%3A/repo`, `%28`).
// So the folder test compares paths, never URI strings.
import * as path from "node:path";
import type { CatalogSymbol } from "./types";

export interface WorkspaceSymbol {
  readonly name: string;
  readonly containerName?: string;
  readonly location: {
    readonly uri: string;
    readonly range?: { readonly start: { line: number; character: number } };
  };
}

/** The file path a `file:` URI names, or undefined for another scheme. */
export function fileUriPath(uri: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const match = /^file:\/\/([^/]*)(\/.*)?$/i.exec(uri);
  if (!match) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[2] ?? "/");
  } catch {
    return undefined;
  }
  const host = match[1] ?? "";
  if (platform !== "win32") return host ? `//${host}${decoded}` : decoded;
  const local = /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
  const windows = local.replaceAll("/", "\\");
  return host ? `\\\\${host}${windows}` : windows;
}

/** Whether `file` is `folder` or inside it, case-insensitively where the filesystem usually is. */
export function pathInside(
  folder: string,
  file: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const lib = platform === "win32" ? path.win32 : path.posix;
  const fold = (value: string) =>
    platform === "win32" || platform === "darwin" ? lib.resolve(value).toLowerCase() : lib.resolve(value);
  const relative = lib.relative(fold(folder), fold(file));
  return relative !== "" && !relative.startsWith("..") && !lib.isAbsolute(relative);
}

/**
 * The symbols in `folder`, as catalogue symbols. `toUri` gives the URI to keep (VS Code's own form of the
 * path, so later lookups by Uri.toString() match); by default the server's.
 */
export function folderSymbols(
  symbols: readonly WorkspaceSymbol[] | null | undefined,
  folder: string,
  platform: NodeJS.Platform = process.platform,
  toUri: (file: string, uri: string) => string = (_file, uri) => uri,
): CatalogSymbol[] {
  const result: CatalogSymbol[] = [];
  for (const symbol of symbols ?? []) {
    const file = fileUriPath(symbol.location.uri, platform);
    if (!file || !pathInside(folder, file, platform)) continue;
    result.push({
      name: symbol.name,
      family: symbol.containerName ?? "",
      uri: toUri(file, symbol.location.uri),
      line: symbol.location.range?.start.line ?? 0,
      character: symbol.location.range?.start.character ?? 0,
    });
  }
  return result;
}
