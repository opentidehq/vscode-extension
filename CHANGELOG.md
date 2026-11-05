# Changelog

All notable changes to the opentide extension (`opentidehq.opentide`). The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Stable releases use even minor versions and
pre-releases odd ones.

## [Unreleased]

### Added

- The opentide engine (WASM): editor features with nothing installed, on every platform VS Code runs
  on. When no opentide answers (the universal package without opentide, Windows 10 on Arm, or a
  bundled runtime that does not start), the extension runs the language server built for WebAssembly
  (language-server 0.10.0's `opentide-wasm-web`, pinned by SHA-256 in `pins.json`) in a worker thread:
  diagnostics, hover, completion, semantic tokens, quick fixes, definitions, references, the outline, and
  the Catalogue, Relations, the graph and Find Detection from its `opentide/catalog` index. The client
  reads the object files (`objects/` and the paths.toml object folders) and `visibility.toml` through VS
  Code and gives them to the engine, which has no filesystem, and restarts it when one changes on disk.
  The status bar reads **opentide engine (WASM): editor features only**; validate and lint, new objects,
  deploy previews, queries, setup, tasks and MCP say they need opentide, with Install opentide and Switch
  Runtime…. Every package carries the engine (3.4 MiB compressed). It also runs in Restricted Mode, where
  it spawns nothing.
- VS Code for the Web: on vscode.dev, github.dev and in desktop virtual workspaces the extension runs
  the same engine (WASM) in a Web Worker, where it had highlighting only. You get diagnostics, hover,
  completion, semantic tokens, quick fixes, definitions, references, the outline, and the Catalogue,
  Relations and Find Detection from the engine's index. The engine reads the repository's object files
  through VS Code's file system, any scheme (`vscode-vfs:` and the like), and a YAML file in a
  paths.toml object folder opens as Tide YAML there too. Every command that needs opentide says so, with
  Open in VS Code Desktop where the browser can continue there.
- **opentide: Install opentide…** opens the installation guide, from the status menu, Switch Runtime…
  and the sidebar on an editor-only runtime.
- Windows on Arm gets the bundled runtime, running as x64 under Windows 11's emulation. The win32-arm64
  package carries the win32-x64 runtime (cryptography has published no Windows on Arm wheel since
  46.0.3), built and tested on a Windows 11 on Arm runner. Windows 10 on Arm cannot run x64 programs:
  there the bundled runtime does not start, the opentide output channel says why, and the extension
  uses an opentide of your own or, without one, the opentide engine (WASM).

### Changed

- An editor-only runtime (the engine, or `opentide-lsp` in `opentide.path`) gets one message for every
  action that needs opentide, naming the runtime, instead of one about `opentide-lsp` alone, and the
  Platforms, Health and Coverage views say what they need instead of "No opentide runtime".
- `npm run smoke` checks the engine in every package, the universal one included, and that each
  carries the web extension (`browser` and the engine's Web Worker), which the Marketplace needs to
  offer it on vscode.dev.

## [0.1.0] - 2026-11-04

The first pre-release of opentide for VS Code and its forks: live checks for Tide objects and their queries, new objects from templates, the catalogue with its Relations view, the graph and the ATT&CK coverage, query results and deploy previews beside the object, the setup wizard and an MCP server for agents. Each platform package bundles opentide 0.22.0 (engine: language server 0.10.0) on CPython 3.13, so it works offline on a machine without Python; a repository's own opentide is used when it has one.

### Added

#### Runtime and core

- Per-platform packages for win32-x64, linux-x64, linux-arm64, alpine-x64, alpine-arm64, darwin-x64
  and darwin-arm64 bundle opentide 0.22.0 on CPython 3.13, with a CycloneDX SBOM and third-party
  notices that include the native libraries linked into CPython (OpenSSL, zlib, libffi, sqlite, …). For Berkeley DB (Sleepycat licence, in the Linux and Alpine runtimes) the notices and SBOM say where its exact source, and CPython's, can be obtained. Every other platform, including win32-arm64 for now, gets the universal package.
- Runtime resolution in four tiers: `opentide.path`, the workspace's environment, uv with the
  repository's pin (opt-in), and the bundled runtime; a version check (an untagged dev build such as
  `0.1.dev216+g0a65c49` is used with a note), pin-mismatch detection, a status bar item and a language
  status item.
- The first time the bundled runtime is used, its bytecode is compiled in the background at low
  priority, into the extension's global storage, so the extension folder stays read-only. An older
  version's bytecode is deleted once VS Code has removed that version's folder.
- The language server: one client per window with pulled diagnostics, the reference lens's
  `opentide.showReferences`, and fix-all on save off by default.
- The backend: `opentide serve` when the runtime has it, spawning `opentide --json` otherwise, with
  cancellation, capability gating from `opentide --json commands`, and an activity log. A command that
  reaches a serve shutting down for a runtime restart, which refuses it unrun, runs again on the new one.
- opentide runs in UTF-8 mode (`-X utf8` for the bundled runtime, `PYTHONUTF8` and `PYTHONIOENCODING`
  for the others), so rule names and paths with accents read correctly on Windows.
- Languages for Tide YAML (`opentide-yaml`, on `objects/**` and the object folders `paths.toml`
  names), opentide configuration TOML (`opentide-config`) and the query languages `kql`, `spl`,
  `esql`, `eql`, `kuery`, `lucene` and `falco`, with grammars from the language-server highlights zip
  (ES|QL under `source.opentide.esql`), embedded query regions and language configurations.
  YAML under a CoreTIDE `Objects/` folder stays `yaml`: VS Code matches `objects/` without case, and
  the extension sets such a file back unless it is in an opentide folder.
- Restricted Mode: only the bundled language server runs, with `PATH` limited to the runtime.
- `opentide.envFile`: a `.env` file whose variables reach commands that contact a tenant. A line it
  cannot read, a double quote never closed (that key is dropped, the lines after it still count) and a
  missing file are reported in the opentide output.
- Web mode (vscode.dev, github.dev and desktop virtual workspaces): languages, grammars and language
  configuration, a "Highlighting only" status item, and every command explaining that it needs
  opentide instead of failing.

#### Problems

- Problems from `opentide validate` and `opentide lint` next to the language server's, one squiggle
  per finding, also where lint and the language server name the same check differently
  (`filename_mismatch`/`filename_slug`, `metadata_recommended`/`missing_<key>`).
  - Saving an object file validates it (`validate --file`) and lints it (`lint --file`, when your
    opentide has it); saving a configuration file validates the workspace. Only files directly in an
    object folder are checked this way (opentide accepts no other), and a run that fails keeps the
    problems it would have replaced.
  - The workspace is also validated on startup and with "opentide: Validate Workspace".
- Quick fixes from each finding's suggested fix (also on the language server's diagnostic when it
  replaces the finding), "Fix all safe opentide problems in this file", and
  "Fix All Safe Problems in the Workspace…", which shows the `validate --fix --dry-run` diff before
  applying.
