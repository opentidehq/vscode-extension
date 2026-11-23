import * as assert from "node:assert/strict";
import * as path from "node:path";
import {
  compareVersions,
  errorForFirstRequest,
  extensionIdOf,
  type Files,
  folderVersion,
  newestInstalled,
  notInstalledMessage,
  obsoleteFolders,
} from "../../../src/mcp-launcher/pick";

/** A fake extensions folder: `tree` maps a folder to the files it holds. */
function fake(tree: Record<string, string[]>, obsolete?: string): Files {
  const dir = "/home/me/.kiro/extensions";
  return {
    list: (d) => (d === dir ? Object.keys(tree) : []),
    exists: (file) =>
      Object.entries(tree).some(([folder, held]) =>
        held.some((f) => path.posix.join(dir, folder, f) === file),
      ),
    read: (file) => (file === path.posix.join(dir, ".obsolete") ? obsolete : undefined),
    join: (...parts) => path.posix.join(...parts),
  };
}
const DIR = "/home/me/.kiro/extensions";
const ID = "opentidehq.opentide";
const BRIDGE = ["dist/mcp-wasi.js"];

describe("the MCP launcher's choice of an installed extension", () => {
  it("reads the version out of the folder's name, with or without a target platform", () => {
    assert.deepEqual(folderVersion("opentidehq.opentide-1.2.3", ID), [1, 2, 3]);
    assert.deepEqual(folderVersion("opentidehq.opentide-1.12.0-linux-x64", ID), [1, 12, 0]);
    assert.equal(folderVersion("opentidehq.opentide-tools-1.0.0", ID), undefined);
    assert.equal(folderVersion("other.opentide-1.0.0", ID), undefined);
    assert.equal(folderVersion("opentidehq.opentide", ID), undefined);
  });

  it("matches the folders of the id it is given: each store's publisher (docs/RELEASING.md)", () => {
    assert.deepEqual(folderVersion("opentide.opentide-1.2.3", "opentide.opentide"), [1, 2, 3]);
    assert.equal(folderVersion("opentidehq.opentide-1.2.3", "opentide.opentide"), undefined);
    assert.equal(folderVersion("opentide.opentide-1.2.3", ID), undefined);
    assert.equal(
      folderVersion("opentideXopentide-1.2.3", "opentide.opentide"),
      undefined,
      "the dot is literal",
    );
    const tree = fake({ "opentide.opentide-2.0.0": BRIDGE, "opentidehq.opentide-1.0.0": BRIDGE });
    assert.equal(newestInstalled(DIR, tree, ID)?.folder, "opentidehq.opentide-1.0.0");
    assert.equal(newestInstalled(DIR, tree, "opentide.opentide")?.folder, "opentide.opentide-2.0.0");
  });

  it("keeps the Marketplace's opentide.opentide-vscode and Open VSX's opentidehq.opentide apart", () => {
    const marketplace = "opentide.opentide-vscode";
    assert.deepEqual(folderVersion("opentide.opentide-vscode-0.3.3", marketplace), [0, 3, 3]);
    assert.equal(folderVersion("opentide.opentide-vscode-0.3.3", ID), undefined);
    assert.equal(folderVersion("opentidehq.opentide-0.3.3", marketplace), undefined);
    // `<name>-<version>`: a name that merely starts with the other's is not taken for it.
    assert.equal(folderVersion("opentidehq.opentide-vscode-0.3.3", ID), undefined);
    const tree = fake({ "opentide.opentide-vscode-0.3.3": BRIDGE, "opentidehq.opentide-0.3.2": BRIDGE });
    assert.equal(newestInstalled(DIR, tree, marketplace)?.folder, "opentide.opentide-vscode-0.3.3");
    assert.equal(newestInstalled(DIR, tree, ID)?.folder, "opentidehq.opentide-0.3.2");
    assert.equal(
      extensionIdOf(undefined, "/home/me/.config/Code/User/globalStorage/opentide.opentide-vscode"),
      marketplace,
    );
  });

  it("takes the id from the entry, else from the global storage folder it runs from", () => {
    const storage = "/home/me/.config/Kiro/User/globalStorage/opentidehq.opentide";
    assert.equal(extensionIdOf("opentide.opentide", storage), "opentide.opentide");
    assert.equal(extensionIdOf(undefined, storage), "opentidehq.opentide");
    assert.equal(
      extensionIdOf(undefined, "C:\\Users\\me\\globalStorage\\opentidehq.opentide\\"),
      "opentidehq.opentide",
    );
    assert.equal(extensionIdOf("not an id", storage), "opentidehq.opentide");
    assert.equal(extensionIdOf(undefined, "/tmp"), undefined);
  });

  it("compares numerically, not as text: 0.10.0 is newer than 0.9.0", () => {
    assert.ok(compareVersions([0, 10, 0], [0, 9, 0]) < 0);
    assert.ok(compareVersions([1, 0, 0], [0, 99, 99]) < 0);
    assert.equal(compareVersions([1, 2, 3], [1, 2, 3]), 0);
  });

  it("chooses the highest version whose bridge exists", () => {
    const found = newestInstalled(
      DIR,
      fake({
        "opentidehq.opentide-0.9.0": BRIDGE,
        "opentidehq.opentide-0.10.0": BRIDGE,
        "opentidehq.opentide-0.2.0": BRIDGE,
        "other.ext-9.9.9": BRIDGE,
      }),
      ID,
    );
    assert.equal(found?.folder, "opentidehq.opentide-0.10.0");
    assert.equal(found?.bridge, `${DIR}/opentidehq.opentide-0.10.0/dist/mcp-wasi.js`);
  });

  it("skips a half-deleted newer folder (no dist/mcp-wasi.js) and runs the older complete one", () => {
    const found = newestInstalled(
      DIR,
      fake({
        "opentidehq.opentide-1.2.0": ["package.json"],
        "opentidehq.opentide-1.0.0": BRIDGE,
      }),
      ID,
    );
    assert.equal(found?.folder, "opentidehq.opentide-1.0.0");
  });

  it("skips a folder the editor marked obsolete (an update that has not deleted the old one yet)", () => {
    const found = newestInstalled(
      DIR,
      fake(
        { "opentidehq.opentide-1.0.0": BRIDGE, "opentidehq.opentide-0.8.0": BRIDGE },
        '{"opentidehq.opentide-1.0.0": true}',
      ),
      ID,
    );
    assert.equal(found?.folder, "opentidehq.opentide-0.8.0");
    assert.deepEqual([...obsoleteFolders("not json")], []);
    assert.deepEqual([...obsoleteFolders("[1]")], []);
    assert.deepEqual([...obsoleteFolders('{"a": true, "b": false}')], ["a"]);
  });

  it("finds nothing when the extension is uninstalled or the folder cannot be read", () => {
    assert.equal(newestInstalled(DIR, fake({}), ID), undefined);
    assert.equal(
      newestInstalled(DIR, fake({ "opentidehq.opentide-1.0.0": ["package.json"] }), ID),
      undefined,
    );
    assert.equal(newestInstalled("/elsewhere", fake({ "opentidehq.opentide-1.0.0": BRIDGE }), ID), undefined);
  });

  it("is stable when two platforms share a version", () => {
    const tree = {
      "opentidehq.opentide-1.0.0-win32-x64": BRIDGE,
      "opentidehq.opentide-1.0.0-linux-x64": BRIDGE,
    };
    assert.equal(newestInstalled(DIR, fake(tree), ID)?.folder, "opentidehq.opentide-1.0.0-linux-x64");
  });
});

