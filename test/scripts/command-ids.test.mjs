// Cross-feature command ids: every command a feature runs (or a menu, keybinding or link names) is one
// some feature contributes, and every contributed command is registered. Features are written in
// parallel and call each other by id; a guessed id fails silently at runtime ("command not found").
// The checks read whole files (a call may span lines) and follow `NAME = "opentide.…"` constants
// wherever they go, through helpers too; a self-test feeds them the cases they must catch.
import * as assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return sources(file);
    return /\.ts$/.test(entry.name) && !entry.name.endsWith(".generated.ts") ? [file] : [];
  });
}

const ID = String.raw`opentide\.[A-Za-z0-9_.]+`;
const CONST = "[A-Z][A-Z0-9_]*";

/** What the manifest contributes that a command id can name, and what else an `opentide.…` id may be. */
function contributions(contributes) {
  const commands = new Set((contributes.commands ?? []).map((c) => c.command));
  const views = new Set(Object.values(contributes.views ?? {}).flatMap((list) => list.map((v) => v.id)));
  const configuration = Array.isArray(contributes.configuration)
    ? contributes.configuration
    : [contributes.configuration ?? {}];
  const others = new Set([
    ...views,
    ...configuration.flatMap((section) => Object.keys(section.properties ?? {})),
    ...(contributes.terminal?.profiles ?? []).map((profile) => profile.id),
  ]);
  /** A contributed command, or VS Code's `<view>.focus`. */
  const isCommand = (id) => commands.has(id) || (id.endsWith(".focus") && views.has(id.slice(0, -6)));
  return { commands, others, isCommand };
}

/** `const NAME = "opentide.x.y"` in the sources: name -> id, and where. */
function constantsOf(files) {
  const constants = new Map();
  for (const { name, text } of files)
    for (const m of text.matchAll(new RegExp(String.raw`\b(${CONST})\s*=\s*"(${ID})"`, "g")))
      constants.set(m[1], { id: m[2], file: name });
  return constants;
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/** Command ids the sources run that nothing contributes, as `file:line id`. */
function unknownCommands(files, contributes) {
  const { isCommand, others } = contributions(contributes);
  const constants = constantsOf(files);
  const all = files.map((f) => f.text).join("\n");
  const unknown = [];
  const check = (name, text, index, id) => {
    if (id && !isCommand(id)) unknown.push(`${name}:${lineOf(text, index)} ${id}`);
  };
  for (const { name, text } of files) {
    // executeCommand("id" | NAME, …) and `command: "id" | NAME`, across line breaks.
    const literal = new RegExp(String.raw`(?:executeCommand(?:<[^>]*>)?\(|\bcommand:)\s*"(${ID})"`, "g");
    for (const m of text.matchAll(literal)) check(name, text, m.index, m[1]);
    const named = new RegExp(String.raw`(?:executeCommand(?:<[^>]*>)?\(|\bcommand:)\s*(${CONST})\b`, "g");
    for (const m of text.matchAll(named)) check(name, text, m.index, constants.get(m[1])?.id);
    // A `…COMMANDS` table of ids (`newRule: "opentide.newObject.ruleForObjective"`).
    const table = /\b[A-Z0-9_]*COMMANDS\b[^=;]*=\s*\{([^}]*)\}/g;
    for (const m of text.matchAll(table))
      for (const id of m[1].matchAll(new RegExp(`"(${ID})"`, "g"))) check(name, text, m.index, id[1]);
  }
  // Every other `opentide.…` constant is a command id, wherever it is handed (a helper's argument, a
  // field): unless the manifest says it is a view, a setting or a profile, or it is a stored state key.
  for (const [constant, { id, file }] of constants) {
    if (isCommand(id) || others.has(id)) continue;
    if (new RegExp(String.raw`\.update\(\s*${constant}\b`).test(all)) continue;
    const text = files.find((f) => f.name === file)?.text ?? "";
    check(file, text, text.indexOf(constant), id);
  }
  return [...new Set(unknown)];
}

