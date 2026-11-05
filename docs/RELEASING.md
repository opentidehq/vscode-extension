# Releasing the extension

A release is **Run workflow** on [`publish.yml`](../.github/workflows/publish.yml) on `main`, with no
inputs, after a notes PR has merged. The workflow reads the version from `CHANGELOG.md`, builds and
smoke-tests every package, tags `v<version>`, creates the GitHub Release, and publishes to the Visual
Studio Marketplace and Open VSX with trusted publishing (OIDC; no long-lived token). It is modelled on
opentide's `publish-pypi.yml` and language-server's `release.yml`. Agents: [`.agents/skills/release/SKILL.md`](../.agents/skills/release/SKILL.md).

- [One-time setup](#one-time-setup)
- [Cutting a release](#cutting-a-release)
- [Pre-release and stable](#pre-release-and-stable)
- [Release cadence and opentide bumps](#release-cadence-and-opentide-bumps)
- [What the workflow does](#what-the-workflow-does)
- [When something fails](#when-something-fails)

## One-time setup

Do these once, in this order, before the first release. Each names where the setting lives.

### 1. The GitHub environment `production`

Repository **Settings → Environments → New environment**, named exactly `production`. Both publish jobs
run in it, and both stores' trusted-publishing registrations name it.

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
  - **Arm runners** (`ubuntu-24.04-arm`, `windows-11-arm`) are free for public repositories; a private
    repository needs a plan that includes them, or the linux-arm64 and alpine-arm64 builds
    wait for a runner that never comes.
- **Settings → Actions → General → Workflow permissions** can stay *Read repository contents*: the
  workflow asks for `contents: write` itself, in its `release` job only.

### 3. Open VSX: namespace, first publish, trusted publisher

Open VSX trusted publishing cannot create an extension, so the first version is published with an access
token, then the token is replaced by the trusted publisher.

1. Sign in to [open-vsx.org](https://open-vsx.org) with the GitHub account that will own the namespace,
   and sign the Eclipse Foundation Open VSX Publisher Agreement (**Settings → Profile**).
2. **Settings → Access Tokens → Generate New Token**, described as `vscode-extension first publish`.
3. Create the namespace: `npx ovsx@1.3.0 create-namespace opentidehq -p <token>`. Then claim it
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

### 4. Visual Studio Marketplace: the trusted-publishing policy

The publisher `opentidehq` has a trusted-publishing policy for the extension `opentide`: provider
GitHub Actions, owner `opentidehq`, repository `vscode-extension`, workflow file
`.github/workflows/publish.yml`, environment `production`. Nothing else is needed: `vsce publish --oidc`
exchanges the job's OIDC token for a Marketplace token.

> **The policy must be used before 2026-11-06 01:40 (local time) or it expires.** A publish through it
> activates it. If the first release cannot run by then, create the policy again, with the same values,
> on the publisher's management page (<https://marketplace.visualstudio.com/manage/publishers/opentidehq>).

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
- [ ] The repository is public (attestations, free arm runners), or on GitHub Enterprise Cloud with
      the variable `ATTEST=true`.
- [ ] Open VSX: publisher agreement signed, namespace `opentidehq` created (and claimed), `OVSX_PAT`
      saved in `production`.
- [ ] The notes PR for the first version has merged (below); its minor is odd, so it is a pre-release.
- [ ] Run **Publish** on `main` before the Marketplace policy's deadline.
- [ ] Both stores list the version; install it in VS Code and in VSCodium or Cursor.
- [ ] Open VSX trusted publisher registered; `OVSX_PAT` deleted and revoked.

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
   - The sections follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/): `Added`,
     `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.
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

- The [GitHub Release](https://github.com/opentidehq/vscode-extension/releases) has one VSIX per
  runtime target, the universal VSIX and `SHA256SUMS`;
  `gh attestation verify <file>.vsix --repo opentidehq/vscode-extension` passes (unless the run warned
  "No build provenance": a private repository).
- [Marketplace](https://marketplace.visualstudio.com/items?itemName=opentidehq.opentide) and
  [Open VSX](https://open-vsx.org/extension/opentidehq/opentide) list the version with every
  platform.

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

Every update re-downloads the bundled runtime for every user (each per-platform package is tens of MB),
so stable releases follow opentide releases and fixes, not every merge (SPEC §3).

An opentide release flows in as a PR:

1. Bump `pins.json` `opentide.version`.
2. Refresh what follows from it: the runtime lock (`npm run runtime:lock`) and, when the engine inside
   that opentide moved, the grammars (`highlights` in `pins.json` follows the engine pin; then
   `npm run grammars` and `npm run manifest`).
3. A `### Changed` bullet under `## [Unreleased]`: "Bundles opentide 0.22.0", with what users see
   change.
4. CI runs the tests against the new opentide (`pip install opentide==<pin>`) and the linux-x64 smoke
   test.

Then cut a release with the notes PR above: stable when the bump is the point of the release, a
pre-release first when it changes much.

## What the workflow does

| Job | Runs on | Does |
|-----|---------|------|
| `prepare` | ubuntu | Refuses unless run on `main`, `CHANGELOG.md`'s newest version matches `package.json`, `[Unreleased]` is empty and `v<version>` is not tagged; computes the channel and the build matrix from `pins.json` `runtimeTargets` |
| `build` | each target's native runner | uv at `pins.json` `uv.version`, `runtime:lock -- --check`, `runtime:build -- --target <t>`, `package -- --target <t>`, `smoke` (Alpine: in a digest-pinned `node:22-alpine` container on the Linux runner of its architecture) |
| `universal` | ubuntu | CI's checks, then `package -- --universal`: the package every target without a runtime, and the web, installs |
| `attest` | ubuntu | Every VSIX is `opentidehq.opentide` at the version and channel, one universal and one per runtime target; `SHA256SUMS`; build provenance for each file (public repository, or `ATTEST=true`; else a warning) |
| `release` | ubuntu | Tags `v<version>` on the built commit with the GitHub Release (notes from the changelog, every asset), then checks the downloads against `SHA256SUMS` and, when attested, their attestations |
| `publish-marketplace` | ubuntu, `production` | `vsce publish --oidc --skip-duplicate --packagePath <every VSIX>`: one call, with one OIDC exchange per package (vsce asks for a token for each VSIX, skipped duplicates included) |
| `publish-openvsx` | ubuntu, `production` | `ovsx publish --trusted-publishing --skip-duplicate --packagePath <every VSIX>`, or with `OVSX_PAT` when the secret is set |

| Runtime target | Runner |
|----------------|--------|
| win32-x64 / win32-arm64 | `windows-latest` / `windows-11-arm` (win32-arm64 bundles win32-x64's runtime, `pins.json` `emulatedTargets`) |
| linux-x64 / linux-arm64 | `ubuntu-latest` / `ubuntu-24.04-arm` |
| alpine-x64 / alpine-arm64 | `ubuntu-latest` / `ubuntu-24.04-arm`, smoke test in Alpine |
| darwin-x64 / darwin-arm64 | `macos-15-intel` / `macos-latest` |

A target `pins.json` does not list in `runtimeTargets` gets no package of its own: the stores give it the
universal package. Nothing is tagged until every package has built and passed its smoke test; the
stores get nothing until the GitHub Release exists.

## When something fails

| Failure | Do |
|---------|----|
| `prepare`: `[Unreleased] still holds …`, a version mismatch | Fix it in a PR; run again |
| `prepare`: `v<version> is already tagged` | That version is out: re-run the failed jobs of its run, or release the next version |
| `build` or `universal` | Nothing was tagged. Fix it on `main` (a PR) and run again |
| `release` (GitHub Release) | **Re-run failed jobs**. When an earlier attempt already made the Release (for example the verify step failed), the job finds it, checks that its tag is on the run's commit, uploads the assets again with `--clobber` and goes on; a Release on another commit stops it. The stores get nothing until it succeeds |
| `publish-marketplace` or `publish-openvsx` | **Re-run failed jobs** on the run. The other store is unaffected; `--skip-duplicate` skips what a store already has |
| Open VSX `401`/`403` with trusted publishing | The trusted publisher's repository, workflow (`publish.yml`) or environment (`production`) differs from the run's; fix the registration and re-run the job |
| Marketplace OIDC exchange refused | The policy expired or names something else; recreate it (step 4) and re-run the job. vsce exchanges a token per package, so a refusal partway leaves the earlier packages published; the re-run skips them (`--skip-duplicate`) |

A re-run uses the run's own commit and the GitHub Release's assets, so it publishes exactly what was
tagged and attested.