- "Explain <code>" on every opentide problem, and "opentide: Explain a Code…": `opentide explain` in a
  Markdown preview, offline.
- The status bar counts errors and warnings from the language server, validate and lint.

#### New objects

- "opentide: New Detection Object…" (also New Threat/Objective/Rule…, File › New File › opentide
  Threat/Objective/Rule, and the Explorer menu on object folders). A guided input picks the name,
  platforms, objective or threats, and folder; `opentide new` writes the file, which opens on its
  first placeholder.
- Placeholder lines (`# opentide:placeholder`) are highlighted in the editor, the gutter and the
  overview ruler. "Next/Previous Placeholder" (Ctrl+Alt+. / Ctrl+Alt+, in Tide YAML) moves between
  them, the status bar shows `N placeholders left`, and "Mark as done" removes a marker.
- The workspace's `tide-*` snippets complete in Tide YAML, and "Add <platform> block" on
  `configurations:`.
- "opentide: Regenerate Templates, Schemas and Snippets".

#### Sidebar and setup

- The opentide wave mark (from opentidehq/.github's brand assets) in the activity bar and as the
  Marketplace icon, on a Reflex Blue (`#001489`) gallery banner.
- The opentide sidebar, six views in the opentide activity bar:
  - **Catalogue:** threats → objectives → signals → rules, plus groups for orphans and files that
    failed to load. Group by threat chain, type, platform, status or technique; filter by name, UUID,
    path or technique. Each rule shows its platforms and problem counts, and its menu runs its query
    or previews its deploy. A tooltip gives an object's type, path, platforms with their status and its
    relation counts both ways; Open to the Side, Show Relations and Show in Graph are buttons on each
    object row. Without `info catalog` the names from the language server come with one Switch
    Runtime… line.
  - **Relations:** the active object (followed with a 150 ms debounce, or pinned) and what it points to
    and what points to it, in groups such as `Implements 1 →` and `← Implemented by 3`, with missing
    references marked. Rows open beside the editor, signals in their objective at the signal; Back and
    Forward go through the objects it showed. Without `info catalog` it reads the language server's
    `opentide/catalog` and inverts the references, and says so; a server without that request gets one
    "needs a newer opentide" line with Switch Runtime….
  - **opentide: Show Relations** (palette, editor title, editor context menu) and a CodeLens on each
    object's `name:` line, `Implements → Detect LSASS memory access · ← Implemented by 3 rules`, which
    `opentide.relations.codeLens` turns off.
  - One set of words, arrows and icons for relations, and one icon and colour per object type, in every
    view. The trees refresh only the rows that changed.
  - **Coverage:** ATT&CK techniques by tactic, with rule counts, gaps first.
  - **Platforms & Tenants:** capabilities, tenants and where each credential comes from. Set a
    credential (in VS Code's secret storage, never a file), check it with doctor, or enable a platform.
    The status commands behind it (`info`, `doctor --offline`) get each credential by name only, never
    its value; an `OPENTIDE_` variable opentide does not read as configuration (`OPENTIDE_PUSH_URL`)
    counts as a credential, and a proxy or index URL loses its user and password.
  - **Health:** `opentide doctor`, with runnable fixes and a redacted report to copy.
  - **Activity:** the last 50 commands, with Run Again (which asks first for a command that writes
    files or contacts a tenant) and Copy Command Line.
  - In a folder that is not a repository yet, each view offers to set one up; in Restricted Mode it
    offers Manage Workspace Trust instead, since the wizard needs a trusted folder.
- Set up a detection repository: a wizard over `opentide setup` that shows the files each step will
  create, merge or remove (with `setup --plan`) before anything is written. It applies step by step, and Copy
  as Script reproduces it in a terminal. The window takes up the new repository without a reload. It also adds platforms, CI and agents to an existing
  repository. A CoreTIDE layout (`Objects/`, `Configurations/`, `global.toml`) is reported as not
  supported: opentide removed its migration in 0.21.0.
- "Get started with opentide": a seven-step walkthrough from runtime to agents, each step completing
  when you do it.

#### Graph and search

- Graph panel ("opentide: Show Graph"): how threats, objectives, signals, rules, ATT&CK techniques,
  actors, log sources and platforms connect, from `opentide info catalog`.
  - Modes: Focus (follows the editor, 1–3 hops), Catalogue, and Threat chains.
  - Filters by kind, platform, status and problems; dangling references are dashed, errors outlined.
  - A node's menu opens, validates, runs a rule's query, previews its deploy, or creates a rule for an
    objective or an objective for a threat.
  - Search, zoom and fit, and SVG, PNG or Mermaid export.
  - "View as list", a keyboard tree for keyboard and screen-reader users, which keeps the focused item
    when the catalogue or Problems change; Shift+F10 or the menu key opens a node's actions there, and
    on the canvas for the selected node.
- "Show in Graph" in a Tide YAML editor's title bar and context menu and the explorer's.
- The graph opens beside the editor it is asked from (Show in Graph, the sidebar, Find Detection, a
  CodeLens) without taking the focus, and retargets its one panel; it follows the active editor, with
  the object's name and a pin in the toolbar.
- In and out at a glance: selecting or hovering a node colours its outgoing edges and targets (→ out)
  and its incoming edges and sources (← in), dims the rest, and shows the relation words on its edges;
  the legend explains the colours and node kinds, with each kind's sidebar icon.
- A details pane (resizable, collapsible) for the selected node: path, UUID, platforms, problems, then
  Outgoing and Incoming groups ("Implements 1 →", "← Implemented by 3", "Precedes 1 →") whose items
  select the node (click) or open its file beside (double-click, Enter); Open file, Focus here, Show Relations, Copy UUID.
  A node's menu has Show Relations too.
- Back and Forward through the selection (toolbar, Alt+←/→); + and − expand and collapse a node's
  neighbours in place, without laying the graph out again; arrow keys move between neighbours, Enter
  opens, Escape clears, and Enter in the search box jumps to the next match.
- Selection and hover restyle only the elements involved (no redraw of the view, no layout); a
  catalogue change sends the webview only the nodes and edges that changed.
- A file that did not load appears by its path in the graph, search, the sidebar and the agents'
  active-object tool, with its load error, even when it carries another object's UUID (a broken copy):
  that object keeps its node, links and counts.
- "opentide: Find Detection…" (Ctrl+Shift+Alt+F, Cmd+Shift+Alt+F on macOS): a quick search over the
  catalogue.
  - Filters: `type:`, `t:` (or `technique:`), `p:`, `s:`, `tactic:`, `actor:`, `author:`, `tlp:`,
    `has:errors`, `has:placeholders`, `uuid:`, `path:`, `created:`/`modified:`/`reviewed:` and
    `unreviewed:>90d` (from `opentide rules unreviewed`).
  - Results open at their name line, to the side, or in the graph, all together if you choose.
  - With an opentide that has no `info catalog` (0.21.0 and earlier) it searches names, types and
    paths, and says which filters need a newer opentide.

#### Panels

- Query lenses above each platform query in a rule, and in `.kql`, `.spl`, `.esql`, `.eql`, `.kuery`
  and `.lucene` files: **Run on <tenant>**, **Validate live** (where opentide can validate the
  platform) and **Compiled query** (from the language server). Sysdig gets no run lens, and Elastic
  Kuery says it writes preview alerts.
- The query results panel: progress per tenant with Cancel and Re-run, then one tab per tenant (with
  a failed tenant's error and the platform's detail). When the platform has several tenants it asks
  which to query; Re-run and "Tenants and window…" wait for that picker, and a pick made after the
  panel closed or a newer run started is dropped. Each tab has a virtual table to sort, filter and
  move through with the keyboard. Copy a cell, a row or the rows as CSV, JSON or Markdown, or export
  CSV or JSONL. Results stay in memory and are dropped when the panel closes
  (`opentide.query.retainResults`). In CSV, a cell a spreadsheet would read as a formula (`=`, `+`,
  `-`, `@` first) gets a leading `'`, since rows carry attacker-controlled telemetry.
- The deploy plan ("opentide: Preview Deploy"): `opentide deploy --dry-run` for the current, selected
  or changed rules. It shows each rule's action per platform and tenant, compile failures (also in
  Problems), skipped rules and missing tenants. API payloads open as read-only JSON, and you can copy
  the deploy command or a CI step that names the secrets of every tenant it deploys to. The editor never
  deploys.
- The ATT&CK matrix ("opentide: Open ATT&CK Matrix"): coverage per tactic and technique from
  `opentide info catalog`. Gaps show without relying on colour, sub-techniques expand in place, and
  layers add planned objectives and unaddressed threats. Filter by platform, tenant, INERT status and
  inherited techniques. Each cell lists its rules, and **Export Navigator layer** writes the file.
- Panels open beside the object: the query results, the deploy plan of a rule, the compiled query, a
  payload and a setup file open in the next editor group without taking the focus, so the YAML stays in
  view. Each kind keeps one panel and retargets it to the next object, with the object in its title
  ("Query · LSASS handle… · Sentinel"); a lock button keeps a panel on its object, and the next one gets
  a panel of its own. Rules opened from a panel go to the group beside it.
- One look for every panel: codicons (bundled, no CDN), design tokens on VS Code's theme variables, a
  toolbar with what the panel is about on the left and its actions on the right, a progress bar and
  skeleton rows while loading (nothing moves when the data arrives), empty and error states with one
  primary action and **Show output**, callouts, collapsible sections, and visible focus rings. Light,
  dark and high-contrast themes, and reduced motion, are honoured.
- Query results: chips for the platform, window, limit and the tenants it contacts; tenant tabs with
  counts; the running time and what it waits for beside **Cancel**; columns to resize (drag, double-click
  to fit, Alt+←/→), a cell menu (Shift+F10: copy, filter to this value, sort); copy and export in one
  **Export** menu. A failed tenant says whether its credentials are unset or refused (**Set
  Credential…**) or it could not be reached (**Re-run**). A 10,000-row table sorts and filters within a
  frame (`test/unit/webview/table.test.ts`).
- Deploy plan: the counts as cards, a collapsible section per platform with each tenant's changes (long
  lists are virtualised), a missing tenant as a callout with **Open configuration**, Changed / All /
  Only this rule and the strategy as segmented controls, and the commands folded into one section.
