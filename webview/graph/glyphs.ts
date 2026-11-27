// The codicons drawn inside graph nodes, as SVG images in the node kind's contrast colour. Cytoscape
// draws on a canvas, so it gets images, not the codicon font. The SVGs come from @vscode/codicons.
import bell from "@vscode/codicons/src/icons/bell.svg";
import bug from "@vscode/codicons/src/icons/bug.svg";
import database from "@vscode/codicons/src/icons/database.svg";
import person from "@vscode/codicons/src/icons/person.svg";
import pulse from "@vscode/codicons/src/icons/pulse.svg";
import serverEnvironment from "@vscode/codicons/src/icons/server-environment.svg";
import symbolEvent from "@vscode/codicons/src/icons/symbol-event.svg";
import target from "@vscode/codicons/src/icons/target.svg";
import warning from "@vscode/codicons/src/icons/warning.svg";

const SVGS: Readonly<Record<string, string>> = {
  bell,
  bug,
  database,
  person,
  pulse,
  "server-environment": serverEnvironment,
  "symbol-event": symbolEvent,
  target,
  warning,
};

/** A data: URI of the codicon `name` filled with `color`, or undefined for an icon not bundled here. */
export function glyphUri(name: string, color: string): string | undefined {
  const svg = SVGS[name];
  if (!svg) return undefined;
  const filled = svg.replaceAll("currentColor", color);
  return `data:image/svg+xml;utf8,${encodeURIComponent(filled)}`;
}
