// Whether the opentidehq/skills Agent Plugin supplies the skills the extension would also contribute through
// `contributes.chatSkills`: an embedded skill and the plugin's would both load (#6). vscode-free.
//
// VS Code documents no API or context key to ask whether a plugin is installed, so this reads what it does
// document: the `chat.plugins.*` settings, the folders agent plugins are installed in (`~/.copilot/installed-plugins/
// <marketplace>/<plugin>/`, direct installs under `_direct`) and the paths of `chat.pluginLocations`. A plugin
// counts only when plugins are on (`chat.plugins.enabled`, off by default) and it is not switched off in
// `chat.plugins.enabledPlugins`. When detection cannot tell, the skills are embedded: a duplicate is better than none.

/** `opentide.agents.embeddedSkills`. */
export type SkillsMode = "auto" | "always" | "never";

export function skillsMode(value: unknown): SkillsMode {
  return value === "always" || value === "never" ? value : "auto";
}

/** A folder that may be an agent plugin, with its manifest (`plugin.json`) when it has one that parsed. */
export interface PluginCandidate {
  readonly dir: string;
  readonly manifest?: { readonly name?: unknown; readonly repository?: unknown; readonly homepage?: unknown };
}

/** The opentidehq/skills plugin: named `opentide`, from the `opentidehq/skills` repository. */
export function isOpentidePlugin(candidate: PluginCandidate): boolean {
  const manifest = candidate.manifest;
  if (manifest?.name !== "opentide") return false;
  const source = [manifest.repository, manifest.homepage]
    .filter((value) => typeof value === "string")
    .join(" ");
  return /opentidehq\/skills/i.test(source);
}

export interface PluginInputs {
  /** `chat.plugins.enabled`, undefined where the setting does not exist (an older VS Code). */
  readonly pluginsEnabled: boolean | undefined;
  /** `chat.plugins.enabledPlugins`: plugin ids to true or false. */
  readonly enabledPlugins: Readonly<Record<string, unknown>> | undefined;
  readonly candidates: readonly PluginCandidate[];
}

export interface Detection {
  readonly fromPlugin: boolean;
  /** Why, for the log. */
  readonly reason: string;
}

/** Whether the plugin is installed and on. */
export function pluginSuppliesSkills(inputs: PluginInputs): Detection {
  if (inputs.pluginsEnabled !== true)
    return {
      fromPlugin: false,
      reason:
        inputs.pluginsEnabled === undefined
          ? "this VS Code has no chat.plugins.enabled"
          : "chat.plugins.enabled is off",
    };
  const found = inputs.candidates.find(isOpentidePlugin);
  if (!found) return { fromPlugin: false, reason: "no opentidehq/skills plugin is installed" };
  // A plugin switched off by id: `opentide@opentide`, `opentide`, … set to false.
  const off = Object.entries(inputs.enabledPlugins ?? {}).find(
    ([id, value]) =>
      value === false && (id === "opentide" || id.startsWith("opentide@") || id.endsWith("/opentide")),
  );
  if (off) return { fromPlugin: false, reason: `the opentidehq/skills plugin is switched off (${off[0]})` };
  return { fromPlugin: true, reason: `the opentidehq/skills plugin is installed and on (${found.dir})` };
}

/** What `opentide.skillsFromPlugin` becomes: `always` embeds, `never` leaves the skills to the plugin or to none. */
export function skillsFromPlugin(mode: SkillsMode, detection: Detection): Detection {
  if (mode === "always") return { fromPlugin: false, reason: "opentide.agents.embeddedSkills is always" };
  if (mode === "never") return { fromPlugin: true, reason: "opentide.agents.embeddedSkills is never" };
  return detection;
}
