import * as assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Backend } from "../../../src/core/backend/backend";
import { CommandTree } from "../../../src/core/capabilities/tree";
import { SaveBatcher } from "../../../src/features/diagnostics/saves";
import { COMMANDS_FIXTURE, fakeRuntime, until } from "../helpers";

describe("diagnostics: saves", () => {
  it("batches saves per folder, objects and configuration apart", async () => {
    const invalidated: string[] = [];
    const flushed: { folder: string; files: string[]; configuration: boolean }[] = [];
    const saves = new SaveBatcher<string>({
      invalidate: (paths) => invalidated.push(...paths),
      flush: (batches) => {
        for (const b of batches)
          flushed.push({ folder: b.folder, files: [...b.files], configuration: b.configuration });
      },
      delayMs: 10,
    });
    saves.add("/a", "/a", "/a/objects/x.yaml", "object");
    saves.add("/a", "/a", "/a/.opentide/configurations/lint.toml", "configuration");
    saves.add("/b", "/b", "/b/objects/y.yaml", "object");
    assert.deepEqual(invalidated, [
      "/a/objects/x.yaml",
      "/a/.opentide/configurations/lint.toml",
      "/b/objects/y.yaml",
    ]);
    await until(() => flushed.length === 2);
    assert.deepEqual(flushed, [
      { folder: "/a", files: ["/a/objects/x.yaml"], configuration: true },
      { folder: "/b", files: ["/b/objects/y.yaml"], configuration: false },
    ]);
    saves.dispose();
  });

  it("invalidates the saved file in opentide serve before the run for the save is sent", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "otide-saves-"));
    const runtime = fakeRuntime();
    const backend = new Backend({
      runtime: () => runtime,
      commands: async () => {
        const document = JSON.parse(readFileSync(COMMANDS_FIXTURE, "utf8"));
        document.commands.push({ ...document.commands[0], path: "serve", name: "serve", subcommands: [] });
        return CommandTree.parse(document);
      },
      classify: () => ({ class: "read-only", writes: false, contactsTenant: false, spawn: false }),
      serveMode: () => "auto",
      baseEnv: () => process.env,
      proxy: () => undefined,
      credentials: async () => ({}),
      platform: process.platform,
      log: () => undefined,
    });
    try {
      assert.equal((await backend.run(repo, ["echo"])).via, "serve");
      const file = path.join(repo, "objects", "rules", "r.yaml");
      let seen: unknown;
      const saves = new SaveBatcher<string>({
        invalidate: (paths) => backend.invalidate(paths),
        // The fake serve answers `invalidated` with every path it was told about, in order.
        flush: async () => {
          seen = (await backend.run(repo, ["invalidated"])).document.paths;
        },
        delayMs: 10,
      });
      saves.add(repo, repo, file, "object");
      await until(() => seen !== undefined);
      assert.deepEqual(seen, [file]);
    } finally {
      await backend.dispose();
    }
  });
});
