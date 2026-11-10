// Settings, read with trust in mind: in Restricted Mode no setting of the restricted list is read at all
// (#8 done-when), so a workspace cannot point the extension at its own executables.
import * as vscode from "vscode";
import type { RuntimeSettings } from "../runtime/resolve";

/** `capabilities.untrustedWorkspaces.restrictedConfigurations` in package.json. */
export const RESTRICTED_SETTINGS = [
  "opentide.path",
  "opentide.interpreter",
  "opentide.uv.usePin",
  "opentide.uv.path",
  "opentide.mcp.provide",
  "opentide.envFile",
  "opentide.terminal.addToPath",
] as const;

export type RestrictedSetting = (typeof RESTRICTED_SETTINGS)[number];

/** Read a restricted setting, or undefined in Restricted Mode (without touching the configuration). */
export function readRestricted<T>(key: RestrictedSetting, scope?: vscode.Uri): T | undefined {
  if (!vscode.workspace.isTrusted) return undefined;
  const dot = key.indexOf(".");
  return vscode.workspace.getConfiguration(key.slice(0, dot), scope).get<T>(key.slice(dot + 1));
}

export function readSetting<T>(key: string, scope?: vscode.Uri): T | undefined {
  if ((RESTRICTED_SETTINGS as readonly string[]).includes(key))
    return readRestricted<T>(key as RestrictedSetting, scope);
  const dot = key.indexOf(".");
  return vscode.workspace.getConfiguration(key.slice(0, dot), scope).get<T>(key.slice(dot + 1));
}

export function runtimeSettings(scope: vscode.Uri | undefined): RuntimeSettings {
  return {
    path: () => readRestricted<string>("opentide.path", scope),
    interpreter: () => readRestricted<string>("opentide.interpreter", scope),
    uvUsePin: () => readRestricted<boolean>("opentide.uv.usePin", scope),
    uvPath: () => readRestricted<string>("opentide.uv.path", scope),
  };
}

/** Settings whose change re-resolves the runtime and restarts the processes. */
export const RESTART_SETTINGS = [
  "opentide.path",
  "opentide.interpreter",
  "opentide.uv.usePin",
  "opentide.uv.path",
  "opentide.backend.serve",
];

/** VS Code's `http.proxy`, if set. */
export function httpProxy(): string | undefined {
  const value = vscode.workspace.getConfiguration("http").get<string>("proxy");
  return value?.trim() ? value.trim() : undefined;
}
