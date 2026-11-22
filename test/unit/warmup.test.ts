import * as assert from "node:assert/strict";
import {
  isWarmupUri,
  ruleFolderOf,
  WARMUP_RULE,
  warmsUp,
  warmUpEnabled,
  warmupUri,
  warmupWatch,
} from "../../src/core/lsp/warmup";

describe("warming the language server before the first document", () => {
  it("is on unless the setting says false", () => {
    assert.equal(warmUpEnabled(undefined), true);
    assert.equal(warmUpEnabled(true), true);
    assert.equal(warmUpEnabled(false), false);
  });

  it("warms opentide's own process and the WASI module, not the engine", () => {
    assert.equal(warmsUp({ kind: "opentide" }), true);
    assert.equal(warmsUp({ kind: "opentide-lsp" }), false);
    assert.equal(warmsUp({ kind: "engine" }), false);
  });

  it("puts the synthetic rule where rules live, in the first folder, and knows it again", () => {
    const uri = warmupUri("file:///work/detections");
    assert.equal(uri, "file:///work/detections/objects/rules/.opentide-warmup.yaml");
    assert.equal(warmupUri("file:///work/detections/"), uri, "a trailing slash is not doubled");
    assert.equal(isWarmupUri(uri), true);
    assert.equal(isWarmupUri("file:///work/detections/objects/rules/real.yaml"), false);
    assert.equal(isWarmupUri("file:///work/detections/objects/rules/x.opentide-warmup.yaml"), false);
  });

  it("follows paths.toml's rule folder, and falls back to objects/rules for anything unsafe or missing", () => {
    const at = (rule: string | undefined) => warmupUri("file:///w", rule === undefined ? {} : { rule });
    assert.equal(at("detections/rules/"), "file:///w/detections/rules/.opentide-warmup.yaml");
    assert.equal(at("./detections/rules"), "file:///w/detections/rules/.opentide-warmup.yaml");
    assert.equal(at("detections\\rules"), "file:///w/detections/rules/.opentide-warmup.yaml");
    for (const bad of [undefined, "", "/etc", "../x", "a/../../b", "C:\\x"])
      assert.equal(at(bad), "file:///w/objects/rules/.opentide-warmup.yaml", String(bad));
    assert.equal(ruleFolderOf(undefined), "objects/rules");
  });

  it("is a rule with a name, a schema, a uuid and a query, and a uuid no real rule has", () => {
    assert.match(WARMUP_RULE, /^name: /m);
    assert.match(WARMUP_RULE, /schema: rule::1\.1/);
    assert.match(WARMUP_RULE, /uuid: 00000000-0000-4000-8000-0000000a11a5/);
    assert.match(WARMUP_RULE, /query: \|/);
  });

  it("ends when the synthetic rule's diagnostics arrive, ignoring any other document's", async () => {
    const watch = warmupWatch(60_000);
    watch.seen("file:///work/objects/rules/real.yaml");
    watch.seen(warmupUri("file:///work"));
    assert.equal(await watch.done, "analysed");
  });

  it("gives up after the timeout, so a server that never answers is not waited for", async () => {
    const fired: (() => void)[] = [];
    const watch = warmupWatch(10_000, ((callback: () => void) => {
      fired.push(callback);
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);
    fired[0]?.();
    assert.equal(await watch.done, "timeout");
    watch.cancel();
  });
});
