import * as assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyToPackage, ManifestError, mergeFragments } from "../../scripts/manifest-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

describe("manifest fragments", () => {
  it("merges core first, then the rest by name, concatenating arrays and merging objects", () => {
    const merged = mergeFragments([
      {
        name: "zeta.json",
        fragment: {
          activationEvents: ["onView:z"],
          contributes: { commands: [{ command: "z.run", title: "Z" }] },
        },
      },
      {
        name: "core.json",
        fragment: {
          activationEvents: ["onLanguage:kql", "onView:z"],
          contributes: {
            commands: [{ command: "core.run", title: "C" }],
            configurationDefaults: { "[kql]": { a: 1 } },
          },
        },
      },
      {
        name: "alpha.json",
        fragment: {
          contributes: {
            configurationDefaults: { "[kql]": { b: 2 } },
            configuration: { title: "A", properties: { "opentide.a": {} } },
          },
        },
      },
    ]);
    assert.deepEqual(
      merged.contributes.commands.map((c) => c.command),
      ["core.run", "z.run"],
    );
    assert.deepEqual(merged.contributes.configurationDefaults, { "[kql]": { a: 1, b: 2 } });
    assert.deepEqual(merged.activationEvents, ["onLanguage:kql", "onView:z"]);
    assert.ok(Array.isArray(merged.contributes.configuration));
  });

  for (const [kind, a, b] of [
    ["command", { commands: [{ command: "x" }] }, { commands: [{ command: "x" }] }],
    [
      "setting",
      { configuration: { properties: { "opentide.x": {} } } },
      { configuration: [{ properties: { "opentide.x": {} } }] },
    ],
    ["view", { views: { explorer: [{ id: "v" }] } }, { views: { opentide: [{ id: "v" }] } }],
    [
      "view container",
      { viewsContainers: { activitybar: [{ id: "c" }] } },
      { viewsContainers: { activitybar: [{ id: "c" }] } },
    ],
  ]) {
    it(`fails on a duplicate ${kind}`, () => {
      assert.throws(
        () =>
          mergeFragments([
            { name: "a.json", fragment: { contributes: a } },
            { name: "b.json", fragment: { contributes: b } },
          ]),
        (error) =>
          error instanceof ManifestError &&
          error.message.includes(`duplicate ${kind}`) &&
          error.message.includes("a.json"),
      );
    });
  }

  it("fails on two different values for the same scalar, and on unknown top-level keys", () => {
    assert.throws(
      () =>
        mergeFragments([
          {
            name: "a.json",
            fragment: { contributes: { configurationDefaults: { "[kql]": { "editor.tabSize": 2 } } } },
          },
          {
            name: "b.json",
            fragment: { contributes: { configurationDefaults: { "[kql]": { "editor.tabSize": 4 } } } },
          },
        ]),
      /b\.json sets contributes\.configurationDefaults\.\[kql\]\.editor\.tabSize/,
    );
    assert.throws(
      () => mergeFragments([{ name: "a.json", fragment: { main: "x" } }]),
      /unknown top-level key "main"/,
    );
  });

  it("replaces only activationEvents and contributes, keeping key order", () => {
    const out = applyToPackage(
      { name: "x", activationEvents: ["old"], contributes: { old: true }, scripts: {} },
      { activationEvents: ["new"], contributes: { a: 1 } },
    );
    assert.deepEqual(Object.keys(out), ["name", "activationEvents", "contributes", "scripts"]);
    assert.deepEqual(out.contributes, { a: 1 });
  });

  it("leaves the hand-written top-level fields alone, the main and browser entries included", () => {
    const out = applyToPackage(
      { main: "./dist/extension.js", browser: "./dist/web/extension.js", contributes: {} },
      { activationEvents: [], contributes: {} },
    );
    assert.equal(out.main, "./dist/extension.js");
    assert.equal(out.browser, "./dist/web/extension.js");
    assert.throws(
      () => mergeFragments([{ name: "web.json", fragment: { browser: "./x.js" } }]),
      /unknown top-level key "browser"/,
    );
  });

  it("package.json is generated from contrib/*.json", () => {
    const fragments = readdirSync(join(root, "contrib"))
      .filter((n) => n.endsWith(".json"))
      .map((name) => ({ name, fragment: JSON.parse(readFileSync(join(root, "contrib", name), "utf8")) }));
    const merged = mergeFragments(fragments);
    assert.deepEqual(pkg.contributes, merged.contributes);
    assert.deepEqual(pkg.activationEvents, merged.activationEvents);
  });
});

