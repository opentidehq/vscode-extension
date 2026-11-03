// Exports of the drawn graph: SVG (from the laid-out positions) and Mermaid (the flowchart syntax
// opentide's generated docs use, documentation/diagram/). vscode-free and DOM-free.

import { bounds, type Point } from "./layout";
import { edgeLabel, type GraphEdge, type GraphNode, type NodeKind } from "./model";

/** One shape per kind, so colour is never the only signal (SPEC §14). Cytoscape names. */
export const KIND_SHAPES: Readonly<Record<NodeKind, string>> = {
  threat: "diamond",
  objective: "ellipse",
  signal: "triangle",
  rule: "round-rectangle",
  technique: "rectangle",
  actor: "hexagon",
  logsource: "barrel",
  platform: "octagon",
  missing: "rectangle",
};

export interface ExportPalette {
  readonly background: string;
  readonly foreground: string;
  readonly edge: string;
  readonly error: string;
  readonly font: string;
  readonly kinds: Readonly<Record<NodeKind, string>>;
}

export interface ExportGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly positions: ReadonlyMap<string, Point>;
  /** Nodes drawn with the error outline. */
  readonly errors: ReadonlySet<string>;
}

const SIZE = 22;
const R = SIZE / 2;

export function escapeXml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] ?? c,
  );
}

const fmt = (value: number): string => String(Math.round(value * 10) / 10);

function polygon(cx: number, cy: number, sides: number, rotation: number): string {
  const points: string[] = [];
  for (let i = 0; i < sides; i += 1) {
    const angle = rotation + (2 * Math.PI * i) / sides;
    points.push(`${fmt(cx + R * Math.cos(angle))},${fmt(cy + R * Math.sin(angle))}`);
  }
  return points.join(" ");
}

function shape(kind: NodeKind, cx: number, cy: number, attributes: string): string {
  switch (KIND_SHAPES[kind]) {
    case "ellipse":
      return `<ellipse cx="${fmt(cx)}" cy="${fmt(cy)}" rx="${R}" ry="${R}" ${attributes}/>`;
    case "diamond":
      return `<polygon points="${polygon(cx, cy, 4, 0)}" ${attributes}/>`;
    case "triangle":
      return `<polygon points="${polygon(cx, cy, 3, -Math.PI / 2)}" ${attributes}/>`;
    case "hexagon":
      return `<polygon points="${polygon(cx, cy, 6, 0)}" ${attributes}/>`;
    case "octagon":
      return `<polygon points="${polygon(cx, cy, 8, Math.PI / 8)}" ${attributes}/>`;
    case "round-rectangle":
    case "barrel":
      return `<rect x="${fmt(cx - R)}" y="${fmt(cy - R)}" width="${SIZE}" height="${SIZE}" rx="5" ${attributes}/>`;
    default:
      return `<rect x="${fmt(cx - R)}" y="${fmt(cy - R)}" width="${SIZE}" height="${SIZE}" ${attributes}/>`;
  }
}

