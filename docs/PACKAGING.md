# Packaging

How the VSIX is built: the package, the pins, the gates, and how to bump what it pins. What and why is
[SPEC §3](SPEC.md#3-distribution-marketplace-and-open-vsx) and
[D1](SPEC.md#d1-run-the-users-opentide-bundle-no-runtime); this is how.

## The package

| Package | Built with | Contents |
|---------|------------|----------|
| Universal, the only one | `npm run package` (`--universal` is accepted) | The extension, its webviews, the grammars, `dist/wasi/` (the WASI module) and `dist/engine/`. No `runtime/`: the extension runs the user's own opentide, else the WASI module |

There are no per-platform packages. 0.1.0 and 0.1.1 shipped eight, each with a bundled CPython runtime
and opentide closure; 0.1.2 dropped them (SPEC D1). VS Code and Open VSX serve a newer universal version
to every platform over an older platform-specific one.

`dist/wasi/` is the WASI module, the runtime of tier 4 ([SPEC §4](SPEC.md#4-the-runtime-resolution-processes-status)):
opentide's own CLI compiled to `wasm32-wasip1`, one file for every platform, which runs when no opentide is
installed. `npm run build` (`scripts/wasi-lib.mjs`) takes the release asset `opentide-wasm32-wasip1.wasm`
that `pins.json` `wasi` pins (URL and SHA-256, the asset's line in the opentide release's `SHA256SUMS`,
downloaded once into `.cache/` and checked again on every build), and writes it as `opentide.wasm` with
`launcher.cjs` (`src/core/wasi/launcher.cjs`: MCP, tasks and terminals run the module through it, under
VS Code's Node), `wasi.json` (version and checksums, which the resolver reads) and the module's own
licence set, five more assets of the same release pinned beside it (`pins.json` `wasi.licences`, each by URL and
SHA-256, verified like the module): `THIRD-PARTY-LICENSES.html` (every Rust crate the CLI module links,
`cargo about` with `wasm32-wasip1`; opentide#1741), `WASI-LIBC-LICENSES.txt`, `LICENSE`, `NOTICE` and `THIRD-PARTY-DATA-LICENSES.txt` (the licence files `NOTICE`
cites for the datasets compiled into the module). They are
not the engine's copies in `dist/engine/`, which belong to another build and would go stale when the module is
bumped. `npm run wasi` downloads and verifies the module and the five files without building. The module needs the
`ms-vscode.wasm-wasi-core` extension when it is installed (`@vscode/wasm-wasi`), and otherwise runs through
the launcher as child processes: nothing to install. It is no `extensionDependencies` entry: the core
extension declares no support for untrusted workspaces, so VS Code disables it in Restricted Mode, and an
extension that depended on it would not activate there.

`dist/mcp-wasi.js` is the MCP bridge (`src/mcp-wasi/main.ts`, bundled with `@opentide/wasi-host` by `npm run build`, about 20 KiB): the editor runs it with its own Node to give agents opentide's MCP tools with no opentide installed ([CONTRACTS.md](CONTRACTS.md#the-mcp-bridge), [AGENT-INTEGRATION.md](AGENT-INTEGRATION.md)). It adds nothing to the package's size to speak of.

`dist/engine/` is the engine (WASM), the runtime of tier 5:
`npm run build` unpacks the `opentide-wasm-web` zip that `pins.json` `engine` pins (URL and SHA-256, the
zip's line in the opentide release's `SHA256SUMS`, cached in `.cache/`), bundles its wasm-bindgen
glue into `dist/engine/worker.js`, and copies `opentide_wasm_bg.wasm`, the zip's `LICENSE`, `NOTICE` and
`licenses/`, and the release's `THIRD-PARTY-LICENSES.html` (pinned the same way) next to it, with
`engine.json` (version and checksums), which the resolver reads (`scripts/engine-lib.mjs`). It gives the
editor features with no opentide installed, on the web too, and stands in for an opentide whose language
server does not start.

Output: `dist-vsix/opentide-universal-<version>.vsix`, with `<name>.size.json` next to it for the CI
summary.

A package whose minor version is odd is a pre-release: `npm run package` passes `--pre-release` to
`vsce` by itself (and also when given `--pre-release`), because `vsce publish --pre-release` refuses a
VSIX that was not packaged as one.

```bash
npm ci
npm run package                                            # dist-vsix/opentide-universal-<version>.vsix
npm run smoke -- dist-vsix/opentide-universal-<version>.vsix
```

### `npm run package [-- --pre-release]`

`scripts/package.mjs`, helpers in `scripts/package-lib.mjs`. It runs `vsce package --no-dependencies`
(vsce runs `vscode:prepublish`, the production build) with `.vscodeignore`, refuses a package that holds
`runtime/`, then the size gate (below) and the `.size.json` report. `--target` is refused: there is no
per-platform package.

### `npm run smoke -- <file.vsix> [--keep]`

`scripts/smoke.mjs`, helpers in `scripts/smoke-lib.mjs`. It unpacks the VSIX and checks:

1. the web extension is there: package.json `browser`, `dist/web/engine-worker.js` and the engine module;
2. the engine's worker (`dist/engine/worker.js`) answers `initialize` as `opentide-lsp` at the version
   `engine.json` records, with no host, and exits after `exit` (the browser build reports the crate's
   version, without a release candidate's suffix: `1.0.0` for `1.0.0-rc.2`);
3. the WASI module (`dist/wasi/`), run through its launcher with Node's own WASI, answers `serve`'s
   `initialize` with protocol 1, `opentide/fetch` offered and the version `wasi.json` records, runs
   `commands`, and exits 0 after `exit`;
4. the package carries no `runtime/`.

It exits non-zero on any failure.

## The pins (`pins.json`)

| Key | |
|-----|-|
| `opentide.version` | The opentide CI tests the extension against (`pip install opentide==<version>` in the real-opentide and integration jobs): a user's own opentide, tiers 1–3. The extension bundles no Python |
| `wasi` | The WASI module: opentide's `opentide-wasm32-wasip1.wasm` release asset (version, URL, SHA-256) and, in `licences`, its licence set: `THIRD-PARTY-LICENSES.html`, `WASI-LIBC-LICENSES.txt`, `LICENSE`, `NOTICE`, `THIRD-PARTY-DATA-LICENSES.txt` (each URL, SHA-256). A `sha256` that is a marked placeholder (`PLACEHOLDER-…`) is refused by `npm run wasi`, `npm run build` and the release check, which say how to set it |
| `highlights` | opentide's highlights zip (version, URL, SHA-256) the grammars come from |
| `skills` | The opentide skills (opentidehq/skills, EUPL-1.2): a commit (the archive URL names it) and `contentSha256`, a digest of the files of `skills/` and `LICENSE` that `scripts/skills-lib.mjs` computes (GitHub does not promise its archive bytes stay the same; the files of a commit do). `npm run skills` copies them into `skills/` and writes `contrib/skills.json` (`contributes.chatSkills`); `npm run manifest`, then `skills:check` in CI. The latest upstream tag is v2.1.0 and `plugin.json` is 2.2.2 at the pinned commit: ask upstream to tag it |
| `engine` | opentide's `opentide-wasm-web` zip (version, URL, SHA-256) and the release's `THIRD-PARTY-LICENSES.html` (URL, SHA-256): the engine (WASM). Same release as `highlights` |
| `tomlGrammar` | The TOML grammar from Even Better TOML (URL, SHA-256) |
| `vsix.budgetBytes`, `vsix.targetBytes` | The size gate (20 MiB) and the target (16 MiB). The gate is opentide's plan §11 and ADR 0007; the target was 15 MiB until rc.3's WASI module, built at opt-level `s` for a faster language-server start in large workspaces (opentide#1774), grew to about 22 MB (see "The gates") |
| `vsix.budgetOverrideBytes` | Optional `{ opentide, bytes, reason }`: a temporary larger gate while `opentide.version` is that version, ignored (with a warning) after a bump |

## The gates

| Gate | Where |
|------|-------|
| Size: 20 MiB per VSIX | `npm run package`: fails, printing the size and the five largest directories |
| No runtime in the package | `npm run package` and `npm run smoke` |
| The engine, the WASI module and the web entry run | `npm run smoke`, in CI's `package` job and publish.yml's `universal` job |
| The WASI module runs in VS Code, under `@vscode/wasm-wasi` and through the launcher | `npm run test:wasi` and `npm run test:wasi-launcher` (`test/wasi/`), in CI's integration job and in the test build |
| The extension runs a real opentide | CI's `real-opentide` job (unit tests) and the integration job (`OPENTIDE_TEST_BIN`), against `pins.json` `opentide.version` |
| The bundled opentide is the default, with or without an opentide on `PATH` | unit tests of `resolveRuntime`, `npm run test:wasi` (nothing set) and the integration job (`opentide.runtime` bundled over `opentide.path`) |
| No opentide anywhere: the WASI module | `npm run test:wasi`, with every folder holding `opentide` off `PATH` and opentide installed only in a venv off `PATH` |
| No opentide anywhere and the module off: the engine | `npm run test:engine`, as above with `opentide.wasi.enabled` off |

Measured on 2026-11-21 with opentide 1.0.0-rc.2's `opentide-wasm-web` and a WASI module built from
opentide's `integration/unified-core` (`1.0.0-rc.3-dev+8b55d0c`): the package is 13.3 MiB (52.4 MiB
installed). Its largest directories are `dist/wasi` at 7.3 MiB compressed (26.9 MiB installed: the 26.8 MiB
module, the launcher and licences) and `dist/engine` at 5.3 MiB (23.0 MiB installed). The budget is 20 MiB
and the target 16 MiB (15 MiB until the rc.3 module, which is larger because it is built at opt-level `s` for a faster
language-server start, opentide#1774; the package is expected at 15-16 MiB and is measured when rc.3 is pinned): the module is opentide's own size gate (`build-wasm.sh cli` fails it above 15 MiB
gzipped). It carries the production build (`vscode:prepublish`: minified, no source maps):
`dist/extension.js` and `dist/webview/graph.js` (Cytoscape) are each under 1 MiB; the other webviews are
14–70 KiB each.

First run, measured in VS Code 1.147 on linux-x64: the extension host compiles the module once per window in
0.6–0.8 s, and `serve` answers `initialize` about 0.8 s after that. A launcher run (`--version`) costs the
same compile again, which is why `serve` and the language server run in the extension host and the launcher
is for what VS Code starts itself.

## Bumping what the extension ships and tests against

**The opentide CI tests against** (`pins.json` `opentide.version`, a user's own opentide):

1. Set `pins.json` `opentide.version`.
2. Drop a `vsix.budgetOverrideBytes` for the old version.
3. CI runs the tests against the new opentide. Users get it with `pip install --upgrade opentide`: the
   extension needs no release for it.

**The skills the extension carries** (`skills`, opentidehq/skills):

1. Pick a commit of [opentidehq/skills](https://github.com/opentidehq/skills) (ideally a tag), set `pins.json` `skills.commit`, `url` (`…/archive/<commit>.zip`) and `version` (`plugin.json`'s).
2. `npm run skills -- --print-digest` prints the content digest of what the URL serves (the first run stops on the old one); set `contentSha256` to it.
3. `npm run skills && npm run manifest`, then `npm test` (the skills' names, descriptions and contributions are checked) and `npm run package && npm run smoke -- <vsix>`. CI's `skills:check` fails when `skills/` or `contrib/skills.json` differ from the pin.

**The opentide the extension carries** (`wasi`, `highlights`, `engine`, one opentide release `v<version>`):

1. From that release's `SHA256SUMS`, set each pin's `version`, `url` and `sha256`: `wasi` (the
   `opentide-wasm32-wasip1.wasm` line, and the lines of its five `licences`: `THIRD-PARTY-LICENSES.html`,
   `WASI-LIBC-LICENSES.txt`, `LICENSE`, `NOTICE`, `THIRD-PARTY-DATA-LICENSES.txt`), `highlights` (`highlights-v<version>.zip`), `engine`
   (`opentide-wasm-web-v<version>.zip`) and its `thirdPartyLicenses` (`THIRD-PARTY-LICENSES.html`). A
   digest of a download that `SHA256SUMS` does not list is no digest: `npm run wasi -- --print-sha256` prints
   the one of what the URL serves, to compare with it.
2. Set `package.json`'s `@opentide/wasi-host` to the same version, and `npm install` (npm's `next`
   dist-tag for a release candidate).
3. `npm run grammars && npm run manifest`: new grammars may need a language in `contrib/core.json`.
4. `npm run build`, `npm test`, `npm run package`, `npm run smoke -- <vsix>`. The engine reports the
   crate's version without a suffix (`1.0.0`) up to rc.2 and the release's (`1.0.0-rc.3`) from rc.3: the test accepts both.

opentide's CI runs this repository's `scripts/grammars.mjs --zip` and `scripts/engine-lib.mjs`
(`prepareEngine`, `GLUE`, `WASM`) on every release's assets (`check-vscode-extension.mjs`): keep their
interfaces.

## The rc.3 pins

opentide 1.0.0-rc.3 is released (its release workflow's `verify-assets` job checked every asset's attestation
before any registry published). `pins.json` names its assets by the digests of the release's `SHA256SUMS`
(the `opentide-wasm32-wasip1.wasm` module, its five licence files, `highlights-v1.0.0-rc.3.zip`,
`opentide-wasm-web-v1.0.0-rc.3.zip` and the engine's `THIRD-PARTY-LICENSES.html`, which is the same asset as the
module's), `package.json` and `package-lock.json` name `@opentide/wasi-host` 1.0.0-rc.3 with the registry's
integrity, and `opentide.version` (the opentide CI's real-opentide tests install) is `1.0.0rc3`. The module is
22.1 MB (opt-level `s`, for a faster language-server start in large workspaces: opentide#1774) and the package
15.2 MiB. The engine zip carries the notices and licences of the data catalogues compiled into it
(`data/catalogs/<name>/NOTICE`, `LICENSE*`); `scripts/engine-lib.mjs` ships exactly those files under
`dist/engine/data/` and refuses any other file there. The module's own `THIRD-PARTY-DATA-LICENSES.txt` (the same
notices in one file) is pinned in `wasi.licences` and ships in `dist/wasi/`.

A later release candidate is the procedure above (the opentide the extension carries), with
`npm install --save-exact @opentide/wasi-host@<version>` for step 2: a plain `npm install` keeps a lock entry
that has no `integrity`, and `npm ci` then installs whatever the registry serves.

## A test build

[`.github/workflows/test-vsix.yml`](../.github/workflows/test-vsix.yml) builds a `.vsix` **before** npm and
the release asset exist, from opentide's source. Nothing is published: no npm publish, no Marketplace or Open
VSX, no GitHub release. Run it from the Actions tab (**Test VSIX**, "Run workflow") and pick the opentide
branch: `integration/unified-core` (the default) or `feat/release-wasi-cli-npm-candidates` (the opentide PR
that adds the asset). It also runs on a pull request that changes the workflow.

It checks out opentide at the ref and builds:

- the WASI module, with opentide's `scripts/engine/build-wasm.sh cli` (the toolchain of opentide's
  `rust-toolchain.toml`, `wasm32-wasip1`, wasi-sdk), with `OPENTIDE_BUILD_VERSION=1.0.0-rc.3-dev+<sha>`;
- `@opentide/wasi-host`, with `npm pack` in `packages/wasi-host` (its `prepack` builds it), installed from
  the tarball in place of the pinned `1.0.0-rc.3`, in that run's checkout only;
- the module's licence set, as opentide's release workflow makes it (`cargo about generate --workspace`, the
  wasi-libc texts, `LICENSE`, `NOTICE`, and `release.py legal-bundle` for `THIRD-PARTY-DATA-LICENSES.txt`), which the
  build takes from `OPENTIDE_WASI_LICENCES`.

Then it packages the extension with `OPENTIDE_WASI_MODULE` and `OPENTIDE_WASI_LICENCES` (which `npm run build` takes instead of the
pinned asset: `pins.json` is not consulted, and `wasi.json` records the build as `local`), smoke-tests the
`.vsix`, runs `npm test` and `npm run test:wasi` on it, and uploads
`opentide-universal-<version>-wasi-<sha>.vsix` as the artifact `opentide-vsix-wasi-<sha>`. To make one by
hand:

```bash
# in an opentide checkout, at the ref
OPENTIDE_BUILD_VERSION=1.0.0-rc.3-dev+$(git rev-parse --short=7 HEAD) scripts/engine/build-wasm.sh cli
(cd packages/wasi-host && npm ci && npm pack)
# here
npm pkg set "dependencies.@opentide/wasi-host=file:<path to opentide-wasi-host-*.tgz>"
npm install
# a folder with THIRD-PARTY-LICENSES.html (cargo about generate --workspace about.hbs), WASI-LIBC-LICENSES.txt,
# LICENSE, NOTICE and THIRD-PARTY-DATA-LICENSES.txt (scripts/engine/release.py legal-bundle), as the workflow makes it
OPENTIDE_WASI_LICENCES=<folder> OPENTIDE_WASI_MODULE=<opentide>/target/wasm32-wasip1/wasi/opentide.wasm npm run package
npm run smoke -- dist-vsix/opentide-universal-*.vsix
```

### Install it, and what to try

```bash
gh run download <run id> --repo opentidehq/vscode-extension --name opentide-vsix-wasi-<sha>
code --install-extension opentide-universal-<version>-wasi-<sha>.vsix
```

Nothing else to install: with no `ms-vscode.wasm-wasi-core` (WASM WASI Core) the module runs through VS Code's Node, which the output channel says (`WASI: ms-vscode.wasm-wasi-core is not installed: the module runs through VS Code's Node`); install that extension and **opentide: Restart Server** to try the other host. Uninstall
with `code --uninstall-extension opentidehq.opentide`. Try it **on a machine with no opentide installed**
(or set `opentide.path` to a path that is nothing, and keep `opentide` off `PATH`):

1. **Open a workspace.** Open a folder with `.opentide/` and `objects/` (`opentide setup` makes one). The
   **opentide output** channel says `runtime: opentide 1.0.0-rc.3-dev+<sha> (tier 4 · bundled WASI)` and
   `WASI: compiled … in <n> ms`; the status bar item reads `opentide 1.0.0-rc.3-dev+<sha>`, not
   `opentide engine (WASM): editor features only`. The compile happens once per window, about a second.
2. **Diagnostics.** Open a rule and break it (a misspelled `tlp: ambr`): a squiggle appears from the language
   server, the Problems view lists it with its code, hover and completion work, and the language status item
   (**Show output**) says `host opentide`: the module's own server, not the engine's. Edit a file outside
   `objects/` that `paths.toml` names: it is checked too.
3. **`opentide serve` features.** The Catalogue, Relations and the graph fill from `info catalog` (paths are
   the folder's own, not `/workspace/…`); **opentide: Validate Workspace** and a save run `validate` through the warm
   `serve` (the output channel logs `via serve`; `opentide.serveRunning` is true); the ATT&CK matrix and
   Coverage need `info catalog`; **New Object** and **Deploy plan** (a dry run) work. Add a second folder to the
   workspace: the module restarts with both mounted (`/workspaces/<name>`).
4. **MCP.** With `opentide.mcp.provide` on (or **opentide: Set Up MCP Server**), the `opentide` MCP server
   starts: VS Code's Node runs `dist/wasi/launcher.cjs` (check **MCP: List Servers** → Show Output). An
   agent's `info` and `validate` tools answer. The paths it prints are the workspace's, as on the native CLI.
5. **A tenant call through FetchHost.** Configure a tenant (`opentide setup`, a platform's TOML and its
   variables in **opentide: Set Credential…**) and run **Run Query** on a rule, or `validate --live`, from
   the editor. The request is made by the extension host (`@opentide/wasi-host`), not the module: **Developer:
   Set Log Level… → Trace** for `opentide`, and the run line says `via serve`. Set `http.proxy` (or a
   certificate in the OS store): the tenant request follows it. Point the tenant at nothing
   (`http://127.0.0.1:9`): the run fails as `connect`, "the tenant cannot be reached", the retries the
   platform's policy says. Cancel a running query: it stops (`interrupted`). In the integrated terminal,
   `opentide query …` through the PATH launcher fails with `this command needs the network; run the opentide
   CLI`: expected, the module has no network there. **Contact only tenants you own.**
6. **An agent, with no opentide installed.** In VS Code, **MCP: List Servers** shows `opentide`; start it and **Show Output**: it answers `initialize`, and `tools/list` has `search`. Ask Copilot's agent for a `search`, then `validate`. Where the server comes from a Copilot harness session rather than the window, check that it still starts (whether a forwarded definition keeps its `env` is unknown: the output says what ran). In Cursor, the server appears in its MCP settings (toggle it if it shows "0 tools"); in Kiro, Devin Desktop and Windsurf, accept the notification and check the editor's MCP panel. Tenant tools (deploy, live validate, query) go through `@opentide/wasi-host`'s `McpFetchBridge` and work with a module that supports `OPENTIDE_FETCH=stdio` (the test build, rc.3): [AGENT-INTEGRATION.md](AGENT-INTEGRATION.md).
7. **Switching off.** `opentide.wasi.enabled` off, and **opentide: Restart Server**: the engine (tier 5) runs,
   editor features only. In an untrusted folder (Restricted Mode) the engine runs too.

## Cold start of the language server

What the first document waits for, and what was tried. Two modules were measured, both from opentide's
`integration/unified-core`, `opentide lsp start` through `dist/wasi/launcher.cjs` under Node 22.23.5 (V8 12.4) on a Linux
container (`scripts/bench-lsp-cold-start.mjs`, five runs): the 28 MB CLI module of ef3ec6d, and the 18.9 MB one of 9cd8da7,
which has opentide#1768's and #1771's cold-start work.

| Small workspace (1 rule), open → diagnostics for the first document, 1.5 s after the server started | ef3ec6d, 28 MB | 9cd8da7, 18.9 MB |
|-|-:|-:|
| Spawn → `initialize` answered | 147 ms | 136 ms |
| The first document | 470–520 ms | 133–146 ms |
| A second document, same process | 22–40 ms | 8–10 ms |
| The first document after a synthetic warm-up rule | 34–51 ms | 11–16 ms |
| Peak resident memory of the server | 127 MB | 109 MB |

| 1,200 rules | ef3ec6d | 9cd8da7 |
|-|-:|-:|
| Spawn → `initialize` | 183 ms | 150 ms |
| The first document | 1,100–1,230 ms | 650–817 ms |
| A second document | 480–590 ms | 398–459 ms |
| The first document after the warm-up (the warm-up itself 0.8–1.1 s of work at start) | 480–610 ms | 484–724 ms |
| Peak resident memory | 148 MB | 133 MB |

**The module's compile is not the cost**: `WebAssembly.compile` of the 28 MB module takes 36–68 ms (about 50 of the 105 ms
that `node` takes to boot, read, compile and run `--version`). V8 flags do not help (`--no-wasm-lazy-compilation`
`--liftoff-only`, `--no-wasm-dynamic-tiering`, `--no-wasm-tier-up`, `--wasm-lazy-validation`: all within noise or worse than
the default); lazy compilation is already the default in V8 12.4. No flag is set.

**A warm-up was tried and dropped.** Opening, analysing and closing a synthetic rule once the server has started
(`opentide.languageServer.warmUp`, PR #98, not merged) moved the first document's wait to the background in the Node harness,
and took 125 ms off it with the 9cd8da7 module. In VS Code (`test/wasi/perf.test.ts`, the Test VSIX workflow, run 45023695400,
medians of four rounds with diagnostics) it did not:

| Host | warm-up off | warm-up on |
|-|-:|-:|
| `@vscode/wasm-wasi` (`wasm-wasi-core`) | 223 ms | 205 ms |
| the launcher (VS Code's Node, one process per start) | 183 ms | 219 ms |

No gain of 100 ms on the launcher, the default path; on 1,200 rules it adds 0.8–1.1 s of work at every start. The first
document of a window starts at about 180 ms without it, because opentide#1768 and #1771 took the cold work out of the first
request. Restarts under `@vscode/wasm-wasi` reuse the window's compiled module and its tier-up. Not kept.

**Compiling once in the extension host (a worker thread) is not done.** Under `@vscode/wasm-wasi` the module is already
compiled once per window (`WasiHost.module`). The launcher runs `node:wasi`, whose standard streams are file descriptors: a
worker thread has no pipe to give it, so it would need its own WASI implementation (file system, `poll_oneoff`, stdin blocking on a
shared buffer) to save about 50 ms a start. The MCP bridge is started by the editor as its own process and cannot share a compile
with the extension host. A helper process with a worker per protocol would share one compile between `serve` and the language
server for the same 50 ms, at the cost of a protocol for the helper and extra inherited descriptors (Windows).

**Rounds with no diagnostics (a pull that overtook its `didOpen`).** In the run with the warm-up code, 8 of 32 rounds (both hosts,
the warm-up off as well as on) got no diagnostics for a fresh rule in 30 s, and two took 9.5 s and 17.7 s; the other rounds took
130-300 ms. A rerun of that code with the whole protocol trace (`opentide.trace.server` verbose, `OPENTIDE_LSP_TIMING=1`, the
extension's log at trace; the Test VSIX run uploads them as `perf-lsp-logs-*`) reproduced it: 6 of 16 rounds on `wasm-wasi-core`,
and one slow one. Every one of them has the same shape. The client is running, the document is open, and the server answers a
`documentSymbol` in 1-2 ms, so it is neither a client that never sent anything nor a server that never answered. In the failing
server sessions the client's first `textDocument/diagnostic` for the new file went out **before the `didOpen` of that file**, in the
middle of the replay of the already-open documents that follows a restart; the server did not know the document and answered
`{"items": [], "kind": "full", "resultId": ...}` in 1-2 ms, and the client kept it. A pull is not repeated until the document
changes, so the file stays empty. Sessions where the pull came after the file's own `didOpen` always got a full answer
(150-350 ms). Two sessions where the pull came first still got one (285 ms, 305 ms): the order on the wire is a race, not a rule.

It is not the version-parse bug (which skipped the workspace pull on that run): 0 of 32 rounds failed with the fix and the pull on
`auto`, and 0 of 32 with the pull answered empty (`opentide.diagnostics.workspacePull` `never`), on `wasm-wasi-core` and the
launcher, on the code without the warm-up (`test/wasi/perf.test.ts` runs both). What differs between the failing and the passing
runs is the warm-up code; why it reorders the replay is not established. The warm-up is dropped (above), and the remaining facts for
the engine side are that a `textDocument/diagnostic` for a document the server was never told about is answered as an empty full
report instead of being analysed from disk or answered `ServerCancelled` with `retriggerRequest: true`, and that the server does not
send `workspace/diagnostic/refresh` when the `didOpen` arrives afterwards.
