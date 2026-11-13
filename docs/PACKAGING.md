# Packaging

How the VSIXs are built: the packages, the pins, the gates, and how to bump what they pin. What and why is
[SPEC §3](SPEC.md#3-distribution-marketplace-and-open-vsx) and
[D1](SPEC.md#d1-carry-opentide-as-opentideopentide-bundle-no-python); this is how.

## The packages

| Package | Built with | Contents |
|---------|------------|----------|
| Universal | `npm run package` (`--universal` is accepted) | The extension, its webviews, the grammars and `dist/engine/`. No native code: it runs the workspace's opentide, else the engine |
| Platform: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, `win32-arm64` | `npm run package -- --target <target>` | The universal package plus `dist/opentide/`: `@opentide/opentide` at `pins.json` `opentide.version` with the native addon for the target |

0.1.0 and 0.1.1 shipped eight per-platform packages, each with a bundled CPython runtime and opentide
closure; 0.1.2 dropped them (SPEC D1). With the unified core, opentide is a Node-API addon, so the platform
packages are back without Python ([SPEC D1](SPEC.md#d1-carry-opentide-as-opentideopentide-bundle-no-python)).
VS Code and Open VSX install a platform package where one exists for the version, else the universal one.
There is none for musl (Alpine): `@opentide/opentide` builds for glibc only.

`dist/opentide/` is staged by `npm run build` (`scripts/opentide-lib.mjs`) when `OPENTIDE_TARGET` is a
target (`npm run package -- --target` sets it) or `host`, or when `OPENTIDE_NPM` names a local package
(then for this machine); a plain `npm run build` and the universal package (`OPENTIDE_TARGET=universal`)
stage none. It holds the package's `package.json`, `index.js` (the napi-rs loader), `cli.js` (the
`opentide` bin), `LICENSE`, the one `opentide.<platform>.node`, and `opentide.json` (version, platform,
the addon's SHA-256), which the resolver reads. Where the package comes from:

1. `OPENTIDE_NPM=<folder>`: npm tarballs of `@opentide/opentide` and `@opentide/opentide-<platform>`
   anywhere under it (opentide's `publish.yml` `npm-packages` artifact, or `npm pack`), or a built
   `bindings/node` checkout (`npm ci && npm run build` leaves `opentide.<platform>.node` beside `index.js`).
   The version must be `opentide.version` (`OPENTIDE_ANY_VERSION=1` for a development build).
2. Otherwise the npm registry: `npm pack` of both, each checked against `pins.json`
   `opentide.npm.integrity` (the registry's `dist.integrity`). With no integrity pinned, it fails.

`dist/engine/` is the engine (WASM), the runtime of tier 4 ([SPEC §4](SPEC.md#4-the-runtime-resolution-processes-status)):
`npm run build` unpacks the `opentide-wasm-web` zip that `pins.json` `engine` pins (URL and SHA-256, the
zip's line in the engine release's `SHA256SUMS`, cached in `.cache/`), bundles its wasm-bindgen
glue into `dist/engine/worker.js`, and copies `opentide_wasm_bg.wasm`, the zip's `LICENSE`, `NOTICE` and
`licenses/`, and the release's `THIRD-PARTY-LICENSES.html` (pinned the same way) next to it, with
`engine.json` (version and checksums), which the resolver reads (`scripts/engine-lib.mjs`). It gives the
editor features with no opentide installed, on the web too, stands in for an opentide whose language
server does not start, and is the only runtime in Restricted Mode, so the platform packages carry it too.

Output: `dist-vsix/opentide-<target|universal>-<version>.vsix`, with `<name>.size.json` next to it for the
CI summary.

A package whose minor version is odd is a pre-release: `npm run package` passes `--pre-release` to
`vsce` by itself (and also when given `--pre-release`), because `vsce publish --pre-release` refuses a
VSIX that was not packaged as one.

```bash
npm ci
npm run package                                            # dist-vsix/opentide-universal-<version>.vsix
npm run smoke -- dist-vsix/opentide-universal-<version>.vsix
OPENTIDE_NPM=../opentide/bindings/node npm run package -- --target linux-x64
npm run smoke -- dist-vsix/opentide-linux-x64-<version>.vsix
```

### `npm run package [-- --target <target>] [-- --pre-release]`

`scripts/package.mjs`, helpers in `scripts/package-lib.mjs`. It runs `vsce package --no-dependencies`
(with `--target` for a platform package; vsce runs `vscode:prepublish`, the production build, with
`OPENTIDE_TARGET` set) with `.vscodeignore`, refuses a package that holds `runtime/`, a universal package
with `dist/opentide/`, and a platform package without its files or with another platform's addon, then
the size gate (below) and the `.size.json` report.

### `npm run smoke -- <file.vsix> [--keep]`

`scripts/smoke.mjs`, helpers in `scripts/smoke-lib.mjs`. It unpacks the VSIX and checks:

1. the web extension is there: package.json `browser`, `dist/web/engine-worker.js` and the engine module;
2. the engine's worker (`dist/engine/worker.js`) answers `initialize` as `opentide-lsp` at the version
   `engine.json` records, with no host, and exits after `exit`;
3. a platform package (from its file name) carries `dist/opentide/` for its platform, and the universal
   one none; on a machine of that platform, the bundled `opentide` (`node dist/opentide/cli.js`) prints
   `opentide.json`'s version, its `--json commands` has `serve`, `lsp start`, `mcp start`, `info catalog`
   and `validate`, and `lsp start` answers `initialize`;
4. the package carries no `runtime/`.

It exits non-zero on any failure.

## The pins (`pins.json`)

| Key | |
|-----|-|
| `opentide.version` | The `@opentide/opentide` the platform packages carry, and the opentide CI tests the extension against |
| `opentide.npm.integrity` | Each npm tarball's `dist.integrity` (the package and its six native packages). Empty until the version is on npm; the release builds platform packages only when all seven are there |
| `opentide.source` | Until the package is on npm: the opentide repository and commit CI builds `bindings/node` from (the `opentide-npm` job). `scripts/pins.mjs` drops it |
| `highlights` | The highlights zip (version, URL, SHA-256) the grammars come from |
| `engine` | The `opentide-wasm-web` zip (`version`: what the engine reports; `release`: the release whose assets they are; URL, SHA-256) and the release's `THIRD-PARTY-LICENSES.html` (URL, SHA-256): the engine (WASM). Same release as `highlights` |
| `tomlGrammar` | The TOML grammar from Even Better TOML (URL, SHA-256) |
| `vsix.budgetBytes`, `vsix.targetBytes` | The universal package's size gate (20 MiB) and target (10 MiB) |
| `vsix.platform.budgetBytes`, `vsix.platform.targetBytes` | A platform package's (30 MiB, 25 MiB): the native addon is about 17 MiB of it |
| `vsix.budgetOverrideBytes` | Optional `{ opentide, bytes, reason }`: a temporary larger gate while `opentide.version` is that version, ignored (with a warning) after a bump |

## The gates

| Gate | Where |
|------|-------|
| Size: 20 MiB per universal VSIX, 30 MiB per platform VSIX | `npm run package`: fails, printing the size and the five largest directories |
| No Python runtime in a package; no native code in the universal one | `npm run package` and `npm run smoke` |
| The engine and the web entry run | `npm run smoke`, in CI's `package` job and publish.yml's `universal` and `platforms` jobs |
| The bundled opentide runs on its platform | `npm run smoke` of a platform package: CI's `package` job (linux-x64), publish.yml's `platforms` job (each on its own runner) |
| The extension runs the bundled opentide | CI's `real-opentide` job (`OPENTIDE_TEST_PACKAGE`, `OPENTIDE_TEST_BIN`) and the integration job (`test/integration/package.test.ts`, with `OPENTIDE_NPM`), against `opentide.version` |
| No opentide anywhere: the engine | `npm run test:engine`, with `OPENTIDE_TARGET=universal` and every folder holding `opentide` off `PATH` |

Measured on 2026-11-13 with `@opentide/opentide` 0.24.0 built from opentide's `feat/uc-6-2` and
language-server 0.10.0's `opentide-wasm-web`: the linux-x64 package is 21.4 MiB (67.7 MiB installed),
`dist/opentide` 17.3 MiB of it (49.6 MiB installed, the addon built with LTO and stripped) and
`dist/engine` 3.4 MiB (15.7 MiB installed). The universal package is 4.0 MiB (17.6 MiB installed). Both
carry the production build (`vscode:prepublish`: minified, no source maps).

## Bumping opentide

The extension pins one opentide version: the `@opentide/opentide` the platform packages carry, the engine
and the grammars, from one opentide release.

1. `node scripts/pins.mjs <version> --engine-version <v>`: each npm package's integrity at `<version>`,
   and the highlights zip, the `opentide-wasm-web` zip and `THIRD-PARTY-LICENSES.html` from that release's
   `SHA256SUMS` (`--engine-version` is the version the engine reports, its crate's). It drops
   `opentide.source`.
2. `npm run grammars && npm run manifest`, then `npm run build` and `npm test`.
3. Drop a `vsix.budgetOverrideBytes` for the old version.
4. A release ships the new opentide in the platform packages. The universal package's users upgrade
   their own opentide (`pip install --upgrade opentide`, `npm install -g @opentide/opentide`).

### Before `@opentide/opentide` is on npm

`opentide.npm.integrity` is empty and `opentide.source.ref` names the opentide commit CI builds from.
To build a platform package locally:

```bash
git clone https://github.com/opentidehq/opentide && cd opentide && git checkout <opentide.source.ref>
cd bindings/node && npm ci && npm pkg set version=<opentide.version> && npm run build
cd -   # back here
OPENTIDE_NPM=<opentide>/bindings/node npm run package -- --target linux-x64
```

Releases until then have the universal package only (publish.yml warns).