- ATT&CK matrix: the grid scrolls in both directions under sticky tactic headers, a cell's hover card
  names its top rules, a click lists them in the side panel, the shading has a legend and outlines in
  high contrast, and every filter sits in one bar. A state update patches the cells in place.
- Setup wizard: a stepper that marks done and invalid steps, inline messages under each field, file
  badges in Review, a progress bar and status per command during Apply, and a finish screen with **Open
  README**, **New Rule**, **Show Graph** and the Catalogue.
- The status item shows the warm backend (`$(zap)` while `opentide serve` runs) next to the version and
  problem counts; its tooltip says which runtime, which backend and how many problems, with links, and
  its menu groups the actions and the runtime's commands.

#### Commands, tasks and agents

- "opentide: Run Command…" runs any opentide command:
  - the menus come from the active opentide's command tree;
  - each command gets a form: choices from the schema, files and folders from a picker, UUIDs from the
    catalogue;
  - it runs in the background with progress and cancellation, the result opening as read-only JSON,
    or in a terminal;
  - a failure shows its exit code, `failure.code` and Explain;
  - keybindings can pass `{ "argv": [...], "mode": "terminal" }`.
- Deploys and shares run only as dry runs, behind a confirmation naming the platforms, tenants and
  rule count. Commands without a dry run are refused.
