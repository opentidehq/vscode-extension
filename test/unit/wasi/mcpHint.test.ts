import * as assert from "node:assert/strict";
import * as path from "node:path";
import { checkRoot, startupLine, withWorkspaceHint, workspaceHint } from "../../../src/core/wasi/mcpHint";

const dirs = (...names: string[]) => {
  const set = new Set(names.map((name) => path.resolve(name)));
  return (folder: string) => set.has(path.resolve(folder));
};

describe("the MCP bridge's root check and hint (#86)", () => {
  it("finds the repository above the working directory, by .opentide/ or objects/", () => {
    const isDir = dirs("/work/repo/.opentide");
    assert.deepEqual(checkRoot("/work/repo/objects/rules", {}, isDir), {
      configured: undefined,
      resolved: path.resolve("/work/repo"),
    });
    assert.equal(
      checkRoot("/work/repo", {}, dirs("/work/repo/objects")).resolved,
      path.resolve("/work/repo"),
    );
  });

  it("finds none from a home folder, and says so", () => {
    const check = checkRoot("/home/me", {}, dirs());
    assert.deepEqual(check, { configured: undefined, resolved: undefined });
    assert.equal(
      startupLine("/home/me", check),
      "opentide mcp bridge: cwd=/home/me; OPENTIDE_REPO_ROOT not set; repository root: none found",
    );
  });

  it("takes OPENTIDE_REPO_ROOT when it names a folder, and reports one that is not", () => {
    const named = checkRoot("/home/me", { OPENTIDE_REPO_ROOT: "/work/repo" }, dirs("/work/repo"));
    assert.deepEqual(named, { configured: "/work/repo", resolved: "/work/repo" });
    assert.match(
      startupLine("/home/me", named),
      /OPENTIDE_REPO_ROOT=\/work\/repo; repository root: \/work\/repo/,
    );
    const missing = checkRoot("/home/me", { OPENTIDE_REPO_ROOT: "/gone" }, dirs());
    assert.equal(missing.resolved, undefined);
    assert.match(workspaceHint("/home/me", missing), /OPENTIDE_REPO_ROOT is \/gone, which is not a folder/);
    // An empty variable is not set.
    assert.equal(checkRoot("/home/me", { OPENTIDE_REPO_ROOT: " " }, dirs()).configured, undefined);
  });

  it("names where the editor started the server and how to fix it", () => {
    const hint = workspaceHint("/home/me", { configured: undefined, resolved: undefined });
    assert.match(hint, /started this server in \/home\/me/);
    assert.match(hint, /Open the repository's folder in the editor, or set OPENTIDE_REPO_ROOT/);
  });

  it("adds the hint to a workspace_not_found tool result, and changes no other line", () => {
    const hint = "fix it";
    const notFound =
      '{"jsonrpc":"2.0","id":3,"result":{"isError":true,"content":[{"type":"text","text":"workspace_not_found: x"}]}}\n';
    const out = JSON.parse(withWorkspaceHint(notFound, hint));
    assert.deepEqual(out.result.content, [
      { type: "text", text: "workspace_not_found: x" },
      { type: "text", text: "fix it" },
    ]);
    assert.equal(out.id, 3);
    assert.ok(withWorkspaceHint(notFound, hint).endsWith("\n"));
    for (const line of [
      '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n',
      '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"ok"}]}}\n',
      // The words in a request, or in a result with no text part that says them, are left alone.
      '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"note":"workspace_not_found"}}\n',
      "not json workspace_not_found\n",
    ])
      assert.equal(withWorkspaceHint(line, hint), line);
  });
});
