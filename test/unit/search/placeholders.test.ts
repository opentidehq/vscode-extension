import * as assert from "node:assert/strict";
import { search } from "../../../src/features/search/match";
import {
  asksPlaceholders,
  countPlaceholders,
  PlaceholderCounts,
} from "../../../src/features/search/placeholders";
import { parseQuery } from "../../../src/features/search/query";
import { buildIndex } from "../../../src/features/search/searchIndex";
import { ROOT, sampleCatalog, UUID } from "../catalogFixture";

const DRAFT = [
  "name: Suspicious LSASS Access",
  "description: Describe what this rule detects # opentide:placeholder",
  "# author: someone # opentide:placeholder",
  "  query: SecurityEvent # opentide:placeholder",
  "",
].join("\n");

describe("search: has:placeholders from the files (#48)", () => {
  it("counts the marker lines the editor counts, commented-out keys aside", () => {
    assert.equal(countPlaceholders(DRAFT), 2);
    assert.equal(countPlaceholders("name: done\r\n"), 0);
  });

  it("reads a file once per version, and an open editor's text first", () => {
    const reads: string[] = [];
    let stamp = "1";
    let open: string | undefined;
    const counts = new PlaceholderCounts({
      openText: () => open,
      stamp: () => stamp,
      read: (file) => {
        reads.push(file);
        return DRAFT;
      },
    });
    assert.equal(counts.count("/ws/a.yaml"), 2);
    assert.equal(counts.count("/ws/a.yaml"), 2);
    assert.deepEqual(reads, ["/ws/a.yaml"]);
    stamp = "2";
    counts.count("/ws/a.yaml");
    assert.equal(reads.length, 2, "read again once it changed");
    open = "name: x\n";
    assert.equal(counts.count("/ws/a.yaml"), 0, "the unsaved editor wins");
  });

  it("finds a placeholder draft no lint has run on", () => {
    const index = buildIndex([
      { folder: ROOT, status: "ready", catalog: sampleCatalog(), refreshing: false },
    ]);
    const draft = index.items.find((item) => item.id === UUID.comsvcs);
    assert.ok(draft?.filePath);
    const counts = new PlaceholderCounts({
      openText: () => undefined,
      stamp: () => "1",
      read: (file) => (file === draft.filePath ? DRAFT : "name: x\n"),
    });
    const query = parseQuery("has:placeholders");
    assert.ok(asksPlaceholders(query.filters));
    assert.ok(!asksPlaceholders(parseQuery("has:errors").filters));
    const outcome = search(index, query, {
      now: Date.now(),
      problems: (item) =>
        item.filePath ? { errors: 0, warnings: 0, placeholders: counts.count(item.filePath) } : undefined,
    });
    assert.deepEqual(
      outcome.results.map((result) => result.item.id),
      [UUID.comsvcs],
    );
  });
});
