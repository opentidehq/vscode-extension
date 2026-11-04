# Packaging

How the VSIX packages are built: the bundled runtime, the pins, the gates, and how to bump opentide.
What and why is [SPEC §3](SPEC.md#3-distribution-marketplace-and-open-vsx) and
[D1](SPEC.md#d1-bundle-a-complete-opentide-runtime-in-each-per-platform-package); this is how.

## The packages

| Package | Built with | Contents |
|---------|------------|----------|
| Per-platform, one per target in `pins.json` `runtimeTargets` | `npm run package -- --target <t>` | The extension, grammars and `runtime/`: CPython, the opentide closure, `BUILD-INFO.json`, `sbom.cdx.json`, `THIRD-PARTY-NOTICES.txt` |
| Universal | `npm run package -- --universal` | The extension and grammars, no `runtime/` |

Output: `dist-vsix/opentide-<target>-<version>.vsix` (universal: `opentide-universal-<version>.vsix`),
with `<name>.size.json` next to it for the CI summary. VS Code installs the per-platform package where one
exists and the universal one everywhere else, so a target missing from `runtimeTargets` (or an empty
list) still gets the extension, running the workspace's opentide or `opentide.path`.

A package whose minor version is odd is a pre-release: `npm run package` passes `--pre-release` to
`vsce` by itself (and also when given `--pre-release`), because `vsce publish --pre-release` refuses a
VSIX that was not packaged as one.

## Building one target

```bash
npm ci
npm run runtime:build -- --target linux-x64   # runtime/ for that target
npm run package -- --target linux-x64         # dist-vsix/opentide-linux-x64-<version>.vsix
npm run smoke -- dist-vsix/opentide-linux-x64-<version>.vsix   # on a linux-x64 machine
```

Every target builds on any machine (the closure is installed for the target's platform), but only a
machine of that target can run the smoke test. `runtime/` holds one target at a time: build, package,
then the next.

### `npm run runtime:build -- --target <t> [--archive <file>]`

`scripts/runtime-build.mjs`, helpers in `scripts/runtime-lib.mjs`:

1. **Interpreter.** python-build-standalone `install_only_stripped` for the target, at the release and
   CPython version in `pins.json` `python`, downloaded from GitHub releases and cached in `.cache/pbs/`
   (or `--archive`). Its SHA-256 must equal `pins.json` `runtimeArchives.<t>.sha256`. An empty entry is
   filled from the release's `SHA256SUMS` on the first build and recorded in `pins.json` (commit it);
   from then on the recorded hash is the check.
2. **Trim.** Unpacked into `runtime/` (only `runtime/requirements.in` and `runtime/locks/` survive),
   then what opentide never loads is removed (`shouldRemove`): the shared `libpython` when the binary is
   static (Linux and macOS: the build checks that the binary does not load it), Tk and Tcl, headers and
   import libraries, `pip`, `idlelib`, `ensurepip`, `turtledemo`, the stdlib's and packages' test
   folders, test extension modules, `__pycache__`, and `share/` (man pages and terminfo, whose file names
   differ only in case, which a VSIX cannot hold). Symlinks are resolved: `bin/python3` becomes the
   binary.
3. **Closure.** `uv pip install --target <site-packages> --python-platform <triple> --python-version
   <cpython> --require-hashes --only-binary :all: -r runtime/locks/<t>.txt`. No sdist is ever built; a
   package without a wheel for the target fails the build and names the package. uv's console scripts
   are dropped: the extension runs `python -I -m opentide`. The installed distributions must be exactly
   the lock's.
4. **Records.** `runtime/BUILD-INFO.json` (build id, target, opentide, engine, CPython,
   python-build-standalone, archive and lock SHA-256), `runtime/sbom.cdx.json` (CycloneDX 1.5: the
   interpreter and every distribution with its licence, purl, and the SHA-256 and URL of the wheel that
   was installed, found on PyPI by its tags and the lock's hashes) and `runtime/THIRD-PARTY-NOTICES.txt`
   (CPython's licence, then each distribution's licence and every licence file it ships). opentide and
   its engine are EUPL-1.2, CPython PSF-2.0, each with its own licence files; the extension is MIT.

| Target | python-build-standalone | uv `--python-platform` |
|--------|-------------------------|------------------------|
| win32-x64 | x86_64-pc-windows-msvc | x86_64-pc-windows-msvc |
| win32-arm64 | aarch64-pc-windows-msvc | aarch64-pc-windows-msvc |
| linux-x64 | x86_64-unknown-linux-gnu | x86_64-manylinux_2_28 (VS Code's own glibc floor) |
| linux-arm64 | aarch64-unknown-linux-gnu | aarch64-manylinux_2_28 |
| alpine-x64 | x86_64-unknown-linux-musl | x86_64-unknown-linux-musl (musllinux_1_2) |
| alpine-arm64 | aarch64-unknown-linux-musl | aarch64-unknown-linux-musl |
| darwin-x64 | x86_64-apple-darwin | x86_64-apple-darwin, `MACOSX_DEPLOYMENT_TARGET` = `python.macosDeploymentTarget` |
| darwin-arm64 | aarch64-apple-darwin | aarch64-apple-darwin, likewise |

The layout the core runs (`bundledLayout` in `src/core/runtime/resolve.ts`): `runtime/bin/python3` on
Linux and macOS, `runtime/python.exe` on Windows, as `python -I -X utf8 -X
pycache_prefix=<globalStorage>/pycache -m opentide`. On first use of the bundled runtime the extension
compiles its bytecode into that prefix in the background, once per `BUILD-INFO.json` `buildId` and
runtime folder (with symbolic links resolved, as Python imports it), so an update that keeps the build
in a new extension folder compiles again (`src/core/runtime/precompile.ts`).

### `npm run runtime:lock [-- --target <t>] [-- --upgrade] [-- --check]`

`scripts/runtime-lock.mjs` writes `runtime/requirements.in` (`opentide==<pins.opentide.version>`) and,
for each target in `runtimeTargets`, `runtime/locks/<t>.txt` with `uv pip compile --python-platform
<triple> --python-version <cpython> --generate-hashes --only-binary :all:`. Both are committed. An
existing lock's versions are kept where `requirements.in` still allows them; `--upgrade` re-resolves to
the newest. `--check` fails when either is stale (CI). `--target` locks one target, also one outside
`runtimeTargets`, to see whether its closure has wheels yet: it fails naming the packages that have none.
The locks are uv's output, so CI and `publish.yml` install the uv `pins.json` names (`uv.version`, with
`astral-sh/setup-uv`), and the script warns when the local uv differs. Committed files are compared as
LF (`.gitattributes` keeps them LF in a Windows checkout too).

### `npm run package -- --target <t> | --universal [--pre-release]`

`scripts/package.mjs`, helpers in `scripts/package-lib.mjs`. It checks that `runtime/BUILD-INFO.json` is
this target's build of the pinned opentide and CPython, then runs `vsce package --target <t>
--no-dependencies` (vsce runs `vscode:prepublish`, the production build). `.vscodeignore` includes
`runtime/**` but not the locks; the universal package uses the same ignore file with `runtime/**`
excluded. Then the size gate (below) and the `.size.json` report.

### `npm run smoke -- <file.vsix> [--keep]`

`scripts/smoke.mjs`, helpers in `scripts/smoke-lib.mjs`, on a machine of the package's target (Alpine in
a container). It unpacks the VSIX (file modes kept) and runs the bundled interpreter as the extension
does:

1. `opentide --version` is the version in `BUILD-INFO.json`;
2. `opentide setup --path <tmp> --yes`, then `opentide --json doctor --offline` there: no failed check
   except the machine's own (`git`, `git_repository`, `proxy`), and the analysis engine loads;
3. `opentide lsp start`: `initialize` reports `capabilities.experimental.opentide.host.name ==
   "opentide"`, the host version, and the engine version `pins.json` derives (`highlights.version`).

It exits non-zero on any failure. On a universal package it checks there is no runtime and stops.

## The pins (`pins.json`)

| Key | |
|-----|-|
| `opentide.version` | The bundled opentide. `runtime/requirements.in` and the locks follow it |
| `python.pythonBuildStandalone`, `python.cpython`, `python.flavor` | The interpreter: the newest CPython for which every closure package has a wheel on every runtime target |
| `python.macosDeploymentTarget` | The oldest macOS the closure's wheels must load on |
| `highlights` | The language-server highlights zip; its version is the engine inside the bundled opentide |
| `runtimeTargets` | The VS Code targets that get a bundled runtime. Empty: universal only |
| `universalTargets` | Why each other target gets the universal package |
| `runtimeArchives.<t>` | The python-build-standalone archive name and SHA-256 per target |
| `vsix.budgetBytes`, `vsix.targetBytes` | The size gate (100 MiB) and the target (70 MiB) |
| `vsix.budgetOverrideBytes` | Optional `{ opentide, bytes, reason }`: a temporary larger gate for that opentide version only, ignored (with a warning) after a bump |

## The gates

| Gate | Where |
|------|-------|
| Lock freshness | `npm run runtime:lock -- --check` |
| Archive checksum | `runtime:build`, against `runtimeArchives` |
| Wheels only, hashed | `runtime:build` (`--require-hashes --only-binary :all:`); a missing wheel names the package |
| Closure equals the lock | `runtime:build` |
| Size: 100 MiB per VSIX | `npm run package`: fails, printing the size and the five largest directories (a site-packages distribution, else a folder at most three levels deep) |
| The package runs | `npm run smoke` on each target's runner |
| Bytecode precompile against a real runtime | `OPENTIDE_TEST_BUNDLED=<repo with a built runtime/> npm test` |

Measured on 2026-11-03 with opentide 0.21.0 (which still requires pandas, and so numpy: opentide#747
drops them; openpyxl is not in its closure), CPython 3.13.14 and python-build-standalone 20260718. All
three fit the 100 MiB gate, so `pins.json` has no budget override; only darwin-arm64 meets the 70 MiB
target. botocore (which only the Carbon Black SDK needs) and pandas with numpy make most of the
difference. (The darwin-arm64 and win32-x64 builds still carried `runtime/locks/`, 0.3 MiB, which the packages
now leave out.)

| Target | VSIX | Installed | Largest directories (compressed) |
|--------|-----:|----------:|----------------------------------|
| linux-x64 | 80.1 MiB | 223.3 MiB | botocore 15.0, bin 11.9, numpy.libs 8.2, pandas 8.2, opentide 6.8 |
| darwin-arm64 | 67.9 MiB | 183.5 MiB | botocore 15.0, numpy 10.0, pandas 7.5, bin 7.4, opentide 6.5 |
| win32-x64 | 74.0 MiB | 200.2 MiB | botocore 15.0, opentide 6.8, pandas 6.8, numpy.libs 6.5, DLLs 4.4 |
| universal | 0.4 MiB | 1.5 MiB | dist 0.2, dist/webview 0.2 |

Every package carries the production build (`vscode:prepublish`: minified, no source maps). With every
feature merged: `dist/extension.js` 746 KiB and `dist/webview/graph.js` 520 KiB (Cytoscape), against
1.5 MiB and 1.1 MiB in `npm run build`; the other webviews are 14–24 KiB each.

## Why a target gets the universal package

- **win32-arm64:** opentide 0.21.0 publishes no `win_arm64` wheel (opentide#748 adds one) and
  cryptography ≥ 47 has none, so its closure cannot be installed. `npm run runtime:lock -- --target
  win32-arm64` says which packages are missing.
- **alpine-x64, alpine-arm64** get a runtime: opentide publishes `musllinux_1_2` wheels (its `_native`
  engine is in the abi3 wheel), and every closure package has a musllinux or pure wheel.

To move a target from universal to a runtime: `npm run runtime:lock -- --target <t>` until it resolves,
add it to `runtimeTargets`, drop it from `universalTargets`, and commit the new lock.

## Bumping opentide

1. Set `pins.json` `opentide.version`.
2. If the engine inside that opentide changed, bump `highlights` (version, URL, SHA-256), then `npm run
   grammars && npm run manifest`.
3. `npm run runtime:lock -- --upgrade` (or without `--upgrade` to keep the other packages where they
   are), and commit `runtime/requirements.in` and `runtime/locks/`.
4. Review `runtimeTargets`/`universalTargets` (a target may gain wheels) and drop a
   `vsix.budgetOverrideBytes` for the old version.
5. Build and package one target locally, and check the size report.

## Bumping CPython or python-build-standalone

1. Set `python.cpython` and/or `python.pythonBuildStandalone`.
2. Set every `runtimeArchives.<t>` to `{ "sha256": null }`: a recorded hash of another archive fails the
   build on purpose.
3. `npm run runtime:lock`, then `npm run runtime:build -- --target <t>` for each target (it records the
   new hashes from the release's `SHA256SUMS`), and commit `pins.json` and the locks.
