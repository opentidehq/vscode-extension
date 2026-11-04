import * as assert from "node:assert/strict";
import { fileUriPath, folderSymbols, pathInside } from "../../src/core/catalog/symbols";

const symbol = (uri: string, name = "Rule") => ({
  name,
  containerName: "rule",
  location: { uri, range: { start: { line: 3, character: 2 } } },
});

describe("catalogue: workspace symbols of a folder", () => {
  it("reads the language server's URIs, which encode less than VS Code's", () => {
    assert.equal(fileUriPath("file:///C:/Users/me/repo/x.yaml", "win32"), "C:\\Users\\me\\repo\\x.yaml");
    assert.equal(fileUriPath("file:///c%3A/Users/me/repo/x.yaml", "win32"), "c:\\Users\\me\\repo\\x.yaml");
    assert.equal(fileUriPath("file:///home/me/Acme%20(Corp)/x.yaml", "linux"), "/home/me/Acme (Corp)/x.yaml");
    assert.equal(fileUriPath("untitled:x", "linux"), undefined);
  });

  it("keeps a folder's symbols on Windows, whatever the drive letter's case or encoding", () => {
    const symbols = [
      symbol("file:///C:/Users/me/repo/objects/rules/a.yaml", "A"),
      symbol("file:///c%3A/Users/me/repo/objects/rules/b.yaml", "B"),
      symbol("file:///C:/Users/me/repo-other/objects/c.yaml", "C"),
    ];
    const kept = folderSymbols(symbols, "c:\\Users\\me\\repo", "win32");
    assert.deepEqual(
      kept.map((s) => s.name),
      ["A", "B"],
    );
    assert.deepEqual(kept[0], {
      name: "A",
      family: "rule",
      uri: "file:///C:/Users/me/repo/objects/rules/a.yaml",
      line: 3,
      character: 2,
    });
  });

  it("keeps the symbols of a folder whose name VS Code percent-encodes", () => {
    const folder = "/home/me/OneDrive - Acme (Corp)/r@pos,x=1";
    const symbols = [
      symbol("file:///home/me/OneDrive%20-%20Acme%20(Corp)/r@pos,x=1/objects/a.yaml", "A"),
      symbol("file:///home/me/OneDrive%20-%20Acme%20%28Corp%29/r%40pos%2Cx%3D1/objects/b.yaml", "B"),
      symbol("file:///home/me/elsewhere/c.yaml", "C"),
    ];
    const kept = folderSymbols(symbols, folder, "linux", (file) => `vscode:${file}`);
    assert.deepEqual(
      kept.map((s) => [s.name, s.uri]),
      [
        ["A", `vscode:${folder}/objects/a.yaml`],
        ["B", `vscode:${folder}/objects/b.yaml`],
      ],
    );
  });

  it("tests containment by path, case-insensitively on Windows and macOS only", () => {
    assert.ok(pathInside("/Repo", "/repo/x", "darwin"));
    assert.ok(!pathInside("/Repo", "/repo/x", "linux"));
    assert.ok(!pathInside("/repo", "/repo", "linux"), "the folder itself is not a file in it");
    assert.ok(!pathInside("/repo", "/repo-2/x", "linux"));
  });
});
