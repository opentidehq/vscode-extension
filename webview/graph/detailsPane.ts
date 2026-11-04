// The details pane's DOM, from the vscode-free NodeDetails (src/features/graph/details.ts). main.ts
// handles its events: a related item's click selects it, a double-click or Enter opens its file.
import type { DetailGroup, NodeDetails } from "../../src/features/graph/details";
import type { NodeProblems } from "../../src/features/graph/model";
import { NODE_ICONS, themeVar } from "../../src/features/graph/words";
import { h, icon } from "./dom";

export interface PaneContext {
  /** Whether the node is drawn on the canvas now. */
  readonly drawn: (id: string) => boolean;
  readonly problems: NodeProblems | undefined;
  /** Commands the pane may offer. */
  readonly canOpen: boolean;
  readonly canFocus: boolean;
  /** The sidebar's Relations view is there (opentide.relations.show) and the node is an object. */
  readonly canShowRelations: boolean;
  /** Why the node is not drawn (a filtered-out kind), when it is not. */
  readonly hiddenBy?: string;
}

function coloured(name: string, themeColor: string): HTMLSpanElement {
  const glyph = icon(name);
  glyph.style.color = `var(${themeVar(themeColor)})`;
  return glyph;
}

function group(details: NodeDetails, entry: DetailGroup, context: PaneContext): HTMLElement {
  const list = h("ul", { role: "list" });
  for (const item of entry.items) {
    const visual = NODE_ICONS[item.missing ? "missing" : item.kind];
    const drawn = context.drawn(item.id);
    const link = h(
      "a",
      {
        href: "#",
        "data-id": item.id,
        class: [item.missing ? "missing" : "", drawn ? "" : "hidden-node"].filter(Boolean).join(" "),
        title: item.missing
          ? `Missing: no object has the UUID ${item.label}`
          : `${item.label}. Click to select, double-click or Enter to open.`,
        "aria-label": `${item.missing ? "missing reference " : ""}${item.label}`,
      },
      coloured(visual.codicon, visual.themeColor),
      h("span", { class: "label", text: item.label }),
    );
    list.append(h("li", {}, link));
  }
  return h(
    "div",
    { class: "relation", "data-node": details.node.id },
    h("h4", {}, icon(entry.icon, entry.direction === "out" ? "out-color" : "in-color"), entry.header),
    list,
  );
}

function section(
  title: string,
  direction: "out" | "in",
  groups: readonly DetailGroup[],
  details: NodeDetails,
  context: PaneContext,
): HTMLElement {
  const count = groups.reduce((sum, entry) => sum + entry.items.length, 0);
  return h(
    "section",
    { "aria-label": `${title}: ${count}` },
    h("h3", {}, h("span", { class: `swatch ${direction}`, "aria-hidden": "true" }), `${title} · ${count}`),
    ...(groups.length > 0
      ? groups.map((entry) => group(details, entry, context))
      : [
          h("p", {
            class: "none",
            text: direction === "out" ? "Points to nothing." : "Nothing points here.",
          }),
        ]),
  );
}

/** The pane for `details`, or the empty state when no node is selected. */
export function paneContent(details: NodeDetails | undefined, context: PaneContext): HTMLElement[] {
  if (!details) {
    return [
      h(
        "p",
        { class: "empty" },
        "Select a node to see what it points to (→ outgoing) and what points to it (← incoming).",
      ),
    ];
  }
  const { node } = details;
  const meta = h("dl", { class: "meta" });
  const row = (term: string, value: Node | string): void => {
    meta.append(h("dt", { text: term }), h("dd", {}, value));
  };
  if (node.path) row("Path", h("span", { class: "mono", text: node.path }));
  if (node.uuid) row("UUID", h("span", { class: "mono", text: node.uuid }));
  if (node.platforms.length > 0) {
    row(
      "Platforms",
      h(
        "span",
        { class: "chips" },
        ...node.platforms.map((platform) =>
          h("span", {
            class: `chip${platform.enabled ? "" : " off"}`,
            text: platform.status ? `${platform.id} · ${platform.status}` : platform.id,
            title: platform.enabled ? platform.id : `${platform.id} (disabled)`,
          }),
        ),
      ),
    );
  }
  if (node.kind !== "technique" && node.techniques.length > 0) row("Techniques", node.techniques.join(", "));
  const problems = context.problems;
  if (node.loadError) row("Load error", h("span", { class: "error", text: node.loadError }));
  if (problems && problems.errors + problems.warnings > 0)
    row(
      "Problems",
      h("span", {
        class: problems.errors ? "error" : "warning",
        text: [
          problems.errors ? `${problems.errors} error${problems.errors === 1 ? "" : "s"}` : "",
          problems.warnings ? `${problems.warnings} warning${problems.warnings === 1 ? "" : "s"}` : "",
        ]
          .filter(Boolean)
          .join(", "),
      }),
    );
  if (node.kind === "missing") row("Missing", "No object has this UUID: the references to it dangle.");
  if (context.hiddenBy) row("Not drawn", context.hiddenBy);
  const button = (name: string, text: string, action: string, primary = false): HTMLButtonElement =>
    h(
      "button",
      { type: "button", "data-action": action, ...(primary ? {} : { class: "secondary" }) },
      icon(name),
      text,
    );
  const actions = h(
    "div",
    { class: "actions", role: "group", "aria-label": "Actions" },
    context.canOpen ? button("go-to-file", "Open file", "open", true) : undefined,
    context.canFocus ? button("location", "Focus here", "focus") : undefined,
    context.canShowRelations ? button("references", "Show Relations", "relations") : undefined,
    node.uuid ? button("copy", "Copy UUID", "copyUuid") : undefined,
  );
  return [
    h(
      "header",
      {},
      coloured(details.icon, details.themeColor),
      h("h2", { text: node.label, title: node.label, tabindex: "-1" }),
      h("span", {}),
      h("span", { class: "kind", text: details.kindLabel }),
    ),
    meta,
    actions,
    section("Outgoing", "out", details.outgoing, details, context),
    section("Incoming", "in", details.incoming, details, context),
  ];
}

/** The pane while the catalogue loads: grey lines where the text will be. */
export function paneSkeleton(): HTMLElement[] {
  return [
    h("span", { class: "skeleton mid" }),
    h("span", { class: "skeleton short" }),
    h("span", { class: "skeleton" }),
    h("span", { class: "skeleton mid" }),
    h("span", { class: "skeleton short" }),
  ];
}
