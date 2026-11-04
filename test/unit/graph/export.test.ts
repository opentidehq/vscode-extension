import * as assert from "node:assert/strict";
import {
  type ExportPalette,
  escapeXml,
  mermaidIdentifier,
  mermaidLabel,
  toMermaid,
  toSvg,
  truncate,
} from "../../../src/features/graph/export";
import { layout } from "../../../src/features/graph/layout";
import { ALL_KINDS, buildModel, type NodeKind } from "../../../src/features/graph/model";
import { document, object, sampleCatalog, UUID } from "../catalogFixture";

const palette: ExportPalette = {
  background: "rgb(30, 30, 30)",
  foreground: "rgb(204, 204, 204)",
  edge: "rgb(133, 133, 133)",
  error: "rgb(241, 76, 76)",
  font: '"Segoe UI", sans-serif',
  kinds: Object.fromEntries(
    ALL_KINDS.map((kind) => [kind, `rgb(1, 2, ${ALL_KINDS.indexOf(kind)})`]),
  ) as Record<NodeKind, string>,
};

describe("graph export", () => {
  const model = buildModel(sampleCatalog());
  const positions = layout(model.nodes, model.edges);

  it("writes a self-contained SVG with every node, a dashed dangling edge and error outlines", () => {
    const svg = toSvg(
      { nodes: model.nodes, edges: model.edges, positions, errors: new Set([UUID.comsvcs]) },
      palette,
      "opentide graph: ws",
    );
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[-\d. ]+"/);
    assert.match(svg, /<title>opentide graph: ws<\/title>/);
    assert.equal((svg.match(/<g>/g) ?? []).length, model.nodes.length);
    assert.match(svg, /stroke="rgb\(241, 76, 76\)" stroke-width="1\.2" stroke-dasharray="5 4"/);
    assert.match(svg, />✗ LSASS dump via comsvcs</);
    assert.match(svg, /font-family="&quot;Segoe UI&quot;, sans-serif"/);
    assert.ok(!/<script/i.test(svg));
  });

  it("escapes names in SVG", () => {
    const catalog = document([object({ uuid: "r", type: "rule", name: 'a <b> & "c"' })], []);
    const built = buildModel(catalog);
    const svg = toSvg(
      { nodes: built.nodes, edges: [], positions: layout(built.nodes, []), errors: new Set() },
      palette,
      "t",
    );
    assert.match(svg, />a &lt;b&gt; &amp; &quot;c&quot;</);
    assert.equal(escapeXml("'"), "&apos;");
    assert.equal(truncate("abcdef", 4), "abc…");
    assert.equal(truncate("abc", 4), "abc");
  });

  it("writes Mermaid as opentide's docs do: sanitised ids and labels, shapes per kind", () => {
    const mermaid = toMermaid(model.nodes, model.edges);
    const lines = mermaid.trim().split("\n");
    assert.equal(lines[0], "flowchart LR");
    assert.ok(lines.includes(`threat_${mermaidIdentifier(UUID.threat)}{{"Credential Dumping"}}`));
    assert.ok(lines.includes(`objective_${mermaidIdentifier(UUID.objective)}(["Detect LSASS access"])`));
    assert.ok(
      lines.some((line) => line.includes(`-->|Implements| objective_${mermaidIdentifier(UUID.objective)}`)),
    );
    assert.ok(
      lines.some((line) => line.includes("-.->|Implements| missing_")),
      "a dangling edge is dotted",
    );
    assert.ok(lines.includes("classDef missing stroke-dasharray: 5 5"));
    assert.ok(lines.some((line) => line.includes("preceeds|")));
  });

  it("keeps Mermaid identifiers unique and labels free of syntax", () => {
    assert.equal(mermaidIdentifier("technique:T1003.001"), "technique_T1003_001");
    assert.equal(mermaidIdentifier("::"), "node");
    assert.equal(mermaidLabel('Run [x] "now" | (please)'), "Run x 'now' please");
    assert.equal(mermaidLabel("one two three four five six seven"), "one two three four five<br>six seven");
    const catalog = document(
      [object({ uuid: "a-b", type: "rule", name: "A" }), object({ uuid: "a_b", type: "rule", name: "B" })],
      [],
    );
    const built = buildModel(catalog);
    const ids = toMermaid(built.nodes, [])
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.split("[")[0]);
    assert.equal(new Set(ids).size, 2);
  });
});
