// Contributed keybindings: none shadows a well-known VS Code or OS default, and each is scoped to an
// opentide context so it does nothing outside opentide files and workspaces.
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const bindings = manifest.contributes.keybindings ?? [];

/** Defaults (VS Code on Windows/Linux and macOS, and the desktops) a binding must not take. */
const TAKEN = {
  key: [
    "ctrl+alt+d", // Xfce, GNOME Flashback: show desktop
    "ctrl+alt+t", // Ubuntu: terminal
    "ctrl+alt+l", // GNOME, Xfce: lock screen
    "ctrl+alt+delete",
    "ctrl+alt+i", // VS Code: Chat
    "ctrl+alt+-", // VS Code (Linux): Go Back
    "shift+alt+.", // VS Code: Auto Fix
    "shift+alt+f", // VS Code: Format Document
    "ctrl+shift+f", // VS Code: Search
    "ctrl+t", // VS Code: Go to Symbol in Workspace
    "ctrl+p",
    "ctrl+shift+p",
  ],
  mac: [
    "cmd+alt+d", // macOS: show or hide the Dock
    "cmd+alt+h", // macOS: hide others
    "cmd+alt+m", // macOS: minimise all
    "cmd+alt+escape", // macOS: Force Quit
    "cmd+alt+.", // VS Code: Auto Fix
    "cmd+alt+f", // VS Code: Replace
    "cmd+alt+i", // VS Code: Chat
    "cmd+alt+s", // VS Code: Save All
    "cmd+alt+b",
    "cmd+shift+f",
    "cmd+t",
    "cmd+p",
    "cmd+shift+p",
  ],
};

describe("keybindings", () => {
  it("takes no well-known default", () => {
    for (const binding of bindings) {
      assert.ok(!TAKEN.key.includes(binding.key), `${binding.command}: ${binding.key}`);
      assert.ok(!TAKEN.mac.includes(binding.mac ?? binding.key), `${binding.command}: ${binding.mac}`);
    }
  });

  it("is scoped to an opentide file or workspace", () => {
    for (const binding of bindings)
      assert.match(binding.when ?? "", /\bopentide\.\w+|editorLangId == opentide-/, binding.command);
  });

  it("moves between placeholders only in Tide YAML", () => {
    for (const binding of bindings.filter((b) => b.command.startsWith("opentide.placeholder.")))
      assert.match(binding.when, /editorLangId == opentide-yaml/);
  });
});
