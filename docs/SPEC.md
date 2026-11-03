# opentide for VS Code: product specification

**Status:** draft for review, 2026-11-03.

**Scope:** what the extension does at 1.0, how it is built and shipped, and what comes after.

**Relation to the issues:** the epic [#1](https://github.com/opentidehq/vscode-extension/issues/1) tracks this spec. Its children #2–#21 are the engineering breakdown, updated to match on 2026-11-03. This document refines the earlier design: it reverses one decision (D1, bundling) and adds the workbench (views, panels, the setup wizard and templates). [Milestones and issues](#16-milestones-and-issues) maps each milestone to its issues.

The extension is the opentide workbench inside VS Code and its forks. A detection engineer installs it, opens a folder, and has everything the CLI, the TUI and the language server offer:

- writing objects and queries with live checks;
- creating them from templates;
- seeing how they relate, and what ATT&CK they cover;
- running queries;
- previewing deploys;
- handing the workspace to an agent.

It does this without installing Python and without leaving the editor.

---

## Contents

1. [Principles](#1-principles)
2. [Decisions](#2-decisions)
3. [Distribution: Marketplace and Open VSX](#3-distribution-marketplace-and-open-vsx)
4. [The runtime: resolution, processes, status](#4-the-runtime-resolution-processes-status)
5. [Languages, highlighting and the language server](#5-languages-highlighting-and-the-language-server)
6. [Diagnostics](#6-diagnostics)
7. [New objects: templates, placeholders, snippets](#7-new-objects-templates-placeholders-snippets)
8. [Setup wizard and onboarding](#8-setup-wizard-and-onboarding)
9. [The opentide sidebar](#9-the-opentide-sidebar)
10. [Panels: graph, ATT&CK matrix, search, query results, deploy plan](#10-panels)
11. [Every CLI command has a home](#11-every-cli-command-has-a-home)
12. [Agents](#12-agents)
13. [Trust, remote and web](#13-trust-remote-and-web)
14. [Quality bar: performance, accessibility, tests](#14-quality-bar)
15. [What this needs from opentide and language-server](#15-what-this-needs-from-opentide-and-language-server)
16. [Milestones and issues](#16-milestones-and-issues)
17. [Open questions](#17-open-questions)

---

## 1. Principles

| # | Principle | What it means in practice |
|---|-----------|---------------------------|
| P1 | **Works on install** | A machine with no Python and no opentide gets every feature, offline. |
| P2 | **The workspace's opentide wins** | When the repository has its own opentide, the editor uses it, so the editor checks what CI checks. |
| P3 | **Every action is a real opentide command** | The UI collects input, runs `opentide --json …`, and shows the command line it ran, ready to copy into a terminal or CI. The extension reimplements no check, no generator and no deploy logic. |
| P4 | **One finding, one squiggle** | A problem shows once in the Problems panel, whether the language server or `opentide validate` found it. |
| P5 | **Nothing touches a tenant without a click** | Commands that contact a platform carry a globe icon and say which tenants they reach. Nothing deploys for real from the editor (D6). |
| P6 | **Native first** | Tree views, quick picks, Problems, tasks, walkthroughs and the Testing view come first. Webviews are only for what VS Code cannot draw: the graph, the ATT&CK matrix, result tables and the wizard. |
| P7 | **Honest capabilities** | A platform that opentide cannot validate or query gets no such button. The UI says why instead, as the CLI does (`can_validate`, `can_query`). |
| P8 | **Fast feels finished** | Typing gets answers from the language server in milliseconds. Catalogue data refreshes in the background, and no UI action blocks on a process. |

---

## 2. Decisions

### D1. Bundle a complete opentide runtime in each per-platform package

**This reverses the epic's decision.** #1 shipped only the `opentide-lsp` binary and left everything else to a user-installed opentide. That breaks P1 in exactly the moment that matters most:

- The setup wizard runs for people who have no detection repository yet, so they also have no opentide in an environment.
- Without opentide, the epic's fallback had no commands, no `new`, no validation, no configuration checks and no MCP.

Each per-platform VSIX therefore carries a CPython runtime and the opentide closure: the opentide wheel, which already contains the analysis engine as `opentide._native`, plus its dependencies.

**What the size is of.** The size that matters is the **VSIX**: the zip a user downloads per platform, on install and again on every update. It holds:
- the CPython runtime;
- opentide and its dependencies (about 80 packages);
- the extension's own code, webviews and grammars, which add a few MB.

On disk it unpacks to two to three times that.

**Measured** on linux-x64, 2026-11-03: python-build-standalone CPython 3.13.14 (`install_only_stripped`) and opentide 0.20.1 from PyPI. Each bundle was zipped as a VSIX is (per-file deflate, level 9), and the trimmed bundle ran `opentide validate` on a test workspace.

| Bundle | VSIX (zipped) | Installed |
|--------|--------------:|----------:|
| Runtime + opentide closure, as published today | 136 MB | 333 MB |
| Trimmed runtime (no duplicate shared `libpython`, Tk, headers, `pip`, `idlelib`, `ensurepip`) + closure without pandas, numpy and openpyxl | 83 MB | 181 MB |
| …and without boto3 and botocore | 67 MB | 150 MB |

What is behind those numbers:
- **pandas and numpy** are 102 MB installed. opentide imports them in only one deploy-planning helper and a deprecated export.
- **boto3 and botocore** are 31 MB installed. They are not imported by opentide at all: only the Carbon Black SDK requires them.
- **What remains:**
  - the interpreter, about 31 MB (one static binary);
  - the analysis engine (`opentide._native`), 16 MB;
  - cryptography, 15 MB;
  - the platform SDKs, pydantic-core, dulwich and pygments, a few MB each.
- **Other targets:** the compressed runtime alone is 33 MB on Linux, 24 MB on macOS arm64 and 21 MB on Windows x64 (`tar.gz` downloads). The other targets' full bundles are not measured yet.

**Size budget:**
- 100 MB per VSIX, enforced in CI; the target is 70 MB.
- Today's closure (136 MB) does not fit. Removing pandas and numpy from opentide's required dependencies is a prerequisite of M0 ([§15](#15-what-this-needs-from-opentide-and-language-server), O1).

**Store limits:**
- The Marketplace documents no hard cap. Microsoft's publishing guidance says to optimise a package over 50 MB ([Microsoft Learn](https://learn.microsoft.com/azure/devops/extend/publish/overview)).
- Open VSX has rejected packages above about 250 MB ([open-vsx.org#8724](https://github.com/EclipseFdn/open-vsx.org/issues/8724), [konveyor#1494](https://github.com/konveyor/editor-extensions/issues/1494)).

Both stores accept the budget, but [M0](#16-milestones-and-issues) proves it with a real publish.

**Why not download the runtime on first use** (uv, PyPI, python-build-standalone):
- Detection teams often sit behind TLS-inspecting proxies, private package mirrors or no internet at all.
- The VSIX has already passed the organisation's extension channel (the Marketplace, Open VSX or a private gallery), so a runtime inside it needs nothing else to be allowed.
- A runtime inside the VSIX is also auditable: pinned, hashed, with an SBOM.

**What the earlier objections become:**
- **"The tools template can't carry it."** We don't use the template. We ship our own interpreter, so `pip --implementation py` does not apply.
- **"It can't follow the repository's pin."** P2 handles this: a workspace opentide always wins. The bundled runtime is the out-of-box tier, and the status item says when its version differs from the repository's pin ([§4](#4-the-runtime-resolution-processes-status)).
- **"We own CPython and dependency security updates."** Yes. Each release rebuilds the closure from a hashed lock, and Dependabot watches the lock. That is the price of P1, and it is paid in CI, not by users.

### D2. Almost every action runs opentide in Python, so one warm process serves them

**What needs the runtime.** Nearly everything.

| Works without the Python runtime | Needs it |
|----------------------------------|----------|
| TextMate highlighting, language ids and file associations, language configuration (comments, brackets), placeholder decorations, the workspace's snippet file, walkthrough text, the empty shells of the panels | Everything else, including: the language server itself (`opentide lsp start` is a Python host around the Rust engine), so diagnostics, hover, completion and semantic tokens; configuration checks; every command; all catalogue data (sidebar, graph, matrix, search); MCP |

So without a runtime the extension is a grammar pack and says so. That is the universal package with no opentide installed, and the web.

**What a Python process costs.** Measured on a 500-rule workspace, linux-x64, 4 CPUs, opentide 0.20.1:

| Process | Time | Memory (RSS) |
|---------|-----:|-------------:|
| `opentide lsp start`, first diagnostics, first start (catalog generated, then cached) | 3.0 s | 188 MB |
| `opentide lsp start`, first diagnostics, later starts | 0.7 s | 117 MB |
| `opentide --json explain <code>` | 0.2 s | — |
| `opentide --json new rule` | 0.6 s | — |
| `opentide --json info` | 1.3 s | 95 MB peak |
| `opentide --json validate --file <rule>` | 1.5–1.7 s | 186 MB peak |
| `opentide --json validate` (all objects) | 5–10 s | 186 MB peak |

**Why spawning per action is not enough:**
- Each CLI call starts Python, imports the models and rebuilds the registry from every YAML file.
- That is fine for occasional commands, but wrong for what runs on every save or click:
  - each catalogue refresh or validate-on-save costs 1.3–1.7 s and 100–190 MB, once per workspace folder;
  - the CLI reads only the disk, so it never sees an unsaved buffer;
  - the language server's index, each CLI run and the MCP server's cache are three registries that can disagree.
- On Windows, Python start-up is slower, and endpoint security scans the bundle's 7,500 files on first use.

**Decision: three channels.**

| Channel | Process | Serves |
|---------|---------|--------|
| Language server | One `opentide lsp start` per window. It holds per-folder state; never start one per folder | Everything while typing: diagnostics, hover, completion, outline, links, lenses, inlay hints, quick fixes, semantic tokens |
| **Backend** | One `opentide serve` per window (new in opentide, [§15](#15-what-this-needs-from-opentide-and-language-server) O12). It is JSON-RPC over stdio and runs CLI commands **in-process**: a CLI argv in, the same `--json` document out. Imports and the registry stay warm, and are invalidated by the file changes the extension forwards. `opentide tui` already works this way, calling the same service functions as the CLI | What runs on every save or click: catalogue data for the sidebar, graph, matrix and search (`info catalog`); validate and lint on save; `explain`; `new`; `info` |
| CLI spawn | `opentide --json <command>` per action | Long or outward-facing commands, where a process of their own is the point: `setup`, `generate`, `query`, `deploy --dry-run`, `doctor`, `migrate`, the generic runner's terminal mode. Also **everything**, as the fallback when the active opentide has no `serve` (an older opentide in tier 1 or 2) |

- **P3 holds for both.** A backend request is a CLI argv, and the UI shows it as the command line to copy.
- **Why the backend is a process of its own,** not requests on the language server:
  - A failing command never takes down editing.
  - The language server stays the engine's protocol, shared with Helix, Neovim and Zed.
- **The cost** is two Python processes per window, about 250–400 MB together, plus a third (MCP) while an agent uses it. If memory turns out to be the problem, the backend's requests can move into the language server's host later behind the same client API.

**Capability gating.**
- The extension reads `opentide --json commands` once per opentide version, cached by version.
- It enables each feature only when the commands and options it needs exist. A feature the active opentide is too old for says which version it needs, instead of failing.
- **TypeScript types** for every document are generated at build time from the `output_schema`s in that tree. A contract test validates real output from the pinned opentide against them.

### D3. The UI never writes workspace files itself

Files are created and changed by opentide commands, or by text edits the user applies: quick fixes, snippets, code actions. Settings are the exception: VS Code's own settings and SecretStorage. This keeps the UI and the CLI from drifting apart, and keeps every change something a reviewer can reproduce.

### D4. Native UI first, webviews where native cannot draw

- **Webviews:** the graph, the ATT&CK matrix, query results, the deploy plan and the setup wizard.
- **Native:** everything else, including payloads and compiled queries. They open as read-only virtual documents (`opentide-payload:`, `opentide-compiled:`) in a normal editor, with its search, folding and copy.

### D5. One finding, one squiggle

See [§6](#6-diagnostics). The language server owns open files. `opentide validate` adds only what the language server did not report.

### D6. No real deploys, pushes or retractions from the editor at 1.0

`opentide deploy` sends at once: it has no confirmation, no `--yes` and no per-rule scope. In the opentide workflow, deployment is a reviewed CI step. So at 1.0:

- **The editor previews.** It runs `deploy --dry-run` and `share preview`.
- **CI executes.** A real deploy, `share push`, `share retract` and `deploy migrate-state` are not offered from any menu.
- **The generic command runner** ([§11](#11-every-cli-command-has-a-home)) can still run them, behind a modal confirmation that names the platform and tenants.

Whether to add a gated "deploy to a development tenant" later is an [open question](#17-open-questions).

---

## 3. Distribution: Marketplace and Open VSX

**Requirement:** every release is published to both the Visual Studio Marketplace and Open VSX. Open VSX is how Cursor, Windsurf, VSCodium, Gitpod, Theia and other forks install extensions. For an agentic detection-engineering tool, those editors matter as much as VS Code.

### Packages

| Package | Contents | Who gets it |
|---------|----------|-------------|
| 8 per-platform VSIX (`vsce package --target`) | Extension, grammars, the **bundled opentide runtime** for that target, licences and SBOM | win32-x64, win32-arm64, linux-x64, linux-arm64, alpine-x64, alpine-arm64, darwin-x64, darwin-arm64 |
| 1 universal VSIX | Extension and grammars, no runtime. Uses the workspace's opentide or `opentide.path`, and says plainly when there is none | Every other target, and the web entry ([§13](#13-trust-remote-and-web)) |

- **win32-arm64** needs opentide `win_arm64` wheels, which opentide does not build today ([§15](#15-what-this-needs-from-opentide-and-language-server)). Until then that target gets the universal package.
- **No `opentide-lsp` binary** in the per-platform packages. The bundled opentide contains the same engine, so a second copy would be about 20 MB for nothing. `opentide.path` may still name an `opentide-lsp` binary for people who want the bare server.

### Building the runtime

- **Interpreter:** python-build-standalone `install_only_stripped`, less what opentide never loads: the duplicate shared `libpython` (the `python` binary is static), Tk and Tcl, headers, `pip`, `idlelib`, `ensurepip`, `turtledemo`. The version is the newest CPython for which every closure package has a wheel on all eight targets (3.13 at the time of writing).
- **Closure:** resolved per target from a committed, hashed lock:
  - `uv pip compile --python-platform <target> --generate-hashes`;
  - installed with `--require-hashes --only-binary :all:`. An sdist is never built; a missing wheel fails the build.
- **Pins:**
  - The bundled opentide version is pinned in this repository, as opentide pins its engine. A bump is a PR.
  - The highlights zip version is **derived** from the engine pin inside that opentide, never chosen separately, so grammar colours and semantic tokens come from the same engine.
- **At runtime:** the interpreter runs isolated (`-I`), with `-X pycache_prefix=<globalStorage>/pycache`, so the extension folder stays read-only and no `PYTHON*` variable or user site leaks in. The first activation compiles bytecode in the background.
- **Size gate:** CI fails a package over 100 MB and reports each package's size and its five largest directories on the PR.

### Publishing and supply chain

- **OIDC, no long-lived token.** Global Azure DevOps PATs retire on 2026-12-01. Commands as in #9:
  - Marketplace: `vsce publish --oidc --packagePath dist/*.vsix --skip-duplicate`;
  - Open VSX: `ovsx publish --trusted-publishing --skip-duplicate`.
- **Namespace:** claim the Open VSX namespace before the first publish.
- **Pre-releases** use odd minor versions with `--pre-release`. Stable uses even minor versions.
- **Release cadence:** every update re-downloads the runtime for every user, so stable releases follow opentide releases and fixes, not every merge.
- **Each VSIX carries:**
  - a CycloneDX SBOM of the closure and the interpreter;
  - `THIRD-PARTY-NOTICES` generated from the closure;
  - a GitHub artifact attestation.
- **Licences:** the extension is MIT. The bundled opentide and engine are EUPL-1.2, and CPython is under the PSF licence. They ship as separate programs that the extension runs, each with its own licence files. This needs the licence review that #6 already calls for.
- **Smoke test** each package on a clean runner of its target (Alpine in a container):
  1. install the VSIX;
  2. run the bundled `opentide --version` and `opentide --json doctor --offline`;
  3. start `opentide lsp start` and check `capabilities.experimental.opentide.host.name == "opentide"` and that `engine` equals the pin.

### Store listing

- **Identity:** display name `opentide`, publisher to be decided ([§17](#17-open-questions)).
- **Categories:** Programming Languages, Linters, Snippets, AI.
- **Keywords:** detection engineering, detection as code, KQL, SPL, ES|QL, Sentinel, Defender, Splunk, Elastic, Falco, MITRE ATT&CK.
- **README:** short GIFs of the five moments in [§8](#8-setup-wizard-and-onboarding).
- **Icon:** 128×128 PNG, well under the Marketplace's 1 MB icon limit.
- **Compatibility:**
  - `engines.vscode` is the lowest version `vscode-languageclient` needs.
  - Newer APIs are feature-detected, not required: the MCP provider, Python Environments, the tree find widget. Forks lag behind VS Code, and a high floor would keep the extension out of them.

---

## 4. The runtime: resolution, processes, status

### Resolution (revises #3)

The first tier that answers wins:

| Tier | Source | Trust | Features |
|-----:|--------|-------|----------|
| 1 | `opentide.path`: an `opentide` executable (`lsp start`), or an `opentide-lsp` executable (`--stdio`, editor features only) | Trusted only | All, or editor only for `opentide-lsp` |
| 2 | The workspace's environment: Python Environments API, else the Python extension API, else `.venv`, else `PATH`. Re-resolved on `onDidChangeEnvironment` | Trusted only | All |
| 3 | uv with the repository's pin: `uv tool run --from opentide==<pin>`. **Opt-in**: offered when the repository pins a version the bundled runtime does not match | Trusted only | All |
| 4 | **The bundled runtime** | Always; the only tier in Restricted Mode | All when trusted; the language server only in Restricted Mode |

- **Minimum versions:** tiers 1–3 must be an opentide released after opentide#734. An older one is refused with the upgrade command, and tier 4 takes over.
- **Pin mismatch:** when the repository pins opentide (`pyproject.toml`, `requirements*.txt`, `uv.lock`) and the active tier's version differs, the status item shows `0.21.0 · repo pins 0.20.1`. It offers "Use the pinned version" (tier 3) and "Create .venv with the pinned version" (`uv venv` + install, or the Python extension's create-environment command).

### Processes

| Process | Lifetime | Environment |
|---------|----------|-------------|
| `opentide lsp start` | One per window; restarted by "opentide: Restart Server" and by interpreter or settings changes | `OPENTIDE_OUTPUT=mcp` is implied. Never credentials |
| `opentide serve` (D2) | One per window, started on the first request; restarted with the language server, and after a crash on the next request | As for a CLI command; credentials only on requests that contact a tenant |
| `opentide --json <cmd>` | One per action, or every action when the runtime has no `serve` | `OPENTIDE_REPO_ROOT=<folder>` (multi-root: the folder the action is about); `NO_COLOR=1`; VS Code's `http.proxy` passed as `OPENTIDE_PROXY`; credentials from SecretStorage, only for commands that contact a tenant |

- **Concurrency:** at most one command that writes the workspace runs at a time; others queue. Read-only commands run concurrently.
- **File changes:** the extension forwards create, change, delete and rename events under the object folders and `.opentide/` to `opentide serve`, which drops what they invalidate. Saves are debounced by 300 ms.
- **Cancellation:** a running command can be cancelled. On POSIX the extension sends SIGINT (exit 130), so CrowdStrike stops its search job. On Windows it ends the process tree, and the UI says a started vendor search may run on until it times out.
- **Logging:** every run goes to the `opentide` output channel: command line (secrets redacted), folder, duration, exit code, and `failure.code` when there is one.

### Status

- **Status bar item:** runtime and catalogue health, `$(opentide-logo) 0.21.0 ✗ 2 ! 5`. Clicking it opens a menu: Validate workspace, Run doctor, Show output, Restart server, Switch runtime….
- **Language status item** (as in #3): reads `capabilities.experimental.opentide` and infers nothing. It shows:
  - `host`, `engine`, `catalog`, `configurationChecks`, `configurationSchemas`;
  - the tier, and the interpreter path.

---

## 5. Languages, highlighting and the language server

**Requirement 2.** Issues #4 and #5 stand as written. The additions:

- **Language ids** are the server's: `opentide-yaml`, `opentide-config`, `kql`, `spl`, `esql`, `eql`, `kuery`, `lucene` and `falco`. Never `sql`.
- **Object folders.** `opentide-yaml` applies to `**/objects/**/*.{yaml,yml}`, and to the object folders `paths.toml` names, set on open with `languages.setTextDocumentLanguage`.
- **Grammars** are copied from the language-server highlights zip at build time:
  - The zip version is derived from the bundled engine (§3).
  - The build checks the zip against a SHA-256 recorded in this repository. Language-server publishes no checksums today ([§15](#15-what-this-needs-from-opentide-and-language-server)).
- **The ES|QL scope collision.** The generated `esql.tmLanguage.json` has scope `source.esql`, Elastic's own scope. `docs/EDITORS.md` promises `source.opentide.esql`. Fix it in language-server. Until then, the build script renames the scope and fails if the grammar refers to `source.esql` anywhere else.
- **Language configuration** (comment tokens, brackets, auto-closing pairs) for the query languages is written in this repository. The zip carries none, and these files are configuration, not grammars.
- **Reference lens:** register the `opentide.showReferences` command the server's lens runs. Map it to `editor.action.showReferences` after converting `[uri, position, Location[]]`.
- **Fix all:** `source.fixAll.opentide` is available on demand. It runs on save only when the user sets `editor.codeActionsOnSave` to `"explicit"`. The contributed default is `"never"`.
- **Not supported by the server**, and not faked in the client: rename, formatting, call hierarchy.

### What the extension adds on top of the server

| Feature | Where | Source |
|---------|-------|--------|
| **Query lenses** above each query block: `▶ Run query` (platform `can_query`, tenants configured), `✓ Validate on tenant` (`can_validate`), `⧉ Copy compiled query` (KQL, SPL) | Rule files and query files | Query ranges from the server's `documentSymbol` (String nodes, `detail` = language). Compiled text from `opentide/compiledKql` / `opentide/compiledSpl` |
| **Editor title actions:** Validate file, Show in graph, Preview deploy (rules), Open generated doc | Object files | CLI |
| **Breadcrumbs and outline** | Object files | Server `documentSymbol` (free) |
| **Deployment state** in the catalogue tooltip and a status entry for the active rule: `Sentinel ✓ prod · Splunk —` | Rule files | `info catalog` ([§15](#15-what-this-needs-from-opentide-and-language-server)), from `.opentide/states/deployment/` |
| **Placeholder navigation** | Files with `# opentide:placeholder` | [§7](#7-new-objects-templates-placeholders-snippets) |

---

## 6. Diagnostics

**Requirement 5:** errors, warnings and notes appear in VS Code exactly where and how often they should.

### Sources

| Collection | Producer | Covers | When |
|------------|----------|--------|------|
| `opentide` | The language server, pulled | Open files: objects, embedded queries, query files, configuration TOML | As you type |
| `opentide validate` | `validate` (and `--file`), through `opentide serve` | Every object file, open or not, and checks the server does not run: platform enablement, configuration-wide checks, `cve`, `sharing-config` | On save of an object or configuration file (`opentide.validate.onSave: file` by default; `workspace` or `off`); on "Validate workspace"; on activation (`opentide.validate.onStartup`, default on) |
| `opentide lint` | `lint` (and `--file`, O11), through `opentide serve` | Filenames, recommended metadata, placeholders, query style | On demand, and with workspace validation when `opentide.lint.withValidate` is on |

### Rules

1. **Deduplicate on the validate side.** A validate or lint finding is dropped when the `opentide` collection has a diagnostic with the same file, `code` and start line, as `opentide tui` does. The extension owns these two collections, so this needs no language-client middleware, and #5's rule (no middleware on `publishDiagnostics`) holds.
2. **Stale is worse than missing.** Editing a file clears its `opentide validate` and `opentide lint` entries until the next run. The language server covers it meanwhile.
3. **Ranges:**
   - CLI positions are 1-based, in code points.
   - Convert them against the document text to VS Code's 0-based UTF-16 positions. This matters on lines with emoji and other astral characters.
   - A validate finding has no `end_line`, so its range is (`line`, `column`)–(`line`, `end_column`). A finding without a column covers its line.
4. **Severity:**

   | opentide severity | VS Code severity |
   |-------------------|------------------|
   | `error` | Error |
   | `warning` | Warning |
   | `info` | Information |
   | `note` / hint | Hint |

   `--strict` changes the exit code, not the severities, so it is a separate gate (`opentide.validate.strict`) used only for the status colour.
5. **What each diagnostic carries:**
   - `source`: `opentide`, `opentide validate` or `opentide lint`;
   - `code`: `{ value, target }`, with the target `https://opentide.org/docs/cli/diagnostics/#<code>`;
   - the `Deprecated` tag for deprecation codes;
   - `relatedInformation` (for example, the other file of a `duplicate_id`).
6. **Quick fixes:**
   - Each `fix.edits[]` becomes a quick fix.
   - `safe: true` fixes are also offered together as "Fix all safe opentide problems in file / workspace".
   - Every diagnostic gets **"Explain <code>"**. It runs `opentide --json explain <code>` and opens the markdown in a preview beside the file. It works offline, from the bundled docs.
7. **Files that fail to load** (`yaml_parse`, `config_parse`) are errors at the line and column the CLI reports, never a silent gap in the catalogue.
8. **Counts:**
   - The status bar shows the union of the three collections.
   - The catalogue tree badges each object with `✗ n` / `! n`.
   - Notes are shown but not counted, as in the TUI.

### Done when

- [ ] A rule with a bad vocabulary value and a broken query shows two problems, not four, with the language server's live diagnostics and a validate run both active.
- [ ] Applying the `vocab_unknown` quick fix from validate's `fix` clears the problem on the next keystroke (live) and on the next save (validate).
- [ ] A finding after an emoji on the same line underlines the right characters.
- [ ] "Explain" works with networking disabled.

---

## 7. New objects: templates, placeholders, snippets

**Requirement 6.** `opentide new` is the only thing that creates an object. The extension makes it the fastest path to a valid file.

### Entry points

All of these run the same flow:

- the command palette: "opentide: New Detection Object…", "New Threat…", "New Objective…", "New Rule…";
- the `+` button on the Catalogue view;
- **File › New File…** (`contributes.menus["file/newFile"]`): Threat, Objective and Rule;
- the Explorer context menu on an object folder (prefills `--path`);
- the catalogue and graph context menus: on a threat, "New objective for this threat"; on an objective, "New rule for this objective";
- a code action in an objective file: "Create a rule for this objective".

### The flow

A multi-step quick input, with back navigation:

```text
New rule ─────────────────────────────────────────────── 1/4
 Name   Suspicious LSASS Access
        → objects/rules/suspicious-lsass-access.yaml

New rule ─────────────────────────────────────────────── 2/4
 Platforms
  [x] Microsoft Sentinel           enabled · deploy · validate · query
  [x] Splunk                       enabled · deploy · validate · query
  [ ] Elastic                      not enabled here: validate will warn
  …

New rule ─────────────────────────────────────────────── 3/4
 Objective (fills detection_model)
  Detect LSASS access              04149254 · T1003.001
  Detect DCSync                    9f0c… · T1003.006
  ＋ Create a new objective…
  ─ None for now

New rule ─────────────────────────────────────────────── 4/4
 Folder  objects/rules/  (default from paths.toml)   [Choose…]
```

1. **Collect.**
   - Objectives and threats come from the catalogue data, searchable by name, UUID prefix and technique.
   - "Create a new objective…" runs the objective flow inline and returns with its UUID, and the same holds for threats.
2. **Run** `opentide --json new rule --name … --platform … --objective … [--path …]`.
3. **Open.** Open the file and select the first placeholder. A notification says `4 placeholders to replace` and offers **Next placeholder**.
4. **Handle failures** by their `failure.code`:

   | Code | What the user sees |
   |------|--------------------|
   | `workspace_not_found` | "Set up this folder" opens the wizard |
   | `reference_not_found` | The picked object vanished: refresh and pick again |
   | `path_exists` | Offer "Open existing" or "Pick another name" |
   | `path_not_writable`, `template_missing` | The CLI's message, and "Regenerate templates" |

### Placeholders

`opentide new` ends every placeholder line with `# opentide:placeholder`. The file validates, but `lint --strict` fails until each is replaced.

- **Decorations:** a background tint and a gutter marker on placeholder lines, plus an overview-ruler mark.
- **Navigation:** "Next / Previous placeholder" (`opentide.placeholder.next`, `.previous`). The keybinding is active only when the file has placeholders (context key `opentide.hasPlaceholders`). It is not Tab, which belongs to indentation and inline suggestions.
- **Status:** `3 placeholders left` while the file is active.
- **Code action:** on a placeholder line whose value has been changed, "Mark as done" removes the marker. Markers are never removed automatically.

### Templates and snippets

- **Templates** live in the workspace (`.opentide/templates/`, written by `opentide generate templates`). When `doctor`'s `templates_fresh` check fails, a notification offers "Regenerate templates, schemas and snippets" (`opentide generate templates schemas snippets`).
- **Snippets.** opentide writes `.vscode/model-templates.code-snippets` (`tide-threat`, `tide-objective`, `tide-rule`, `tide-<platform>`) with `scope: "yaml"`. **Under the extension, object files are `opentide-yaml`, so those snippets disappear.**
  - Fix in opentide: write `scope: "yaml,opentide-yaml"` ([§15](#15-what-this-needs-from-opentide-and-language-server)).
  - Until then, the extension offers the workspace's `tide-*` snippets in `opentide-yaml` files through a completion provider that reads that file.
- **Add a platform block.** A code action on `configurations:` ("Add Splunk block…") inserts the platform's `tide-<platform>` snippet. Platforms the workspace has not enabled are marked.

### Done when

- [ ] From an empty workspace after setup, File › New File › opentide Rule creates a rule that `opentide validate` passes, opens it with the first placeholder selected, and "Next placeholder" visits every marked line.
- [ ] "New rule for this objective" from the catalogue prefills `--objective`.
- [ ] `tide-sentinel` completes in an `opentide-yaml` file.

---

## 8. Setup wizard and onboarding

**Requirement 3.** Five moments define the first hour:

1. **Install.** The status item says `opentide 0.21.0 ready`, with no Python prompt.
2. **Set up.** An empty folder offers "Create a detection repository".
3. **Create.** The first rule, with placeholders to replace.
4. **Check.** Problems fill as you type, and "Validate" agrees.
5. **See.** The graph and the ATT&CK matrix show where the new rule sits.

### Triggers

- **The opentide sidebar's welcome view**, for a folder with no `.opentide/` and no `objects/`. It offers two choices:
  - **Create a detection repository here**: opens the wizard.
  - **Open an existing repository**: opens a folder.

  A CoreTIDE layout (`Objects/`, `Configurations/` or `global.toml`) gets a plain statement that opentide
  does not support it, with a link to the 0.21.0 release notes: opentide 0.21.0 removed `migrate objects`,
  and there is no migration.
- **The palette:** "opentide: Set Up Repository…".
- **Step 2 of the walkthrough.**

### The wizard

A webview stepper. It is a form over `opentide setup` flags (D3), so it writes nothing itself.

```text
┌ Set up a detection repository ───────────────────────────────────────┐
│ ① Repository  ② Platforms  ③ CI  ④ Agents  ⑤ Extras  ⑥ Review        │
│                                                                      │
│  Platforms                              deploy  validate  query      │
│  [x] Microsoft Sentinel                   ✓       ✓ KQL     ✓        │
│  [x] Microsoft Defender for Endpoint      ✓       ✓ KQL     ✓        │
│  [ ] Splunk                               ✓       ✓ SPL     ✓        │
│  [ ] Elastic                              ✓       ✓ 4 lang  ✓        │
│  [ ] CrowdStrike                          ✓       —         ✓ CQL    │
│  …                                                                   │
│                                              [Back]  [Next]          │
└──────────────────────────────────────────────────────────────────────┘
```

| Step | Fields | Flags |
|------|--------|-------|
| ① Repository | Name (defaults to the folder; required), organisation, description. Offers `git init` when the folder is not a repository | `--name`, `--org`, `--description` |
| ② Platforms | The nine platforms with their capability badges (from `opentide info`). At least one | `--platform` (repeatable) |
| ③ CI | GitHub Actions, GitLab, Azure Pipelines or later. Features: staging, inflight, promotion, sharing, explorer pages (GitHub only). Python version, default branch | `--ci`, `--staging`, `--inflight`, `--promotion`, `--sharing`, `--explorer-pages`, `--python-version`, `--default-branch` |
| ④ Agents | MCP for Cursor, Claude Code or generic hosts; skills for Claude Code, Cursor, Copilot or generic; the opentidehq/skills Agent Plugin. VS Code needs no MCP file because the extension provides the server ([§12](#12-agents)). A checkbox writes `.vscode/mcp.json` anyway, for teammates without the extension | `setup mcp --cursor --claude-code --generic [--vscode]`, `setup skills … [--plugin]` |
| ⑤ Extras | Pre-commit hooks, `.env.example` | `setup hooks`, `setup env` |
| ⑥ Review | The files each step will write, and the exact commands, with "Copy as script" | `setup --plan` ([§15](#15-what-this-needs-from-opentide-and-language-server)) |

- **Apply** runs the commands in order with `--yes --json` and shows each `steps[]` entry as it completes. On failure it stops and shows that step's `failure` with its fix.
- **On success:** reveal the Catalogue, open the README, and mark walkthrough step 2 done.
- **Existing workspace** (`.opentide/` present): the wizard opens on steps ②–⑤ to add platforms, CI or agents (`setup platforms`, `setup ci`, `setup mcp`, `setup skills`, `setup hooks`).
- **CoreTIDE layout:** not supported (opentide 0.21.0). The wizard says so before it opens, and sets up a new layout beside it only if asked to continue.

### Walkthrough

`contributes.walkthroughs`. Each step completes on the command it names.

1. **opentide is ready.** The runtime and its version. "Use my environment's opentide instead…"
2. **Set up a detection repository.** Opens the wizard.
3. **Create your first detection.** Opens the New Rule flow.
4. **Validate it.** "Validate workspace", and how Problems and Explain work.
5. **See how it fits.** Opens the graph on the new rule and the ATT&CK matrix.
6. **Preview a deploy.** Opens the deploy plan as a dry run.
7. **Bring your agent.** MCP is on; install the skills plugin.

---

## 9. The opentide sidebar

**Requirements 3 and 4.** An activity bar container, `opentide`, with five views. In a multi-root window each view groups by folder.

```text
OPENTIDE
▾ CATALOGUE                          [+] [⟳] [⋯]
  ▾ ⚠ Credential Dumping                    2 obj · 5 rules
    ▾ ◎ Detect LSASS access         T1003.001  3 rules
        ◆ Suspicious LSASS Access   ⬢ ⬡   ✗ 2
        ◆ LSASS dump via comsvcs    ⬢     ✓
    ▸ ◎ Detect DCSync               T1003.006  2 rules
  ▸ Objectives without a threat (1)
  ▸ Rules without an objective (3)
  ▸ Files that failed to load (1)
▸ COVERAGE                     212 techniques · 37 covered
▸ PLATFORMS & TENANTS
▸ HEALTH                       ✓ 15  ! 2  ✗ 1
▸ ACTIVITY
```

| View | Content | Actions |
|------|---------|---------|
| **Catalogue** | Threats → objectives → (signals) → rules, as in `opentide tui`, plus groups for objectives without a threat, rules without an objective and files that failed to load. Each rule shows its platforms (icon per block, dimmed when the status is `INERT`) and its problem badge. Group by threat chain (default), platform, status, technique or folder | Open; New…; Validate; Show in graph; Run query; Preview deploy; Copy UUID; Reveal in Explorer. The tree find widget filters by name, UUID or technique |
| **Coverage** | ATT&CK techniques named by any object: rule count, gaps (`0`) first, sub-techniques under their parent (a parent counts its sub-techniques' rules, as `info coverage` does) | Open the matrix; show the rules; "New objective for this technique" |
| **Platforms & tenants** | The nine platforms: enabled, `can_deploy`, `can_validate`, `can_query`; tenants per platform and their credential state from `doctor`'s `credentials` check | Enable a platform (`setup platforms`); open its TOML; **Set credential…**: SecretStorage, injected as the `$VAR` the TOML names (D3: never written to a file); Test connection (`doctor`) |
| **Health** | `opentide doctor` checks, pass/warn/fail/skip, each with its `fix` | Run the fix; re-run; "Copy report" (redacted) for bug reports |
| **Activity** | The last 50 commands the extension ran, with status, duration and the command line. The TUI's Results tab | Re-run; copy command; open output |

**Data:**
- The Catalogue, Coverage and search all come from **one** `info catalog` document per folder ([§15](#15-what-this-needs-from-opentide-and-language-server), O3), answered by `opentide serve` from its warm registry and cached in memory.
- **Refresh triggers:** activation; create, delete or rename under an object folder; save of an object or configuration file; after any command that writes. Refreshes are debounced by 1 s and run one at a time.
- **Until the first run returns,** the tree shows names from the server's `workspace/symbol`, so it is never empty for long.

---

## 10. Panels

**Requirement 4.** Each panel is a webview in the editor area:
- **Theming:** VS Code theme variables, including high-contrast themes.
- **Security:** a strict CSP (`default-src 'none'`, nonce scripts), no remote resources, and `localResourceRoots` limited to the bundled assets.
- **Messaging:** typed messages, validated on both sides. A webview never receives a secret, and all actions go through the extension host.
- **Components:** `@vscode-elements/elements` (MIT), since Microsoft's webview UI toolkit was retired.

### 10.1 Graph: how detections connect

```text
┌ opentide graph ── Focus: Suspicious LSASS Access ── depth 2 ── [⚙ filters] [⤓] ┐
│                                                                                │
│   ⚠ Credential Dumping ──covers──▶ ◎ Detect LSASS access ──implemented by──▶ ◆ Suspicious LSASS Access
│          │                                │                                    ◆ LSASS dump via comsvcs
│     precedes                         T1003.001                                  │
│          ▼                                                                   uses log source
│   ⚠ Lateral Movement                                                       ▣ DeviceProcessEvents
│                                                                                │
│  ● threat ● objective ● signal ● rule ● technique ● log source   ✗ has errors │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **Nodes:**
  - always: threat, objective, signal and rule;
  - optional: ATT&CK technique, actor, log source (`visibility.toml`) and platform.
- **Edges:**

  | Edge | From |
  |------|------|
  | objective → threat (covers) | `objective.threats` |
  | rule → objective or signal (implements) | `rule.detection_model` |
  | signal → parent signal | `signals[].parent` |
  | threat → threat (`chaining` relation, e.g. *precedes*) | `threat.chaining` |
  | → technique | `mitre_attack` / `techniques` |
  | signal → log source | `signals[].data.logsources` |

  These come from opentide's existing `CoverageGraph` and chaining network (`documentation/catalog.py`), not from client-side YAML parsing.
- **Modes:**
  - **Focus** (default): follows the active editor, depth 1–3.
  - **Catalogue:** everything, clustered by threat.
  - **Threat chains:** threats and their chaining only.
- **Layout:** layered left to right, threat → objective → rule (Cytoscape.js and dagre, both MIT). Techniques, log sources and platforms go in one column per kind to the right, each beside the mean of what references it: laid out by dagre, their many edges made a 1,000-node Catalogue view take minutes. Above 600 laid-out nodes dagre ranks with `longest-path`. Positions stay stable across refreshes, so the graph does not jump while you work.
- **Interaction:**
  - click opens the object at its `name:` line;
  - hover shows name, UUID, status, techniques and problems;
  - the context menu has the same actions as the catalogue (New rule for this objective, Validate, Run query, Preview deploy);
  - search highlights matches;
  - filter by platform, status, technique and "has problems".
- **Problems on the graph:** nodes with errors carry the error colour, and dangling references (`invalid_ref`) draw as dashed edges to a "missing" node.
- **Export:** SVG, PNG and Mermaid (the same syntax opentide's generated docs use).
- **Scale:** Catalogue mode handles 5,000 nodes. Above 1,000 nodes it opens in Focus mode and offers Catalogue.
- **Accessibility:** a "View as list" toggle shows the same nodes and edges as a navigable tree for keyboard and screen-reader users.

### 10.2 ATT&CK matrix

- **Layout:** tactics as columns and techniques as cells, shaded by the number of rules (0 = gap, with a distinct pattern, not colour alone). Sub-techniques expand in place.
- **Layers:** rules only; rules plus objectives without rules ("planned"); threats with no objective ("unaddressed"). These match the Navigator layer opentide exports.
- **Filters:** platform, status (exclude `INERT`), tenant.
- **Clicks:** a cell lists its rules and objectives, and opens one. "New objective for this technique" starts the flow with the technique prefilled.
- **Export:** "Export Navigator layer" runs `opentide generate exports navigator` and reveals the file.

### 10.3 Search

Three levels, from fastest to richest:

1. **Go to detection** (`Ctrl+T`, workspace symbols) comes free from the server: names, UUIDs and families.
2. **Quick search** ("opentide: Find Detection…", `Ctrl+Shift+Alt+F`, `Cmd+Shift+Alt+F` on macOS; `Ctrl+Alt+D` was taken by macOS's Dock and Xfce's Show Desktop): a quick pick over the catalogue data. Query syntax: free text, plus `type:rule`, `platform:sentinel`, `status:release`, `technique:T1003`, `tactic:credential-access`, `actor:APT29`, `tlp:amber`, `author:me`, `has:errors`, `has:placeholders`, `unreviewed:>90d`.
3. **Search panel:** the same query with facets and counts in a side list, results grouped by type, each with its techniques, platforms, status and problems.
   - Select many results, then act on them: validate them, show them in the graph, preview their deploy.
   - Saved searches are kept per workspace.

The search runs client-side on the cached catalogue (an in-memory index), so results appear as you type. `rules unreviewed` feeds `unreviewed:`.

### 10.4 Query results

Opened by a query lens, "Run query" in the catalogue or palette, or a `.kql` / `.spl` / … file.

```text
┌ Query results ── Suspicious LSASS Access ── sentinel ── last 24h ─────── [⟳] [⤓ CSV] [⤓ JSONL] ┐
│ Tenants: [prod ✓ 120 rows 1.8s] [dev ✗ 403 Forbidden]                                         │
│ ┌───────────────────────┬────────────┬─────────────────────┬──────────────────────────┐       │
│ │ TimeGenerated  ▾      │ DeviceName │ InitiatingProcess…  │ FileName                 │       │
│ ├───────────────────────┼────────────┼─────────────────────┼──────────────────────────┤       │
│ │ 2026-11-03 09:12:44   │ ws-0142    │ rundll32.exe        │ comsvcs.dll              │       │
│ …                                                                                             │
│ Showing 100 of 120 · truncated at --limit 100 · [Show up to 1000]                             │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Before running:**
  - Pick the tenant(s). Several tenants with none named is the CLI's exit-2 case, so the picker uses its `choices`.
  - Pick the window (`--since`, or `--from`/`--to`) and the limit.
  - The run button shows a globe icon and names the tenants it will contact.
- **Running** `opentide --json query --rule <uuid> | --file <rule> | <text>`. Rows arrive at the end, so the panel shows progress per tenant and a Cancel button ([§4](#4-the-runtime-resolution-processes-status)).
- **Results:**
  - one tab per tenant;
  - typed columns, sortable and filterable, with a virtual table (up to the CLI's 5,000-row limit);
  - copy a cell, a row or the table as Markdown;
  - export CSV or JSONL;
  - `sent` (the query as sent) and `vendor_query_id` in a details drawer;
  - failures show `error` and `detail`;
  - partial and truncated results are labelled.
- **Privacy:** results can hold personal data. They live in memory only, are dropped when the panel closes (`opentide.queryResults.retain`, default off), and are written to disk only by an explicit export.
- **Platforms:** Sysdig has no query runner, so it gets no button. Elastic `kuery` runs as a rule preview, which writes preview alerts. The button says so (AGENTS.md: the one write).

### 10.5 Deploy plan (dry run)

- **Opened by:** "Preview deploy" from a rule, the catalogue, the palette or the walkthrough.
- **Choices:**
  - strategy: `PREVIEW` or `RELEASE`;
  - scope: **changed rules** (the CLI's default, from the git diff) or **all** (`--all`). Per rule once opentide supports it ([§15](#15-what-this-needs-from-opentide-and-language-server)).
- **Runs** `opentide --json deploy --dry-run --strategy … [--all] [--platform …]`. No credentials are needed.
- **Shows:**
  - **Changes:** platform → tenant → rule → action (`create`, `update`, `upsert`, `disable`, `delete`), with the status.
  - **Skipped:** each rule with its reason (strategy, status, unconfigured).
  - **Missing tenants.**
  - **Diagnostics:** also added to Problems, under `opentide deploy`.
  - **Payloads:** each `api_request` opens as a read-only JSON document (`opentide-payload:`), so search, folding and copy are the editor's.
- **Footer:** the command line, and "Copy as CI step". No "Deploy" button (D6).

---

## 11. Every CLI command has a home

**Requirement 3:** all of opentide's functionality is reachable. Two mechanisms guarantee it.

### Bespoke surfaces

| CLI | Surface |
|-----|---------|
| `setup` (all subcommands) | Wizard (§8); Platforms view; palette |
| `new threat \| objective \| rule` | New object flow (§7) |
| `validate`, `validate --file`, `validate --fix`, `validate --fix --dry-run` | Problems (§6); "Validate file / workspace"; "Fix all safe problems" shows the `--fix --dry-run` diff first, then applies |
| `validate query` (offline, `--live`, `--changed`) | Query lens "Validate on tenant"; palette "Validate changed queries on tenants" |
| `lint`, `lint --fix` | Problems; "Fix filenames" shows the renames first |
| `info`, `info coverage`, `info vocab` | Catalogue, Coverage, Platforms; "Show vocabulary…" opens a vocabulary as a read-only document |
| `query` | Query results panel (§10.4) |
| `deploy --dry-run` | Deploy plan panel (§10.5) |
| `generate` and its phases; `generate docs`, `exports`, `explorer`, `extract` | Palette "Generate…" with the phases as a multi-pick; "Open generated docs" (Markdown preview); `extract` is marked as contacting tenants |
| `rules unreviewed` | Search `unreviewed:`; Catalogue badge; palette "Show unreviewed rules" |
| `share preview`, `share status`, `share targets` | Palette and Catalogue context menu (TLP-aware) |
| `doctor` | Health view |
| `explain` | "Explain" on every diagnostic; palette "Explain a code…" |
| `lsp start`, `mcp start` | The extension's own processes (§4, §12) |
| `tui` | "Open opentide TUI in terminal" |
| `commands` | The generic runner, below |

### The generic runner, for everything else and everything new

"opentide: Run Command…" builds its menus from `opentide --json commands` for the active runtime:

1. Pick a command. The list shows each command's summary.
2. Fill required options. Choices come from the schema; paths from a file picker; UUIDs from the catalogue.
3. Optionally, "Add options…" adds more flags.
4. Choose where to run: **in the background** (`--json`, with the result shown as a document and in Activity) or **in a terminal** (human output, colours, prompts).

**Every command is classified in this repository:**

| Class | Behaviour |
|-------|-----------|
| `read-only` | Runs as picked |
| `writes-workspace` | Runs as picked; the files it wrote are listed afterwards |
| `contacts-tenant` | Globe icon; names the tenants first |
| `deploys` or `shares` | Modal confirmation naming platform, tenants and rule count (D6) |

A test runs `opentide --json commands` for the pinned opentide and **fails when a command is not classified**. A new opentide command can therefore never appear in the UI unclassified, and the runner covers it on the day it ships.

### Tasks, terminal and keybindings

- **Tasks:** a task provider (`type: "opentide"`, `command`, `args`) for validate, lint, generate, dry-run deploy and query, for `tasks.json`, keybindings and pre-launch chains.
  - The `$opentide` problem matcher reads the human code frames (`error[code]: message` / `╭─▶ path:line:column`), so a task run in the terminal also fills Problems.
- **Terminal `PATH`:** when the active runtime is the bundled one and no `opentide` is on `PATH`, the integrated terminal gets it prepended (`environmentVariableCollection`, `opentide.terminal.addToPath`, default on). `opentide …` then works in the terminal for people and for terminal agents.
- **Terminal links:** object UUIDs open the object, and `error[<code>]` opens Explain.

---

## 12. Agents

Revises #6.

- **MCP server provider:**
  - Registered with `vscode.lm.registerMcpServerDefinitionProvider` when the API exists and the runtime resolved: `McpStdioServerDefinition("opentide", <runtime>, ["mcp", "start"], { OPENTIDE_REPO_ROOT })`.
  - With the bundled runtime this works on install, so every VS Code agent gets opentide's tools with no `.vscode/mcp.json`.
  - The label `opentide` deduplicates against workspace MCP files.
  - The setting `opentide.mcp.provide` takes `auto`, `always` or `never`. `auto` provides nothing when a workspace MCP file already defines `opentide` with a command VS Code can start (an absolute path that exists, a name on `PATH`, or one with `${…}` variables). An entry whose command is not found, such as `setup mcp --vscode`'s `opentide` for a user with only the bundled runtime, is skipped with a log line, and the extension provides its server.
  - Off in Restricted Mode.
- **Forks without the provider API** (Cursor, Windsurf): the Agents step of the wizard and the walkthrough offer "Add opentide to Cursor's MCP settings".
  - This is a **user-level** entry pointing at the resolved runtime's absolute path, because a committed `.cursor/mcp.json` with `command: opentide` fails for teammates without opentide on `PATH`.
  - The project file is still offered for teams that install opentide.
- **Skills:**
  - Recommend the opentidehq/skills Agent Plugin from the wizard and the walkthrough.
  - Embedding the skills (`chatSkills`) still waits for the licence review in #6.
- **Language-model tools**, for live editor state only, with names prefixed `opentide_`:
  - `opentide_open_file_diagnostics`: the merged collections for a file;
  - `opentide_active_object`: the object, its UUID and its graph neighbourhood.

  Catalogue, validation and deployment stay on MCP. There is no chat participant.

---

## 13. Trust, remote and web

Revises #8 and #10.

- **Restricted Mode:**
  - Only the language server runs, from the bundled runtime.
  - No workspace interpreter, no uv, no `opentide.path`, no CLI commands, tasks, panels or MCP.
  - It runs with `PATH` limited to the runtime's own `bin`, so a subprocess such as `git` would fail rather than run workspace-controlled configuration (`core.fsmonitor`). A Restricted Mode test asserts the server spawns nothing.
  - The views show "Trust this folder to load the catalogue".
  - `onDidGrantWorkspaceTrust` restarts on the best tier.
  - `restrictedConfigurations` lists `opentide.path`, `opentide.interpreter`, `opentide.uv.*`, `opentide.mcp.provide`, `opentide.envFile` and `opentide.terminal.addToPath`.
- **Remote:**
  - `extensionKind: ["workspace"]`.
  - The per-platform package for the remote's target installs there: SSH, WSL, Dev Containers (Alpine included) and Codespaces. The bundled runtime runs on the remote.
- **Settings scopes:**
  - `opentide.path` and `opentide.interpreter` are `machine-overridable` and not synced.
  - Credentials live in SecretStorage, per workspace, and are never synced.
- **Optional `.env` file:** `opentide.envFile` (trusted only, default none) loads `$VAR`s for tenant credentials, because opentide reads only the process environment.
- **Telemetry:** none.
- **Web** (vscode.dev, github.dev):
  - The universal package's `browser` entry gives grammars, semantic tokens from the WASM highlighter, and later the wasip1 language server behind a setting, as in #10.
  - No Python means no commands and no panels ([D2](#d2-almost-every-action-runs-opentide-in-python-so-one-warm-process-serves-them)). The status item says so.
  - A later `opentide/catalog` request in the language server would bring the Catalogue, search and the graph to the web.

---

## 14. Quality bar

### Performance budgets

These are measured in CI on a 500-object fixture.

| Moment | Budget |
|--------|-------:|
| Activation, until commands and views are registered (no process start on the critical path) | < 300 ms |
| First diagnostics after opening a rule: the first start ever (the catalog is generated) / later starts (measured 3.0 s / 0.7 s at 500 rules) | < 4 s / < 1 s |
| Live diagnostics after a keystroke | < 150 ms |
| Catalogue refresh after a save, from `opentide serve` (spawning: 1.3 s) | < 300 ms |
| Validate on save of one file, from `opentide serve` (spawning: 1.5–1.7 s) | < 500 ms |
| Memory: language server + backend, per window, 500 rules | < 400 MB |
| Quick search results per keystroke (client-side index) | < 50 ms |
| Graph Focus mode render, from cached data | < 300 ms |
| First command after install (bytecode compile, endpoint scanning), Windows included | < 5 s |

### Accessibility

- Every webview action is reachable by keyboard.
- Visible focus, ARIA labels and roles on custom controls.
- Colour is never the only signal (gaps, errors).
- High-contrast themes are tested.
- The graph has its list view.

### Tests

| Layer | Tool | Covers |
|-------|------|--------|
| Unit | `@vscode/test-cli` | Range conversion (code points → UTF-16), deduplication, severity mapping, command classification, search query parsing |
| Contract | The pinned opentide | Every `--json` document the extension reads validates against its `output_schema`; `opentide --json commands` is fully classified |
| Integration | `@vscode/test-electron` | Each tier with a fake executable; the bundled runtime end to end; the lens, fix-all, multi-root and refresh cases from #5; new → placeholder navigation; validate dedupe |
| Restricted Mode | `.vscode-test.mjs` label | Only the language server starts; no restricted setting is read; no subprocess is spawned |
| Webviews | Playwright against the built webview bundles | Graph, matrix, results, wizard: rendering, keyboard paths, axe accessibility checks |
| Packages | Smoke test per target (§3) | Install, `doctor --offline`, LSP `initialize` host and engine |

CI runs {ubuntu, macos, windows} × {minimum engine, stable, insiders}, with Xvfb on Linux, as #2 says.

---

## 15. What this needs from opentide and language-server

Each item names the milestone that needs it. Items marked *nice* have a workaround in the extension.

### opentide

| # | Change | Why | Needed by |
|---|--------|-----|-----------|
| O1 [opentide#747](https://github.com/opentidehq/opentide/issues/747) | Move pandas, numpy and openpyxl out of the required dependencies: replace `deployment/planning.py`'s `_json_normalize`, and drop or move the deprecated playbook-map export. Check whether the Carbon Black SDK works for opentide's calls without boto3 and botocore (31 MB, never imported by opentide) | The bundle is 136 MB with them and 83 MB without pandas and numpy (67 MB without boto3 too); the budget is 100 MB (D1) | **M0** |
| O2 [opentide#748](https://github.com/opentidehq/opentide/issues/748) | Build `win_arm64` wheels | The win32-arm64 package | M0 *nice* (universal package until then) |
| O3 [opentide#749](https://github.com/opentidehq/opentide/issues/749) | `opentide --json info catalog`: one row per object (uuid, type, schema, name, path and line, platforms with status and deployment state, own and inherited techniques, tactics, actors, tlp, author, modified, reviewed, load errors), plus `edges[]` (`from`, `to`, `kind`, `field_path`) from `CoverageGraph` and the chaining network, plus the ATT&CK skeleton (tactics, techniques, names) for gaps | One document feeds the Catalogue, Coverage, search, graph and matrix. Today `info` returns UUID lists only, and the explorer bundle is undocumented and O(n²) | M2 |
| O4 [opentide#751](https://github.com/opentidehq/opentide/issues/751) | `opentide setup --plan` (a dry run: the files each step would write), and the MCP and skills choices as flags on the parent `setup` | Wizard step ⑥ Review; one command instead of three | M2 |
| O5 [opentide#752](https://github.com/opentidehq/opentide/issues/752) | Generated snippets use `scope: "yaml,opentide-yaml"` | Snippets vanish in `opentide-yaml` files | M1 *nice* (client workaround) |
| O6 [opentide#752](https://github.com/opentidehq/opentide/issues/752) | `setup vscode` recommends the extension, and stops writing `yaml.schemas` and recommending `redhat.vscode-yaml` when the extension is in use | They contradict language-server's `EDITORS.md` (an existing epic follow-up) | M1 |
| O7 [opentide#753](https://github.com/opentidehq/opentide/issues/753) | `deploy --dry-run` scoped to one rule (`--uuid` / `--file`) | "Preview deploy" on a single rule | M2 *nice* (changed or all until then) |
| O8 [opentide#754](https://github.com/opentidehq/opentide/issues/754) | A way to list tenants and the variables they need (`info --platform` or `doctor`'s `credentials` subjects, in a stable shape) | The Platforms view without parsing TOML in the client | M2 |
| O9 [opentide#755](https://github.com/opentidehq/opentide/issues/755) | An `end_line` on validate and lint findings | Multi-line ranges | M1 *nice* |
| O10 [opentide#756](https://github.com/opentidehq/opentide/issues/756) | Progress events for long commands (NDJSON on stderr under `--json`, or a documented `OPENTIDE_LOG_JSON` event set) for `generate`, `validate`, `query` and `deploy` | Progress bars instead of spinners | M2 *nice* |
| O11 [opentide#755](https://github.com/opentidehq/opentide/issues/755) | `lint --file` | Lint on save for one file instead of 5.6 s for the workspace | M1 *nice* |
| O12 [opentide#750](https://github.com/opentidehq/opentide/issues/750) | `opentide serve`: JSON-RPC over stdio that runs CLI commands in-process (argv in, the `--json` document out) with imports and the registry kept warm, invalidated by file-change notifications, and cancellable per request | Each spawned command re-imports and rebuilds the registry: 1.3–1.7 s and 100–190 MB per save or click at 500 rules (D2) | M1 (validate on save), M2 (sidebar and panels); spawning is the fallback |

### language-server

| # | Change | Why | Needed by |
|---|--------|-----|-----------|
| L1 [language-server#195](https://github.com/opentidehq/language-server/issues/195) | ES\|QL grammar scope `source.opentide.esql`, as `docs/EDITORS.md` says. The generated grammar uses `source.esql`, Elastic's scope | Collides with Elastic's ES\|QL extension | M1 *nice* (build-time rename) |
| L2 [language-server#196](https://github.com/opentidehq/language-server/issues/196) | SHA-256 sums, and ideally attestations, for release assets | The grammar build verifies the zip; today the extension records its own hashes | M1 *nice* |
| L3 [language-server#197](https://github.com/opentidehq/language-server/issues/197) | `DOCUMENT_SELECTOR` gains `opentide-config`, and non-`file` schemes for the web | Consistency with `EDITORS.md`; web mode | M4 |
| L4 [language-server#198](https://github.com/opentidehq/language-server/issues/198) | An `opentide/catalog` (index) request: per object `{uuid, object_type, name, uri, range, refs[]}`, with a change notification | A live, keystroke-fresh graph, and the Catalogue and graph on the web. The body is already in memory | M4 |

---

## 16. Milestones and issues

1.0 is M1–M3 together: the bar this document sets. Pre-releases ship along the way to both stores.

| Milestone | Delivers | Issues |
|-----------|----------|--------|
| **M0 Foundation** | Skeleton, CI matrix, test harness; the per-target runtime build with size gate, SBOM and smoke tests; a first pre-release to both stores over OIDC | #2, #11, #9; opentide#747 |
| **M1 Editor** | Languages and grammars; resolution with the bundled tier; the server's features; Restricted Mode; the backend client (`opentide serve`, with spawning as the fallback) and capability gating; diagnostics from three sources with dedupe and Explain; new-object flow with placeholders; status items; output channel | #3, #12, #4, #5, #13, #14, #8 (Restricted Mode); opentide#750 |
| **M2 Workbench** | The sidebar views; setup wizard and walkthrough; generic runner with classification; tasks, problem matcher, terminal `PATH` and links; MCP provider; query lenses and results panel; deploy plan; credentials in SecretStorage | #15, #16, #7, #6, #17, #18, #8 (the rest); opentide#749, #751, #754 |
| **M3 Visual** | Graph; ATT&CK matrix; search (quick and panel) | #19, #20, #21 |
| **M4 After 1.0** | Testing view (one test per object; validate as run, `--live` as a second profile); web mode; the live catalogue from the server (L4); hunting notebooks (query cells with result tables) if users ask; real deploys to development tenants if [§17](#17-open-questions) says yes | #10; language-server#197, #198 |

### Changes to existing issues

| Issue | Change |
|-------|--------|
| #1 Epic | Decision reversed: bundle the opentide runtime (D1). Children by milestone, and the cross-repository issues |
| #3 Resolution | Tier 4 is the bundled opentide with every feature, not the bare `opentide-lsp`. Tier 3 (uv) becomes the pin-mismatch action |
| #4 Languages | Add the ES\|QL scope rename (L1) and the snippets-in-`opentide-yaml` workaround (O5) |
| #5 Server features | Unchanged |
| #6 Agents | MCP works on install via the bundled runtime; add the fork fallback (user-level config with an absolute path) |
| #7 Workflows | Now "Every CLI command has a home" (palette commands, generic runner, tasks, terminal). Its diagnostics moved to #13, new objects to #14, the walkthrough to #16, run query to #17, deploy dry run to #18 |
| #8 Trust | Restricted Mode runs the bundled language server with a locked-down `PATH`; add `opentide.envFile` and `opentide.terminal.addToPath` to the restricted list |
| #9 Packaging | Per-platform packages carry the runtime, not `opentide-lsp`; size budget; hashed lock; SBOM; attestations |
| #10 Web | Unchanged; L4 later brings the catalogue panels |

---

## 17. Open questions

These need a decision before the milestone named.

1. **Bundling (M0).** Confirm D1: a 67–83 MB download per platform package once O1 lands (136 MB today), 150–181 MB on disk, downloaded again on every update.
2. **Real deploys from the editor (M4).** Never, with CI only (the recommendation for 1.0), or later behind a setting, for tenants marked non-production, one rule at a time, with a modal confirmation? The latter needs O7 and a confirmation contract in `opentide deploy`.
3. **Publisher identity (M0).** The Marketplace publisher id and Open VSX namespace (`opentide`?). Marketplace publisher verification for `opentide.org` becomes possible after six months.
4. **The VS Code floor and forks (M0).** Check the VS Code version Cursor and Windsurf are based on today, and set `engines.vscode` so they install the extension. Everything newer is feature-detected.
5. **Licence review (M0).** EUPL-1.2 opentide, engine and (optionally) skills inside an MIT VSIX, shipped as separate programs. This extends #6's review to the runtime.
6. **Object form editor (later).** A custom editor that edits an object as a form beside its YAML. Not planned for 1.0: the YAML, the server's completion and the templates cover authoring, and a second editing surface would have to stay in sync with every schema revision.

### Non-goals for 1.0

- Reimplementing any opentide check, generator or deploy logic in TypeScript.
- A chat participant (deprecated).
- Telemetry.
- Real deploys, MISP pushes and retractions from menus (D6).
- Rename or format support the server does not offer.