describe("package.json", () => {
  it("is the opentidehq.opentide extension", () => {
    assert.equal(pkg.publisher, "opentidehq");
    assert.equal(pkg.name, "opentide");
    assert.equal(pkg.displayName, "opentide");
    assert.equal(pkg.license, "MIT");
    assert.deepEqual(pkg.extensionKind, ["workspace"]);
    assert.deepEqual(pkg.categories, ["Programming Languages", "Linters", "Snippets", "AI", "Visualization"]);
    assert.ok(existsSync(join(root, pkg.icon)));
  });

  it("sets engines.vscode to what vscode-languageclient requires", () => {
    const client = JSON.parse(
      readFileSync(join(root, "node_modules", "vscode-languageclient", "package.json"), "utf8"),
    );
    assert.equal(pkg.engines.vscode, client.engines.vscode);
    const types = JSON.parse(
      readFileSync(join(root, "node_modules", "@types", "vscode", "package.json"), "utf8"),
    );
    assert.equal(
      `^${types.version}`,
      pkg.engines.vscode,
      "@types/vscode matches the floor, so newer APIs need feature detection",
    );
  });

  it("declares Restricted Mode support with the restricted settings (#8)", () => {
    const untrusted = pkg.capabilities.untrustedWorkspaces;
    assert.equal(untrusted.supported, "limited");
    assert.deepEqual(untrusted.restrictedConfigurations, [
      "opentide.path",
      "opentide.interpreter",
      "opentide.uv.usePin",
      "opentide.uv.path",
      "opentide.mcp.provide",
      "opentide.envFile",
      "opentide.terminal.addToPath",
    ]);
  });

  it("scopes opentide.path and opentide.interpreter machine-overridable, never synced", () => {
    const properties = Object.assign(
      {},
      ...pkg.contributes.configuration.map((section) => section.properties),
    );
    for (const key of ["opentide.path", "opentide.interpreter"]) {
      assert.equal(properties[key].scope, "machine-overridable", key);
      assert.equal(properties[key].ignoreSync, true, key);
    }
    assert.ok(properties["opentide.envFile"], "opentide.envFile is contributed");
  });

  it("forces semantic highlighting on and fix-all on save to never, per language", () => {
    for (const id of ["opentide-yaml", "kql", "spl", "esql", "eql", "kuery", "lucene", "falco"]) {
      const defaults = pkg.contributes.configurationDefaults[`[${id}]`];
      assert.equal(defaults["editor.semanticHighlighting.enabled"], true, id);
      assert.deepEqual(defaults["editor.codeActionsOnSave"], { "source.fixAll.opentide": "never" }, id);
    }
    assert.equal(pkg.contributes.configurationDefaults["[opentide-yaml]"]["editor.tabSize"], 2);
  });

  it("points every language and grammar at a file that exists", () => {
    for (const language of pkg.contributes.languages)
      assert.ok(existsSync(join(root, language.configuration)), language.configuration);
    for (const grammar of pkg.contributes.grammars)
      assert.ok(existsSync(join(root, grammar.path)), grammar.path);
    const ids = new Set(pkg.contributes.languages.map((l) => l.id));
    for (const grammar of pkg.contributes.grammars) assert.ok(ids.has(grammar.language), grammar.language);
  });

  it("associates opentide-yaml with objects/** and opentide-config with .opentide/configurations/**", () => {
    const byId = Object.fromEntries(pkg.contributes.languages.map((l) => [l.id, l]));
    assert.deepEqual(byId["opentide-yaml"].filenamePatterns, ["**/objects/**/*.yaml", "**/objects/**/*.yml"]);
    assert.deepEqual(byId["opentide-config"].filenamePatterns, ["**/.opentide/configurations/**/*.toml"]);
    assert.equal(byId.sql, undefined);
  });

  it("activates on an opentide workspace and on its languages", () => {
    assert.ok(pkg.activationEvents.includes("workspaceContains:.opentide/**"));
    assert.ok(pkg.activationEvents.includes("onLanguage:opentide-yaml"));
  });
});

describe("Show in Graph", () => {
  const entries = (menu) =>
    (pkg.contributes.menus[menu] ?? []).filter((item) => item.command === "opentide.graph.showInGraph");

  it("is on an opentide-yaml editor's title bar and context menu, and the explorer's", () => {
    for (const menu of ["editor/title", "editor/context", "explorer/context"]) {
      const [entry, ...more] = entries(menu);
      assert.ok(entry, `${menu} has Show in Graph`);
      assert.equal(more.length, 0, `${menu} has it once`);
      assert.match(entry.when, /resourceLangId == opentide-yaml/, menu);
      assert.match(entry.when, /opentide\.hasInfoCatalog/, `${menu}: only where the graph can draw`);
    }
    assert.match(entries("editor/title")[0].group, /^navigation@/, "an icon in the title bar");
    const command = pkg.contributes.commands.find((c) => c.command === "opentide.graph.showInGraph");
    assert.equal(command.icon, "$(type-hierarchy)");
  });
});

describe("README settings table", () => {
  it("lists every contributed setting, and only those", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const declared = [manifest.contributes.configuration]
      .flat()
      .flatMap((c) => Object.keys(c.properties ?? {}))
      .sort();
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const start = readme.indexOf("## Settings");
    const section = readme.slice(start, readme.indexOf("\n## ", start + 1));
    const listed = [...section.matchAll(/^\| `(opentide\.[A-Za-z0-9_.]+)` \|/gm)].map((m) => m[1]).sort();
    assert.deepEqual(listed, declared);
  });

  it("keeps the anchor the web mode links to", () => {
    assert.match(readFileSync(join(root, "README.md"), "utf8"), /^### Web and virtual workspaces$/m);
  });
});
