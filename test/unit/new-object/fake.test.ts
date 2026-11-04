// `opentide new` through the backend, against test/fixtures/fake-opentide.mjs.
import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Backend } from "../../../src/core/backend/backend";
import { classify } from "../../../src/core/capabilities/classification";
import { createdOf, failureAction, newArgv } from "../../../src/features/new-object/flow";
import { nextPlaceholder, placeholderLines } from "../../../src/features/new-object/placeholders";
import { fakeRuntime } from "../helpers";

function backend(): Backend {
  const runtime = fakeRuntime();
  return new Backend({
    runtime: () => runtime,
    commands: async () => undefined,
    classify: (argv) => classify(argv),
    serveMode: () => "never",
    baseEnv: () => process.env,
    proxy: () => undefined,
    credentials: async () => ({}),
    platform: process.platform,
    log: () => {},
  });
}

describe("new-object against the fake opentide", function () {
  this.timeout(20_000);
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "otide-new-"));
    mkdirSync(path.join(root, "objects", "rules"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("creates a rule, and Next placeholder visits every marked line", async () => {
    const b = backend();
    const argv = newArgv({
      kind: "rule",
      name: "Suspicious LSASS Access",
      platforms: ["sentinel"],
      objective: "u-1",
    });
    const result = await b.run(root, argv);
    const created = createdOf(result.document, root);
    assert.ok(created, JSON.stringify(result.document));
    assert.equal(created.file, path.join(root, "objects", "rules", "suspicious-lsass-access.yaml"));
    const lines = readFileSync(created.file, "utf8").split("\n");
    const marked = placeholderLines(lines);
    assert.equal(marked.length, created.placeholders);
    const visited = new Set<number>();
    let at = -1;
    for (let i = 0; i < marked.length; i++) {
      at = nextPlaceholder(marked, at, 1) ?? -1;
      visited.add(at);
    }
    assert.deepEqual([...visited], marked);
    assert.ok(lines.includes("detection_model: u-1"), "--objective prefilled detection_model");

    // As the real CLI: the same name again gets the new UUID's first 8 characters, never overwrites.
    const again = await b.run(root, argv);
    const second = createdOf(again.document, root);
    assert.ok(second, JSON.stringify(again.document));
    assert.match(path.basename(second.file), /^suspicious-lsass-access-[0-9a-f]{8}\.yaml$/);
    assert.notEqual(second.uuid, created.uuid);

    // Only a file named with --path is refused.
    const named = await b.run(root, [...argv, "--path", path.relative(root, created.file)]);
    const action = failureAction(named.document.failure?.code, named.document.failure?.message ?? "", root);
    assert.deepEqual(action, { kind: "exists", file: created.file });
    await b.dispose();
  });

  it("names the failure of a vanished objective", async () => {
    const b = backend();
    const result = await b.run(
      root,
      newArgv({ kind: "rule", name: "X", objective: "00000000-0000-0000-0000-000000000000" }),
    );
    assert.equal(failureAction(result.document.failure?.code, "", root).kind, "pick-again");
    await b.dispose();
  });
});
