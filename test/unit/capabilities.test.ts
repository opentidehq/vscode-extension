import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Capabilities, cacheable } from "../../src/core/capabilities/capabilities";
import { COMMAND_CLASSES, classify, splitCommandPath } from "../../src/core/capabilities/classification";
import { CommandTree, stripGlobalOptions } from "../../src/core/capabilities/tree";
import { COMMANDS_FIXTURE, fakeRuntime } from "./helpers";

const fixture = (): unknown => JSON.parse(readFileSync(COMMANDS_FIXTURE, "utf8"));

describe("command tree (opentide 0.20.1 `--json commands`)", () => {
  const tree = CommandTree.parse(fixture());

  it("answers hasCommand for commands and for positional choices", () => {
    assert.equal(tree.version, "0.20.1");
    assert.ok(tree.hasCommand("validate"));
    assert.ok(tree.hasCommand("validate query"));
    assert.ok(tree.hasCommand(["new", "rule"]));
    assert.ok(tree.hasCommand("info coverage"), "a value of info's `section` argument");
    assert.ok(!tree.hasCommand("info catalog"), "0.20.1 has no catalogue (opentide#749)");
    assert.ok(!tree.hasCommand("serve"), "0.20.1 has no serve (opentide#750)");
    assert.ok(!tree.hasCommand(""));
  });

  it("answers hasOption for command options and global options", () => {
    assert.ok(tree.hasOption("validate", "--file"));
    assert.ok(tree.hasOption("validate", "--repo"), "a global option");
    assert.ok(!tree.hasOption("lint", "--file"), "lint --file arrives with opentide#755");
    assert.ok(!tree.hasOption("deploy", "--uuid"), "deploy --uuid arrives with opentide#753");
    assert.ok(!tree.hasOption("nope", "--file"));
  });

  it("finds the command path of an argv", () => {
    assert.deepEqual(tree.commandPathOf(["--repo", "/x", "generate", "docs", "rules", "--all"]), {
      path: "generate docs rules",
      rest: ["--all"],
    });
    assert.deepEqual(stripGlobalOptions(["--json", "--proxy=http://p", "validate"]), ["validate"]);
  });

  it("rejects a document that is not a command tree", () => {
    assert.throws(() => CommandTree.parse({ ok: true }));
  });
});

describe("command classification", () => {
  it("classifies every command of the pinned opentide (a new command fails this test)", () => {
    const tree = CommandTree.parse(fixture());
    const missing = tree.commands.map((c) => c.path).filter((p) => !Object.hasOwn(COMMAND_CLASSES, p));
    assert.deepEqual(missing, []);
  });

  it("depends on flags where the flags change what a command does", () => {
    assert.equal(classify(["validate", "--file", "x"]).class, "read-only");
    assert.equal(classify(["validate", "--fix"]).writes, true);
    assert.equal(classify(["validate", "--fix", "--dry-run"]).writes, false);
    assert.equal(classify(["validate", "query", "--live"]).contactsTenant, true);
    assert.equal(classify(["deploy", "--dry-run"]).class, "read-only");
    assert.equal(classify(["deploy"]).class, "deploys");
    assert.equal(classify(["share", "push"]).class, "shares");
    assert.equal(classify(["doctor", "--offline"]).contactsTenant, false);
    assert.equal(
      classify(["query", "--rule", "u"]).spawn,
      true,
      "long, outward commands get a process of their own",
    );
    assert.equal(classify(["info", "catalog"]).class, "read-only");
    assert.equal(classify(["setup", "--plan"]).writes, false);
    assert.deepEqual(
      splitCommandPath(["--repo", "r", "generate", "extract", "sentinel"]).path,
      "generate extract sentinel",
    );
  });

  it("treats an unknown command as a writer that gets no credentials", () => {
    const unknown = classify(["frobnicate"]);
    assert.equal(unknown.unclassified, true);
    assert.equal(unknown.writes, true);
    assert.equal(unknown.contactsTenant, false);
  });

  it("asks registered classifiers first", () => {
    const answer = { class: "read-only", writes: false, contactsTenant: false, spawn: false } as const;
    assert.equal(
      classify(["frobnicate"], [(_path, rest) => (rest[0] === "frobnicate" ? answer : undefined)]).class,
      "read-only",
    );
  });
});

describe("capabilities", () => {
  it("reads `commands` once per version and caches it", async () => {
    const stored = new Map<string, unknown>();
    let fetches = 0;
    const capabilities = new Capabilities({
      fetch: async () => {
        fetches++;
        return fixture();
      },
      cache: { read: async (v) => stored.get(v), write: async (v, d) => void stored.set(v, d) },
      log: () => {},
    });
    const runtime = fakeRuntime({ version: "0.20.1" });
    await capabilities.load(runtime);
    assert.ok(capabilities.hasCommand("validate"));
    assert.ok(!capabilities.hasCommand("info catalog"));
    await capabilities.load({ ...runtime });
    assert.equal(fetches, 1, "the second load of the same version reads the cache");
    assert.ok(stored.has("0.20.1"));
    await capabilities.refresh();
    assert.equal(fetches, 2);
  });

  it("has no tree for a restricted or editor-only runtime, and never fetches one", async () => {
    let fetches = 0;
    const capabilities = new Capabilities({
      fetch: async () => {
        fetches++;
        return fixture();
      },
      cache: { read: async () => undefined, write: async () => {} },
      log: () => {},
    });
    assert.equal(await capabilities.load(fakeRuntime({ restricted: true })), undefined);
    assert.equal(await capabilities.load(fakeRuntime({ kind: "opentide-lsp" })), undefined);
    assert.equal(fetches, 0);
    assert.ok(!capabilities.hasCommand("validate"));
  });

  it("does not cache development versions on disk", () => {
    assert.ok(cacheable("0.20.1"));
    assert.ok(!cacheable("0.21.0.dev3"));
    assert.ok(!cacheable("0.21.0+g1234"));
  });
});