/** Contributed commands no source registers (registerCommand, or a local `command(…)` helper). */
function unregisteredCommands(files, contributes) {
  const { commands } = contributions(contributes);
  const constants = constantsOf(files);
  const registered = new Set();
  const prefixes = [];
  const call = String.raw`(?:registerCommand|\bcommand)\(\s*`;
  for (const { text } of files) {
    for (const m of text.matchAll(new RegExp(`${call}"(${ID})"`, "g"))) registered.add(m[1]);
    for (const m of text.matchAll(new RegExp(`${call}(${CONST})\\b`, "g"))) {
      const id = constants.get(m[1])?.id;
      if (id) registered.add(id);
    }
    // Ids registered from a template: command(`opentide.newObject.${kind}`, …).
    for (const m of text.matchAll(new RegExp(`${call}\`(${ID})\\$\\{`, "g"))) prefixes.push(m[1]);
  }
  return [...commands].filter(
    (id) => !registered.has(id) && !prefixes.some((prefix) => id.startsWith(prefix)),
  );
}

const read = (dir) =>
  sources(join(ROOT, dir)).map((file) => ({
    name: relative(ROOT, file).replaceAll("\\", "/"),
    text: readFileSync(file, "utf8"),
  }));
const files = [...read("src"), ...read("webview")];
// The web entry registers every contributed command generically, to say it needs opentide.
const desktop = files.filter((f) => !f.name.startsWith("src/web/"));

describe("command ids across features", () => {
  it("every command the sources run, hand over or name in a constant is contributed", () => {
    assert.deepEqual(unknownCommands(files, manifest.contributes), []);
  });

  it("every command a menu, keybinding, walkthrough step or welcome link names is contributed", () => {
    const { contributes } = manifest;
    const { isCommand } = contributions(contributes);
    const refs = [];
    for (const [menu, items] of Object.entries(contributes.menus ?? {}))
      for (const item of items) if (item.command) refs.push([item.command, `menus.${menu}`]);
    for (const binding of contributes.keybindings ?? []) refs.push([binding.command, "keybindings"]);
    for (const m of JSON.stringify(contributes).matchAll(/command:([A-Za-z0-9_.]+)/g))
      refs.push([m[1], "link"]);
    for (const m of JSON.stringify(contributes).matchAll(/onCommand:([A-Za-z0-9_.]+)/g))
      refs.push([m[1], "walkthrough completion"]);
    const unknown = refs.filter(([id]) => !/^(workbench|vscode|editor|git)\./.test(id) && !isCommand(id));
    assert.deepEqual(unknown, []);
  });

  it("every contributed command is registered by the desktop extension", () => {
    assert.deepEqual(unregisteredCommands(desktop, manifest.contributes), []);
  });
});

describe("command ids: the guard itself", () => {
  const contributes = {
    commands: [{ command: "opentide.a.run" }, { command: "opentide.a.other" }, { command: "opentide.b.go" }],
    views: { opentide: [{ id: "opentide.view" }] },
    configuration: { properties: { "opentide.a.setting": {} } },
  };

  it("finds a guessed id in a call over several lines, through a constant and a helper, and in a table", () => {
    const text = [
      'const RUN = "opentide.a.run";',
      'const GUESSED = "opentide.a.guessed";',
      'const STATE_KEY = "opentide.a.state";',
      'const SETTING = "opentide.a.setting";',
      "void vscode.commands.executeCommand(",
      '  "opentide.a.typo",',
      ");",
      "handOver(ref, GUESSED);",
      "context.workspaceState.update(STATE_KEY, 1);",
      'const NODE_COMMANDS = { go: "opentide.b.go", gone: "opentide.b.gone" };',
      'executeCommand("opentide.view.focus"); executeCommand(RUN);',
    ].join("\n");
    assert.deepEqual(unknownCommands([{ name: "x.ts", text }], contributes).sort(), [
      "x.ts:10 opentide.b.gone",
      "x.ts:2 opentide.a.guessed",
      "x.ts:5 opentide.a.typo",
    ]);
  });

  it("finds a contributed command that is only run, never registered", () => {
    const text = [
      'const GO = "opentide.b.go";',
      "vscode.commands.registerCommand(",
      '  "opentide.a.run",',
      "  () => {},",
      ");",
      'void vscode.commands.executeCommand("opentide.a.other");',
      "command(GO, () => {});",
    ].join("\n");
    assert.deepEqual(unregisteredCommands([{ name: "x.ts", text }], contributes), ["opentide.a.other"]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text with a template, not a template
    const template = "command(`opentide.a.${kind}`, run);";
    assert.deepEqual(unregisteredCommands([{ name: "y.ts", text: template }], contributes), [
      "opentide.b.go",
    ]);
  });
});
