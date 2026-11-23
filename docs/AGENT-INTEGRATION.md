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
| Tenant tools | `@opentide/wasi-host`'s `McpFetchBridge` answers the module's `opentide/fetch` (`OPENTIDE_FETCH=stdio`, opentide#1742, in rc.3) with FetchHost; nothing but MCP reaches the editor |
| Runtime decides | with `opentide.runtime` bundled (the default) every editor gets the bridge (VS Code's provider, Cursor's `registerServer`, the Kiro/Devin/Windsurf file); with `installed`, the installed opentide's own `mcp start` runs, as before |
| Restricted Mode | off |
| Verified | **against a scripted module** with `server/discover`, legacy `initialize`, a fetch-delegated tool call, an unreachable tenant, a cancelled call, an input closed mid-request, a forged answer and a leaked private-link line (`test/scripts/mcp-bridge.test.mjs`); **against the real module** for `initialize` and `tools/list`. **The real module's tenant path** (a deploy against a local fake tenant, a cancelled call, a closed input) is tested in `test/scripts/mcp-bridge.test.mjs` against a module built from opentide's `feat/mcp-wasi-fetch` (opentide#1742, at ed5d747 here; the Test VSIX workflow runs it), and **skips itself for a module without `OPENTIDE_FETCH`**. Against a released module (rc.3) it runs in CI once the pins are set; until then, "verified against the real module" means that test build |
| Assumed | that every editor spawns the definition's `process.execPath` with the `env` it is given, and passes `ELECTRON_RUN_AS_NODE` through |

## Two gates on the server (QA rerun 3)

- **No opentide folder, no server (#96).** In a window with no opentide folder, `provideMcpServerDefinitions` returns
  nothing and the runtime is not resolved for it: Copilot starts whatever the provider names, and without a
  repository the tools can only answer `workspace_not_found`. It provides the server, and fires
  `onDidChangeMcpServerDefinitions`, when an opentide folder appears. The **Add to editor MCP settings** command is
  not held to it.
- **An installed opentide older than 1.0.0rc3 does not get the user-level file (#97).** The `tools/list` of rc2 lacks
  `resultType`, which Kiro rejects. For Kiro, Devin Desktop and Windsurf, when `opentide.runtime` is `installed` and
  the installed opentide is older than 1.0.0rc3 (`MIN_NATIVE_MCP_FOR_FILES`, read from the runtime's version; an
  untagged dev build is left alone), the entry runs the bundled bridge through the launcher instead, with a log line
  and a one-time notice saying why and to upgrade. VS Code's provider and Cursor are not gated. Without a bridge in the
  build the installed opentide stays.

## The user-level entry survives an extension update

A user-level entry (Kiro, Devin Desktop, Windsurf) does not name the extension's own folder. An update deletes
`<extensions>/<publisher>.opentide-<old version>`, and the entry is only rewritten when the extension next activates,
so until then, in a workspace with no opentide content for instance, a path with the version in it points at nothing
and the agent starts a missing file. The entry names a small stable launcher instead:

| | |
|-|-|
| Command | the editor's own binary (`process.execPath`) with `ELECTRON_RUN_AS_NODE=1` |
| Script | `<globalStorage>/mcp-launcher.cjs`, the extension's global storage folder (`context.globalStorageUri`), which does not change across versions. The extension copies `dist/mcp-launcher.js` there at activation when the file is missing or differs |
| Environment | `OPENTIDE_EXTENSIONS_DIR`, the editor's extensions folder (`~/.kiro/extensions`, `~/.windsurf/extensions`, Devin's equivalent: the parent of the extension's own folder), `OPENTIDE_EXTENSION_ID`, the extension's id (`context.extension.id`: `opentidehq.opentide` from Open VSX, `opentide.opentide-vscode` from the Marketplace), and `OPENTIDE_MCP_ENTRY_FILE`, the MCP file the entry is in. The entry's marker, `OPENTIDE_VSCODE_EXTENSION`, is the same id |
| At start | the launcher lists `OPENTIDE_EXTENSIONS_DIR`, takes the highest version among `<id>-<version>[-<platform>]` folders (the id from `OPENTIDE_EXTENSION_ID`; an entry written before 0.3.1 has none, and the launcher takes the name of its own folder, the global storage, which VS Code names after the id) that have `dist/mcp-wasi.js` (a half-deleted folder is skipped, and so is one in the editor's `.obsolete` list), and `require`s that bridge: stdio is untouched |
| None installed | the extension was uninstalled: one line on stderr, an MCP error (`-32603`) for the first request, "the opentide extension is not installed; remove the opentide entry from `<file>` or reinstall", then it exits with 1 |
| Refreshed | at activation: the launcher file, and the entry when the editor's binary or the extensions folder changed (and once, in 0.3.1, to add `OPENTIDE_EXTENSION_ID`). The entry is **byte-identical across extension updates** |

Tested by `test/unit/mcp-launcher/`, `test/unit/agents/launcher.test.ts` (the entry does not change on an update) and
`test/scripts/mcp-launcher.test.mjs` (the built launcher against a fake extensions folder). **Assumed, not observed:**
that Kiro, Devin Desktop and Windsurf keep their extensions in a folder named `<publisher>.opentide-<version>` and
list obsolete ones in `.obsolete`, as VS Code does; the launcher falls back to "not installed" when the folder has
none, rather than guessing.

## A user-level entry has no repository root ([#86](https://github.com/opentidehq/vscode-extension/issues/86))

The entry the extension writes into Kiro's, Devin Desktop's or Windsurf's **user-level** file has no
`OPENTIDE_REPO_ROOT`: the file is global, and none of the editors documents a variable that names the workspace. So
the server finds the repository from the directory the editor starts it in (opentide's `get_repo_root` walks up
from the working directory to the nearest folder with `.opentide/` or `objects/`). Started anywhere else, its tools
answer `workspace_not_found`. **Decision: keep the user-level entry** (option (b)); a workspace-level file through
`opentide setup mcp` (option (a)) is the fallback if the check below fails for an editor, and a workspace argument on
the tools (option (c)) is not planned.

| Editor | What is known about the directory the server starts in | Confidence | Source |
|--------|------|-----------|--------|
| **Kiro** | The agent starts a stdio server in `config.cwd || <the connection's cwd>`, and the connection's cwd is the workspace folder (servers are keyed by name and cwd). The config's `cwd` field exists in the code, undocumented | **Medium: a static read** of the minified `kiro.kiro-agent` 1.5.11 `dist/extension.js`, not observed at run time | `StdioClientTransport` set-up in `kiro-agent`; the docs ([MCP configuration](https://kiro.dev/docs/mcp/configuration/), the custom-agents reference) are **silent** on the directory, a workspace variable (only `${VARIABLE}` of approved environment variables is expanded) and MCP roots |
| **Devin Desktop** | Not documented. Devin Local shares Devin CLI's harness, which works on the project | **Low: documentation only**, and the pages say nothing on the directory, `cwd`, a workspace variable or roots | [Devin Local customizations, MCP](https://docs.devin.ai/desktop/cascade/mcp) and the CLI's [MCP configuration](https://docs.devin.ai/cli/extensibility/mcp/configuration.md). Its scopes: project `.devin/mcp_config.json` (checked in), local `.devin/mcp_config.local.json` (gitignored), user `~/.config/devin/mcp_config.json` |
| **Windsurf** (older builds) | Not documented | **Low** | none |

**The manual check** (the owner; Kiro needs a sign-in the QA session did not have): in a signed-in Kiro with a
detection repository open, accept the entry, open the `opentide` server's log in Kiro's MCP panel and read the first
line the bridge writes:

```
opentide mcp bridge: cwd=<folder>; OPENTIDE_REPO_ROOT not set; repository root: <folder>
```

`cwd` should name the open workspace and the root should not be `none found`. If it names the home folder (or anything
outside the repository), the tools answer `workspace_not_found` with a hint that names that cwd, and the editor needs
(a): the same check for Devin Desktop. Until then the matrix says "static read" for Kiro and "documentation only"
for Devin Desktop and Windsurf.

## The matrix

| Editor | Mechanism | Verified | Assumed or unknown | Manual check |
|--------|-----------|----------|--------------------|--------------|
| **VS Code**, Copilot agent mode (Local) | `lm.registerMcpServerDefinitionProvider` (`contributes.mcpServerDefinitionProviders`), one complete `McpStdioServerDefinition` (execPath, `[bridge]`, env, cwd). Same label and dedup rules as with a native opentide | The decision (`test/unit/agents/`); the bridge round trip; the provider is the existing one | Whether VS Code spawns the definition with our env and the Electron path | In **MCP: List Servers**, start `opentide`, **Show Output**: `initialize` answered, `tools/list` has `search`; ask the agent for `search`. With no opentide on `PATH` |
| **VS Code**, Copilot harness (a definition forwarded out of the window) | the same definition | nothing | **Unknown** whether a definition forwarded to the harness keeps our env (`ELECTRON_RUN_AS_NODE`) and the Electron path | Run a Copilot CLI / harness session against the workspace; if the server fails to start, the output says what the harness ran. The extension logs the host and mechanism at activation (`agents: host … MCP through …`) |
| **Cursor** | `vscode.cursor.mcp.registerServer({name, server: {command, args, env}})`, `unregisterServer` when it no longer applies or on deactivate. Nothing is written to `~/.cursor/mcp.json` | registration shape and withdrawal against a mocked API (`cursorMcp`, `cursorRegistration`) | the API's behaviour; whether the stdio server starts under Cursor's Electron; language-model tools are not supported in Cursor (none are registered there) | In Cursor's MCP settings the `opentide` server is listed. **Known Cursor bug:** an extension-registered stdio server shows "0 tools" until toggled off and on: toggle it. Then ask the agent to `search` |
| **Kiro** (Code OSS ≥ 1.108) | **By host, not by API presence:** a consented entry in `~/.kiro/settings/mcp.json` (`mcpServers.opentide`), marked, kept current, **and** the provider where the core has it (it does; harmless). Kiro's core has `registerMcpServerDefinitionProvider` but `kiro.kiro-agent` never reads it (QA, #84: it reads `<home>/settings/mcp.json` and `<workspace>/.kiro/settings/mcp.json`), so the file is what reaches the agent. Logged: `host Kiro (kiro): a known editor … MCP through the user-level MCP file … and the provider` | the writer: idempotent, marker-only, JSON preserved, comments refused (`test/unit/agents/`); the choice by host (`chooseMcpMechanism`); by QA: the extension runs in Kiro 1.5.11 and the server, run as Kiro would run the entry, answers `tools/list` | that Kiro spawns it with `ELECTRON_RUN_AS_NODE`; Kiro's UI and agent were behind a sign-in; a user-level entry has no repository root ([#86](https://github.com/opentidehq/vscode-extension/issues/86)) | Open Kiro: the notification offers the entry; Add; Kiro's MCP panel lists `opentide` with its tools. Update the extension: the entry's path is rewritten. **Remove opentide from This Editor's MCP Settings** removes it, and only it |
| **Devin Desktop** (formerly Windsurf, renamed 2026-06-02) | as Kiro, by host: `~/.config/devin/mcp_config.json` (`%APPDATA%\devin\mcp_config.json` on Windows), plus the provider if the host has the API | the writer and the choice by host, as for Kiro | the file path; detection by `vscode.env.appName` ("Devin") or `uriScheme`; whether it has the provider API and whether its agent reads it | as Kiro |
| **Windsurf** (older builds) | the same, by host, `~/.codeium/windsurf/mcp_config.json` | the writer and the choice by host | the file path; whether it has the provider API | as Kiro |

## Skills and instructions

The extension contributes the opentide skills (`contributes.chatSkills`, from [opentidehq/skills](https://github.com/opentidehq/skills), pinned in `pins.json` `skills`) and always-on instructions (`contributes.chatInstructions`) to VS Code's agents. Sources: VS Code's [contribution points reference](https://code.visualstudio.com/api/references/contribution-points) (`chatSkills`, `chatInstructions`, `chatPromptFiles`: each takes `path`, relative to the extension root and inside it, and an optional `when`; a skill's folder name must match its `name`), [agent skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills), [custom instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions), [prompt files](https://code.visualstudio.com/docs/copilot/customization/prompt-files) and [agent plugins](https://code.visualstudio.com/docs/agent-customization/agent-plugins).

| Editor | What it gets | Verified | Not known |
|--------|--------------|----------|-----------|
| **VS Code** (Copilot) | Both contribution points. The skills are left out (`when: !opentide.skillsFromPlugin`) when the `opentide` Agent Plugin of opentidehq/skills is installed and on, so they do not load twice; `opentide.agents.embeddedSkills` overrides | the manifest, the files in the package (smoke), the gate's logic (`test/unit/knowledge/`); activation with the points present on 1.91.0 (the floor) and 1.147; the package size | that VS Code lists the skills: **no public API lists them**, so this is not tested in VS Code; whether `when` is re-evaluated when the context key changes; the minimum VS Code version for these points and the behaviour in Restricted Mode (**the docs say nothing**); how VS Code identifies an installed plugin (the heuristic reads `~/.copilot/installed-plugins/`, `chat.pluginLocations` and `chat.plugins.*`) |
| **Cursor** | Neither: it reads no `chatSkills`. The skills come from the plugin: `/add-plugin opentidehq/skills` | n/a | whether Cursor ever reads the contribution points |
| **Kiro** | Neither. The skills come as a **Kiro Power**: Powers → Add Custom Power → Import from GitHub → `https://github.com/opentidehq/skills` (the repository's `POWER.md` and `steering/`) | n/a | |
| **Devin Desktop, Windsurf** | Not known to read them | n/a | whether they do |

**No prompt files.** VS Code's docs say prompt files run only in Local harness sessions, which are to be removed in February 2027, and recommend converting them to skills. The `opentide-rule` skill covers a new detection rule.

**Manual check** (VS Code with GitHub Copilot signed in, the part this repository cannot test): in a workspace with opentide content, open the Chat view's **Configure Chat** → **Skills**: the opentide skills are listed (34), the extension's output says `agents: the opentide skills are contributed by the extension: …`. Turn on `chat.plugins.enabled`, install the plugin (**Chat: Install Plugin from Source** → `opentidehq/skills`), reload: the output says they are left to the plugin and the Skills page lists each once.

## Not done, and why

- **An extension-host HTTP MCP server** is not the main path: it dies with the window, needs Origin checks and a
  token, and Cursor drops remote headers.
- **No `engines.vscode` bump** (`^1.101.0`, the provider API's floor): the extension feature-detects every newer
  API (SPEC §3), and a higher floor would keep forks that lag behind out. No `extensionDependencies` either:
  `ms-vscode.wasm-wasi-core` declares no support for untrusted workspaces, and the bridge needs it no more than
  the launcher does.
- **The two language-model tools stay** (`opentide_open_file_diagnostics`, `opentide_active_object`): editor
  state, not an MCP tool, and never a duplicate of one.
