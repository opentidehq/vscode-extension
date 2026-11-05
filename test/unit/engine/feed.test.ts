import * as assert from "node:assert/strict";
import { comparablePath, relativeTo } from "../../../src/engine/feed";

const uri = (path: string, scheme = "file", authority = "") => ({ scheme, authority, path });

describe("engine feed: which folder a changed file is in (src/engine/feed.ts)", () => {
  it("matches a watcher's drive letter to the folder's, whatever their case (Windows)", () => {
    assert.equal(comparablePath("/D:/a/repo"), "/d:/a/repo");
    assert.equal(comparablePath("/home/D:/x"), "/home/D:/x");
    assert.equal(
      relativeTo(uri("/d:/a/repo"), uri("/D:/a/repo/objects/objectives/o.yaml")),
      "objects/objectives/o.yaml",
    );
    assert.equal(relativeTo(uri("/D:/a/repo/"), uri("/d:/a/repo/objects/r.yaml")), "objects/r.yaml");
  });

  it("keeps the rest of the path's case, the scheme and the authority", () => {
    assert.equal(relativeTo(uri("/w/Repo"), uri("/w/repo/objects/r.yaml")), undefined);
    assert.equal(relativeTo(uri("/w"), uri("/w/objects/r.yaml", "vscode-vfs")), undefined);
    assert.equal(
      relativeTo(
        uri("/org/repo", "vscode-vfs", "github"),
        uri("/org/repo/objects/r.yaml", "vscode-vfs", "github"),
      ),
      "objects/r.yaml",
    );
    assert.equal(relativeTo(uri("/w"), uri("/wx/objects/r.yaml")), undefined);
  });
});
