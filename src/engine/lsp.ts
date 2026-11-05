// What both hosts read from the server: `capabilities.experimental.opentide`, and the arguments of its
// `opentide.showReferences` lens. vscode-free (types only), no Node built-ins.
import type * as vscode from "vscode";
import type { Location as LspLocation, Position as LspPosition } from "vscode-languageclient";
import type { OpentideServerInfo } from "../core/context";

/** `capabilities.experimental.opentide`, when the server sent one that looks right. */
export function readServerInfo(experimental: unknown): OpentideServerInfo | undefined {
  const value = (experimental as { opentide?: unknown } | undefined)?.opentide;
  if (!value || typeof value !== "object") return undefined;
  const info = value as Partial<OpentideServerInfo>;
  return typeof info.engine === "string" ? (value as OpentideServerInfo) : undefined;
}

/** The arguments of the server's `opentide.showReferences` lens, converted for `editor.action.showReferences`. */
export function convertShowReferencesArgs(
  args: readonly unknown[],
  convert: {
    asUri(value: string): vscode.Uri;
    asPosition(value: LspPosition): vscode.Position;
    asLocation(value: LspLocation): vscode.Location;
  },
): [vscode.Uri, vscode.Position, vscode.Location[]] | undefined {
  const [uri, position, locations] = args;
  if (typeof uri !== "string" || !position || typeof position !== "object" || !Array.isArray(locations))
    return undefined;
  return [
    convert.asUri(uri),
    convert.asPosition(position as LspPosition),
    locations.map((location) => convert.asLocation(location as LspLocation)),
  ];
}
