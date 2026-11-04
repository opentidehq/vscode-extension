// The graph page's styles, added as a <style> with the page's nonce (the CSP allows no other inline
// style). Theme variables only.
export const CSS = `
html, body { height: 100%; }
body { padding: 0; overflow: hidden; }
#root { height: 100%; display: flex; flex-direction: column; }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 12px;
  border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border)); }
.toolbar label { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.toolbar .group { display: inline-flex; align-items: center; gap: 4px; }
.toolbar .spacer { flex: 1 1 auto; }
.toolbar button { padding: 2px 8px; }
.toolbar input[type="search"] { width: 14em; }
details.menu { position: relative; }
details.menu > summary { list-style: none; cursor: pointer; padding: 2px 8px; border-radius: 2px;
  color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
details.menu > summary::-webkit-details-marker { display: none; }
details.menu > .popup { position: absolute; z-index: 20; top: calc(100% + 2px); left: 0; min-width: 12em;
  padding: 6px; display: flex; flex-direction: column; gap: 4px;
  background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
  color: var(--vscode-menu-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-menu-border, var(--vscode-editorWidget-border)); }
details.menu.right > .popup { left: auto; right: 0; }
.status { padding: 3px 12px; min-height: 1.4em; color: var(--vscode-descriptionForeground);
  border-bottom: 1px solid var(--vscode-panel-border, transparent); }
.status .warning { color: var(--vscode-editorWarning-foreground); }
.main { position: relative; flex: 1 1 auto; min-height: 0; }
#canvas { position: absolute; inset: 0; }
#canvas:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
#list { position: absolute; inset: 0; overflow: auto; padding: 6px 12px; margin: 0; }
#list ul { list-style: none; margin: 0; padding-left: 16px; }
#list > li { padding-left: 0; }
#list, #list ul { list-style: none; }
#list [role="treeitem"] > .row { display: flex; gap: 8px; align-items: baseline; padding: 1px 4px; border-radius: 2px; cursor: default; }
#list [role="treeitem"]:focus { outline: none; }
#list [role="treeitem"]:focus > .row { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px;
  background: var(--vscode-list-focusBackground, transparent); color: var(--vscode-list-focusForeground, inherit); }
#list [role="treeitem"][aria-selected="true"] > .row { background: var(--vscode-list-inactiveSelectionBackground); }
#list .twisty { display: inline-block; width: 1em; text-align: center; color: var(--vscode-descriptionForeground); }
#list .desc { color: var(--vscode-descriptionForeground); font-size: 0.92em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#list .problem { color: var(--vscode-errorForeground); }
.state { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; padding: 24px; text-align: center; }
.state p { max-width: 42em; margin: 0; }
.state .actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; padding: 4px 12px; font-size: 0.92em;
  border-top: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border)); color: var(--vscode-descriptionForeground); }
.legend .glyph { display: inline-block; width: 1.2em; text-align: center; }
.legend .error { color: var(--vscode-errorForeground); }
.kind-threat { color: var(--vscode-charts-red); }
.kind-objective { color: var(--vscode-charts-blue); }
.kind-signal { color: var(--vscode-charts-purple); }
.kind-rule { color: var(--vscode-charts-green); }
.kind-technique { color: var(--vscode-charts-orange); }
.kind-actor { color: var(--vscode-charts-yellow); }
.kind-logsource { color: var(--vscode-terminal-ansiCyan, var(--vscode-charts-blue)); }
.kind-platform { color: var(--vscode-descriptionForeground); }
.kind-missing { color: var(--vscode-errorForeground); }
.tooltip, .context-menu { position: absolute; z-index: 30; max-width: 28em; padding: 6px 8px;
  background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background));
  color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-editorWidget-border)); pointer-events: none; }
.tooltip .title { font-weight: 600; }
.tooltip .row { color: var(--vscode-descriptionForeground); word-break: break-all; }
.context-menu { pointer-events: auto; padding: 4px 0; display: flex; flex-direction: column;
  background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
  color: var(--vscode-menu-foreground, var(--vscode-foreground));
  border-color: var(--vscode-menu-border, var(--vscode-editorWidget-border)); }
.context-menu button { text-align: left; border: none; border-radius: 0; padding: 3px 14px; color: inherit; background: transparent; }
.context-menu button:hover, .context-menu button:focus { color: var(--vscode-menu-selectionForeground, inherit);
  background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground)); outline: none; }
[hidden] { display: none !important; }
`;
