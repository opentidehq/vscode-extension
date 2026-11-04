// The graph page's styles, added as a <style> with the page's nonce (the CSP allows no other inline
// style). Theme variables only; spacing on a 4/8 px grid; no size depends on the data, so nothing moves
// when it arrives.
export const CSS = `
html, body { height: 100%; }
body { padding: 0; overflow: hidden; }
#root { height: 100%; display: flex; flex-direction: column; }
.codicon { font-size: 16px; line-height: 16px; vertical-align: text-bottom; }

/* ---------------------------------------------------------------- toolbar */
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; padding: 4px 8px;
  border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border, transparent)); }
.toolbar .group { display: inline-flex; align-items: center; gap: 2px; }
.toolbar .group + .group { padding-left: 8px; border-left: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border, transparent)); }
.toolbar .spacer { flex: 1 1 auto; }
.icon-button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-width: 24px; height: 24px;
  padding: 0 4px; border: 1px solid transparent; border-radius: 4px; color: var(--vscode-icon-foreground, var(--vscode-foreground));
  background: transparent; cursor: pointer; }
.icon-button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
.icon-button[aria-pressed="true"] { background: var(--vscode-inputOption-activeBackground, var(--vscode-toolbar-activeBackground));
  border-color: var(--vscode-inputOption-activeBorder, transparent); color: var(--vscode-inputOption-activeForeground, inherit); }
.icon-button:disabled { opacity: 0.4; cursor: default; }
.icon-button .text { font-size: 12px; }
.segmented { display: inline-flex; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, transparent)); border-radius: 4px; overflow: hidden; }
.segmented button { height: 22px; padding: 0 8px; border: none; border-radius: 0; font-size: 12px;
  color: var(--vscode-foreground); background: transparent; }
.segmented button + button { border-left: 1px solid var(--vscode-input-border, var(--vscode-panel-border, transparent)); }
.segmented button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
.segmented button[aria-pressed="true"], .segmented button[aria-pressed="true"]:hover:not(:disabled) {
  color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
.toolbar select { height: 24px; padding: 0 4px; font-size: 12px; }
.target { display: inline-flex; align-items: center; gap: 4px; max-width: 26ch; height: 24px; padding: 0 4px 0 6px;
  border-radius: 4px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.target .follow-state { font-size: 11px; opacity: 0.85; text-transform: uppercase; letter-spacing: 0.04em; }
.target .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.target .icon-button { color: inherit; min-width: 20px; height: 20px; }
.search { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 4px;
  background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
.search:focus-within { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.search input { width: 14em; border: none; background: transparent; padding: 0; outline: none; font-size: 12px; }
.search .count { font-size: 11px; color: var(--vscode-descriptionForeground); min-width: 4ch; text-align: right; }
.badge { min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; font-size: 10px; line-height: 16px; text-align: center;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
details.menu { position: relative; }
details.menu > summary { list-style: none; }
details.menu > summary::-webkit-details-marker { display: none; }
details.menu > .popup { position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; min-width: 14em;
  padding: 8px; display: flex; flex-direction: column; gap: 4px;
  background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
  color: var(--vscode-menu-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-menu-border, var(--vscode-editorWidget-border, var(--vscode-contrastBorder, transparent)));
  border-radius: 4px; box-shadow: 0 2px 8px var(--vscode-widget-shadow, transparent); }
details.menu.right > .popup { left: auto; right: 0; }
.popup label { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.popup .heading { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); margin-top: 4px; }
.popup button.item { text-align: left; border: none; border-radius: 2px; padding: 4px 8px; color: inherit; background: transparent; }
.popup button.item:hover, .popup button.item:focus { background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
  color: var(--vscode-menu-selectionForeground, inherit); outline: none; }

/* ---------------------------------------------------------------- progress and status */
.progress { position: relative; height: 2px; overflow: hidden; }
.progress.active::after { content: ""; position: absolute; top: 0; bottom: 0; width: 30%; left: -30%;
  background: var(--vscode-progressBar-background); animation: progress 1.2s linear infinite; }
@keyframes progress { to { left: 100%; } }
.status { display: flex; gap: 8px; align-items: center; height: 22px; padding: 0 8px; font-size: 12px; overflow: hidden; white-space: nowrap;
  color: var(--vscode-descriptionForeground); }
.status .warning { color: var(--vscode-editorWarning-foreground); overflow: hidden; text-overflow: ellipsis; }

/* ---------------------------------------------------------------- body: canvas | splitter | details */
.body { flex: 1 1 auto; min-height: 0; display: flex; }
.main { position: relative; flex: 1 1 auto; min-width: 0; }
#canvas { position: absolute; inset: 0; }
#canvas:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.splitter { flex: 0 0 4px; cursor: col-resize; background: transparent;
  border-left: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border, transparent)); }
.splitter:hover, .splitter:focus-visible, .splitter.dragging { background: var(--vscode-sash-hoverBorder, var(--vscode-focusBorder)); outline: none; }
.details { flex: 0 0 auto; min-width: 200px; max-width: 70%; overflow: auto; padding: 8px 12px 16px;
  background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
.details header { display: grid; grid-template-columns: 20px 1fr auto; gap: 2px 8px; align-items: start; }
.details header .codicon { margin-top: 2px; }
.details h2 { margin: 0; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.details .kind { grid-column: 2; font-size: 11px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.04em; }
.details .meta { margin: 8px 0 0; display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; font-size: 12px; }
.details .meta dt { color: var(--vscode-descriptionForeground); }
.details .meta dd { margin: 0; overflow-wrap: anywhere; }
.details .chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { display: inline-flex; align-items: center; gap: 4px; padding: 0 6px; border-radius: 9px; font-size: 11px; line-height: 18px;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, transparent)); }
.chip.off { opacity: 0.6; }
.details .actions { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0; }
.details .actions button { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; font-size: 12px; }
.details section { margin-top: 12px; }
.details h3 { margin: 0 0 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
  display: flex; align-items: center; gap: 6px; color: var(--vscode-descriptionForeground); }
.details h3 .swatch { width: 12px; height: 3px; border-radius: 2px; }
.details h4 { margin: 8px 0 2px; font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.details ul { list-style: none; margin: 0; padding: 0; }
.details li a { display: flex; align-items: center; gap: 6px; padding: 2px 4px 2px 22px; border-radius: 2px; text-decoration: none;
  color: var(--vscode-textLink-foreground); white-space: nowrap; overflow: hidden; }
.details li a .label { overflow: hidden; text-overflow: ellipsis; }
.details li a .note { color: var(--vscode-descriptionForeground); font-size: 11px; }
.details li a:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-textLink-activeForeground); }
.details li a:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.details li a.missing { color: var(--vscode-errorForeground); border: 1px dashed var(--vscode-errorForeground); }
.details li a.hidden-node .label::after { content: " (not drawn)"; color: var(--vscode-descriptionForeground); }
.details .empty { color: var(--vscode-descriptionForeground); margin: 16px 0; }
.details .none { color: var(--vscode-descriptionForeground); font-size: 12px; padding-left: 22px; }
.out-color { color: var(--vscode-charts-orange); }
.in-color { color: var(--vscode-charts-blue); }
.swatch.out { background: var(--vscode-charts-orange); }
.swatch.in { background: var(--vscode-charts-blue); }
.skeleton { display: block; height: 10px; margin: 8px 0; border-radius: 4px; background: var(--vscode-editorWidget-background, var(--vscode-input-background)); }
.skeleton.short { width: 40%; }
.skeleton.mid { width: 70%; }

/* ---------------------------------------------------------------- list */
#list { position: absolute; inset: 0; overflow: auto; padding: 4px 8px; margin: 0; }
#list ul { list-style: none; margin: 0; padding-left: 16px; }
#list, #list ul { list-style: none; }
#list [role="treeitem"] > .row { display: flex; gap: 6px; align-items: center; padding: 1px 4px; border-radius: 2px; cursor: default; white-space: nowrap; }
#list [role="treeitem"]:focus { outline: none; }
#list [role="treeitem"]:focus > .row { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px;
  background: var(--vscode-list-focusBackground, transparent); color: var(--vscode-list-focusForeground, inherit); }
#list [role="treeitem"][aria-selected="true"] > .row { background: var(--vscode-list-inactiveSelectionBackground); }
#list .twisty { display: inline-block; width: 16px; text-align: center; color: var(--vscode-descriptionForeground); }
#list .desc { color: var(--vscode-descriptionForeground); font-size: 0.92em; overflow: hidden; text-overflow: ellipsis; }
#list .problem { color: var(--vscode-errorForeground); }
#list .missing { color: var(--vscode-errorForeground); }

/* ---------------------------------------------------------------- states, legend, overlays */
.state { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; padding: 24px; text-align: center; }
.state p { max-width: 42em; margin: 0; }
.state .actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.state .codicon { font-size: 32px; line-height: 32px; color: var(--vscode-descriptionForeground); }
.state.skeleton-state { align-items: stretch; justify-content: center; }
.skeleton-graph { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px 48px; max-width: 520px; margin: 0 auto; width: 100%; }
.skeleton-graph span { height: 28px; border-radius: 14px; background: var(--vscode-editorWidget-background, var(--vscode-input-background)); opacity: 0.8; }
.legend { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; padding: 4px 8px; font-size: 11px; min-height: 24px;
  border-top: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border, transparent)); color: var(--vscode-descriptionForeground); }
.legend span.entry { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.legend .codicon { font-size: 14px; line-height: 14px; }
.legend .line { display: inline-block; width: 16px; height: 2px; position: relative; }
.legend .line.out { background: var(--vscode-charts-orange); }
.legend .line.in { background: var(--vscode-charts-blue); }
.legend .line.missing { height: 0; border-top: 2px dashed var(--vscode-errorForeground); }
.legend .sep { width: 1px; height: 12px; background: var(--vscode-panel-border, var(--vscode-descriptionForeground)); }
.legend .error { color: var(--vscode-errorForeground); }
.tooltip, .context-menu { position: absolute; z-index: 30; max-width: 28em; padding: 6px 8px; border-radius: 4px;
  background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background));
  color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-editorWidget-border, var(--vscode-contrastBorder, transparent))); pointer-events: none; }
.tooltip .title { font-weight: 600; }
.tooltip .row { color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
.context-menu { pointer-events: auto; padding: 4px 0; display: flex; flex-direction: column;
  background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
  color: var(--vscode-menu-foreground, var(--vscode-foreground));
  border-color: var(--vscode-menu-border, var(--vscode-editorWidget-border, var(--vscode-contrastBorder, transparent))); }
.context-menu button { text-align: left; border: none; border-radius: 0; padding: 4px 16px; color: inherit; background: transparent; }
.context-menu button:hover, .context-menu button:focus { color: var(--vscode-menu-selectionForeground, inherit);
  background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground)); outline: none; }
.context-menu hr { border: none; border-top: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-panel-border, transparent)); margin: 4px 0; }
.node-tools { position: absolute; z-index: 25; display: flex; gap: 2px; padding: 2px; border-radius: 4px;
  background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-contrastBorder, transparent));
  box-shadow: 0 1px 4px var(--vscode-widget-shadow, transparent); }
.node-tools .icon-button { min-width: 22px; height: 22px; }
.mono { font-family: var(--vscode-editor-font-family); font-size: 12px; }
[hidden] { display: none !important; }
@media (prefers-reduced-motion: reduce) { .progress.active::after { animation: none; left: 0; width: 100%; opacity: 0.6; } }
`;
