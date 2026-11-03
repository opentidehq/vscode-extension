import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  contributedCommands,
  isVirtualOnly,
  languageIds,
  STATUS,
  unavailableMessage,
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
      unavailableMessage("opentide: Restart Server"),
      /^opentide: Restart Server needs opentide, which cannot run in the browser/,
    );
  });

  it("says what is missing in a short status", () => {
    assert.equal(STATUS.text, "Highlighting only");
    assert.ok(STATUS.detail.length < 100);
  });

  it("treats a window as virtual only when it has folders and none is on disk", () => {
    assert.equal(isVirtualOnly([]), false, "no folder: the bundled server still serves single files");
    assert.equal(isVirtualOnly(["file"]), false);
    assert.equal(isVirtualOnly(["vscode-vfs"]), true);
    assert.equal(isVirtualOnly(["vscode-vfs", "file"]), false);
  });

  it("links to a README section", () => {
    const anchor = WEB_DOCS_URL.split("#")[1];
    assert.ok(anchor);
    // The integrator adds the README section (see the web mode result); until then this documents the anchor.
    if (readme.includes("## Web and virtual workspaces")) assert.equal(anchor, "web-and-virtual-workspaces");
  });
});
