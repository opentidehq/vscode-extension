// Cross-feature command ids: every command a feature runs (or a menu, keybinding or link names) is one
// some feature contributes, and every contributed command is registered. Features are written in
// parallel and call each other by id; a guessed id fails silently at runtime ("command not found").
import * as assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const contributes = manifest.contributes;
const contributed = new Set(contributes.commands.map((c) => c.command));
const views = new Set(Object.values(contributes.views ?? {}).flatMap((list) => list.map((v) => v.id)));

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return sources(file);
    return /\.ts$/.test(entry.name) && !entry.name.endsWith(".generated.ts") ? [file] : [];
  });
}

const files = [...sources(join(ROOT, "src")), ...sources(join(ROOT, "webview"))].map((file) => ({
  name: relative(ROOT, file),
  text: readFileSync(file, "utf8"),
}));

/** `const NAME = "opentide.x.y"` anywhere in the sources. */
const constants = new Map();
for (const { text } of files)
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]*)\s*=\s*"(opentide\.[A-Za-z0-9_.]+)"/g))
    constants.set(m[1], m[2]);

/** Is `id` something a command can be: a contributed command, or VS Code's `<view>.focus`. */
const known = (id) => contributed.has(id) || (id.endsWith(".focus") && views.has(id.slice(0, -6)));

describe("command ids across features", () => {
  it("every executeCommand / command: target in src is contributed", () => {
    const unknown = [];
    for (const { name, text } of files) {
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        const ids = [
          ...[...line.matchAll(/executeCommand\(\s*"(opentide\.[A-Za-z0-9_.]+)"/g)].map((m) => m[1]),
          ...[...line.matchAll(/\bcommand:\s*"(opentide\.[A-Za-z0-9_.]+)"/g)].map((m) => m[1]),
          ...[...line.matchAll(/executeCommand(?:<[^>]*>)?\(\s*([A-Z][A-Z0-9_]*)\b/g)]
            .map((m) => constants.get(m[1]))
            .filter(Boolean),
        ];
        for (const id of ids) if (!known(id)) unknown.push(`${name}:${index + 1} ${id}`);
      });
    }
    assert.deepEqual(unknown, []);
  });

  it("every command a menu, keybinding, walkthrough or welcome link names is contributed", () => {
    const refs = [];
    for (const [menu, items] of Object.entries(contributes.menus ?? {}))
      for (const item of items) if (item.command) refs.push([item.command, `menus.${menu}`]);
    for (const binding of contributes.keybindings ?? []) refs.push([binding.command, "keybindings"]);
    for (const m of JSON.stringify(contributes).matchAll(/command:([A-Za-z0-9_.]+)/g))
      refs.push([m[1], "link"]);
    const unknown = refs.filter(([id]) => !/^(workbench|vscode|editor|git)\./.test(id) && !known(id));
    assert.deepEqual(unknown, []);
  });

  it("every contributed command is registered", () => {
    const all = files.map((f) => f.text).join("\n");
    // Ids registered from a template: registerCommand(`opentide.newObject.${kind}`) and the like.
    const prefixes = [...all.matchAll(/`(opentide\.[A-Za-z0-9_.]+)\$\{/g)].map((m) => m[1]);
    const missing = [...contributed].filter(
      (id) => !all.includes(`"${id}"`) && !prefixes.some((prefix) => id.startsWith(prefix)),
    );
    assert.deepEqual(missing, []);
  });
});
