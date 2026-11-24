import * as assert from "node:assert/strict";
import * as path from "node:path";

import { mergeMcpEntry } from "../../../src/features/agents/forks";
import { launcherEntry, launcherPath, launcherStale } from "../../../src/features/agents/launcher";

const ID = "opentidehq.opentide";
const storage = "/home/me/.config/Kiro/User/globalStorage/opentidehq.opentide";
const input = (version: string) => ({
  execPath: "/usr/share/kiro/kiro",
  storageDir: storage,
  extensionId: "opentidehq.opentide",
  extensionPath: `/home/me/.kiro/extensions/opentidehq.opentide-${version}`,
  entryFile: "/home/me/.kiro/settings/mcp.json",
});

describe("the user-level MCP entry for the bundled bridge", () => {
  it("names the stable launcher, the editor's binary, the extensions folder and the file", () => {
    assert.deepEqual(launcherEntry(input("1.0.0")), {
      command: "/usr/share/kiro/kiro",
      args: [path.join(storage, "mcp-launcher.cjs")],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        OPENTIDE_EXTENSIONS_DIR: "/home/me/.kiro/extensions",
        OPENTIDE_EXTENSION_ID: "opentidehq.opentide",
        OPENTIDE_MCP_ENTRY_FILE: "/home/me/.kiro/settings/mcp.json",
      },
    });
    assert.equal(launcherPath(storage), path.join(storage, "mcp-launcher.cjs"));
  });

  it("does not change on an extension update: the file stays byte-identical", () => {
    const first = mergeMcpEntry(
      '{"mcpServers": {"other": {"command": "x"}}}',
      launcherEntry(input("1.0.0")),
      ID,
    );
    assert.equal(first.kind, "write");
    if (first.kind !== "write") return;
    // The same extension, updated: a new folder in the same extensions directory.
    assert.deepEqual(mergeMcpEntry(first.text, launcherEntry(input("1.2.0")), ID), { kind: "same" });
    assert.equal(
      JSON.stringify(launcherEntry(input("1.0.0"))),
      JSON.stringify(launcherEntry(input("1.2.0"))),
    );
    assert.doesNotMatch(first.text, /1\.0\.0|mcp-wasi\.js/);
  });

  it("rewrites, once, an entry 0.3.0 wrote: its marker, and no OPENTIDE_EXTENSION_ID", () => {
    const written030 = JSON.stringify({
      mcpServers: {
        opentide: {
          command: "/usr/share/kiro/kiro",
          args: [path.join(storage, "mcp-launcher.cjs")],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            OPENTIDE_EXTENSIONS_DIR: "/home/me/.kiro/extensions",
            OPENTIDE_MCP_ENTRY_FILE: "/home/me/.kiro/settings/mcp.json",
            OPENTIDE_VSCODE_EXTENSION: "opentidehq.opentide",
          },
        },
      },
    });
    const merged = mergeMcpEntry(written030, launcherEntry(input("0.3.1")), ID);
    assert.equal(merged.kind, "write");
    if (merged.kind !== "write") return;
    assert.equal(JSON.parse(merged.text).mcpServers.opentide.env.OPENTIDE_EXTENSION_ID, ID);
    assert.deepEqual(mergeMcpEntry(merged.text, launcherEntry(input("0.3.2")), ID), { kind: "same" });
  });

  it("changes when the editor's binary or the extensions folder moves, and carries the proxy when there is one", () => {
    const moved = launcherEntry({ ...input("1.0.0"), execPath: "/opt/kiro-2/kiro" });
    const first = mergeMcpEntry(undefined, launcherEntry(input("1.0.0")), ID);
    if (first.kind !== "write") throw new Error("expected a write");
    assert.equal(mergeMcpEntry(first.text, moved, ID).kind, "write");
    assert.equal(
      launcherEntry({ ...input("1.0.0"), proxy: "http://p:3128" }).env.OPENTIDE_PROXY,
      "http://p:3128",
    );
  });

  it("rewrites the launcher file only when it is missing or differs from the extension's", () => {
    assert.equal(launcherStale(undefined, "a"), true);
    assert.equal(launcherStale("a", "b"), true);
    assert.equal(launcherStale("a", "a"), false);
  });
});
