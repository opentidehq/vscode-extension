import * as assert from "node:assert/strict";
import {
  isOpentidePlugin,
  type PluginCandidate,
  pluginSuppliesSkills,
  skillsFromPlugin,
  skillsMode,
} from "../../../src/features/knowledge/plugin";

const plugin = (extra: Record<string, unknown> = {}): PluginCandidate => ({
  dir: "/home/me/.copilot/installed-plugins/_direct/opentide",
  manifest: { name: "opentide", repository: "https://github.com/opentidehq/skills", ...extra },
});

describe("agent knowledge: the Agent Plugin gate (#6)", () => {
  it("knows the opentidehq/skills plugin by name and repository, and no other", () => {
    assert.equal(isOpentidePlugin(plugin()), true);
    assert.equal(
      isOpentidePlugin(plugin({ repository: undefined, homepage: "https://github.com/OpenTideHQ/skills" })),
      true,
    );
    assert.equal(isOpentidePlugin(plugin({ name: "other" })), false);
    assert.equal(isOpentidePlugin(plugin({ repository: "https://github.com/someone/opentide" })), false);
    assert.equal(isOpentidePlugin({ dir: "/x" }), false);
  });

  it("leaves the skills to the plugin only when plugins are on and it is installed and not switched off", () => {
    const on = { pluginsEnabled: true, enabledPlugins: {}, candidates: [plugin()] };
    assert.equal(pluginSuppliesSkills(on).fromPlugin, true);
    assert.match(pluginSuppliesSkills(on).reason, /installed and on/);
    // Plugins off (VS Code's default): the plugin does not load, so the extension's skills are the ones.
    assert.deepEqual(pluginSuppliesSkills({ ...on, pluginsEnabled: false }), {
      fromPlugin: false,
      reason: "chat.plugins.enabled is off",
    });
    // An older VS Code has no such setting.
    assert.match(
      pluginSuppliesSkills({ ...on, pluginsEnabled: undefined }).reason,
      /no chat\.plugins\.enabled/,
    );
    // Not installed.
    assert.equal(pluginSuppliesSkills({ ...on, candidates: [] }).fromPlugin, false);
    assert.equal(pluginSuppliesSkills({ ...on, candidates: [plugin({ name: "x" })] }).fromPlugin, false);
    // Installed but switched off by id.
    for (const id of ["opentide@opentide", "opentide", "opentidehq/opentide"]) {
      const off = pluginSuppliesSkills({ ...on, enabledPlugins: { [id]: false } });
      assert.equal(off.fromPlugin, false, id);
      assert.match(off.reason, /switched off/);
    }
    // Another plugin switched off does not matter; an explicit true does not either.
    assert.equal(
      pluginSuppliesSkills({ ...on, enabledPlugins: { "other@market": false, "opentide@opentide": true } })
        .fromPlugin,
      true,
    );
  });

  it("lets the setting decide: always embeds, never leaves them out, auto follows the detection", () => {
    const detected = { fromPlugin: true, reason: "r" };
    const absent = { fromPlugin: false, reason: "r" };
    assert.equal(skillsFromPlugin("auto", detected).fromPlugin, true);
    assert.equal(skillsFromPlugin("auto", absent).fromPlugin, false);
    assert.equal(skillsFromPlugin("always", detected).fromPlugin, false);
    assert.equal(skillsFromPlugin("never", absent).fromPlugin, true);
    assert.match(skillsFromPlugin("always", detected).reason, /embeddedSkills is always/);
    assert.equal(skillsMode("always"), "always");
    assert.equal(skillsMode("never"), "never");
    assert.equal(skillsMode("anything else"), "auto");
    assert.equal(skillsMode(undefined), "auto");
  });
});
