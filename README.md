# opentide for VS Code

The opentide workbench for detection engineers, in VS Code and its forks (Cursor, Windsurf, VSCodium
and others through Open VSX).

- Live checks for Tide objects and their KQL, SPL, ES|QL, EQL, Kibana KQL, Lucene and Falco queries.
- New objects from templates.
- A catalogue, a graph and the ATT&CK coverage of how detections connect.
- Query results and deploy previews.
- An MCP server for agents.

It works on install: the platform packages bundle an opentide runtime, so a machine without Python
gets live checks, templates, the catalogue, the graph, the ATT&CK matrix, queries and deploy previews,
offline. When the repository has its own opentide (a `.venv`, the Python extension's interpreter,
`opentide` on `PATH`, or `opentide.path`), the extension uses it, so the editor checks what CI checks.

## Features

### Works on install

The extension for your platform ships with its own opentide (0.22.0 on CPython 3.13), so it works
offline on a machine with no Python, the graph, the ATT&CK matrix and Relations included. An older
opentide of your own may have no `info catalog`; the features that need it say so and offer Switch
Runtime. The first time the bundled opentide runs, it prepares itself in the background. Each package includes an SBOM (`runtime/sbom.cdx.json`) and the
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

The opentide activity bar has six views. In a multi-root window each view groups by folder.

- **Catalogue**: threats → objectives → signals → rules, with objectives without a threat, rules without
  an objective, and files that failed to load. Group by threat chain, type, platform, status or technique
  (the group button). Filter by name, UUID, path or technique, or use the tree's find widget. Click an
  object to open it at its name. Hover an object for its type, path, platforms with their status and its
  relations both ways (`Implements 1 →`, `← Implemented by 3`). Each object row has **Open to the Side**,
  **Show Relations** and **Show in Graph** buttons; its menu also validates it, previews sharing, runs a
  rule's query or previews its deploy, creates a rule for an objective or an objective for a threat, copies
  its UUID, or reveals the file. Until opentide answers, or when it has no `info catalog`, the tree shows
  names from the language server, with one **Switch Runtime…** line.