/** A self-contained SVG of the graph as laid out, in the given (theme) colours. */
export function toSvg(graph: ExportGraph, palette: ExportPalette, title: string): string {
  const box = bounds(graph.positions.values());
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(box.x)} ${fmt(box.y)} ${fmt(box.width)} ${fmt(box.height)}" width="${fmt(box.width)}" height="${fmt(box.height)}" font-family="${escapeXml(palette.font)}" font-size="11">`,
    `<title>${escapeXml(title)}</title>`,
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${escapeXml(palette.edge)}"/></marker></defs>`,
    `<rect x="${fmt(box.x)}" y="${fmt(box.y)}" width="${fmt(box.width)}" height="${fmt(box.height)}" fill="${escapeXml(palette.background)}"/>`,
  ];
  for (const edge of graph.edges) {
    const from = graph.positions.get(edge.source);
    const to = graph.positions.get(edge.target);
    if (!from || !to) continue;
    const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const ux = (to.x - from.x) / length;
    const uy = (to.y - from.y) / length;
    const dash = edge.missing ? ` stroke-dasharray="5 4"` : "";
    const stroke = edge.missing ? palette.error : palette.edge;
    parts.push(
      `<line x1="${fmt(from.x + ux * R)}" y1="${fmt(from.y + uy * R)}" x2="${fmt(to.x - ux * (R + 2))}" y2="${fmt(to.y - uy * (R + 2))}" stroke="${escapeXml(stroke)}" stroke-width="1.2"${dash} marker-end="url(#arrow)"><title>${escapeXml(edgeLabel(edge))}</title></line>`,
    );
  }
  for (const node of graph.nodes) {
    const at = graph.positions.get(node.id);
    if (!at) continue;
    const error = graph.errors.has(node.id);
    const missing = node.kind === "missing";
    const stroke = error || missing ? palette.error : palette.foreground;
    const attributes = `fill="${escapeXml(missing ? palette.background : palette.kinds[node.kind])}" stroke="${escapeXml(stroke)}" stroke-width="${error ? 2.5 : 1}"${missing ? ` stroke-dasharray="4 3"` : ""}`;
    const label = `${error ? "✗ " : ""}${node.label}`;
    parts.push(
      `<g><title>${escapeXml(`${node.kind}: ${node.label}${node.uuid ? ` (${node.uuid})` : ""}`)}</title>${shape(node.kind, at.x, at.y, attributes)}<text x="${fmt(at.x)}" y="${fmt(at.y + R + 12)}" text-anchor="middle" fill="${escapeXml(palette.foreground)}">${escapeXml(truncate(label, 30))}</text></g>`,
    );
  }
  parts.push("</svg>");
  return `${parts.join("\n")}\n`;
}

export function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

// Mermaid, as opentide's documentation/diagram/sanitize.py and graph.py write it.

export function mermaidIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "node";
}

export function mermaidLabel(value: string, limit = 24): string {
  const cleaned =
    value
      .replace(/[()[\]{}|]/g, "")
      .replaceAll('"', "'")
      .replaceAll("\n", " ")
      .trim() || "node";
  const words = cleaned.split(/\s+/);
  const lines: string[] = [];
  let current = words[0] ?? "";
  for (const word of words.slice(1)) {
    const candidate = `${current} ${word}`;
    if (candidate.length <= limit) current = candidate;
    else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines.join("<br>");
}

const MERMAID_SHAPES: Readonly<Record<NodeKind, (label: string) => string>> = {
  threat: (label) => `{{"${label}"}}`,
  objective: (label) => `(["${label}"])`,
  signal: (label) => `>"${label}"]`,
  rule: (label) => `["${label}"]`,
  technique: (label) => `[/"${label}"/]`,
  actor: (label) => `(("${label}"))`,
  logsource: (label) => `[("${label}")]`,
  platform: (label) => `[["${label}"]]`,
  missing: (label) => `["${label}"]:::missing`,
};

/** A Mermaid flowchart of the nodes and edges (left to right). Identifiers stay unique. */
export function toMermaid(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string {
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const node of nodes) {
    const base = mermaidIdentifier(`${node.kind}_${node.uuid ?? node.id}`);
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}_${n}`;
    used.add(id);
    ids.set(node.id, id);
  }
  const lines = ["flowchart LR"];
  for (const node of nodes) {
    const label = node.kind === "missing" ? `missing ${node.label}` : node.label;
    lines.push(`${ids.get(node.id)}${MERMAID_SHAPES[node.kind](mermaidLabel(label))}`);
  }
  for (const edge of edges) {
    const source = ids.get(edge.source);
    const target = ids.get(edge.target);
    if (!source || !target) continue;
    const arrow = edge.missing ? "-.->" : "-->";
    lines.push(`${source} ${arrow}|${mermaidLabel(edgeLabel(edge), 18)}| ${target}`);
  }
  if (nodes.some((node) => node.kind === "missing")) lines.push("classDef missing stroke-dasharray: 5 5");
  return `${lines.join("\n")}\n`;
}
