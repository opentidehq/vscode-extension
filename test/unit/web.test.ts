import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { ENGINE_STATUS } from "../../src/engine/protocol";
import {
  CONTINUE_ON_DESKTOP,
  contributedCommands,
  engineStatus,
  isVirtualOnly,
  languageIds,
  STATUS,
  unavailableMessage,
  WEB_COMMANDS,
  WEB_DOCS_URL,
} from "../../src/web/mode";

const pkg: unknown = JSON.parse(readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8"));
const readme = readFileSync(path.join(__dirname, "..", "..", "..", "README.md"), "utf8");

describe("web mode", () => {
  it("lists every contributed language for the status item", () => {
    const ids = languageIds(pkg);
    for (const id of [
      "opentide-yaml",
      "opentide-config",
      "kql",
      "spl",
      "esql",
      "eql",
      "kuery",
      "lucene",
      "falco",
    ]) {
      assert.ok(ids.includes(id), id);
    }
    assert.deepEqual(languageIds({ contributes: { languages: [{ id: 3 }, {}, { id: "kql" }] } }), ["kql"]);
    assert.deepEqual(languageIds(undefined), []);
  });

  it("explains every contributed command, with its palette title", () => {
    const commands = contributedCommands(pkg);
    assert.ok(
      commands.some((c) => c.command === "opentide.restartServer" && c.title === "opentide: Restart Server"),
    );
    assert.deepEqual(
      contributedCommands({
        contributes: { commands: [{ command: "a.b" }, { title: "no id" }, { command: "c", title: "C" }] },
      }),
      [
        { command: "a.b", title: "a.b" },
        { command: "c", title: "C" },
      ],
    );
    assert.match(
      unavailableMessage("opentide: Validate Workspace"),
      /^opentide: Validate Workspace needs opentide, which runs in VS Code Desktop.*engine \(WASM\)/,
    );
  });

  it("implements only commands the manifest contributes, and explains the others", () => {
    const contributed = new Set(contributedCommands(pkg).map((c) => c.command));
    for (const command of WEB_COMMANDS) assert.ok(contributed.has(command), command);
    assert.ok(contributed.has(CONTINUE_ON_DESKTOP[0]) === false, "a VS Code command, not ours");
  });

  it("runs every Catalogue and Relations menu command that can show on the web", () => {
    // Keys web mode never sets: a menu that needs one never shows there.
    const neverOnTheWeb =
      /opentide\.(hasCli|hasInfoCatalog|editorOnly|runtimeReady|relations\.(hasTarget|pinned))\b/;
    const menus = (pkg as { contributes: { menus: Record<string, { command: string; when?: string }[]> } })
      .contributes.menus;
    const shown = ["view/title", "view/item/context"].flatMap((where) =>
      (menus[where] ?? []).filter(
        (m) =>
          /opentide\.sidebar\.(catalogue|relations)\b/.test(m.when ?? "") &&
          !neverOnTheWeb.test(m.when ?? ""),
      ),
    );
    assert.ok(shown.length > 0);
    const missing = [...new Set(shown.map((m) => m.command))].filter((command) => !WEB_COMMANDS.has(command));
    assert.deepEqual(missing, [], "these menus answer 'needs opentide' on the web");
  });

  it("warns, with Restart, when the engine does not run in an opentide workspace", () => {
    assert.deepEqual(engineStatus(true, true), {
      severity: "information",
      detail: STATUS.detail,
      restart: false,
    });
    assert.equal(engineStatus(false, false).restart, false, "no opentide folder: nothing to restart");
    const stopped = engineStatus(false, true);
    assert.equal(stopped.severity, "warning");
    assert.equal(stopped.restart, true);
    assert.match(stopped.detail, /not running/);
  });

  it("says what runs and what is missing in a short status", () => {
    assert.equal(ENGINE_STATUS, "opentide engine (WASM): editor features only");
    assert.ok(STATUS.detail.length < 100);
  });

  it("treats a window as virtual only when it has folders and none is on disk", () => {
    assert.equal(isVirtualOnly([]), false, "no folder: the bundled server still serves single files");
    assert.equal(isVirtualOnly(["file"]), false);
    assert.equal(isVirtualOnly(["vscode-vfs"]), true);
    assert.equal(isVirtualOnly(["vscode-vfs", "file"]), false);
  });

  it("links to a README section that exists", () => {
    const anchor = WEB_DOCS_URL.split("#")[1];
    assert.ok(anchor);
    // GitHub's heading anchors: lower case, punctuation dropped, spaces as hyphens.
    const slugs = [...readme.matchAll(/^#{1,6} +(.+?) *#*$/gm)].map((m) =>
      (m[1] ?? "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/ /g, "-"),
    );
    assert.ok(slugs.includes(anchor), `README.md has no heading with the anchor #${anchor}`);
  });
});
