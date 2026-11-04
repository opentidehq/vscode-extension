# Changelog

All notable changes to the opentide extension (`opentidehq.opentide`). The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Stable releases use even minor versions and
pre-releases odd ones.

## [Unreleased]

### Added

#### Runtime and core

- Per-platform packages for win32-x64, linux-x64, linux-arm64, alpine-x64, alpine-arm64, darwin-x64
  and darwin-arm64 bundle opentide 0.21.0 on CPython 3.13, with a CycloneDX SBOM and third-party
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
  cancellation, capability gating from `opentide --json commands`, and an activity log.
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
- Set up a detection repository: a wizard over `opentide setup` that shows the files each step will
  create, merge or remove (with `setup --plan`) before anything is written. It applies step by step, and Copy
  as Script reproduces it in a terminal. The window takes up the new repository without a reload. It also adds platforms, CI and agents to an existing
  repository. A CoreTIDE layout (`Objects/`, `Configurations/`, `global.toml`) is reported as not
  supported: opentide 0.21.0 has no migration.
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
- "Show in Graph" in the editor and explorer context menus for Tide YAML.
- A file that did not load appears by its path in the graph, search, the sidebar and the agents'
  active-object tool, with its load error, even when it carries another object's UUID (a broken copy):
  that object keeps its node, links and counts.
- "opentide: Find Detection…" (Ctrl+Shift+Alt+F, Cmd+Shift+Alt+F on macOS): a quick search over the
  catalogue.
  - Filters: `type:`, `t:` (or `technique:`), `p:`, `s:`, `tactic:`, `actor:`, `author:`, `tlp:`,
    `has:errors`, `has:placeholders`, `uuid:`, `path:`, `created:`/`modified:`/`reviewed:` and
    `unreviewed:>90d` (from `opentide rules unreviewed`).
  - Results open at their name line, to the side, or in the graph, all together if you choose.
  - With opentide 0.21.0 it searches names, types and paths, and says which filters need a newer
    opentide.

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
  (`opentide.mcp.provide`: auto|always|never); there is none in Restricted Mode. "Add opentide to This
  Editor's MCP Settings" for Cursor and Windsurf. Language-model tools `opentide_open_file_diagnostics`
  and `opentide_active_object`.

#### Releases

- Releases to the Visual Studio Marketplace and Open VSX from one workflow, with trusted publishing
  (no long-lived token), plus a `SHA256SUMS` for every release and a build-provenance attestation for
  every VSIX once the repository is public.
