# Changelog

All notable changes to the opentide extension (`opentidehq.opentide`). The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Stable releases use even minor versions and
pre-releases odd ones.

## [Unreleased]

## [0.1.1] - 2026-11-05

VS Code installs the extension from the Marketplace on every platform, and the opentide engine
(WASM) gives editor features with nothing installed, vscode.dev and github.dev included. The bundled
opentide is still 0.22.0 (engine: language server 0.10.0).

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

Live checks for Tide objects and their queries, the catalogue, graph and ATT&CK coverage, query
results, deploy previews and an MCP server. Each platform package bundles opentide 0.22.0 (engine:
language server 0.10.0) and works offline, without Python.

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
