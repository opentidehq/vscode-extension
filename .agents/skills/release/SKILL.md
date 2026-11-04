---
name: release
description: >-
  Cut a release of the opentide VS Code extension (opentidehq.opentide): the notes PR (CHANGELOG.md
  section, package.json version), Run workflow on publish.yml on main, the v* tag and GitHub Release,
  and the Marketplace and Open VSX publishes over trusted publishing. Use when releasing, tagging,
  publishing to a store, bumping the bundled opentide, or when publish.yml fails.
---

# Release: opentidehq.opentide

The human procedure, the one-time setup and the failure table are in
[`docs/RELEASING.md`](../../../docs/RELEASING.md). This is the agent's checklist.

## Facts

| Fact | Detail |
|------|--------|
| Version | `CHANGELOG.md`'s newest dated heading, `## [x.y.z] - YYYY-MM-DD`: `node scripts/release.mjs version`. `package.json` must match |
| Tag | `v<version>`, created by the workflow on the built commit. Never push a tag by hand |
| Release | **Run workflow** on `.github/workflows/publish.yml`, ref `main`, no inputs |
| Channel | odd minor = pre-release (`--pre-release` at package and publish), even minor = stable: `node scripts/release.mjs prerelease` |
| Auth | Marketplace: `vsce publish --oidc` (policy: owner `opentidehq`, repo `vscode-extension`, `.github/workflows/publish.yml`, environment `production`). Open VSX: `ovsx publish --trusted-publishing` (same workflow file and environment); `OVSX_PAT` only for the very first publish |
| Packages | One per `pins.json` `runtimeTargets` entry plus the universal one, from `npm run package`; checked by `node scripts/release.mjs assets` |
| Never | rename `publish.yml` or the `production` environment (both stores' trust names them); add a workflow input that publishes from another ref; publish from a laptop |

## When not to release

- CI, docs-for-agents or test-only changes: no release (users re-download the runtime on every update).
- `[Unreleased]` empty: nothing to release.
- A stable release outside the cadence: stable releases follow opentide releases and fixes. A
  pre-release is fine any time.

## Step 1: the notes PR

Branch `docs/release-x.y.z` from `origin/main`, one commit, PR to `main`:

1. `CHANGELOG.md`: move every entry under `## [Unreleased]` into `## [x.y.z] - <today>` directly
   below it; leave `## [Unreleased]` with nothing under it. Start the section with one paragraph (what
   the release is for, the opentide it bundles); the paragraph and the lists are the GitHub Release
   notes.
2. Pick the number: the next odd minor's patch for a pre-release (`0.3.1`), the next even minor for a
   stable release (`0.3.4` -> `0.4.0`). Never a `-suffix`.
3. `npm version x.y.z --no-git-tag-version` (package.json and package-lock.json).
4. Check, and read the notes:

   ```bash
   node scripts/release.mjs check vx.y.z
   node scripts/release.mjs notes
   npm run manifest:check && npm run typecheck && npm run lint && npm test && npm run build
   ```

Commit `docs(release): x.y.z`. Wait for CI green on the head SHA, then merge.

## Step 2: run the workflow

| Where | How |
|-------|-----|
| Cloud session (no `gh` GraphQL) | GitHub MCP `actions_run_trigger`: `method: run_workflow`, `workflow_id: publish.yml`, `ref: main`, no inputs |
| Local | `gh workflow run publish.yml --repo opentidehq/vscode-extension --ref main` |

Find the run over REST:

```bash
gh api "repos/opentidehq/vscode-extension/actions/workflows/publish.yml/runs?per_page=1" \
  --jq '.workflow_runs[0] | "\(.id) \(.status) \(.conclusion) \(.head_sha)"'
```

If `production` has required reviewers, the run waits after `release` for a human to approve both
publish jobs. Do not approve on the user's behalf; tell them.

## Step 3: prove it

```bash
gh release view vx.y.z --repo opentidehq/vscode-extension --json assets --jq '.assets[].name'
gh release download vx.y.z --repo opentidehq/vscode-extension --dir /tmp/vsx && (cd /tmp/vsx && sha256sum -c SHA256SUMS)
gh attestation verify /tmp/vsx/opentide-linux-x64-x.y.z.vsix --repo opentidehq/vscode-extension
npx ovsx@1.3.0 show opentidehq.opentide@x.y.z
```

`gh attestation verify` fails on a release from a private repository: the `attest` job skipped the
attestations with a "No build provenance" warning (docs/RELEASING.md, one-time setup). That is expected
until the repository is public.

The Marketplace page (`https://marketplace.visualstudio.com/items?itemName=opentidehq.opentide`) can
take a few minutes to show a new version.

## Failures

| Job | Meaning | Do |
|-----|---------|----|
| `prepare` | The notes PR is missing or incomplete, or the tag exists | Fix in a PR. If the tag exists, the version is out: re-run failed jobs of its run, never retag |
| `build` / `universal` / `attest` | A package, its smoke test, its size budget or its identity failed. Nothing is tagged | Fix on `main` through a PR, run again |
| `release` | The Release may exist from this attempt, or the verify step failed | **Re-run failed jobs**: the job finishes an existing Release on the run's commit (`gh release upload --clobber`) instead of creating it again, and stops if the tag is on another commit. Ask the user before deleting a tag or Release |
| `publish-marketplace` / `publish-openvsx` | One store refused. The other is independent | **Re-run failed jobs**: the job re-downloads the Release's assets and `--skip-duplicate` skips what is there. A trust error is a registration that no longer matches the workflow file or environment: tell the user (docs/RELEASING.md, one-time setup) |

## The bundled opentide

A bump is its own PR: `pins.json` `opentide.version`, then `npm run runtime:lock`; when the engine pin
inside that opentide moved, `highlights` in `pins.json`, `npm run grammars` and `npm run manifest`.
Add a `### Changed` bullet ("Bundles opentide x.y.z") under `[Unreleased]`. Release after it merges,
per the cadence.
