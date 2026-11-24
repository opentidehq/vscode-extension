// Agent knowledge (SPEC §12, #6): the opentide skills (`contributes.chatSkills`, generated from opentidehq/skills by
// scripts/skills.mjs) and the always-on instructions (`contributes.chatInstructions`) VS Code's agents read. The
// contributions are static; this feature only decides whether the skills are left to the opentidehq/skills Agent
// Plugin, which would load them as well: it sets the context key `opentide.skillsFromPlugin` that their `when`
// clause reads, and logs why. VS Code and forks that do not know these contribution points ignore them.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { defineFeature } from "../../core/feature";
import { type PluginCandidate, pluginSuppliesSkills, skillsFromPlugin, skillsMode } from "./plugin";

export default defineFeature({
  id: "knowledge",
  activate(ctx) {
    let last: string | undefined;
    const apply = () => {
      const mode = skillsMode(vscode.workspace.getConfiguration("opentide.agents").get("embeddedSkills"));
      const detection = skillsFromPlugin(
        mode,
        pluginSuppliesSkills({
          pluginsEnabled: userSetting<boolean>("chat.plugins", "enabled"),
          enabledPlugins: userSetting<Record<string, unknown>>("chat.plugins", "enabledPlugins"),
          candidates: pluginCandidates(userSetting<Record<string, unknown>>("chat", "pluginLocations")),
        }),
      );
      void vscode.commands.executeCommand("setContext", "opentide.skillsFromPlugin", detection.fromPlugin);
      const line = `agents: the opentide skills are ${detection.fromPlugin ? "left to the opentidehq/skills plugin" : "contributed by the extension"}: ${detection.reason}`;
      if (line !== last) ctx.log.info(line);
      last = line;
    };
    apply();
    ctx.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("opentide.agents.embeddedSkills") ||
          event.affectsConfiguration("chat.plugins") ||
          event.affectsConfiguration("chat.pluginLocations")
        )
          apply();
      }),
      // A plugin installed from a terminal or by the CLI changes no setting: look again when the window is back.
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) apply();
      }),
    );
  },
});

/**
 * A VS Code setting at the user level, plus the workspace's only when the folder is trusted: an untrusted workspace
 * does not decide how agents are set up. `undefined` where the setting does not exist.
 */
function userSetting<T>(section: string, key: string): T | undefined {
  const inspected = vscode.workspace.getConfiguration(section).inspect<T>(key);
  if (!inspected) return undefined;
  return (
    (vscode.workspace.isTrusted ? (inspected.workspaceFolderValue ?? inspected.workspaceValue) : undefined) ??
    inspected.globalValue ??
    inspected.defaultValue
  );
}

/** The folders that may be agent plugins: the installed ones (`~/.copilot/installed-plugins`) and `chat.pluginLocations`. */
function pluginCandidates(locations: Record<string, unknown> | undefined): PluginCandidate[] {
  const folders: string[] = [];
  const installed = path.join(os.homedir(), ".copilot", "installed-plugins");
  for (const marketplace of listDirectories(installed)) {
    for (const plugin of listDirectories(path.join(installed, marketplace)))
      folders.push(path.join(installed, marketplace, plugin));
  }
  for (const [location, value] of Object.entries(locations ?? {})) {
    if (value === false) continue;
    folders.push(location.replace(/^~(?=$|[\\/])/, os.homedir()));
  }
  return folders.map((dir) => ({ dir, manifest: readManifest(dir) }));
}

function listDirectories(folder: string): string[] {
  try {
    return fs
      .readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function readManifest(dir: string): PluginCandidate["manifest"] {
  for (const file of [
    "plugin.json",
    path.join(".claude-plugin", "plugin.json"),
    path.join(".github", "plugin", "plugin.json"),
  ]) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if (typeof parsed === "object" && parsed !== null) return parsed as PluginCandidate["manifest"];
    } catch {
      // No such file, or not JSON: the next one.
    }
  }
  return undefined;
}
