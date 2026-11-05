# Packaging

How the VSIX packages are built: the bundled runtime, the pins, the gates, and how to bump opentide.
What and why is [SPEC §3](SPEC.md#3-distribution-marketplace-and-open-vsx) and
[D1](SPEC.md#d1-bundle-a-complete-opentide-runtime-in-each-per-platform-package); this is how.

## The packages

| Package | Built with | Contents |
|---------|------------|----------|
| Per-platform, one per target in `pins.json` `runtimeTargets` | `npm run package -- --target <t>` | The extension, grammars, `dist/engine/` and `runtime/`: CPython, the opentide closure, `BUILD-INFO.json`, `sbom.cdx.json`, `THIRD-PARTY-NOTICES.txt`. An `emulatedTargets` target's `runtime/` is another target's ([below](#emulated-targets-win32-arm64)) |
| Universal | `npm run package -- --universal` | The extension, grammars and `dist/engine/`, no `runtime/` |

`dist/engine/` is the engine (WASM), the runtime of tier 5 ([SPEC §4](SPEC.md#4-the-runtime-resolution-processes-status)):
`npm run build` unpacks the `opentide-wasm-web` zip that `pins.json` `engine` pins (URL and SHA-256, the
zip's line in the language-server release's `SHA256SUMS`, cached in `.cache/`), bundles its wasm-bindgen
glue into `dist/engine/worker.js`, and copies `opentide_wasm_bg.wasm`, the zip's `LICENSE`, `NOTICE` and
`licenses/`, and the release's `THIRD-PARTY-LICENSES.html` (pinned the same way) next to it, with
`engine.json` (version and checksums), which the resolver reads (`scripts/engine-lib.mjs`). Every package
carries it, the per-platform ones as the safety net for a bundled runtime that does not start; the cost
is in the size table below.

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

### Emulated targets (win32-arm64)

`pins.json` `emulatedTargets` maps a runtime target to the target whose runtime its package bundles,
which the OS runs under emulation: `"win32-arm64": { "runtime": "win32-x64", "reason": … }`. The
package is still `vsce package --target win32-arm64`, so VS Code on Windows on Arm installs it; its
`runtime/` is win32-x64's: the `x86_64-pc-windows-msvc` interpreter (`runtimeArchives.win32-x64`),
`runtime/locks/win32-x64.txt` installed for `x86_64-pc-windows-msvc`, and
`runtime-licenses/win32-x64.json`. There is no second lock, licence file or archive record: the scripts
map the target with `runtimeOf` (`scripts/runtime-lib.mjs`), and `lockTargets` lists each runtime once.
`BUILD-INFO.json` has `target: "win32-arm64"` and `runtime: "win32-x64"`; the SBOM and the notices say
"win32-arm64: the win32-x64 runtime, under emulation". The extension finds it as it finds any Windows
runtime (`runtime/python.exe`; nothing in `src/core/runtime` depends on `process.arch`).

Why: cryptography published `win_arm64` wheels for 46.0.0 to 46.0.3 only (checked on PyPI on
2026-11-05: none for 46.0.4 to 50.0.2, abi3 included), while every other target locks 50.x. A native
closure would ship 46.0.3, which has seven advisories that 50.x fixes (CVE-2026-26007, CVE-2026-34073,
CVE-2026-39892, CVE-2026-69247, CVE-2026-69248, CVE-2026-69249, and GHSA-537c-gmf6-5ccf for the OpenSSL
in its wheels). Windows 11 on Arm runs x64 programs under its emulation (Prism), so the x64 runtime,
opentide's x64 wheel and its Rust engine run there unchanged. CI builds the package on `windows-11-arm`
and runs its smoke test, the unit tests against that runtime and VS Code's integration, bundled-runtime
(`npm run test:bundled`) and Restricted Mode tests there, next to win32-x64 on `windows-latest`.

**Windows 10 on Arm** emulates only 32-bit x86, not x64, so the bundled `python.exe` does not start: the
extension logs that the bundled runtime did not start and why ("This package's runtime is x64: Windows
11 on Arm runs it under emulation, Windows 10 on Arm cannot"), and works with an opentide of the user's
own (tiers 1 to 3), as the universal package did. Windows 10 is past end of support (2025-10-14;
consumer ESU ended 2026-10-13), and VS Code supports only the Windows client versions Microsoft
supports.

To go native again once cryptography publishes a `win_arm64` wheel: `npm run runtime:lock -- --target
win32-arm64` (it locks natively, warning that the lock is unused while the target is emulated) until its
versions match the other targets', drop the `emulatedTargets` entry, `npm run runtime:licenses -- --target
win32-arm64`, build it (which records `runtimeArchives.win32-arm64`), commit the lock, licences and pins,
and remove `bundledEmulationHint` (`src/core/runtime/emulation.ts`; a unit test fails until you do).

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
   (CPython's licence, the native libraries linked into it, then each distribution's licence and every
   licence file it ships). opentide and its engine are EUPL-1.2, CPython PSF-2.0, each with its own
   licence files; the extension is MIT.

   The native libraries (OpenSSL, zlib, libffi, expat, bzip2, liblzma, sqlite, ncurses, …) come from
   `runtime-licenses/<t>.json`: the build refuses to run without it, or with one for another CPython or
   python-build-standalone. `install_only_stripped` carries neither their list nor their licences, so
   `npm run runtime:licenses [-- --target <t>]` (`scripts/runtime-licenses.mjs`) reads them from the same
   release's `full` archive (`python/PYTHON.json`, `python/licenses/`), streamed and SHA-256-checked
   against `SHA256SUMS`, and commits only what it needs. They are a section each in the notices and
   components nested under `cpython` in the SBOM.

| Target | python-build-standalone | uv `--python-platform` |
|--------|-------------------------|------------------------|
| win32-x64 | x86_64-pc-windows-msvc | x86_64-pc-windows-msvc |
| win32-arm64 | x86_64-pc-windows-msvc (emulated: win32-x64's runtime) | x86_64-pc-windows-msvc |
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
for the runtime of each target in `runtimeTargets` (once each: win32-arm64 adds none), `runtime/locks/<t>.txt` with `uv pip compile --python-platform
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

1. the interpreter is of its runtime's architecture (`sysconfig.get_platform()`: `win-amd64` for
   win32-arm64 too), and `opentide --version` is the version in `BUILD-INFO.json`, timed cold (no
   bytecode) and warm (median of three);
2. `opentide setup --path <tmp> --yes`, then `opentide --json doctor --offline` there: no failed check
   except the machine's own (`git`, `git_repository`, `proxy`), and the analysis engine loads;
3. with `test/fixtures/workspace/objects` copied in, `opentide --json info catalog` lists its objective
   and rule, loaded, and the rule's edge to the objective;
4. `opentide lsp start`: `initialize` reports `capabilities.experimental.opentide.host.name ==
   "opentide"`, the host version, and the engine version `pins.json` derives (`highlights.version`).

It prints the time of each step (`smoke: timing …`); CI puts them in the job summary.

It exits non-zero on any failure. On a universal package it checks there is no runtime and stops.

## The pins (`pins.json`)

| Key | |
|-----|-|
| `opentide.version` | The bundled opentide. `runtime/requirements.in` and the locks follow it |
| `python.pythonBuildStandalone`, `python.cpython`, `python.flavor` | The interpreter: the newest CPython for which every closure package has a wheel on every runtime target |
| `python.macosDeploymentTarget` | The oldest macOS the closure's wheels must load on |
| `highlights` | The language-server highlights zip; its version is the engine inside the bundled opentide |
| `engine` | The language-server `opentide-wasm-web` zip (version, URL, SHA-256) and the release's `THIRD-PARTY-LICENSES.html` (URL, SHA-256): the engine (WASM). Same release as `highlights` |
| `runtimeTargets` | The VS Code targets that get a bundled runtime. Empty: universal only |
| `universalTargets` | Why each other target gets the universal package |
| `emulatedTargets.<t>` | `{ runtime, reason }`: a runtime target whose package bundles `runtime`'s runtime, which the OS emulates (win32-arm64: win32-x64). Same OS, not itself emulated |
| `runtimeArchives.<t>` | The python-build-standalone archive name and SHA-256 per runtime (none for an emulated target) |
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
| The package runs | `npm run smoke` on each target's runner (win32-arm64: `windows-11-arm`) |
| The extension runs its bundled runtime | `npm run test:bundled` with a built `runtime/` (CI: both Windows targets) |
| Bytecode precompile against a real runtime | `OPENTIDE_TEST_BUNDLED=<repo with a built runtime/> npm test` |

Measured on 2026-11-04 with opentide 0.22.0 (which no longer requires pandas or numpy, opentide#747;
openpyxl is not in its closure), CPython 3.13.14 and python-build-standalone 20260718. Every package
fits the 100 MiB gate and meets the 70 MiB target, so `pins.json` has no budget override. botocore
(which only the Carbon Black SDK needs) is now the largest directory in each. With opentide 0.21.0 the
same packages were 80.5 MiB for linux-x64 (224.7 MiB installed, the same extension build), and on
2026-11-03 67.9 MiB for darwin-arm64 and 74.0 MiB for win32-x64.

| Target | VSIX | Installed | Largest directories (compressed) |
|--------|-----:|----------:|----------------------------------|
| linux-x64 | 57.7 MiB | 150.6 MiB | botocore 15.0, bin 11.9, opentide 6.8, cryptography 4.6, lib/python3.13 3.5 |
| darwin-arm64 | 50.2 MiB | 127.1 MiB | botocore 15.0, bin 7.4, opentide 6.6, cryptography 3.7, lib/python3.13 2.6 |
| win32-x64 | 56.1 MiB | 144.4 MiB | botocore 15.0, opentide 6.9, DLLs 4.4, cryptography 3.6, runtime 2.7 |
| win32-arm64 (2026-11-05: win32-x64's runtime) | 56.1 MiB | 144.4 MiB | the same as win32-x64 |
| universal | 0.6 MiB | 1.9 MiB | dist 0.2, dist/webview 0.2, dist/webview/codicons 0.1 |

With the engine (WASM), measured on 2026-11-05 with language-server 0.10.0's `opentide-wasm-web`: the
universal package is 4.0 MiB (17.6 MiB installed), its largest directory `dist/engine` at 3.4 MiB
compressed (15.7 MiB installed: the 15.5 MiB module, its worker and licences). Each per-platform package
grows by the same 3.4 MiB, about 6%: linux-x64 61.1 MiB (measured in CI, 166.3 MiB installed, its
smoke test running the engine too), darwin-arm64 about 53.6 MiB and win32-x64 about 59.5 MiB, all under
the 70 MiB target.

Every package carries the production build (`vscode:prepublish`: minified, no source maps). With every
feature merged: `dist/extension.js` 746 KiB and `dist/webview/graph.js` 520 KiB (Cytoscape), against
1.5 MiB and 1.1 MiB in `npm run build`; the other webviews are 14–24 KiB each.

## Why a target gets the universal package

- **None today.** win32-arm64 was universal until it got the win32-x64 runtime under emulation
  ([Emulated targets](#emulated-targets-win32-arm64)).
- **alpine-x64, alpine-arm64** get a runtime: opentide publishes `musllinux_1_2` wheels (its `_native`
  engine is in the abi3 wheel), and every closure package has a musllinux or pure wheel.

To move a target from universal to a runtime: `npm run runtime:lock -- --target <t>` until it resolves,
add it to `runtimeTargets`, drop it from `universalTargets`, and commit the new lock.

## Bumping opentide

1. Set `pins.json` `opentide.version`.
2. If the engine inside that opentide changed, bump `highlights` (version, URL, SHA-256), then `npm run
   grammars && npm run manifest`, and `engine` to the same release (the zip's and `THIRD-PARTY-LICENSES.html`'s
   URLs and SHA-256 from its `SHA256SUMS`); `npm run build` unpacks it.
3. `npm run runtime:lock -- --upgrade` (or without `--upgrade` to keep the other packages where they
   are), and commit `runtime/requirements.in` and `runtime/locks/`.
4. Review `runtimeTargets`/`universalTargets` (a target may gain wheels) and drop a
   `vsix.budgetOverrideBytes` for the old version.
5. Build and package one target locally, and check the size report.

## Bumping CPython or python-build-standalone

1. Set `python.cpython` and/or `python.pythonBuildStandalone`.
2. Set every `runtimeArchives.<t>` to `{ "sha256": null }`: a recorded hash of another archive fails the
   build on purpose.
3. `npm run runtime:lock` and `npm run runtime:licenses`, then `npm run runtime:build -- --target <t>`
   for each target (it records the new hashes from the release's `SHA256SUMS`), and commit `pins.json`,
   the locks and `runtime-licenses/`.
