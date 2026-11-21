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
VS Code's Node), `wasi.json` (version and checksums, which the resolver reads) and the project's `LICENSE`
and `NOTICE`. `npm run wasi` downloads and verifies the module without building. The module needs the
`ms-vscode.wasm-wasi-core` extension when it is installed (`@vscode/wasm-wasi`), and otherwise runs through
the launcher as child processes: nothing to install. It is no `extensionDependencies` entry: the core
extension declares no support for untrusted workspaces, so VS Code disables it in Restricted Mode, and an
extension that depended on it would not activate there.

`dist/mcp-wasi.js` is the MCP bridge (`src/mcp-wasi/main.ts`, bundled with `@opentide/wasi-host` by `npm run build`, about 17 KiB): the editor runs it with its own Node to give agents opentide's MCP tools with no opentide installed ([CONTRACTS.md](CONTRACTS.md#the-mcp-bridge), [AGENT-INTEGRATION.md](AGENT-INTEGRATION.md)). It adds nothing to the package's size to speak of.

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
| `wasi` | The WASI module: opentide's `opentide-wasm32-wasip1.wasm` release asset (version, URL, SHA-256). **While opentide has not released it, `sha256` is a marked placeholder** (`PLACEHOLDER-…`): `npm run wasi` and `npm run build` refuse it and say how to set it |
| `highlights` | opentide's highlights zip (version, URL, SHA-256) the grammars come from |
| `engine` | opentide's `opentide-wasm-web` zip (version, URL, SHA-256) and the release's `THIRD-PARTY-LICENSES.html` (URL, SHA-256): the engine (WASM). Same release as `highlights` |
| `tomlGrammar` | The TOML grammar from Even Better TOML (URL, SHA-256) |
| `vsix.budgetBytes`, `vsix.targetBytes` | The size gate (20 MiB) and the target (15 MiB), as opentide's plan §11 and ADR 0007 say |
| `vsix.budgetOverrideBytes` | Optional `{ opentide, bytes, reason }`: a temporary larger gate while `opentide.version` is that version, ignored (with a warning) after a bump |

## The gates

| Gate | Where |
|------|-------|
| Size: 20 MiB per VSIX | `npm run package`: fails, printing the size and the five largest directories |
| No runtime in the package | `npm run package` and `npm run smoke` |
| The engine, the WASI module and the web entry run | `npm run smoke`, in CI's `package` job and publish.yml's `universal` job |
| The WASI module runs in VS Code, under `@vscode/wasm-wasi` and through the launcher | `npm run test:wasi` and `npm run test:wasi-launcher` (`test/wasi/`), in CI's integration job and in the test build |
| The extension runs a real opentide | CI's `real-opentide` job (unit tests) and the integration job (`OPENTIDE_TEST_BIN`), against `pins.json` `opentide.version` |
| No opentide anywhere: the WASI module | `npm run test:wasi`, with every folder holding `opentide` off `PATH` and opentide installed only in a venv off `PATH` |
| No opentide anywhere and the module off: the engine | `npm run test:engine`, as above with `opentide.wasi.enabled` off |

Measured on 2026-11-21 with opentide 1.0.0-rc.2's `opentide-wasm-web` and a WASI module built from
opentide's `integration/unified-core` (`1.0.0-rc.3-dev+8b55d0c`): the package is 13.3 MiB (52.4 MiB
installed). Its largest directories are `dist/wasi` at 7.3 MiB compressed (26.9 MiB installed: the 26.8 MiB
module, the launcher and licences) and `dist/engine` at 5.3 MiB (23.0 MiB installed). The budget is 20 MiB
and the target 15 MiB: the module is opentide's own size gate (`build-wasm.sh cli` fails it above 15 MiB
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

**The opentide the extension carries** (`wasi`, `highlights`, `engine`, one opentide release `v<version>`):

1. From that release's `SHA256SUMS`, set each pin's `version`, `url` and `sha256`: `wasi` (the
   `opentide-wasm32-wasip1.wasm` line), `highlights` (`highlights-v<version>.zip`), `engine`
   (`opentide-wasm-web-v<version>.zip`) and its `thirdPartyLicenses` (`THIRD-PARTY-LICENSES.html`). A
   digest of a download that `SHA256SUMS` does not list is no digest: `npm run wasi -- --print-sha256` prints
   the one of what the URL serves, to compare with it.
2. Set `package.json`'s `@opentide/wasi-host` to the same version, and `npm install` (npm's `next`
   dist-tag for a release candidate).
3. `npm run grammars && npm run manifest`: new grammars may need a language in `contrib/core.json`.
4. `npm run build`, `npm test`, `npm run package`, `npm run smoke -- <vsix>`. The engine reports the
   crate's version without a suffix (`1.0.0`): that is expected.

opentide's CI runs this repository's `scripts/grammars.mjs --zip` and `scripts/engine-lib.mjs`
(`prepareEngine`, `GLUE`, `WASM`) on every release's assets (`check-vscode-extension.mjs`): keep their
interfaces.

## When opentide 1.0.0-rc.3 is released

Until opentide releases `opentide-wasm32-wasip1.wasm` and publishes `@opentide/wasi-host@1.0.0-rc.3` (npm
dist-tag `next`), `pins.json` `wasi.sha256` is a placeholder and `package-lock.json` names a package the
registry does not have. CI fails on exactly that: `npm ci` (404 for `@opentide/wasi-host`), and `npm run
build` (the placeholder). Then:

1. Set `pins.json` `wasi.sha256` to the `opentide-wasm32-wasip1.wasm` line of the release's `SHA256SUMS`
   (check the asset's attestation: `gh attestation verify opentide-wasm32-wasip1.wasm --repo
   opentidehq/opentide`).
2. `npm install`, to let npm add the package's `integrity` to `package-lock.json` (it already names the
   version and the registry URL); commit both.
3. `npm run build && npm test && npm run package && npm run smoke -- dist-vsix/*.vsix`, and `npm run
   test:wasi`; push, and re-run CI.
4. Check the module's version: `wasi.json`'s and `serve`'s `initialize` must agree on `1.0.0-rc.3`.

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
  the tarball in place of the pinned `1.0.0-rc.3`, in that run's checkout only.

Then it packages the extension with `OPENTIDE_WASI_MODULE` (which `npm run build` takes instead of the
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
OPENTIDE_WASI_MODULE=<opentide>/target/wasm32-wasip1/wasi/opentide.wasm npm run package
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
6. **An agent, with no opentide installed.** In VS Code, **MCP: List Servers** shows `opentide`; start it and **Show Output**: it answers `initialize`, and `tools/list` has `search`. Ask Copilot's agent for a `search`, then `validate`. Where the server comes from a Copilot harness session rather than the window, check that it still starts (whether a forwarded definition keeps its `env` is unknown: the output says what ran). In Cursor, the server appears in its MCP settings (toggle it if it shows "0 tools"); in Kiro, Devin Desktop and Windsurf, accept the notification and check the editor's MCP panel. `OPENTIDE_FETCH=stdio` tenant tools (deploy, live validate, query) work once opentide's `mcp start` supports it: [AGENT-INTEGRATION.md](AGENT-INTEGRATION.md).
7. **Switching off.** `opentide.wasi.enabled` off, and **opentide: Restart Server**: the engine (tier 5) runs,
   editor features only. In an untrusted folder (Restricted Mode) the engine runs too.