- **Relations**: the object in the active editor, what it points to (→) and what points to it (←). See
  [Relations](#relations).
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

### Relations

The **Relations** view, under the Catalogue, follows the active threat, objective or rule (its title says
`Following: <name>`) and lists its relations in groups, outgoing first, each with its count:

```text
RELATIONS              Following: LSASS handle opened by unsigned process   [Back] [Forward] [Pin]
  ◆ Rule · LSASS handle opened by unsigned process      objects/rules/lsass-handle-opened-….yaml
  ▾ Implements 1 →
      ◎ Detect LSASS memory access                      objects/objectives/detect-lsass-memory-access.yaml
  ▾ Technique 1 →
      T1003.001                                         LSASS Memory
```

The same words, arrows and icons are used everywhere: `Implements →` / `← Implemented by`, `Covers →` /
`← Covered by`, `Has signal →` / `← Signal of`, `Child of →` / `← Parent of`, `Technique →`, `Uses log
source →`; a threat chain reads as its relation, `Precedes →` / `← Preceded by`, `Enables →` / `← Enabled
by` and so on (`Chains to →` / `← Chained from` when it has none), one group per relation. A reference to a UUID no object carries shows as **missing**,
with a warning icon.

- Click an object to open it in the editor group beside the one you are reading, at its `name:` line; the
  view stays on its object and keeps the focus, so the arrow keys move on to the next relation (**Open to
  the Side** moves the focus to the editor). A signal opens in its objective,
  at the signal. A technique opens the ATT&CK matrix.
- Each object row has **Open to the Side**, **Show Relations** (the view moves to that object) and **Show
  in Graph**; **Back** and **Forward** in the view's title go through the objects it showed.
- **Pin** keeps the view on its object while you move between editors; **Unpin** follows the editor again.
- **opentide: Show Relations** (Command Palette, the editor title, the editor's context menu) shows the
  view on the active object without taking the focus from the editor. It has no default key; bind
  `opentide.relations.show` in Keyboard Shortcuts, for example to `Ctrl+Shift+Alt+R`
  (`Cmd+Shift+Alt+R` on macOS) with `when` `editorLangId == opentide-yaml`.
- A CodeLens on each object's `name:` line sums up its relations both ways, for example `Implements →
  Detect LSASS memory access · ← Implemented by 3 rules`; click it to show the view. It needs `info
  catalog`, and `opentide.relations.codeLens` turns it off. The language server's own lens on
  `metadata.uuid` (`3 rules use this objective`) still opens the references in place.

The view reads the cached catalogue, so following the editor runs no opentide command. With an opentide
that has no `info catalog` (0.21.0 and earlier), it reads the language server's `opentide/catalog` index
instead, inverting every object's references to find what points to it, and says so in its message:
references between objects only, without techniques and log sources. A language server without that
request shows one line, **Relations need a newer opentide**, with **Switch Runtime…**.

### Set up a repository

**opentide: Set Up Repository…** (or **Create a Detection Repository Here** in an empty folder's sidebar)
opens a wizard over `opentide setup`: repository, platforms, CI, agents and extras. **Review** lists every
file each step will create or merge before anything is written (with an opentide that has `setup --plan`),
and **Copy as Script** gives the same commands for a terminal. The stepper marks the steps that are done
and those that need attention, and each field says what is wrong as you type. **Apply** runs the commands
with a progress bar and the status of each, opens the README beside the wizard, and ends on what to do
next: **Open README**, **New Rule**, **Show Graph** or the Catalogue. In
an existing repository the wizard adds platforms, CI, MCP, skills and hooks. The **Get started with
opentide** walkthrough goes from the runtime to your first validated rule, its coverage, a deploy preview
and your agent.

### Graph

**opentide: Show Graph** draws how your detections connect: threats, the objectives that cover them,
their signals, the rules that implement them, and optionally ATT&CK techniques, actors, log sources and
platforms.

- **Beside the object.** **Show in Graph** (the type-hierarchy icon in a Tide YAML editor's title bar,
  the editor and explorer context menus, the sidebar's and Find Detection's "Show in graph") opens the
  graph beside the editor, without taking the focus, in **Focus** on that object. There is one graph
  panel: asking again retargets it.
- **Following the editor.** The toolbar names the object the graph is on, **Following** the active
  editor; the pin keeps it **Pinned** there while you open other files.
- **In and out.** Click a node: its outgoing edges and the nodes they point to turn one colour (→ out),
  its incoming edges and their sources another (← in), and everything else dims. Hovering does the same
  for a moment. The legend names the colours and the kinds.
- **Details pane** (right; drag its edge to resize, the toolbar button hides it): the node's kind, path,
  UUID, platforms and problems, then **Outgoing** and **Incoming** groups, worded as everywhere else
  ("Implements 1 →", "← Implemented by 3", "Precedes 1 →"). Click an item to select it in the graph;
  double-click it (or <kbd>Enter</kbd>) to open its file beside, at its line. **Open file**, **Focus here**,
  **Show Relations** (the sidebar's Relations view) and **Copy UUID** act on the node.
- **Click around.** Double-click a node to open it; <kbd>Alt</kbd>+<kbd>←</kbd>/<kbd>→</kbd> (or the
  toolbar's arrows) go back and forward through what you selected. **+** and **−** beside the selected
  node (or the keys) show its hidden neighbours in place, or hide the ones that link to nothing else. On
  the canvas the arrow keys move to the neighbour that way, <kbd>Enter</kbd> opens, <kbd>Escape</kbd>
  clears the selection, <kbd>/</kbd> searches; <kbd>Enter</kbd> in the search box jumps to the next match.
- **Scope:** **Focus** (1–3 hops; a rule shows its objective and that objective's threat), **Catalogue**
  (everything; above 1,000 nodes the graph opens in Focus), **Chains** (threats and how they chain).
  **Filters** by kind, platform, status or "Problems only". Nodes with errors carry ✗ and an error
  outline; a reference to a UUID no object has is drawn dashed to a "missing" node.
- Right-click a node to focus on it, expand or collapse it, validate its file, run a rule's query,
  preview its deploy, create a rule for an objective or an objective for a threat, or copy its UUID.
  Fit, re-layout, and **Export** as SVG, PNG or Mermaid.
- **View as list** shows the same nodes as a keyboard-navigable tree, structured as the details pane is;
  <kbd>Shift</kbd>+<kbd>F10</kbd> (or the menu key) opens a node's actions, as a right-click does.

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
| `has:errors`, `has:placeholders` | from the Problems panel; placeholders also from the files' `# opentide:placeholder` lines |
| `created:`, `modified:`, `reviewed:` | `>2026-01-01`, `<30d`, `none` |
| `unreviewed:>90d` | rules `opentide rules unreviewed --older-than 90d` lists (`6m` is six months, as in `modified:`; `12h`, `30min`) |

Repeating a filter means "or"; `-` excludes. A `word:` that is not a filter, such as `lsadump::dcsync`,
is searched as text. Each result opens at its name line, to the side, or in
the graph, and **Show all in the graph** focuses the graph on every result. A single word, or one `t:`,
`uuid:` or `path:` filter, can also **Filter the Catalogue**. With an opentide that has no `info catalog`
(0.21.0 and earlier), search matches names, types and paths only.

### ATT&CK coverage

**opentide: Open ATT&CK Matrix** shows your coverage, tactic by tactic. Each technique is shaded by the
number of rules covering it, and gaps are hatched. Add planned objectives and unaddressed threats, filter
by platform, tenant or status, and select a technique to list and open its rules, search for it, or start
a new objective. The grid scrolls both ways under sticky tactic headers, and the arrow keys move through it;
hover a cell for its rule count and top rules. Rules open beside the matrix. **Export Navigator layer**
writes the ATT&CK Navigator file. The matrix needs an opentide with `info catalog`.

### Run queries on your tenants

Above every query in a rule, and in `.kql`, `.spl`, `.esql`, `.eql`, `.kuery` and `.lucene` files, lenses
run the query on the platform's tenants (**Run on prod**), check it there (**Validate live**), or show the
KQL or SPL the platform runs (**Compiled query**). Pick the tenants and the time window, and the results
panel opens beside the rule, keeping your place in it. It shows each tenant's progress and the running
time with **Cancel**, then one tab per tenant: sort, filter, resize columns, copy a cell or a row
(Shift+F10 for the cell menu), and copy or export the rows from the **Export** menu. A tenant whose
credentials are unset or refused offers **Set Credential…**. Running another query reuses the panel;
**Lock** keeps it on its results and the next query opens a panel of its own. Queries are read-only,
except Elastic Kuery: it runs as a rule preview, which
writes preview alerts, and the lens says so. Results stay in memory and are dropped when the panel closes.
Credentials you set are kept in VS Code's secret storage.

### Preview a deploy

**opentide: Preview Deploy** (editor title, explorer, palette, the Catalogue and the graph) runs `opentide
deploy --dry-run` for the current rule, the selected rules or the changed rules. It shows what each
platform and tenant would get, beside the rule: the counts as cards, a section per platform with its
tenants' changes, the rules that would fail to compile (also in Problems), skipped rules and missing
tenants (with **Open configuration**). Switch between Changed, All and Only this rule. Each API request
opens beside as a read-only JSON document. Previewing another rule reuses the panel unless it is locked.
The editor never deploys: copy the deploy command or a ready-made CI step instead.

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
  mcp start` with the runtime it uses. `opentide.mcp.provide`: `auto` (skipped when a workspace MCP file,
  `.vscode/mcp.json` or the root `.mcp.json` `opentide setup mcp --claude-code` writes, already defines an
  `opentide` server VS Code can start), `always` or `never`. VS Code keeps one server per name, so when
  that file's `opentide` command is not found (only the bundled runtime), the extension's server is
  named `opentide (VS Code)` and stays enabled. No server in Restricted Mode.
- In Cursor and Windsurf, run **opentide: Add opentide to This Editor's MCP Settings**.
- Tools `#opentideDiagnostics` (a file's problems) and `#opentideActiveObject` (the open object and what
  it connects to). Skills: install the opentidehq/skills Agent Plugin; the extension does not embed it.

### Status

The status bar shows the opentide version in use, a lightning icon while the warm backend (`opentide serve`)
runs, and the workspace's problem counts; its tooltip names the runtime, the backend and the problems.
Its menu runs the common actions, shows Problems, restarts the server, switches the runtime and shows the
output. When the repository pins a different
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
| `opentide.relations.codeLens` | `true` | The relations CodeLens on each object's `name:` line (needs `info catalog`) |
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
