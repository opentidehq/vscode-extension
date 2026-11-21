import * as assert from "node:assert/strict";
import { SERVER_WATCH_GLOBS, UNWATCHED_OPENTIDE_DIRECTORIES } from "../../src/core/services/watchGlobs";

/** The two glob forms used here, as regular expressions: `**` crosses folders, nothing else is special. */
function matches(glob: string, path: string): boolean {
  const pattern = glob
    .split("**")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`).test(path);
}
const watched = (path: string) => SERVER_WATCH_GLOBS.some((glob) => matches(glob, path));

describe("the files the language server's client watches (E3)", () => {
  it("covers the object files, the configurations and the schemas, in any folder of the window", () => {
    assert.equal(watched("/ws/objects/rules/a.yaml"), true);
    assert.equal(watched("/ws/sub/repo/objects/threats/t.yaml"), true);
    assert.equal(watched("/ws/.opentide/configurations/paths.toml"), true);
    assert.equal(watched("/ws/.opentide/configurations/platforms/elastic.toml"), true);
    assert.equal(watched("/ws/.opentide/schemas/rule.json"), true);
  });

  it("leaves out what the extension's own runs write by the thousand", () => {
    for (const directory of UNWATCHED_OPENTIDE_DIRECTORIES) {
      assert.equal(watched(`/ws/.opentide/${directory}/some/file.json`), false, directory);
      assert.equal(watched(`/ws/.opentide/${directory}/x`), false, directory);
    }
  });

  it("is not the whole of .opentide", () => {
    const globs: readonly string[] = SERVER_WATCH_GLOBS;
    assert.ok(!globs.includes("**/.opentide/**"));
    assert.ok(!globs.includes("**/{objects,.opentide}/**"));
  });
});
