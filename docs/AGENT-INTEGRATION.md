# Agent integration: what each editor gets

How an IDE agent reaches opentide through MCP with no opentide installed, as long as the extension is. The
design is [SPEC §12](SPEC.md#12-agents); the bridge's contract is [CONTRACTS.md](CONTRACTS.md#the-mcp-bridge).
This page is the per-editor matrix: the mechanism, what has been **verified** (run, by a test or by hand) and
what is **assumed** (from the maintainers' research of 2026-11-21 or from documentation, not run), and the
manual check to run before a release.

**Sources** (fetched by the maintainers on 2026-11-21; not re-fetched here):

- **VS Code:** `vscode.d.ts` (a Node-based MCP server may use `process.execPath` to run its script in the editor's own Node; `ELECTRON_RUN_AS_NODE=1` is undocumented but implied). Forwarding to the Copilot harness: <https://code.visualstudio.com/api/extension-guides/ai/mcp> ("forwarding rejects configurations that require" input or command variables).
- **MCP 2026-07-28 stdio transport:** <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md> (a server must not write requests of its own to stdout).
- **Cursor:** the extension API, <https://cursor.com/docs/context/mcp-extension-api> (`vscode.cursor.mcp.registerServer`); the "0 tools" bug, <https://forum.cursor.com/t/cursor-ide-mcp-server-provided-by-extension-displays-0-tools/169322>. Cursor reports VS Code extension API 1.128.0.
- **Kiro:** Code OSS base and Open VSX, <https://kiro.dev/docs/upgrade-guides/migrating-from-vscode/>; MCP configuration, <https://kiro.dev/docs/mcp/configuration/> (user `~/.kiro/settings/mcp.json`, workspace `.kiro/settings/mcp.json`, the workspace wins; `mcpServers` with `command`, `args`, `env`, `disabled`, `autoApprove`, `disabledTools`); Powers, <https://kiro.dev/docs/powers/>. Kiro's documentation says nothing about extension MCP APIs.
- **Devin Desktop** (formerly Windsurf, renamed 2026-06-02): the rename, <https://docs.devin.ai/desktop/devin-desktop-faq>; configuration, <https://docs.devin.ai/desktop/cascade/mcp> and <https://docs.devin.ai/cli/extensibility/mcp/configuration.md> (user `~/.config/devin/mcp_config.json`, `%APPDATA%\devin\mcp_config.json` on Windows, workspace `.devin/mcp_config.json`, `mcpServers`).

**Open: Windsurf's path.** The Devin FAQ still mentions the old `~/.codeium/mcp_config.json`, while the writer uses `~/.codeium/windsurf/mcp_config.json` for builds that still call themselves Windsurf (from the first brief). The two disagree and neither is verified here; the writer takes the second, and only for an `appName` that says Windsurf. Check on a Windsurf build before relying on it.

## The shared core

| | |
|-|-|
| Command | the editor's own binary: `process.execPath`, `ELECTRON_RUN_AS_NODE=1` |
| Script | `dist/mcp-wasi.js` in the extension: runs the module's `mcp start` in a child process and pipes MCP stdio through |
| Tenant tools | the bridge answers the module's `opentide/fetch` (`OPENTIDE_FETCH=stdio`, opentide's side in progress) with FetchHost; nothing but valid MCP reaches the editor |
| Native first | a native opentide (tiers 1–3) wins unless `opentide.mcp.useBundled` is on |
| Restricted Mode | off |
| Verified | the bridge against the real module (`initialize`, `tools/list`), and against a scripted module with `server/discover`, legacy `initialize`, a fetch-delegated tool call, noise on stdout and an unreachable tenant (`test/scripts/mcp-bridge.test.mjs`); the filter (`test/unit/wasi/mcpBridge.test.ts`) |
| Assumed | that every editor spawns the definition's `process.execPath` with the `env` it is given, and passes `ELECTRON_RUN_AS_NODE` through |

## The matrix

| Editor | Mechanism | Verified | Assumed or unknown | Manual check |
|--------|-----------|----------|--------------------|--------------|
| **VS Code**, Copilot agent mode (Local) | `lm.registerMcpServerDefinitionProvider` (`contributes.mcpServerDefinitionProviders`), one complete `McpStdioServerDefinition` (execPath, `[bridge]`, env, cwd). Same label and dedup rules as with a native opentide | The decision (`test/unit/agents/`); the bridge round trip; the provider is the existing one | Whether VS Code spawns the definition with our env and the Electron path | In **MCP: List Servers**, start `opentide`, **Show Output**: `initialize` answered, `tools/list` has `search`; ask the agent for `search`. With no opentide on `PATH` |
| **VS Code**, Copilot harness (a definition forwarded out of the window) | the same definition | nothing | **Unknown** whether a definition forwarded to the harness keeps our env (`ELECTRON_RUN_AS_NODE`) and the Electron path | Run a Copilot CLI / harness session against the workspace; if the server fails to start, the output says what the harness ran. The extension logs the host and mechanism at activation (`agents: host … MCP through …`) |
| **Cursor** | `vscode.cursor.mcp.registerServer({name, server: {command, args, env}})`, `unregisterServer` when it no longer applies or on deactivate. Nothing is written to `~/.cursor/mcp.json` | registration shape and withdrawal against a mocked API (`cursorMcp`, `cursorRegistration`) | the API's behaviour; whether the stdio server starts under Cursor's Electron; language-model tools are not supported in Cursor (none are registered there) | In Cursor's MCP settings the `opentide` server is listed. **Known Cursor bug:** an extension-registered stdio server shows "0 tools" until toggled off and on: toggle it. Then ask the agent to `search` |
| **Kiro** (Code OSS ≥ 1.108) | **First** `lm.registerMcpServerDefinitionProvider`, if Kiro implements it (logged: `MCP through an MCP server definition provider`). **Otherwise** a consented entry in `~/.kiro/settings/mcp.json` (`mcpServers.opentide`), marked, kept current | the writer: idempotent, marker-only, JSON preserved, comments refused (`test/unit/agents/`) | that Kiro has no documented extension API (kiro.dev docs are silent); the file path; that Kiro spawns it with `ELECTRON_RUN_AS_NODE`; whether it implements the provider API | Open Kiro: the notification offers the entry; Add; Kiro's MCP panel lists `opentide` with its tools. Update the extension: the entry's path is rewritten. **Remove opentide from This Editor's MCP Settings** removes it, and only it |
| **Devin Desktop** (formerly Windsurf, renamed 2026-06-02) | the Kiro fallback: `~/.config/devin/mcp_config.json` (`%APPDATA%\devin\mcp_config.json` on Windows) | the writer, as for Kiro | the file path; detection by `vscode.env.appName` ("Devin") | as Kiro |
| **Windsurf** (older builds) | the same, `~/.codeium/windsurf/mcp_config.json` | the writer | the file path | as Kiro |

Kiro's steering: the opentidehq/skills Agent Plugin can be installed as a **Kiro Power**; it is not built here.
`chatSkills` for the opentide workflow skills wait for the licence review in #6 (SPEC §17, open question 5):
TODO there.

## Not done, and why

- **An extension-host HTTP MCP server** is not the main path: it dies with the window, needs Origin checks and a
  token, and Cursor drops remote headers.
- **No `engines.vscode` bump** (`^1.101.0`, the provider API's floor): the extension feature-detects every newer
  API (SPEC §3), and a higher floor would keep forks that lag behind out. No `extensionDependencies` either:
  `ms-vscode.wasm-wasi-core` declares no support for untrusted workspaces, and the bridge needs it no more than
  the launcher does.
- **The two language-model tools stay** (`opentide_open_file_diagnostics`, `opentide_active_object`): editor
  state, not an MCP tool, and never a duplicate of one.
