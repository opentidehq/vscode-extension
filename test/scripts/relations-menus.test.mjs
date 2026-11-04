// The Relations view and the relation entry points in the manifest: where the view sits, which actions
// each object row has in every sidebar view, and the when clauses that keep the editor entries on Tide
// YAML and the pin and unpin buttons apart.
import * as assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const { menus, views, configuration } = pkg.contributes;
const RELATIONS = "opentide.sidebar.relations";
const OBJECT_VIEWS = ["opentide.sidebar.catalogue", "opentide.sidebar.coverage", RELATIONS];

const itemMenus = menus["view/item/context"];
const inlineOn = (view) =>
  itemMenus
    .filter(
      (m) => m.group?.startsWith("inline") && m.when.includes(`view == ${view}`) && /object/.test(m.when),
    )
    .sort((a, b) => a.group.localeCompare(b.group))
    .map((m) => m.command);

describe("the Relations view in the manifest", () => {
  it("sits right under the Catalogue", () => {
    const ids = views.opentide.map((v) => v.id);
    assert.equal(ids.indexOf(RELATIONS), ids.indexOf("opentide.sidebar.catalogue") + 1);
  });

  it("gives object rows the same inline actions in the Catalogue, Coverage and Relations", () => {
    const expected = [
      "opentide.relations.openToSide",
      "opentide.relations.show",
      "opentide.sidebar.showInGraph",
      "opentide.sidebar.validate",
    ];
    for (const view of OBJECT_VIEWS) assert.deepEqual(inlineOn(view), expected, view);
  });

  it("gives object rows the same context menu in every view that lists objects", () => {
    const commandsOn = (view) =>
      itemMenus
        .filter((m) => !m.group?.startsWith("inline") && m.when.includes(`view == ${view}`))
        .filter((m) => /viewItem (=~ \/\^(\(object|object)|== object\.)/.test(m.when))
        .map((m) => `${m.command} ${m.group}`)
        .sort();
    const catalogue = commandsOn("opentide.sidebar.catalogue");
    assert.ok(catalogue.length >= 10, catalogue.join("\n"));
    assert.deepEqual(commandsOn(RELATIONS), catalogue);
  });

  it("gates Show in Graph on info catalog, as the graph's own entry points are", () => {
    for (const entry of itemMenus.filter((m) => m.command === "opentide.sidebar.showInGraph"))
      assert.match(entry.when, /opentide\.hasInfoCatalog/, entry.when);
  });

  it("offers Show Relations on Tide YAML in the editor title and context menu, and in the palette", () => {
    for (const menu of ["editor/title", "editor/context"]) {
      const entry = menus[menu].find((m) => m.command === "opentide.relations.show");
      assert.ok(entry, menu);
      assert.match(entry.when, /resourceLangId == opentide-yaml/);
      assert.match(entry.when, /opentide\.hasWorkspace/);
    }
    const palette = menus.commandPalette.find((m) => m.command === "opentide.relations.show");
    assert.equal(palette.when, "opentide.hasWorkspace");
    for (const hidden of ["opentide.relations.open", "opentide.relations.openToSide"])
      assert.equal(menus.commandPalette.find((m) => m.command === hidden)?.when, "false", hidden);
  });

  it("shows pin or unpin in the view title, never both, and back and forward with a target", () => {
    const title = menus["view/title"].filter((m) => m.when.includes(`view == ${RELATIONS}`));
    const pin = title.find((m) => m.command === "opentide.relations.pin");
    const unpin = title.find((m) => m.command === "opentide.relations.unpin");
    assert.match(pin.when, /!opentide\.relations\.pinned/);
    assert.match(unpin.when, /(?<!!)opentide\.relations\.pinned/);
    assert.equal(pin.group, unpin.group);
    for (const command of ["opentide.relations.back", "opentide.relations.forward"]) {
      assert.match(title.find((m) => m.command === command).when, /opentide\.relations\.hasTarget/);
      const contributed = pkg.contributes.commands.find((c) => c.command === command);
      assert.match(contributed.enablement, /opentide\.relations\.can(Back|Forward)/);
    }
  });

  it("has a welcome per state: no folder, not a repository, nothing open (trusted or not), a virtual workspace", () => {
    const welcomes = pkg.contributes.viewsWelcome.filter((w) => w.view === RELATIONS);
    assert.deepEqual(
      welcomes.map((w) => w.when),
      [
        "workspaceFolderCount == 0",
        "workspaceFolderCount > 0 && !opentide.hasWorkspace && isWorkspaceTrusted && !virtualWorkspace",
        "workspaceFolderCount > 0 && !opentide.hasWorkspace && !isWorkspaceTrusted && !virtualWorkspace",
        "opentide.hasWorkspace && isWorkspaceTrusted && !virtualWorkspace",
        "opentide.hasWorkspace && !isWorkspaceTrusted && !virtualWorkspace",
        "virtualWorkspace",
      ],
    );
    assert.match(welcomes[3].contents, /\(command:opentide\.relations\.show\)/);
    assert.match(welcomes[4].contents, /\(command:workbench\.trust\.manage\)/);
  });

  it("turns the CodeLens on by default, with a setting to turn it off", () => {
    const sections = Array.isArray(configuration) ? configuration : [configuration];
    const setting = sections.map((s) => s.properties?.["opentide.relations.codeLens"]).find(Boolean);
    assert.equal(setting?.type, "boolean");
    assert.equal(setting?.default, true);
  });
});

describe("server notifications", () => {
  it("are taken once by the core: no feature registers opentide/catalogChanged itself", () => {
    // vscode-languageclient keeps one handler per notification; a feature's would replace the core's
    // (ctx.client.onCatalogChanged) and every other subscriber's.
    const root = fileURLToPath(new URL("../../src/features", import.meta.url));
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    const offenders = files.filter((file) =>
      /\.onNotification\(/.test(readFileSync(join(root, file), "utf8")),
    );
    assert.deepEqual(offenders, []);
  });
});
