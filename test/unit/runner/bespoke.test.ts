import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CommandTree } from "../../../src/core/capabilities/tree";
import {
  docsFolders,
  docsIndex,
  explainEntries,
  explainMarkdown,
  generateChoices,
  generatePhases,
  generateRuns,
  markdownTable,
  unreviewedRules,
  vocabularies,
  vocabularyMarkdown,
} from "../../../src/features/runner/bespoke";
import { COMMANDS_FIXTURE } from "../helpers";

const tree = CommandTree.parse(JSON.parse(readFileSync(COMMANDS_FIXTURE, "utf8")));

describe("runner palette commands", () => {
  it("reads generate's phases from its help", () => {
    assert.deepEqual(generatePhases(tree.command("generate")?.help), [
      "schemas",
      "templates",
      "vocabs",
      "snippets",
    ]);
    assert.deepEqual(generatePhases("Generate things."), []);
    assert.deepEqual(generatePhases(undefined), []);
  });

  it("offers generate's subcommands, extract per platform with a globe, then its phases", () => {
    const choices = generateChoices(tree);
    const ids = choices.map((c) => c.id);
    assert.deepEqual(ids.slice(0, 4), ["explorer", "docs", "exports", "extract sentinel"]);
    assert.ok(ids.includes("inflight"));
    assert.ok(!ids.includes("extract"), "extract alone does not run");
    assert.deepEqual(
      choices.filter((c) => c.contactsTenant).map((c) => c.id),
      ["extract sentinel", "extract defender", "extract elastic"],
    );
    assert.deepEqual(
      choices.filter((c) => c.kind === "phase").map((c) => c.id),
      ["schemas", "templates", "vocabs", "snippets"],
    );
  });

  it("runs subcommands alone and phases together", () => {
    const choices = generateChoices(tree);
    const pick = (...ids: string[]) => choices.filter((c) => ids.includes(c.id));
    assert.deepEqual(generateRuns(pick("docs", "schemas", "snippets", "exports")), [
      ["generate", "docs"],
      ["generate", "exports"],
      ["generate", "schemas", "snippets"],
    ]);
    assert.deepEqual(generateRuns(pick("extract elastic")), [["generate", "extract", "elastic"]]);
    assert.deepEqual(generateRuns([]), []);
  });

  it("renders a vocabulary as Markdown: facts, then a table per list", () => {
    const document = {
      vocabulary: {
        name: "tlp",
        title: "Traffic Light Protocol",
        entries: 5,
        staged: false,
        stages: [],
        revisions: [{ revision: "1.0", introduced: 5, removed: 0 }],
        pins: [{ schema: "rule::1.1", field: "metadata.tlp", scoped: false }],
      },
    };
    const markdown = vocabularyMarkdown(document, "opentide --json info vocab tlp");
    assert.ok(markdown.startsWith("# tlp: Traffic Light Protocol\n"));
    assert.ok(markdown.includes("`opentide --json info vocab tlp`"));
    assert.ok(markdown.includes("- **Entries:** 5"));
    assert.ok(markdown.includes("- **Staged:** no"));
    assert.ok(markdown.includes("## Stages\n\nNone."));
    assert.ok(markdown.includes("| Revision | Introduced | Removed |\n| --- | --- | --- |\n| 1.0 | 5 | 0 |"));
    assert.ok(markdown.includes("| rule::1.1 | metadata.tlp | no |"));
    assert.equal(vocabularyMarkdown({}, "x"), "");
    assert.equal(markdownTable([{ a: "x|y" }]), "| A |\n| --- |\n| x\\|y |");
  });

  it("lists vocabularies, unreviewed rules and explain codes from their documents", () => {
    assert.deepEqual(
      vocabularies({ vocabularies: [{ name: "tlp", title: "TLP", entries: 5 }, { title: "no name" }] }),
      [{ name: "tlp", title: "TLP", entries: 5 }],
    );
    assert.deepEqual(
      unreviewedRules({
        rules: [{ path: "objects/rules/a.yaml", reason: "absent", reviewed: null }, { nope: 1 }],
      }),
      [{ path: "objects/rules/a.yaml", reason: "absent", reviewed: null }],
    );
    assert.deepEqual(explainEntries({ codes: [{ code: "vocab_unknown", meaning: "m" }, { meaning: "x" }] }), [
      { code: "vocab_unknown", meaning: "m" },
    ]);
    assert.equal(explainMarkdown({ markdown: "# vocab_unknown\n" }), "# vocab_unknown\n");
    assert.equal(explainMarkdown({ code: "x", meaning: "Means x." }), "# x\n\nMeans x.\n");
  });

  it("finds the generated docs' first page", () => {
    assert.deepEqual(docsFolders(undefined), ["docs"]);
    assert.deepEqual(docsFolders({ output: "site/docs", outputs: ["docs", 3] }), ["site/docs", "docs"]);
    assert.equal(docsIndex(["rules/a.md", "index.md", "rules/index.md"]), "index.md");
    assert.equal(docsIndex(["rules/b.md", "rules/a.md", "x.txt"]), "rules/a.md");
    assert.equal(docsIndex(["README.md", "rules/a.md"]), "README.md");
    assert.equal(docsIndex([]), undefined);
  });
});
