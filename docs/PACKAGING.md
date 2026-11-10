# Packaging

How the VSIX is built: the package, the pins, the gates, and how to bump what it pins. What and why is
[SPEC §3](SPEC.md#3-distribution-marketplace-and-open-vsx) and
[D1](SPEC.md#d1-run-the-users-opentide-bundle-no-runtime); this is how.

## The package

| Package | Built with | Contents |
|---------|------------|----------|
| Universal, the only one | `npm run package` (`--universal` is accepted) | The extension, its webviews, the grammars and `dist/engine/`. No `runtime/`: the extension runs the user's own opentide |

There are no per-platform packages. 0.1.0 and 0.1.1 shipped eight, each with a bundled CPython runtime
and opentide closure; 0.1.2 dropped them (SPEC D1). VS Code and Open VSX serve a newer universal version
to every platform over an older platform-specific one.

`dist/engine/` is the engine (WASM), the runtime of tier 4 ([SPEC §4](SPEC.md#4-the-runtime-resolution-processes-status)):
`npm run build` unpacks the `opentide-wasm-web` zip that `pins.json` `engine` pins (URL and SHA-256, the
zip's line in the language-server release's `SHA256SUMS`, cached in `.cache/`), bundles its wasm-bindgen
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
   `engine.json` records, with no host, and exits after `exit`;
3. the package carries no `runtime/`.

It exits non-zero on any failure.

## The pins (`pins.json`)

| Key | |
|-----|-|
| `opentide.version` | The opentide CI tests the extension against (`pip install opentide==<version>` in the real-opentide and integration jobs). The extension bundles none |
| `highlights` | The language-server highlights zip (version, URL, SHA-256) the grammars come from |
| `engine` | The language-server `opentide-wasm-web` zip (version, URL, SHA-256) and the release's `THIRD-PARTY-LICENSES.html` (URL, SHA-256): the engine (WASM). Same release as `highlights` |
| `tomlGrammar` | The TOML grammar from Even Better TOML (URL, SHA-256) |
| `vsix.budgetBytes`, `vsix.targetBytes` | The size gate (20 MiB) and the target (10 MiB) |
| `vsix.budgetOverrideBytes` | Optional `{ opentide, bytes, reason }`: a temporary larger gate while `opentide.version` is that version, ignored (with a warning) after a bump |

## The gates

| Gate | Where |
|------|-------|
| Size: 20 MiB per VSIX | `npm run package`: fails, printing the size and the five largest directories |
| No runtime in the package | `npm run package` and `npm run smoke` |
| The engine and the web entry run | `npm run smoke`, in CI's `package` job and publish.yml's `universal` job |
| The extension runs a real opentide | CI's `real-opentide` job (unit tests) and the integration job (`OPENTIDE_TEST_BIN`), against `pins.json` `opentide.version` |
| No opentide anywhere: the engine | `npm run test:engine`, with every folder holding `opentide` off `PATH` and opentide installed only in a venv off `PATH` |

Measured on 2026-11-05 with language-server 0.10.0's `opentide-wasm-web`: the package is 4.0 MiB
(17.6 MiB installed), its largest directory `dist/engine` at 3.4 MiB compressed (15.7 MiB installed: the
15.5 MiB module, its worker and licences). It carries the production build (`vscode:prepublish`:
minified, no source maps): `dist/extension.js` 746 KiB and `dist/webview/graph.js` 520 KiB (Cytoscape),
against 1.5 MiB and 1.1 MiB in `npm run build`; the other webviews are 14–24 KiB each.

## Bumping the opentide CI tests against

1. Set `pins.json` `opentide.version`.
2. If the engine inside that opentide changed, bump `highlights` (version, URL, SHA-256), then `npm run
   grammars && npm run manifest`, and `engine` to the same release (the zip's and
   `THIRD-PARTY-LICENSES.html`'s URLs and SHA-256 from its `SHA256SUMS`); `npm run build` unpacks it.
3. Drop a `vsix.budgetOverrideBytes` for the old version.
4. CI runs the tests against the new opentide. Users get it with `pip install --upgrade opentide`: the
   extension needs no release for it.
