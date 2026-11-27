# Changelog

All notable changes to the opentide extension (`opentide.opentide-vscode` on the Visual Studio Marketplace,
`opentidehq.opentide` on Open VSX). The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). From 1.1.0 the extension's version is the
opentide release it ships, and every release is stable.

## [Unreleased]

## [1.1.0] - 2026-11-27

The extension now shares opentide's version: 1.1.0 ships opentide 1.1.0. Rules look like YAML in every
colour theme, and each object type has its own icon.

### Changed

- **The extension's version is the opentide release it ships.** 1.1.0 carries opentide 1.1.0, and
  every release is stable: there is no pre-release channel any more.
- **The bundled opentide (WASI) and the opentide engine (WASM) are 1.1.0.** Editor features with no
  opentide installed, and in Restricted Mode, come from this release
  ([opentide 1.1.0](https://github.com/opentidehq/opentide/releases/tag/v1.1.0)).
- **Rules look like YAML in every colour theme.** Keys, values and enumerations take your theme's
  YAML colours. In GitHub, Dracula, Monokai and Catppuccin, keys were plain text, and so were
  `true`, `false` and other fixed values in Dracula and Monokai.
- **Object and configuration files have opentide icons.** Tabs, the Explorer and breadcrumbs show
  opentide's wave for objects and a gear for configurations, in place of a plain-text icon.
- **Threats, objectives and rules have icons of their own.** A biohazard, a target and a siren, in
  red, blue and green, mark them in the Catalogue, Relations and Find Detection. Elsewhere they show
  as a bug, a target and a bell.

## [0.6.0] - 2026-11-25

Microsoft Defender replaces Defender for Endpoint, for opentide 1.0.0. The deploy plan is a native view with
VS Code's diff editor.

### Upgrade

- **Upgrade your own opentide to 1.0.0:** `pip install --upgrade opentide`. The extension names the
  `microsoft_defender` platform, which earlier opentide releases do not have.

### Breaking

- **Microsoft Defender replaces Defender for Endpoint.** The setup wizard, the Platforms view, the
  deploy plan and the query lenses name the `microsoft_defender` platform of opentide 1.0.0, a
  Microsoft Defender custom detection rule. `defender_for_endpoint` is no longer listed
  ([opentidehq/opentide#1856](https://github.com/opentidehq/opentide/pull/1856)).

### Changed

- **The bundled opentide (WASI) and the opentide engine (WASM) are 1.0.0.** Editor features with no
  opentide installed, and in Restricted Mode, come from this release
  ([opentide 1.0.0](https://github.com/opentidehq/opentide/releases/tag/v1.0.0)).
- **The opentide skills for agents cover Microsoft Defender and opentide 1.0.0.** The
  `microsoft-defender` skill replaces `microsoft-defender-endpoint`, and every skill is reviewed
  against opentide 1.0.0 ([opentidehq/skills#42](https://github.com/opentidehq/skills/pull/42),
  [#43](https://github.com/opentidehq/skills/pull/43)).
- **The deploy plan is a native view in the panel, and each change opens in VS Code's diff editor.** It lists
  platform → tenant → change with the counts of each, an icon per action, the number of changes as a badge and a
  one-line summary. Opening a change shows what is deployed against what the plan would send (the request alone
  when the plan has no deployed state). Options, filter, "Open Rule", "Copy Request" and the copy commands are in
  the view's toolbar and menus; the summary cards and the lock that kept several plans open are gone.

### Fixed

- **A panel that opens blank loads again on its own.** After you closed the graph while it was still
  loading, the next one could stay empty. A panel whose page has not loaded after 10 seconds on
  screen is now opened again in its place, once.
- **The language server starts again after a crash on Windows.** When it ended abruptly, VS Code
  could report the connection as broken before it closed, and the server then stayed stopped until
  **opentide: Restart Server**. It now restarts as it does elsewhere.
- **Faster startup on Windows.** Looking for `opentide`, `python` and `uv` on your PATH no longer
  holds up other extensions, and each is looked up once. A program you install while VS Code is
  open is found after **opentide: Restart Server**.
- **The opentide status keeps saying why the engine serves the editor.** When the language server
  keeps crashing and the opentide engine (WASM) takes over, the status tooltip and the output
  said why, until the window got the focus back. Now they keep saying it.
- **opentide tasks and commands stay available after you switch runtimes.** A command cut short by
  the switch now runs on the opentide you switched to, and a failed read of opentide's commands is
  tried again instead of leaving tasks empty until the next restart.

## [0.4.1] - 2026-11-24

Tenant queries no longer hold up the editor, and panels come back after a reload. Runs on opentide 1.0.0-rc.5.

### Added

- **The graph and the ATT&CK coverage panel come back after you reload the window.** They reopen where they
  were, with the choices you had made in them, and show a loading state until opentide has answered.

### Changed

- **The bundled opentide (WASI) and the opentide engine (WASM) are 1.0.0-rc.5.** Editor features with no
  opentide installed, and in Restricted Mode, come from this release
  ([opentide 1.0.0-rc.5](https://github.com/opentidehq/opentide/releases/tag/v1.0.0-rc.5)).
- **Most query languages are coloured more fully as soon as a file opens.** The grammars colour fields,
  functions and constants before the language server answers, so less of a query changes colour once it does.
- **Closing a window stops the language server and `opentide serve` together.** A slow stop of one no
  longer uses up the time VS Code gives the other, so neither is left running behind a closed window.
- **Windows that never need the language server start faster.** The extension loads its language client the
  first time a server starts, not in every window as it opens.
- **The graph's platform, status and hops choices open VS Code's own picker.** They were native drop-downs
  whose popup looked unlike the rest of VS Code.
- **The ATT&CK coverage panel's folder, platform and tenant choices open VS Code's own picker.** They were
  native drop-downs whose popup looked unlike the rest of VS Code; the folder list shows each folder's path.
- **The results table's "in column" choice opens VS Code's own picker.** It was a native drop-down whose popup
  looked unlike the rest of VS Code; it is now a button that opens the Quick Pick, with the current column
  marked, and Escape keeps the choice.
- **Large query results open and filter faster.** A result of 50,000 rows no longer scans every cell to open,
  and the table prepares its filter in the background while the panel is idle, so the first filter keystroke
  answers without a pause.
- **The ATT&CK coverage panel no longer holds memory while it is in the background.** It is rebuilt when you
  come back to it, with its filters, expanded techniques, selected technique, scroll position and focused
  cell as you left them.
- **The graph opens without a pause on catalogues of 500–1,500 objects.** The Catalogue view used to block the
  panel for up to 0.7 s while it was laid out; it now takes a few milliseconds. Small catalogues and Focus
  keep the layout they had.

### Fixed

- **A restart no longer hangs when the bundled opentide is busy (VS Code's WASI host).** Stopping the bundled
  opentide while it was working could wait for ever for an exit that VS Code's WASI host never reported, and
  every restart after it waited too.
- **The editor features no longer stay stuck when the language server is restarted while it is still
  starting.** A start that gets no answer is given up on after 30 seconds and the opentide engine (WASM) takes
  over; a stop that gets no answer is cut short, so `opentide: Restart Server` always comes back.
- **A slow tenant query no longer holds up the sidebar, the problems list or the coverage panel.** With the
  bundled opentide, queries, deploy previews and other commands that reach a tenant run beside the editor's
  own checks instead of in front of them. An editor command that answers nothing for 5 minutes is cancelled
  with `timed-out`.
- **A command that hangs can be cancelled.** Cancelling it stops it within 5 seconds, even when
  opentide does not answer, and the commands queued behind it run. A command still waiting its turn
  is cancelled at once.
- **opentide stops restarting when it keeps crashing.** After four crashes in two minutes, commands
  run in a process of their own; with the bundled opentide they stop, with a notice, until you run
  "opentide: Restart Server".
- **CQL, Exabeam, YARA and YARA-L queries are fully coloured in every theme.** Fields, functions and types
  were left plain in themes that do not turn on semantic highlighting, such as High Contrast Light.
- **A query written on one line in quotes is coloured as a query.** `query: '…'` was painted as a single
  string until the language server answered. A comment after it is coloured as a comment.
- **Inline code in a rule's description is readable in dark themes.** It was dark grey on dark, at a contrast
  of 3:1 in Dark+ and Dark Modern; it now takes the theme's constant colour (8:1).
- **The editor features come back after the language server crashes.** The server now restarts after a
  short, growing wait instead of at once. If it crashes five times in three minutes, the opentide engine
  (WASM) takes over, with a notice, instead of the editor features staying dead until you run
  `opentide: Restart Server`.

## [0.4.0] - 2026-11-23

opentide 1.0.0-rc.4 inside the extension. Completion and hover know ATT&CK 20.1 and current MISP threat actors.

### Changed

- **The bundled opentide (WASI) and the opentide engine (WASM) are 1.0.0-rc.4.** Editor features with no
  opentide installed, and in Restricted Mode, come from this release
  ([opentide 1.0.0-rc.4](https://github.com/opentidehq/opentide/releases/tag/v1.0.0-rc.4)).
- **Completion and hover offer ATT&CK 20.1 techniques and the current MISP threat actors.**
- **Hover and highlighting answer while a large workspace is still being validated for the first time.**
  They no longer wait for the first validation to finish.
- **A misspelt table name in a KQL query is an error.** The problem is reported as `kql_table_misspelt`.
- **Configuration problems land on the right key.** Findings carry a line and column, and `lint.toml` can
  set the severity of a single code.

## [0.3.3] - 2026-11-23

The first release on the Visual Studio Marketplace: "opentide for VS Code", id `opentide.opentide-vscode`.

### Upgrade

1. If you use VS Code, install `opentide.opentide-vscode` from the Visual Studio Marketplace:
   `code --install-extension opentide.opentide-vscode --pre-release`.

### Changed

- **On the Visual Studio Marketplace the extension is `opentide.opentide-vscode`.** The Marketplace keeps the
  name `opentide` for the extension it banned, so 0.3.1 and 0.3.2 never reached it. Open VSX keeps
  `opentidehq.opentide`, and nothing else changed since 0.3.2
  ([#109](https://github.com/opentidehq/vscode-extension/pull/109)).

## [0.3.2] - 2026-11-23

The first release on the Visual Studio Marketplace: "opentide for VS Code", id `opentide.opentide`.

### Upgrade

1. If you use VS Code, install `opentide.opentide` from the Visual Studio Marketplace:
   `code --install-extension opentide.opentide --pre-release`.

### Changed

- **The Visual Studio Marketplace lists the extension as "opentide for VS Code".** Its id is still
  `opentide.opentide`; the name "opentide" was taken there. Open VSX keeps "opentide", and nothing else
  changed since 0.3.1 ([#107](https://github.com/opentidehq/vscode-extension/pull/107)).

## [0.3.1] - 2026-11-23

The extension is on the Visual Studio Marketplace as `opentide.opentide`. A rule's colours match the language
server's from the first paint.

### Upgrade

1. If you installed `opentidehq.opentide` in VS Code from a `.vsix`, uninstall it:
   `code --uninstall-extension opentidehq.opentide`.
2. If you use VS Code, install `opentide.opentide` from the Visual Studio Marketplace:
   `code --install-extension opentide.opentide --pre-release`.

### Added

- **Elastic queries are coloured at once.** In an Elastic rule, the editor colours an ES|QL, EQL, Kuery or Lucene
  query as soon as the file opens, when `type:` (esql, eql) or `language:` (kuery, lucene) is written before
  `query:`. ES|QL keywords had no colour until the language server's came, a few seconds later
  ([#104](https://github.com/opentidehq/vscode-extension/pull/104)).

### Changed

- **VS Code users: install `opentide.opentide` from the Visual Studio Marketplace.** The Marketplace refuses
  the publisher `opentidehq`, so the extension never appeared there. Kiro, Cursor, Windsurf and VSCodium
  users of `opentidehq.opentide` on Open VSX need do nothing: updates arrive as before. Settings,
  commands and the MCP server keep their names ([#105](https://github.com/opentidehq/vscode-extension/pull/105)).
- **The opentide MCP server starts its module at the first tool call.** VS Code starts the server with the window, and
  the module took about a second and 100 MB in every window with an opentide folder, used or not. After the first
  run in a folder, the extension answers the editor's start-up questions itself and starts the module when an agent
  calls a tool ([#103](https://github.com/opentidehq/vscode-extension/pull/103)).
- **Every release is scanned before it reaches a store.** Microsoft Defender, ClamAV and YARA check both packages,
  which hold no native executables ([#105](https://github.com/opentidehq/vscode-extension/pull/105)).

### Fixed

- **A rule's colours no longer change when the language server's arrive.** The keys, colons, values, dates, UUIDs and
  `true` and `false` of a rule were painted one way by the editor and another, seconds later, by the server, and most
  of what changed colour was outside the query. They now start with the colours they end with. Colours the server
  alone knows still arrive later: a query's columns, functions and tables, and the values of other enumerated fields
  ([#104](https://github.com/opentidehq/vscode-extension/pull/104)).

## [0.3.0] - 2026-11-23

opentide runs with nothing installed: the extension bundles opentide 1.0.0-rc.3 as WebAssembly, with no Python.
Agents get its MCP tools and skills.

### Upgrade

1. If you use an opentide you installed yourself, set `opentide.runtime` to `installed` (or run **opentide:
   Switch Runtime…**), so the extension keeps using it instead of the bundled one.
2. If you run tenant commands in a task or terminal, install opentide and choose `installed` the same way:
   the bundled opentide has no network there.

### Breaking

- **An opentide you have installed is no longer used unless you ask for it.** The extension runs the opentide it
  carries. A non-empty `opentide.path` still selects `installed`, so a configuration that names a path keeps
  working. The output channel says which runtime runs and why.
- **Tasks and the terminal use the bundled opentide by default**, through the extension's own launcher. A
  tenant command in a task or terminal, and `opentide tui`, do not run there: the extension says so and
  offers **opentide: Switch Runtime…**.

### Added

- **The opentide skills and a few lines of guidance come with the extension, for VS Code's agents.** Agent mode
  gets the 34 skills of [opentidehq/skills](https://github.com/opentidehq/skills) (rules, objectives, threats,
  each platform's query language and internals) and always-on instructions: use the opentide tools, validate
  before deploying, never deploy for real unless asked. They are left out when the opentide Agent Plugin
  supplies the skills (`opentide.agents.embeddedSkills` overrides). Cursor and Kiro do not read them: install the
  plugin or the Power.
  The extension now activates in every window to decide that, and starts no opentide and shows no status item
  in a window with no opentide content.
- **opentide runs with nothing installed, and the bundled opentide is the default.** The extension carries
  opentide's own command line, compiled to WebAssembly, and runs it for the language server, the catalogue,
  the commands and MCP, whether or not you have opentide installed
  ([#75](https://github.com/opentidehq/vscode-extension/issues/75)).
- **`opentide.runtime` chooses between the bundled opentide and your own.** `bundled` (the default) runs the
  module the extension carries; `installed` runs `opentide.path`, the workspace's environment, `uv` or
  `PATH`, and falls back to the bundled one, with a notice, when none answers. A workspace value applies only
  in a trusted folder. **opentide: Switch Runtime…** sets it.
- **Tenant requests work from the bundled opentide in the editor and in MCP.** Queries, deploys and
  `validate --live` are made by the extension, so VS Code's proxy settings and certificate store apply. In
  MCP that needs opentide 1.0.0-rc.3 or later (the module asks the extension for each request); with an older
  module the MCP tenant tools say `network_unavailable`. In a terminal or a task the bundled opentide has no
  network: install opentide to run a tenant command there.
- **`opentide.diagnostics.workspacePull` stops slow completion with an older opentide.** VS Code asks the language
  server for the problems of closed files again 2 seconds after each answer, and an opentide older than
  1.0.0rc3 re-analyses every closed file each time, on the thread that answers completions: stalls of 0.5 to 3
  seconds at a thousand objects. With `auto` (the default) those servers are not asked, so **the problems of
  closed files leave the Problems panel for them**; your open files keep theirs and `opentide validate` still
  reports the workspace. `always` and `never` decide it by hand.
- **`opentide.wasi.enabled` turns the bundled opentide off.** With it off, and no opentide installed, only
  the engine's editor features run.
- **Grammars for CQL, Exabeam, YARA and YARA-L.** They come with opentide 1.0.0-rc.3's highlights and
  highlight those queries inside rules. They are available through **Change Language Mode** and have no
  file association yet.
- **Agents get opentide's MCP tools with no opentide installed.** The extension gives VS Code's agent mode
  an `opentide` MCP server that runs the bundled opentide through a small script, run by the editor's own
  Node. With `opentide.runtime` set to `installed`, your own opentide's `mcp start` runs instead.
  Tenant tools (deploy, live validate, query) work through the extension once opentide's MCP server asks it
  to make the requests; search, validate, lint, new and the catalogue work now.
- **Cursor gets the server from the extension.** It is registered with Cursor's extension API, and
  `~/.cursor/mcp.json` is no longer written.
- **When the MCP server finds no repository, it says where it was started and what to do.** The bridge's first log line names its working directory and the repository it will use, and a `workspace_not_found` answer says how to fix it (open the repository's folder, or set `OPENTIDE_REPO_ROOT`).
- **Kiro, Devin Desktop and Windsurf get a user-level MCP entry, if you agree.** Kiro's core has the VS Code API for MCP servers but its agent does not use it, so the extension goes by the editor's name instead of by the API (it still registers the provider where there is one). The extension asks once
  before adding `opentide` to the editor's MCP file, keeps it current when it updates, and never touches an
  entry it did not write. `opentide.agents.writeEditorConfig` sets `ask`, `always` or `never`;
  **Remove opentide from This Editor's MCP Settings** takes it away.

### Changed

- **The package grows from 4 to about 16 MiB** for the bundled opentide, one file for every platform.
- **The bundled opentide is 1.0.0-rc.3's WebAssembly build.** It needs no Python and no opentide on the
  machine.
- **The extension is licensed under the EUPL-1.2**, the licence of opentide and of the engine and grammars
  it carries, instead of MIT, so the whole package is under one licence. Third-party material keeps its own
  licence (`NOTICE`, `THIRD-PARTY-LICENSES`).
- **The extension watches fewer files for the language server.** It watches the object files,
  `.opentide/configurations` and the deployment state files, not the exports, inflight or templates that its own
  runs write by the thousand.
- **The engine reads your workspace's files straight from the disk** when its folders are `file:` ones, instead of
  asking the editor for each file, which was most of its start-up at a thousand objects.
- **The opentide engine is runtime tier 5, after the bundled opentide.** Restricted Mode still runs the
  engine only: no opentide runs in an untrusted folder, the bundled one included.
- **The engine and the grammars are opentide 1.0.0-rc.3's.** The engine now reads a folder's
  `.opentide/configurations/*.toml`, which it needs to check rules in the object folders `paths.toml`
  names.
- **The `opentide` command in terminals also covers the bundled opentide**, where none is installed.
- **The bundled opentide ships its own licences.** `dist/wasi/` carries the licence set of the module's own
  release (every Rust crate it links, the wasi-libc texts, `LICENSE` and `NOTICE`), checked against the pinned
  checksums, instead of the engine's copy.

### Fixed

- **The first problems of a large workspace come about twice as fast with the WASM WASI Core extension installed.** The
  bundled opentide ran under that extension whenever it was there: 10.6 seconds to the first problems on 1,000 rules,
  against 4.5 seconds through VS Code's own Node. It now runs through VS Code's Node wherever it can, and
  `opentide.wasi.host` (`wasm-wasi`) asks for the WASM WASI Core extension instead
  ([#100](https://github.com/opentidehq/vscode-extension/issues/100)).
- **A server restart no longer logs a warning.** With the WASM WASI Core extension, every **Restart Server** wrote
  "opentide lsp start exited with code 1" for the server the extension had stopped itself
  ([#99](https://github.com/opentidehq/vscode-extension/issues/99)).
- **A rule you open right after the language server restarts gets its problems.** The server could be asked
  for a file's problems before it had been told the file was open, answer that there were none, and VS Code
  kept that answer. The extension now asks once more after the file is open.
- **Validate Query on Tenants works from the Command Palette** while the language server is restarting (a
  setting changed, the folder trusted): the command waits for the server instead of saying the rule has no
  query.
- **Validate Query on Tenants and Run Query work from the Command Palette.** They said "this rule has no platform
  query" because the extension asked the language server for the rule's outline with parameters it rejected;
  the CodeLens, which asks another way, worked.
- **`opentide.trace.server` shows the trace.** The `opentide Language Server Trace` output stayed empty unless the
  channel's log level was set to Trace by hand; it now follows the setting.
- **An `opentide.path` that is not named `opentide` or `opentide-lsp` is named in the log.** The extension runs it as
  a full opentide and says so, with its path, and says why when it does not answer and the next runtime runs.
- **The credential check no longer says a variable is "not set" when `opentide.envFile` provides it.** It
  reads the same file the run does.
- **The query-validation notification no longer shows `$(pass)` as text.**
- **The log no longer tells you to install opentide in Restricted Mode.** It says no opentide runs there and
  to trust the folder.
- **The status bar says "bundled WASI" next to the version** when the module the extension carries is the
  runtime, so you can see which opentide is running without opening the tooltip.
- **Closing a window ends its opentide processes before it finishes closing.** The extension waits for the
  language server, `opentide serve` and MCP to stop, in that order, instead of leaving them to exit on
  their own.
- **Stopping an opentide process works the same on every platform and runtime.** It is asked to stop first
  and ended after two seconds if it does not, and on Windows its child processes end with it.
- **Changing a setting while opentide is being looked for no longer waits for the search.** The search for
  an installed opentide (a slow `uv` check can take minutes) is cancelled and starts again with the new
  settings.
- **A damaged `dist/wasi/wasi.json` or `dist/engine/engine.json` is reported in the log** with what is wrong
  with it, and that runtime is skipped. It no longer fails without a word.
- **A reply from `opentide serve` that does not have the expected shape is reported as a protocol error**
  instead of being read as if it were well formed.
- **The opentide entry in Kiro's, Devin Desktop's and Windsurf's MCP file keeps working after an extension
  update.** It runs a small launcher the extension keeps in its own storage, which starts the newest installed
  copy of the extension, instead of naming a folder the update deletes. If the extension was uninstalled, the
  agent is told to remove the entry or reinstall.
- **A window with no opentide folder no longer starts the opentide MCP server.** Agents there got a server that
  could only say it found no repository; it appears when an opentide folder does.
- **Kiro, Devin Desktop and Windsurf get the bundled MCP server when your installed opentide is older than
  1.0.0rc3.** Kiro rejects the older opentide's tool list. The extension says so once and writes the bundled
  entry; upgrade opentide to use your own there.
- **A damaged Kiro, Devin Desktop or Windsurf MCP file is left alone and the problem is named.** A file that
  is not JSON, has an `mcpServers` that is not an object, or holds comments is no longer offered an
  opentide entry, and **opentide: Remove from the Editor's MCP Settings** says what is wrong with it instead
  of saying it has no entry.

## [0.1.2] - 2026-11-10

Uses the opentide you install instead of bundling one: one 4 MiB package for every platform.

### Upgrade

1. Install opentide 0.24.1 or later where the repository's checks run, if you relied on the bundled
   one: `pip install opentide` (or `uv tool install opentide`, or a `.venv` with opentide in it).
2. If the `opentide` command is blocked on your machine and `python` is not on `PATH`, set
   `opentide.interpreter` to a Python with opentide installed.

### Breaking

- **The extension no longer bundles opentide or Python.** It runs the opentide you install
  ([Runtime](https://github.com/opentidehq/vscode-extension#runtime)); with none, the opentide engine
  (WASM) gives the editor features. One package now serves every platform, at about 4 MiB instead of
  50 to 60 MiB.
- **`opentide.runtime` is removed.** Its `bundled` value has nothing left to choose; set
  `opentide.path` or `opentide.interpreter` to pin a runtime.
- **In Restricted Mode only the opentide engine (WASM) runs.** It was the bundled runtime's language
  server; the engine gives the same editor features and starts no process.

### Added

- **`python -m opentide` where the `opentide` command cannot run.** When an interpreter's `opentide`
  script does not start (an application-control policy that blocks it but allows Python, a stale
  launcher), the extension runs `python -m opentide` with the same interpreter, for the language
  server, commands and MCP.
- **A `python` on `PATH` with opentide installed is found.** `python3` or `python`, and `py -3` on
  Windows, after `opentide` on `PATH`: a `pip install --user` whose scripts folder is not on `PATH`
  now works.
- **An `opentide` command in terminals for `python -m opentide`.** New integrated terminals get it on
  `PATH` when opentide runs as a module (`opentide.terminal.addToPath`).

### Fixed

- **A `.venv` whose `opentide` script does not run is used through its `python`.** The extension
  tried the script only, and fell back to the engine (WASM).

## [0.1.1] - 2026-11-05

Install from the Marketplace on any platform. Editor features work with nothing installed, on
vscode.dev and github.dev too.

### Added

- **The opentide engine (WASM) gives editor features with nothing installed.** It runs when no
  opentide answers: the universal package without opentide, Windows 10 on Arm, or a bundled runtime
  that does not start ([Runtime](https://github.com/opentidehq/vscode-extension#runtime)). It is
  [language-server 0.10.0](https://github.com/opentidehq/language-server/releases/tag/v0.10.0) built
  for WebAssembly, and every package carries it (3.4 MiB compressed).
  - diagnostics, hover, completion and semantic tokens
  - quick fixes, definitions, references and the outline
  - the Catalogue, Relations, the graph and Find Detection, from its `opentide/catalog` index
- **The engine reads the workspace through VS Code.** It gets the files in `objects/` and the
  paths.toml object folders, and `visibility.toml`, and restarts when one of them changes on disk.
- **The engine also runs in Restricted Mode, spawning nothing.**
- **The status bar reads "opentide engine (WASM): editor features only".** Validate and lint, new
  objects, deploy previews, queries, setup, tasks and MCP say they need opentide, with Install
  opentide and Switch Runtime….
- **"opentide: Install opentide…" opens the installation guide.** It is in the status menu, in
  Switch Runtime… and in the sidebar on an editor-only runtime.
- **Editor features on vscode.dev, github.dev and in virtual workspaces.** The engine runs there,
  where 0.1.0 had highlighting only, and every command that needs opentide says so, with Open in VS
  Code Desktop where the browser can continue there
  ([Web and virtual workspaces](https://github.com/opentidehq/vscode-extension#web-and-virtual-workspaces)).
  - the engine's editor features, and the Catalogue, Relations and Find Detection
  - object files on any file system scheme, such as `vscode-vfs:`
  - YAML in a paths.toml object folder opens as Tide YAML
- **Windows on Arm gets the bundled runtime, under x64 emulation.** The win32-arm64 package carries
  the win32-x64 runtime, which Windows 11 runs. Windows 10 on Arm cannot run x64 programs: there the
  opentide output channel says why, and the extension uses your own opentide or the engine (WASM).

### Changed

- **Editor-only runtimes say what each action and view needs.** Like the engine, `opentide-lsp` in
  `opentide.path` gets one message for every action that needs opentide, naming the runtime, instead
  of one about `opentide-lsp` alone. The Platforms, Health and Coverage views say what they need
  instead of "No opentide runtime".
- **The Marketplace page has screenshots and more search terms.** The extension is also listed under
  the Visualization category.

### Fixed

- **The Marketplace offers the extension on every platform.** 0.1.0 reached it for Alpine arm64
  only, so VS Code on macOS, Windows, Linux x64 and the web said the extension was not available for
  the platform. All eight platform packages and the universal one are published.
- **The Marketplace Overview no longer turns into code partway down.** A placeholder written as
  `Explain <code>` opened an HTML element that never closed; placeholders are escaped.

## [0.1.0] - 2026-11-04

First release: live checks for Tide objects and queries, catalogue, graph, ATT&CK coverage and
deploy previews. Works offline, without Python.

### Added

#### Runtime and core

- **Seven platform packages bundle
  [opentide 0.22.0](https://github.com/opentidehq/opentide/releases/tag/v0.22.0) on CPython 3.13.**
  Its engine is
  [language-server 0.10.0](https://github.com/opentidehq/language-server/releases/tag/v0.10.0);
  every other platform, win32-arm64 included, gets the universal package, with no bundled runtime.
  - Windows: `win32-x64`
  - Linux: `linux-x64`, `linux-arm64`
  - Alpine Linux: `alpine-x64`, `alpine-arm64`
  - macOS: `darwin-x64`, `darwin-arm64`
- **Each platform package carries an SBOM and third-party notices.** The CycloneDX SBOM and the
  notices cover the native libraries linked into CPython (OpenSSL, zlib, libffi, sqlite, …), and say
  where to obtain the exact source of Berkeley DB (Sleepycat licence, in the Linux and Alpine
  runtimes) and of CPython.
- **The repository's own opentide wins over the bundled one.** The extension uses the first of these
  that answers ([Runtime](https://github.com/opentidehq/vscode-extension#runtime)):
  - `opentide.path`
  - the workspace's environment
  - uv with the repository's pin, when you opt in
  - the bundled runtime
- **A runtime that differs from the repository's pin is flagged.** Each runtime's version is
  checked, and an untagged dev build such as `0.1.dev216+g0a65c49` is used with a note.
- **Status bar and language status items show the runtime.** A lightning icon next to the version
  means the warm backend, `opentide serve`, is running. The tooltip says which runtime, which
  backend and how many problems, with links, and the menu groups the actions and the runtime's
  commands.
- **First use compiles the bundled runtime's bytecode in the background.** It runs at low priority
  and writes to the extension's global storage, so the extension folder stays read-only; an older
  version's bytecode is deleted once VS Code has removed that version's folder.
- **The opentide language server checks files as you type.** One runs per window, its reference
  lens shows the references (`opentide.showReferences`), and fix-all on save is off by default.
- **Commands run in one warm `opentide serve` process.** An opentide without `serve` spawns
  `opentide --json` per command instead. Commands can be cancelled, each is logged, and a feature is
  offered only when the runtime's `opentide --json commands` has what it needs.
- **Rule names and paths with accents read correctly on Windows.** opentide runs in UTF-8 mode:
  `-X utf8` for the bundled runtime, `PYTHONUTF8` and `PYTHONIOENCODING` for the others.
- **Languages for Tide YAML, configuration TOML and seven query languages.** They come with grammars
  (ES|QL under `source.opentide.esql`), embedded query regions and language configurations.
  - Tide YAML: `opentide-yaml`, on `objects/**` and the object folders `paths.toml` names
  - configuration TOML: `opentide-config`
  - queries: `kql`, `spl`, `esql`, `eql`, `kuery`, `lucene` and `falco`
- **YAML under a CoreTIDE `Objects/` folder stays `yaml`.** VS Code matches `objects/` without case,
  so the extension sets such a file back unless it is in an opentide folder.
- **`opentide.envFile`: a `.env` file for commands that contact a tenant.** A line it cannot read, a
  double quote never closed (that key is dropped, the lines after it still count) and a missing file
  are reported in the opentide output.
- **Highlighting on vscode.dev, github.dev and in virtual workspaces.** Languages, grammars and
  language configuration work there, the status item reads "Highlighting only", and every command
  says it needs opentide instead of failing.

#### Problems

- **Problems from `opentide validate` and `opentide lint`, one squiggle each.** They sit next to the
  language server's, and a finding reported twice shows once, also where lint and the language
  server name the same check differently: `filename_mismatch` and `filename_slug`,
  `metadata_recommended` and `missing_<key>`.
- **Saving an object file validates and lints it.** It runs `validate --file`, and `lint --file`
  when your opentide has it, for files directly in an object folder; a run that fails keeps the
  problems it would have replaced.
- **The workspace is validated on startup and on demand.** "opentide: Validate Workspace" runs it,
  and so does saving a configuration file.
- **Quick fixes from each finding's suggested fix.** They are also on the language server's
  diagnostic when it replaces the finding.
  - "Fix all safe opentide problems in this file"
  - "opentide: Fix All Safe Problems in the Workspace…", which shows the
    `validate --fix --dry-run` diff first
- **"Explain &lt;code&gt;" on every opentide problem, offline.** It and "opentide: Explain a Code…"
  open `opentide explain` in a Markdown preview.
- **The status bar counts every source's errors and warnings.** It adds up the language server's,
  validate's and lint's.

#### New objects

- **"opentide: New Detection Object…" creates a threat, objective or rule.** A guided input picks
  the name, platforms, objective or threats, and folder; `opentide new` writes the file, which opens
  on its first placeholder. The same flow starts from:
  - "opentide: New Threat…", "New Objective…" and "New Rule…"
  - File › New File › opentide Threat, Objective or Rule
  - the Explorer menu on an object folder
- **Placeholder lines are highlighted, and keys move between them.** Lines marked
  `# opentide:placeholder` show in the editor, the gutter and the overview ruler, and the status bar
  shows `N placeholders left`.
  - "opentide: Next Placeholder" (Ctrl+Alt+.) and "Previous Placeholder" (Ctrl+Alt+,), in Tide YAML
  - "Mark as done" removes a marker
- **The workspace's snippets complete in Tide YAML.** They are its `tide-*` snippets; on
  `configurations:`, "Add &lt;platform&gt; block" inserts that platform's block.
- **One command regenerates templates, schemas and snippets.** Run
  "opentide: Regenerate Templates, Schemas and Snippets" from the palette.

#### Sidebar and setup

- **The opentide activity bar holds six views.** Its icon is the opentide wave mark. In a folder
  that is not a repository yet, each view offers to set one up or, in Restricted Mode, Manage
  Workspace Trust, since the wizard needs a trusted folder.
- **The Catalogue lists threats → objectives → signals → rules.** It also groups orphans and files
  that failed to load. With opentide 0.21.0 or earlier, which has no `info catalog`, it shows the
  language server's names, with one Switch Runtime… line.
  - group by threat chain, type, platform, status or technique
  - filter by name, UUID, path or technique
  - each rule's platforms and problem counts; its menu runs its query or previews its deploy
  - a tooltip with the type, path, platforms and their status, and relation counts both ways
  - Open to the Side, Show Relations and Show in Graph on each object row
- **The Relations view shows the active object's links, both ways.** It lists what the object
  points to and what points to it, in groups such as `Implements 1 →` and `← Implemented by 3`, with
  missing references marked. It follows the active editor unless pinned.
  - rows open beside the editor; a signal opens in its objective, at the signal
  - Back and Forward go through the objects it showed
  - with opentide 0.21.0 or earlier, it reads the language server's `opentide/catalog`, and says so
  - a server without that request gets one "needs a newer opentide" line, with Switch Runtime…
- **Relations from the editor: a command and a CodeLens.** "opentide: Show Relations" is in the
  palette, the editor title and the editor context menu. A CodeLens on each object's `name:` line
  reads like `Implements → Detect LSASS memory access · ← Implemented by 3 rules`, and
  `opentide.relations.codeLens` turns it off.
- **Relations and object types look the same in every view.** Relations share one set of words,
  arrows and icons, and each object type one icon and colour.
- **The Coverage view lists ATT&CK techniques by tactic, gaps first.** Each technique shows its rule
  count.
- **Platforms & Tenants shows each platform's capabilities and tenants.** It says where each
  credential comes from, and its actions are Set Credential…, Check Credentials (doctor) and Enable
  Platform.
- **The Health view shows `opentide doctor`, with fixes to run.** It also gives a redacted report to
  copy.
- **The Activity view lists the last 50 commands.** Each has Run Again, which asks first for a
  command that writes files or contacts a tenant, and Copy Command Line.
- **"opentide: Set Up Repository…" opens a wizard over `opentide setup`.** Before anything is
  written it shows the files each step will create, merge or remove (with `setup --plan`), and Copy
  as Script reproduces it in a terminal. In an existing repository it adds platforms, CI and agents.
  - a stepper that marks done and invalid steps, with a message under each field
  - file badges in Review
  - Apply runs step by step, with a progress bar and each command's status
  - a finish screen with Open README, New Rule, Show Graph and the Catalogue
  - the window takes up the new repository without a reload
- **Setup reports a CoreTIDE layout as not supported.** That layout (`Objects/`, `Configurations/`,
  `global.toml`) has no migration:
  [opentide 0.21.0](https://github.com/opentidehq/opentide/releases/tag/v0.21.0) removed it.
- **"Get started with opentide" walks you from runtime to agents.** Each of its seven steps
  completes when you do it.

#### Graph and search

- **"opentide: Show Graph" draws how your detections connect.** It shows threats, objectives,
  signals, rules, ATT&CK techniques, actors, log sources and platforms, from
  `opentide info catalog`.
  - modes: Focus (follows the editor, 1–3 hops), Catalogue and Threat chains
  - filters by kind, platform, status and problems
  - dangling references dashed, errors outlined
  - search, zoom and fit, and export as SVG, PNG or Mermaid
- **Each node's menu acts on its object.** It opens or validates it, runs a rule's query, previews
  its deploy, shows its relations, or creates a rule for an objective or an objective for a threat.
- **Show in Graph opens the graph beside the editor.** It does not take the focus, and the one graph
  panel retargets, then follows the active editor; its toolbar names the object, with a pin.
  - in a Tide YAML editor's title bar and context menu, and the explorer's
  - also from the sidebar, Find Detection and a CodeLens
- **Selecting or hovering a node shows its links both ways.** Its outgoing edges and targets
  (→ out) and its incoming edges and sources (← in) take their own colours, the rest dims, and its
  edges show their relation words. The legend explains the colours and node kinds.
- **A details pane shows the selected node.** It is resizable and collapsible.
  - path, UUID, platforms and problems
  - Outgoing and Incoming groups, such as "Implements 1 →" and "← Implemented by 3"
  - click an item to select it; double-click or Enter opens its file beside
  - Open file, Focus here, Show Relations and Copy UUID
- **Back, Forward and the keyboard move through the graph.** A node's + and − expand and collapse
  its neighbours in place, without laying the graph out again.
  - Back and Forward through the selection: the toolbar, or Alt+←/→
  - arrow keys move between neighbours
  - Enter opens, Escape clears
  - Enter in the search box jumps to the next match
- **"View as list" gives the graph as a keyboard tree.** It is for keyboard and screen-reader users,
  and keeps the focused item when the catalogue or Problems change. Shift+F10 or the menu key opens
  a node's actions there, and on the canvas for the selected node.
- **Files that fail to load show by their path.** They appear with their load error in the graph,
  search, the sidebar and the agents' active-object tool. A broken copy that carries another
  object's UUID leaves that object its node, links and counts.
- **"opentide: Find Detection…" searches the catalogue, with filters.** Ctrl+Shift+Alt+F opens it
  (Cmd+Shift+Alt+F on macOS), and results open at their name line, to the side, or in the graph, all
  together if you choose. With opentide 0.21.0 or earlier, it searches names, types and paths, and
  says which filters need a newer opentide.
  - `type:`, `t:` (or `technique:`), `tactic:`, `actor:`
  - `p:`, `s:`, `author:`, `tlp:`, `uuid:`, `path:`
  - `has:errors` and `has:placeholders`
  - `created:`, `modified:` and `reviewed:`
  - `unreviewed:>90d`, from `opentide rules unreviewed`

#### Panels

- **Query lenses: Run on &lt;tenant&gt;, Validate live and Compiled query.** They sit above each
  platform query in a rule and in `.kql`, `.spl`, `.esql`, `.eql`, `.kuery` and `.lucene` files.
  Validate live appears where opentide can validate the platform, Sysdig gets no run lens, and
  Elastic Kuery's lens says it writes preview alerts.
- **Query results open in a panel, one tab per tenant.** It shows each tenant's progress and the
  running time, with Cancel, Re-run and "Tenants and window…", and chips for the platform, window,
  limit and the tenants it contacts. When the platform has several tenants, it asks which to query.
- **Results are a table to sort, filter, copy and export.** The keyboard moves through each tenant's
  table, and a 10,000-row table sorts and filters within a frame.
  - resize columns: drag, double-click to fit, or Alt+←/→
  - a cell menu (Shift+F10): copy, filter to this value, sort
  - copy a cell, a row or the rows as CSV, JSON or Markdown
  - export CSV or JSONL, from the same Export menu
- **A failed tenant says why, with the next step.** Its tab shows the error and the platform's
  detail: unset or refused credentials offer Set Credential…, and a tenant that could not be reached
  offers Re-run.
- **"opentide: Preview Deploy" shows what a deploy would do.** It runs `opentide deploy --dry-run`
  for the current, selected or changed rules, and shows each rule's action per platform and tenant.
  - the counts as cards, and a collapsible section per platform
  - compile failures (also in Problems) and skipped rules
  - a missing tenant as a callout, with Open configuration
  - Changed, All or Only this rule, and the strategy, as segmented controls
  - API payloads, as read-only JSON
  - copy the deploy command, or a CI step naming its tenants' secrets
- **"opentide: Open ATT&CK Matrix" shows coverage by tactic and technique.** Gaps show without
  relying on colour, sub-techniques expand in place, and layers add planned objectives and
  unaddressed threats. Export Navigator layer writes the layer file.
  - filters in one bar: platform, tenant, INERT status, inherited techniques
  - a cell's hover card names its top rules; a click lists them in the side panel
  - the grid scrolls both ways under sticky tactic headers
  - a legend for the shading, and outlines in high contrast
- **Panels open beside the YAML, without taking the focus.** The query results, a rule's deploy
  plan, the compiled query, a payload and a setup file open in the next editor group, and a rule
  opened from a panel goes to the group beside it.
- **Each kind of panel is reused, unless you lock it.** It retargets to the next object, named in
  its title ("Query · LSASS handle… · Sentinel"); with its lock button on, it keeps its object and
  the next one gets a panel of its own.
- **Panels honour your theme, high contrast and reduced motion.** They share one look, with visible
  focus rings, a progress bar and skeleton rows while loading, and empty and error states with Show
  output. Icons are bundled, never loaded from a CDN.

#### Commands, tasks and agents

- **"opentide: Run Command…" runs any command the active opentide has.** Its menus come from that
  opentide's command tree, and each command gets a form: choices from the schema, files and folders
  from a picker, UUIDs from the catalogue.
  - in the background (progress, cancellation, the result as read-only JSON) or in a terminal
  - a failure shows its exit code, `failure.code` and Explain
  - keybindings can pass `{ "argv": [...], "mode": "terminal" }`
- **Palette commands for generating, vocabularies, sharing and the TUI.**
  - Generate… (by phase) and Open Generated Docs
  - Show Vocabulary… and Show Unreviewed Rules
  - Preview Sharing (also in the Explorer menu), Show Sharing Status and Show Sharing Targets
  - Open TUI in Terminal and Show Last Command Result
- **`opentide` tasks, with the `$opentide` problem matcher.** Tasks run `validate`, `lint`,
  `generate`, `deploy --dry-run`, `validate query` or any command in `tasks.json`, and the matcher's
  problems (source `opentide task`) sit next to the language server's.
- **Background runs, tasks and terminal runs get VS Code's `http.proxy`.** It reaches them as
  `OPENTIDE_PROXY`.
- **The bundled `opentide` is on new terminals' `PATH`.** `opentide.terminal.addToPath` controls it,
  and it also works when the Windows user folder's name is not ASCII, where Ctrl+C then leaves the
  console's code page as it was.
- **An "opentide" terminal profile, and links in the terminal.** Object UUIDs open the object, and
  `error[code]` opens Explain.
- **VS Code's agents get the opentide MCP server on install.** It needs only the bundled runtime,
  and `opentide.mcp.provide` takes `auto`, `always` or `never`
  ([Agents](https://github.com/opentidehq/vscode-extension#agents)). It reads these files for an
  `opentide` server:
  - the root `.mcp.json` and `.vscode/mcp.json`
  - `.cursor/mcp.json`, when VS Code discovers it
  - the `mcp.servers` of a `.code-workspace` and of the user's mcp.json
- **The extension's MCP server stays on beside a broken entry.** When the `opentide` server in one
  of those files runs a command that is not found, the extension's is named `opentide (VS Code)`,
  because VS Code keeps one server per name and would disable the working one.
- **Cursor and Windsurf get opentide's MCP server from one command.** Run
  "opentide: Add opentide to This Editor's MCP Settings".
- **Agents read a file's problems and the active object.** These are the language-model tools
  `opentide_open_file_diagnostics` and `opentide_active_object`.

#### Releases

- **Releases go to the Visual Studio Marketplace and Open VSX.** Every release has a `SHA256SUMS`,
  and every VSIX a build-provenance attestation
  ([Install](https://github.com/opentidehq/vscode-extension#install)).

### Security

- **Restricted Mode runs only the bundled language server.** The server's `PATH` is limited to the
  runtime, and there is no MCP server.
- **Credentials you set stay in VS Code's secret storage.** Set Credential… keeps each one there,
  never in a file.
- **Status commands get credential names, never values.** `info` and `doctor --offline`, behind
  Platforms & Tenants, get each credential by name only; an `OPENTIDE_` variable opentide does not
  read as configuration (`OPENTIDE_PUSH_URL`) counts as one, and a proxy or index URL loses its user
  and password.
- **The editor's commands deploy and share only as dry runs.** The deploy plan never deploys, and
  "opentide: Run Command…" runs a deploy or share only as its dry run, behind a confirmation naming
  the platforms, tenants and rule count. A command without a dry run is refused.
- **Query results stay in memory, dropped when the panel closes.** `opentide.query.retainResults`
  keeps them after it closes.
- **CSV from query results escapes spreadsheet formulas.** A cell starting with `=`, `+`, `-` or `@`
  gets a leading `'`, since rows carry attacker-controlled telemetry.