describe("the launcher's answer when the extension is not installed", () => {
  const message = notInstalledMessage("~/.kiro/settings/mcp.json");
  it("names the file and the way out", () => {
    assert.equal(
      message,
      "the opentide extension is not installed; remove the opentide entry from ~/.kiro/settings/mcp.json or reinstall",
    );
    assert.match(notInstalledMessage(undefined), /the editor's MCP settings/);
  });

  it("answers the first request, by its id, with a JSON-RPC error, and ignores what is not a request", () => {
    const reply = errorForFirstRequest('{"jsonrpc":"2.0","id":7,"method":"initialize","params":{}}', message);
    assert.deepEqual(JSON.parse(reply ?? ""), { jsonrpc: "2.0", id: 7, error: { code: -32603, message } });
    assert.ok(reply?.endsWith("\n"));
    assert.equal(JSON.parse(errorForFirstRequest('{"id":"abc","method":"x"}', message) ?? "").id, "abc");
    assert.equal(
      errorForFirstRequest('{"jsonrpc":"2.0","method":"notifications/initialized"}', message),
      undefined,
    );
    assert.equal(errorForFirstRequest("not json", message), undefined);
    assert.equal(errorForFirstRequest("[1]", message), undefined);
    assert.equal(errorForFirstRequest('{"id":1,"result":{}}', message), undefined);
    assert.equal(errorForFirstRequest('{"id":{},"method":"x"}', message), undefined);
  });
});
