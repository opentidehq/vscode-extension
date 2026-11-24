# Releasing the extension

A release is **Run workflow** on [`publish.yml`](../.github/workflows/publish.yml) on `main`, with no
inputs, after a notes PR has merged. The workflow reads the version from `CHANGELOG.md`, builds and
smoke-tests the packages (one universal package per store: the extension bundles no runtime), tags
`v<version>`, creates the GitHub Release, and publishes to the Visual Studio Marketplace and Open VSX
with trusted publishing (OIDC; no long-lived token). It is modelled on
opentide's `publish-pypi.yml` and language-server's `release.yml`. Agents: [`.agents/skills/release/SKILL.md`](../.agents/skills/release/SKILL.md).

- [One-time setup](#one-time-setup)
- [Cutting a release](#cutting-a-release)
- [Pre-release and stable](#pre-release-and-stable)
- [Release cadence and opentide bumps](#release-cadence-and-opentide-bumps)
- [What the workflow does](#what-the-workflow-does)
- [When something fails](#when-something-fails)

## One-time setup

Do these once, in this order, before the first release. Each names where the setting lives.

### Two publishers, and why

The extension has a different id (publisher and name), and a different display name, in each store:

| Store | Publisher | Extension id | Display name | Package |
|-------|-----------|--------------|--------------|---------|
| Visual Studio Marketplace | `opentide` | `opentide.opentide-vscode` | opentide for VS Code | `opentide-marketplace-<version>.vsix` |
| Open VSX | `opentidehq` (verified namespace) | `opentidehq.opentide` | opentide | `opentide-openvsx-<version>.vsix` |

- The Marketplace publisher `opentidehq` was banned and cannot be registered again: 0.3.0's publish
  failed on every attempt with `RequestBlockedException … Concurrency … VSID`, and the Marketplace has
  never listed `opentidehq.opentide`. The Marketplace publisher is `opentide`.
- **The Marketplace package is `opentide.opentide-vscode`, "opentide for VS Code".** The Marketplace holds
  the extension name `opentide` across publishers (the banned `opentidehq` extension, hidden from the
  gallery, still has it). 0.3.1 (run 45187038205) passed the OIDC login and was refused with "The extension
  'opentide' already exists in the Marketplace. Please use a different 'name'"; 0.3.2 (run 45196460839),
  with the display name changed to "opentide for VS Code", was refused the same way. So the `name` itself
  changed: `opentide-vscode`. Neither 0.3.1 nor 0.3.2 ever reached the Marketplace; the first version
  there is 0.3.3, and the job refuses anything older. Never re-run either run's Marketplace job. If a
  publish is refused again, the job fails on vsce's own error, which stays in the log; nothing retries a
  refusal (`tools/publish/marketplace.mjs` stops on it).
- **The Marketplace trusted-publishing policy must name the extension `opentide-vscode`**, if the policy is
  scoped to an extension: a policy created for `opentide` would refuse the OIDC exchange for the new name.
- Open VSX keeps its verified namespace `opentidehq`, the name `opentide` and the display name "opentide":
  0.3.0, 0.3.1 and 0.3.2 are `opentidehq.opentide` there, so its users keep their updates. The namespace
  `opentide` cannot be verified there.
- **Settings, commands, views, languages and the MCP provider do not depend on the name or the publisher**:
  they are `opentide*` ids of their own, the same in both packages (`test/scripts/package.test.mjs` builds the
  Marketplace manifest and checks its contributions are unchanged). The code takes the id from
  `context.extension.id`.
- Both packages come from one commit. `npm run package` packages it twice (vsce builds it each time): the
  Marketplace package with `package.json`'s `name`, `publisher` and `displayName` lines set to
  `opentide-vscode`, `opentide` and "opentide for VS Code" while vsce runs, then the Open VSX package from
  `package.json` as committed (`"name": "opentide"`, `"publisher": "opentidehq"`, `"displayName": "opentide"`).
  It checks that every other entry of the two is byte-identical
  (`scripts/package-lib.mjs` `STORES`; `node scripts/release.mjs assets` checks it again before the
  release).
- **Only new versions go to the Marketplace.** `opentide.opentide-vscode` starts at 0.3.3. Never publish,
  backfill or re-run anything older there: 0.3.2 and earlier were built as `opentidehq.opentide` or
  `opentide.opentide`. The `publish-marketplace` job refuses a version before 0.3.3, or any file but this
  release's `opentide-marketplace-<version>.vsix` (`tools/publish/marketplace.mjs --check`). Never use
  **Re-run failed jobs** on a run of 0.3.2 or earlier.
- The code never names the id: it takes `context.extension.id` (the MCP entry's marker and the launcher's
  folder match). Settings, commands, views and the MCP provider are `opentide.*` in both.

### 1. The GitHub environment `production`

Repository **Settings → Environments → New environment**, named exactly `production`. Both publish jobs
run in it, and both stores' trusted-publishing registrations (each for its own publisher) name it.

- **Deployment branches and tags:** *Selected branches and tags*, add `main`. A run from another branch
  then cannot publish.
- **Required reviewers (optional):** add the people who approve a publish. The run then pauses before
  the two publish jobs, after the GitHub Release exists; one review can approve both.
- **Secrets:** `OVSX_PAT`, only for the first Open VSX publish (step 3); delete it afterwards.

### 2. The repository

- **Make the repository public** (**Settings → General → Danger Zone → Change visibility**) before the
  first release. Two things depend on it:
  - **Artifact attestations** (`actions/attest-build-provenance`) need a public repository, or GitHub
    Enterprise Cloud for a private one. On a private repository the `attest` job skips them with a
    warning, and the release goes out with `SHA256SUMS` only (its notes then leave out
    `gh attestation verify`). On GitHub Enterprise Cloud, set the repository variable `ATTEST` to
    `true` (**Settings → Secrets and variables → Actions → Variables**) to attest a private repository.
- **Settings → Actions → General → Workflow permissions** can stay *Read repository contents*: the
  workflow asks for `contents: write` itself, in its `release` job only.

### 3. Open VSX: namespace, first publish, trusted publisher

Open VSX trusted publishing cannot create an extension, so the first version is published with an access
token, then the token is replaced by the trusted publisher.

1. Sign in to [open-vsx.org](https://open-vsx.org) with the GitHub account that will own the namespace,
   and sign the Eclipse Foundation Open VSX Publisher Agreement (**Settings → Profile**).
2. **Settings → Access Tokens → Generate New Token**, described as `vscode-extension first publish`.
3. Create the namespace: `npx ovsx@1.4.0 create-namespace opentidehq -p <token>`. Then claim it
   (verified ownership): open an issue at
   [EclipseFdn/open-vsx.org](https://github.com/EclipseFdn/open-vsx.org/issues/new/choose) with the
   *Claim namespace ownership* template for `opentidehq`, linking the `opentidehq` GitHub organisation.
4. Save the token as the `production` environment secret `OVSX_PAT` (step 1).
5. Release (below). The `publish-openvsx` job sees `OVSX_PAT`, publishes with it, and warns that it did.
6. On open-vsx.org, **Settings → Trusted Publishers → Add**: provider *GitHub Actions*, repository
   `opentidehq/vscode-extension`, workflow `publish.yml`, environment `production`, for the extension
   `opentidehq.opentide`.
7. Delete the `OVSX_PAT` secret and revoke the token on open-vsx.org. From the next release, the job
   publishes with `--trusted-publishing`.

### 4. Visual Studio Marketplace: the publisher `opentide` and its trusted-publishing policy

The publisher is `opentide` (not `opentidehq`: see [Two publishers](#two-publishers-and-why)). It has a
trusted-publishing policy: provider GitHub Actions, owner `opentidehq`, repository `vscode-extension`,
workflow `publish.yml`, environment `production`. Nothing else is needed: `vsce publish --oidc`
exchanges the job's OIDC token for a Marketplace token, and `publish-marketplace` publishes only
`opentide-marketplace-<version>.vsix`, the extension `opentide-vscode` of the publisher `opentide`. If the
policy names an extension, it must be `opentide-vscode` (a policy for `opentide` would refuse the exchange).

> **A policy that is not used in time expires.** A publish through it activates it. If the first
> release under `opentide` cannot run before the policy's deadline, create it again, with the same
> values, on the publisher's management page (<https://marketplace.visualstudio.com/manage/publishers/opentide>).

Renaming `publish.yml` or the `production` environment breaks both stores' trusted publishing: change
the registrations first.

The publish jobs run `vsce` and `ovsx` from [`tools/publish/package-lock.json`](../tools/publish/package-lock.json),
installed with `npm ci --ignore-scripts`, never through `npx`: those jobs hold `id-token: write` (and
the Open VSX job the `OVSX_PAT` secret, in its publish step only), so no unlocked package or install
script runs there. To bump them, change `tools/publish/package.json` and run `npm install
--package-lock-only --ignore-scripts` in that folder (Dependabot does both); check that `vsce publish
--help` still lists `--oidc` and `ovsx publish --help` `--trusted-publishing`.

### 5. First-publish checklist

- [ ] Environment `production` exists, limited to `main` (optionally with reviewers).
- [ ] The repository is public (attestations), or on GitHub Enterprise Cloud with
      the variable `ATTEST=true`.
- [ ] Open VSX: publisher agreement signed, namespace `opentidehq` created (and claimed), `OVSX_PAT`
      saved in `production`.
- [ ] Marketplace: the publisher `opentide` exists with its trusted-publishing policy (step 4).
- [ ] The notes PR for the first version has merged (below); its minor is odd, so it is a pre-release.
- [ ] Run **Publish** on `main` before the Marketplace policy's deadline.
- [ ] Both stores list the version: `opentide.opentide-vscode` on the Marketplace, `opentidehq.opentide` on
      Open VSX; install the first in VS Code and the second in VSCodium or Cursor.
- [ ] Open VSX trusted publisher registered; `OVSX_PAT` deleted and revoked.

## The antivirus gate

The Marketplace banned the old publisher, `opentidehq`, at 0.2.0 for bundling heavy native binaries and for
Microsoft Defender detections. Both packages pass [`av-gate.yml`](../.github/workflows/av-gate.yml) before
`attest` and the GitHub Release, so before either store. CI runs the same gate on every pull request's packages.

| Job | Checks | Fails on |
|-----|--------|----------|
| `static` | `scripts/av-gate.mjs static`: every file of each VSIX, nested zip, gzip and tar archives opened; the size against `pins.json` `vsix.recordedBytes`; YARA (`scripts/av/package.yar`), proven on a canary written at run time | any PE, ELF or Mach-O file at any depth (only WebAssembly, JavaScript and data are allowed); an archive it cannot read; a package more than `vsix.growthLimit` (10 %) over its recorded size; a YARA match |
| `clamav` | ClamAV with signatures `freshclam` just fetched (a daily database over 48 hours old fails), proven on EICAR canaries (plain and zipped) written at run time; each `.vsix` and every extracted file, archives scanned, limits set to report rather than skip | any detection; a file over a scan limit |
| `defender` | Microsoft Defender on `windows-latest` (`scripts/av/defender-scan.ps1`): the runner image's exclusions removed (GitHub's images exclude `C:\` and `D:\`, where the artifacts are, so a scan would report clean while scanning nothing: opentide#1752), samples never sent, signatures updated, an EICAR canary written at run time that must be detected for the scan to count; then `MpCmdRun -Scan -ScanType 3 -DisableRemediation` on each `.vsix`, each extracted VSIX and each `.wasm` and JavaScript file, verdicts read from MpCmdRun's output | any detection, by the scans or by real-time protection; a path exclusion that remains; an output that says neither "no threats" nor "N threats" |

- **Nothing is uploaded** to VirusTotal or any other external scanner, and no file in the repository holds the
  EICAR string: the canaries are put together at run time (a test checks both).
- **The YARA rules judge format only.** The package is a detection-engineering tool: its skills and catalogue
  describe attacker tooling in plain text, which string rules would flag. Defender and ClamAV judge content.
- **A package that grew on purpose** records its new size in `pins.json` `vsix.recordedBytes` in the same PR
  (the size `npm run package` prints).
- **Dry run:** **Actions → AV gate → Run workflow** (optionally with a version, such as the next release's)
  packages the extension at that version, without committing it, and runs the gate. Nothing is tagged,
  released or published. The notes PR's own CI also runs the gate on the real packages of the version it releases.

## Cutting a release

### Step 1: the notes PR

A `docs:` (or `chore:`) PR to `main`, alone:

1. **`CHANGELOG.md`:** move everything under `## [Unreleased]` into a new section directly below it,
   and leave `## [Unreleased]` empty:

   ```markdown
   ## [Unreleased]

   ## [0.3.0] - 2026-11-20

   One paragraph: what this release is for, and the opentide it bundles (opentide 0.22.0).

   ### Added

   - …

   ### Changed

   - …

   ### Fixed

   - …
   ```

   - The heading is `## [x.y.z] - YYYY-MM-DD` (a hyphen; an en or em dash also works). The newest dated
     section is the version the workflow releases.
   - The opening paragraph and the lists below it become the GitHub Release notes, unwrapped, with
     relative links pointed at the tag, followed by install and verify instructions
     (`node scripts/release.mjs notes` prints them).
   - The sections are `Upgrade` and `Breaking`, then [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)'s
     `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`, in that order, each left out
     when empty. How to write the summary and the entries:
     [`.agents/skills/release-notes/SKILL.md`](../.agents/skills/release-notes/SKILL.md).
   - Version link definitions at the bottom (`[0.3.0]: …`) are optional and left out of the notes.
2. **`package.json`:** `"version": "0.3.0"`, and the same in `package-lock.json`
   (`npm version 0.3.0 --no-git-tag-version`).
3. Check: `node scripts/release.mjs check v0.3.0` prints `v0.3.0 is ready to release`.

CI must be green on the PR. Merge it.

### Step 2: Run workflow

**Actions → Publish → Run workflow**, branch `main`. With `gh`:

```bash
gh workflow run publish.yml --ref main --repo opentidehq/vscode-extension
gh run watch --repo opentidehq/vscode-extension
```

If `production` has reviewers, approve the two publish jobs when the run pauses.

### Step 3: check

- The [GitHub Release](https://github.com/opentidehq/vscode-extension/releases) has both VSIXs
  (`opentide-marketplace-<version>.vsix`, `opentide-openvsx-<version>.vsix`) and `SHA256SUMS`;
  `gh attestation verify <file>.vsix --repo opentidehq/vscode-extension` passes for each (unless the run
  warned "No build provenance": a private repository).
- The [Marketplace](https://marketplace.visualstudio.com/items?itemName=opentide.opentide-vscode) lists
  `opentide.opentide-vscode` and [Open VSX](https://open-vsx.org/extension/opentidehq/opentide)
  `opentidehq.opentide` at the version.

## Pre-release and stable

| Minor | Channel | Packaged and published with | GitHub Release |
|-------|---------|-----------------------------|----------------|
| odd (`0.1.x`, `0.3.x`) | pre-release | `--pre-release` | marked pre-release |
| even (`0.2.x`, `1.0.x`) | stable | — | latest |

- The store versions are plain `x.y.z`: the Marketplace accepts no `-beta` suffix, so the minor's parity
  is the channel. `scripts/release.mjs prerelease` computes it, and `assets` refuses a package whose
  pre-release flag disagrees.
- Users on the pre-release channel get the highest version of either channel, so a stable release is
  the next even minor above the last pre-release (`0.3.4` → `0.4.0`), and the next pre-releases are
  `0.5.x`.
- Pre-releases ship along the way, to both stores, so forks' users can try them; stable releases follow
  the cadence below.

## Release cadence and opentide bumps

The extension bundles no Python (SPEC D1): users upgrade opentide themselves (`pip install --upgrade
opentide`), and a release follows the extension's own changes. A bump of `pins.json` `opentide.version`
changes only what CI tests against ([PACKAGING.md](PACKAGING.md#bumping-what-the-extension-ships-and-tests-against)):
it needs no release unless the extension changes with it. A bump of `wasi`, `highlights` and `engine` (the
opentide the extension carries) is a change to the package: it ships in the next release. `release.mjs
check` refuses a release while `pins.json` `wasi.sha256` is still a placeholder.

## What the workflow does

| Job | Runs on | Does |
|-----|---------|------|
| `prepare` | ubuntu | Refuses unless run on `main`, `CHANGELOG.md`'s newest version matches `package.json`, `[Unreleased]` is empty and `v<version>` is not tagged; computes the channel |
| `universal` | ubuntu | CI's checks, then `npm run package -- --universal` (one universal package per store, every platform and the web) and a smoke test of each |
| `av-gate` | ubuntu, windows | [The antivirus gate](#the-antivirus-gate) on both packages: no native executables, the size, YARA, ClamAV, Microsoft Defender |
| `attest` | ubuntu | `opentide-marketplace-<version>.vsix` is `opentide.opentide-vscode` and `opentide-openvsx-<version>.vsix` is `opentidehq.opentide`, both at the version and channel, universal, and otherwise identical; `SHA256SUMS`; build provenance for each file (public repository, or `ATTEST=true`; else a warning) |
| `release` | ubuntu | Tags `v<version>` on the built commit with the GitHub Release (notes from the changelog, every asset), then checks the downloads against `SHA256SUMS` and, when attested, their attestations |
| `publish-marketplace` | ubuntu, `production` | `vsce publish --oidc --skip-duplicate --packagePath opentide-marketplace-<version>.vsix`. Then `tools/publish/marketplace.mjs opentide.opentide-vscode` waits until the Marketplace gallery lists it, publishes it again if missing, and fails naming it: vsce's "Published" is not the listing (0.1.0, the first publish, kept one package of eight) |
| `publish-openvsx` | ubuntu, `production` | `ovsx publish --trusted-publishing --skip-duplicate --packagePath opentide-openvsx-<version>.vsix`, or with `OVSX_PAT` when the secret is set |

The stores get nothing until the GitHub Release exists, and nothing is tagged until the package has
built and passed its smoke test.

## When something fails

| Failure | Do |
|---------|----|
| `prepare`: `[Unreleased] still holds …`, a version mismatch | Fix it in a PR; run again |
| `prepare`: `v<version> is already tagged` | That version is out: re-run the failed jobs of its run, or release the next version |
| `universal` or `attest` | Nothing was tagged. Fix it on `main` (a PR) and run again |
| `av-gate`: a native executable, a detection or the size | Nothing was tagged. Find what the package carries (the job names the file); a growth that is meant records its size in `pins.json`; a detection that is a false positive is reported to the vendor, never waved through. Fix in a PR and run again |
| `av-gate`: a canary was not detected, or signatures could not be updated | The scanner, not the package: **Re-run failed jobs** once; if it fails again, fix the gate in a PR |
| `release` (GitHub Release) | **Re-run failed jobs**. When an earlier attempt already made the Release (for example the verify step failed), the job finds it, checks that its tag is on the run's commit, uploads the assets again with `--clobber` and goes on; a Release on another commit stops it. The stores get nothing until it succeeds |
| `publish-marketplace` or `publish-openvsx` | **Re-run failed jobs** on the run (never on a run of 0.3.2 or earlier for the Marketplace). The other store is unaffected; `--skip-duplicate` skips what a store already has |
| Open VSX `401`/`403` with trusted publishing | The trusted publisher's repository, workflow (`publish.yml`) or environment (`production`) differs from the run's; fix the registration and re-run the job |
| Marketplace OIDC exchange refused | The policy expired or names something else (it is the publisher `opentide`'s); recreate it (step 4) and re-run the job |
| `attest`: `… is opentide.opentide, not opentide.opentide-vscode`, `… is named "opentide", not "opentide for VS Code"` or `… differs … beyond the name, publisher and display name` | The packages differ beyond the name, publisher and display name, or carry the wrong ones: fix `npm run package` (`scripts/package.mjs`) in a PR; nothing was tagged |
| Marketplace: vsce refused the package (its error is in the log, e.g. "already exists in the Marketplace") | Read vsce's error: the job stops on it and nothing retries it. A taken display name or `name` needs a new one in `scripts/package-lib.mjs` `STORES` (a PR, then the next version) |

A re-run uses the run's own commit and the GitHub Release's assets, so it publishes exactly what was
tagged and attested.
