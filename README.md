# opentide for VS Code

The opentide workbench for detection engineers, in VS Code and its forks (Cursor, Windsurf, VSCodium
and others through Open VSX).

- Live checks for Tide objects and their KQL, SPL, ES|QL, EQL, Kibana KQL, Lucene and Falco queries.
- New objects from templates.
- A catalogue, a graph and the ATT&CK coverage of how detections connect.
- Query results and deploy previews.
- An MCP server for agents.

It works on install: the platform packages bundle an opentide runtime, so a machine without Python
gets live checks, templates, the catalogue, queries and deploy previews, offline. The graph and the
ATT&CK matrix need a newer opentide than the bundled 0.21.0 (one with `info catalog`). When the repository has its own opentide (a `.venv`, the Python
extension's interpreter, `opentide` on `PATH`, or `opentide.path`), the extension uses it, so the
editor checks what CI checks.

## Features

### Works on install

The extension for your platform ships with its own opentide (0.21.0 on CPython 3.13), so it works
offline on a machine with no Python; the features that need a newer opentide say so and offer
Switch Runtime. The first time the bundled opentide runs, it
prepares itself in the background. Each package includes an SBOM (`runtime/sbom.cdx.json`) and the
licences of everything it bundles (`runtime/THIRD-PARTY-NOTICES.txt`). On Windows on Arm, and on
platforms without a dedicated package, the extension needs an opentide of your own ([Runtime](#runtime)).

### Languages

| Language | Files | Id |
|----------|-------|----|
| Tide YAML | `objects/**/*.yaml`, and the object folders `paths.toml` names | `opentide-yaml` |
| opentide configuration | `.opentide/configurations/**/*.toml` | `opentide-config` |
| KQL (Microsoft) | `.kql` | `kql` |
| SPL | `.spl` | `spl` |
| ES\|QL | `.esql` | `esql` |
| EQL | `.eql` | `eql` |
| Kibana KQL | `.kuery` | `kuery` |
| Lucene | `.lucene` | `lucene` |
| Falco | `.falco` | `falco` |

The queries of Sentinel, Defender, Splunk, Carbon Black and Sysdig in a rule
(`configurations.<platform>.query`) are highlighted, commented and bracket-matched in their own
language. An Elastic query's language depends on its `language` key, so it gets the language server's
semantic highlighting only: comment toggling and bracket pairs there are YAML's.

### Problems: live, validate and lint

The language server checks open files as you type (`opentide` in the Problems panel). `opentide validate`
and `opentide lint` add what only the CLI checks, for every file, open or not:

- **On save:** the saved object file is validated (`validate --file`) and linted (`lint --file`, when your
  opentide has it). Saving a configuration file validates the workspace. Set `opentide.validate.onSave` to
  `workspace` or `off`, and `opentide.lint.onSave` to `off`.
- **On startup:** the workspace is validated in the background (`opentide.validate.onStartup`).
- **On demand:** *opentide: Validate Workspace*, *Lint Workspace* and *Validate File* (editor title bar).

A problem shows once: a validate or lint finding the language server already reports (same file, code and
line) is left out. Editing a file clears its validate and lint problems until the next run. Each problem
links its code to its page. **Explain <code>** (and *opentide: Explain a Code…*) opens `opentide explain`
in a Markdown preview, offline. Suggested fixes are quick fixes; safe ones can be applied together for the
file, or for the workspace after the `validate --fix --dry-run` diff. The status bar counts errors and
warnings from all three.

### New objects and placeholders

*opentide: New Detection Object…* (also New Threat/Objective/Rule…, **File › New File**, and the Explorer
menu on an object folder) asks for the name, the platforms, the objective or threats, and the folder, then
runs `opentide new`. The file opens on its first placeholder.

Lines ending in `# opentide:placeholder` are highlighted. **Next/Previous Placeholder**
(<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>.</kbd> / <kbd>,</kbd>, in Tide YAML) moves between them, and the
status bar counts what is left. After you change a value, **Mark as done** removes its marker.

The workspace's `tide-*` snippets (`opentide generate snippets`) complete in Tide YAML files. On a rule's
`configurations:` line, **Add <platform> block** inserts that platform's block.

### The opentide sidebar

The opentide activity bar has five views. In a multi-root window each view groups by folder.

- **Catalogue**: threats → objectives → signals → rules, with objectives without a threat, rules without
  an objective, and files that failed to load. Group by threat chain, type, platform, status or technique
  (the group button). Filter by name, UUID, path or technique, or use the tree's find widget. Click an
  object to open it at its name. Its menu validates it, shows it in the graph, previews sharing, runs a
  rule's query or previews its deploy, creates a rule for an objective or an objective for a threat, copies
  its UUID, or reveals the file. Until opentide answers, or when it has no `info catalog`, the tree shows
  names from the language server.
- **Coverage**: the ATT&CK techniques your objects name, by tactic, with how many rules cover each. Gaps
  come first, and sub-techniques sit under their parent. Opens the ATT&CK matrix.
- **Platforms & Tenants**: the nine platforms, which are enabled, and what each can deploy, validate and
  query. With an opentide that lists tenants, each tenant shows which credential variables are set: in VS
  Code, in the environment, or not at all. **Set Credential…** keeps the value in VS Code's secret storage
  and passes it only to commands that contact that tenant; it is never written to a file. **Check
  Credentials** runs `opentide doctor`.
- **Health**: `opentide doctor` checks, failures first. Run a fix that is an opentide command, run the
  network checks, or **Copy Doctor Report**, with paths and stored secrets redacted, for a bug report.
- **Activity**: every opentide command the extension ran, with its status, its duration and the exact
  command line to copy into a terminal or CI.

### Set up a repository

**opentide: Set Up Repository…** (or **Create a Detection Repository Here** in an empty folder's sidebar)
opens a wizard over `opentide setup`: repository, platforms, CI, agents and extras. **Review** lists every
file each step will create or merge before anything is written (with an opentide that has `setup --plan`),
and **Copy as Script** gives the same commands for a terminal. **Apply** runs them and opens the README. In
an existing repository the wizard adds platforms, CI, MCP, skills and hooks. The **Get started with
opentide** walkthrough goes from the runtime to your first validated rule, its coverage, a deploy preview
and your agent.

### Graph

**opentide: Show Graph** draws how your detections connect: threats, the objectives that cover them,
their signals, the rules that implement them, and optionally ATT&CK techniques, actors, log sources and
platforms.

- **Focus** follows the file you are editing. A rule shows its objective and that objective's threat;
  widen to 2 or 3 hops. **Catalogue** shows everything; **Threat chains** shows threats and how they chain.
- Filter by kind, platform, status or "Problems only". Nodes with errors carry ✗ and an error outline;
  a reference to a UUID no object has is drawn dashed to a "missing" node.
- Double-click a node to open it at its `name:` line. Right-click to focus on it, validate its file, run a
  rule's query, preview its deploy, create a rule for an objective or an objective for a threat, or copy
  its UUID. Search, zoom, fit, and **Export** as SVG, PNG or Mermaid.
- **View as list** shows the same nodes and links as a keyboard-navigable tree.
- **Show in Graph** is in the editor and explorer context menus of Tide YAML files.

The graph needs an opentide with `info catalog`; with an older one it says so and offers Switch Runtime.

### Find Detection

**opentide: Find Detection…** (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd>,
<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd> on macOS) searches the catalogue as you type:

    lsass t:T1003 p:sentinel s:production -tlp:red author:"Jane Doe" modified:<30d unreviewed:>90d

| Filter | Matches |
|--------|---------|
| `type:` | rule, objective, threat, signal |
| `t:` (or `technique:`) | an ATT&CK technique; `T1003` also finds its sub-techniques |
| `p:`, `s:` | platform and status, on the same platform block when both are given |
| `tactic:`, `actor:`, `author:`, `tlp:`, `uuid:`, `path:` | as named |
| `has:errors`, `has:placeholders` | from the Problems panel |
| `created:`, `modified:`, `reviewed:` | `>2026-01-01`, `<30d`, `none` |
| `unreviewed:>90d` | rules `opentide rules unreviewed --older-than 90d` lists (`6m` is six months, as in `modified:`; `12h`, `30min`) |

Repeating a filter means "or"; `-` excludes. A `word:` that is not a filter, such as `lsadump::dcsync`,
is searched as text. Each result opens at its name line, to the side, or in
the graph, and **Show all in the graph** focuses the graph on every result. A plain name, or one `t:`,
`uuid:` or `path:` filter, can also **Filter the Catalogue**. With opentide 0.21.0, search matches names,
types and paths only.

### ATT&CK coverage

**opentide: Open ATT&CK Matrix** shows your coverage, tactic by tactic. Each technique is shaded by the
number of rules covering it, and gaps are hatched. Add planned objectives and unaddressed threats, filter
by platform, tenant or status, and select a technique to list and open its rules, search for it, or start
a new objective. **Export Navigator layer** writes the ATT&CK Navigator file. The matrix needs an opentide
with `info catalog`.

### Run queries on your tenants

Above every query in a rule, and in `.kql`, `.spl`, `.esql`, `.eql`, `.kuery` and `.lucene` files, lenses
run the query on the platform's tenants (**Run on prod**), check it there (**Validate live**), or show the
KQL or SPL the platform runs (**Compiled query**). Pick the tenants and the time window, and the results
panel shows each tenant's progress, then one tab per tenant: sort, filter, copy as CSV, JSON or Markdown,
or export CSV or JSONL. Queries are read-only, except Elastic Kuery: it runs as a rule preview, which
writes preview alerts, and the lens says so. Results stay in memory and are dropped when the panel closes.
Credentials you set are kept in VS Code's secret storage.

### Preview a deploy

**opentide: Preview Deploy** (editor title, explorer, palette, the Catalogue and the graph) runs `opentide
deploy --dry-run` for the current rule, the selected rules or the changed rules. It shows what each
platform and tenant would get, the rules that would fail to compile (also in Problems), skipped rules and
missing tenants. Each API request opens as a read-only JSON document. The editor never deploys: copy the
deploy command or a ready-made CI step instead.

### Every command, in the palette, tasks and the terminal

- **opentide: Run Command…** lists every command the active opentide has. It asks for the required
  options (choices, files, objects from the catalogue); **Add Options…** adds the rest. It then runs the
  command in the background (the result opens as JSON; progress shows in a notification you can cancel)
  or in a terminal. A failed run shows its `failure.code`, plus **Explain** when opentide explains that
  code. Commands that write files list what they changed. Commands that reach a tenant say which tenants
  first, and offer to store a missing credential in VS Code's secret storage.
- **Nothing deploys from the editor.** A deploy or a share runs only as its dry run, after a confirmation
  that names the platforms, tenants and rule count. `deploy migrate-state` and `share retract` are left to
  CI.
- **Palette:** Generate… (pick phases), Open Generated Docs, Show Vocabulary…, Show Unreviewed Rules,
  Preview Sharing, Show Sharing Status, Show Sharing Targets, Open TUI in Terminal, Show Last Command
  Result.
- **Tasks:** `{ "type": "opentide", "command": "validate", "args": ["--strict"], "problemMatcher":
  "$opentide" }`. The provider lists validate, lint, generate, deploy --dry-run and validate query. Bind
  one to a key with `workbench.action.tasks.runTask`, or bind `opentide.runner.run` with
  `{ "argv": ["lint", "--fix"] }`.
- **Terminal:** with the bundled runtime, `opentide …` works in new integrated terminals
  (`opentide.terminal.addToPath`), or open the **opentide** terminal profile. Object UUIDs and
  `error[code]` in the terminal are links.

### Agents

- VS Code's agents get opentide's MCP tools with no `.vscode/mcp.json`: the extension provides `opentide
  mcp start` with the runtime it uses. `opentide.mcp.provide`: `auto` (skipped when `.vscode/mcp.json`
  already defines `opentide`), `always` or `never`. No server in Restricted Mode.
- In Cursor and Windsurf, run **opentide: Add opentide to This Editor's MCP Settings**.
- Tools `#opentideDiagnostics` (a file's problems) and `#opentideActiveObject` (the open object and what
  it connects to). Skills: install the opentidehq/skills Agent Plugin; the extension does not embed it.

### Status

The status bar shows the opentide version in use and the workspace's problem counts. Its menu
restarts the server, switches the runtime and shows the output. When the repository pins a different
opentide, it says so and offers the pinned version.

### Web and virtual workspaces

In vscode.dev, github.dev and virtual workspaces (Remote Repositories), the extension highlights Tide
YAML, opentide configuration and every query language, with comments, brackets and your workspace's
snippet files. There is no opentide there: checks, commands, panels and MCP need a local folder in VS
Code Desktop, and the status item says so. Diagnostics in the browser come later, from the language
server built for WebAssembly.

## Runtime

The first that answers wins:

1. `opentide.path`: an `opentide` executable, or `opentide-lsp` for editor features only.
2. The workspace's environment: `opentide.interpreter`, the Python Environments or Python extension's
   interpreter, `.venv`, then `PATH`.
3. With `opentide.uv.usePin`: `uv tool run --from opentide==<pin>`.
4. The bundled runtime.

## Restricted Mode

In an untrusted folder only the language server runs, from the bundled runtime, with no access to the
workspace's executables. Commands, tasks, panels and MCP need a trusted folder.

## Settings

| Setting | Default | |
|---------|---------|-|
| `opentide.path` | | An `opentide` or `opentide-lsp` executable, used before any other runtime (machine-overridable, not synced) |
| `opentide.interpreter` | | A Python interpreter with opentide installed, in place of the environment lookup (machine-overridable, not synced) |
| `opentide.runtime` | `auto` | `auto` or `bundled` |
| `opentide.uv.usePin` | `false` | Run the repository's pinned opentide with `uv tool run`, before the workspace's environment |
| `opentide.uv.path` | | The `uv` executable for `opentide.uv.usePin` (default: `uv` on `PATH`) |
| `opentide.envFile` | | A `.env` file whose variables reach commands that contact a tenant |
| `opentide.backend.serve` | `auto` | `auto` (one warm `opentide serve`) or `never` (spawn each command) |
| `opentide.trace.server` | `off` | Language server protocol trace: `off`, `messages` or `verbose` |
| `opentide.validate.onSave` | `file` | Run `opentide validate` on save: `file`, `workspace` or `off` |
| `opentide.validate.onStartup` | `true` | Validate the workspace in the background on startup |
| `opentide.lint.onSave` | `file` | Run `opentide lint` on save: `file` or `off` |
| `opentide.lint.withValidate` | `false` | Lint the workspace whenever it is validated |
| `opentide.query.lenses` | `true` | Run, Validate live and Compiled query lenses above each query |
| `opentide.query.defaultWindow` | `24h` | The look-back a query run offers first (`--since`) |
| `opentide.query.defaultLimit` | `100` | Rows per tenant (`--limit`, at most 5,000) |
| `opentide.query.retainResults` | `false` | Keep a query's last results in memory after its panel closes, for this window |
| `opentide.mcp.provide` | `auto` | Give VS Code's agents the opentide MCP server: `auto`, `always` or `never` |
| `opentide.terminal.addToPath` | `true` | Put the bundled `opentide` on new integrated terminals' `PATH` |

`opentide.path`, `opentide.interpreter`, `opentide.uv.*`, `opentide.envFile`, `opentide.mcp.provide` and
`opentide.terminal.addToPath` are ignored in Restricted Mode, and a workspace cannot set them until it is
trusted.

Fix-all on save (`source.fixAll.opentide`) is off by default. To apply every suggestion on save, set
`"editor.codeActionsOnSave": { "source.fixAll.opentide": "explicit" }` for the language; fixes rewrite
query text.

No telemetry.

## Related

[opentidehq/opentide](https://github.com/opentidehq/opentide) (the CLI, models and MCP server) ·
[opentidehq/language-server](https://github.com/opentidehq/language-server) (the analysis engine and
language server). Design: [`docs/SPEC.md`](docs/SPEC.md).

## Licence

MIT. The bundled opentide runtime and engine are EUPL-1.2 and CPython is PSF-2.0; they ship as
separate programs with their own licence files ([`NOTICE`](NOTICE)).