- Palette commands: Generate… (phases), Open Generated Docs, Show Vocabulary…, Show Unreviewed Rules,
  Preview Sharing (also in the Explorer menu), Show Sharing Status, Show Sharing Targets, Open TUI in
  Terminal, Show Last Command Result.
- `opentide` tasks (validate, lint, generate, deploy --dry-run, validate query, or any command in
  tasks.json) with the `$opentide` problem matcher, whose problems (source `opentide task`) sit next to
  the language server's. Tasks and terminal runs get VS Code's `http.proxy`
  as `OPENTIDE_PROXY`, as background runs do.
- Terminal:
  - the bundled `opentide` goes on new terminals' PATH (`opentide.terminal.addToPath`), also when
    the Windows user folder's name is not ASCII (and Ctrl+C then leaves the console's code page as it
    was);
  - an "opentide" terminal profile;
  - links: UUIDs open the object, `error[code]` opens Explain.
- The opentide MCP server for VS Code's agents, working on install with the bundled runtime
  (`opentide.mcp.provide`: auto|always|never); there is none in Restricted Mode. It reads the root
  `.mcp.json` as well as `.vscode/mcp.json` (and `.cursor/mcp.json` when VS Code discovers it), and the
  `mcp.servers` of a `.code-workspace` and of the user's mcp.json. When the
  `opentide` server there runs a command that is not found, the extension's server is named
  `opentide (VS Code)`: VS Code keeps one server per name, and it disabled the working one in favour of
  the file's. "Add opentide to This
  Editor's MCP Settings" for Cursor and Windsurf. Language-model tools `opentide_open_file_diagnostics`
  and `opentide_active_object`.

#### Releases

- Releases to the Visual Studio Marketplace and Open VSX from one workflow, with trusted publishing
  (no long-lived token), plus a `SHA256SUMS` for every release and a build-provenance attestation for
  every VSIX.
