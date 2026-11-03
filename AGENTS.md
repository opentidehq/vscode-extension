# opentide for VS Code: agent guide

The VS Code extension **`opentidehq.opentide`**: the opentide workbench (live checks, templates,
catalogue, ATT&CK coverage, query results, deploy previews, MCP) with a bundled opentide runtime.

Read, in order:

1. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): the core, the FeatureContext API, how to add a feature.
2. [`docs/SPEC.md`](docs/SPEC.md): what the extension does and why.
3. [`docs/CONTRACTS.md`](docs/CONTRACTS.md): the interfaces with opentide (`opentide serve`, `info
   catalog`, …) and language-server. Implement them exactly; a deviation changes that file in the same change.
4. language-server's [`docs/EDITORS.md`](https://github.com/opentidehq/language-server/blob/main/docs/EDITORS.md):
   what the server offers editors.

## Build and test

```bash
npm ci
npm run manifest:check   # package.json contributes == contrib/*.json
npm run typecheck
npm run lint             # Biome; `npm run format` fixes formatting
npm test                 # unit + script tests, plain node, no VS Code
npm run build
npm run package -- --universal               # universal VSIX in dist-vsix/
```

- Per-platform packages (bundled runtime, locks, size gate, SBOM, smoke test): [`docs/PACKAGING.md`](docs/PACKAGING.md).
  `npm run runtime:lock -- --check`, `npm run runtime:build -- --target <t>`, `npm run package -- --target <t>`,
  `npm run smoke -- <vsix>`. Bumping opentide or CPython is a `pins.json` change plus `npm run runtime:lock`.

- Integration tests (`npm run test:integration`, `npm run test:restricted`) download VS Code; they
  run in CI.
- Tests against a real opentide: `OPENTIDE_TEST_BIN=<opentide> OPENTIDE_TEST_WORKSPACE=<workspace> npm test`.
- Grammars: `npm run grammars` downloads the highlights zip pinned in `pins.json`, checks its
  SHA-256, and rewrites `syntaxes/` and `contrib/grammars.json`; then `npm run manifest`.

## Rules

- **Never hand-edit `contributes` or `activationEvents` in package.json.** Edit `contrib/<feature>.json`
  and run `npm run manifest`. On a merge conflict in package.json, take either side and rerun it.
- **One feature, one folder:** `src/features/<id>/index.ts` default-exports `defineFeature({ id,
  activate(ctx) })`; its manifest is `contrib/<id>.json`; its tests `test/unit/<id>/`. Do not edit
  another feature's folder. Core changes (`src/core/`, `contrib/core.json`) are their own change.
- Every action is a real opentide command through `ctx.backend` (SPEC P3); gate features with
  `ctx.capabilities.hasCommand` / `hasOption`, never with version numbers.
- The UI never writes workspace files itself (SPEC D3). Nothing deploys for real (D6).
- Logic goes in vscode-free modules with unit tests; `index.ts` is glue. Every fix has a regression
  test; every user-visible change has a `## [Unreleased]` bullet in CHANGELOG.md.
- TypeScript strict, no `any`, no `console.log`, no non-null assertions. No telemetry.
- npm only; commit `package-lock.json`. Pin exact dependency versions.
- Commits: Conventional Commits (`feat`, `fix`, `refactor`, `docs`, `chore`, `test`, `ci`, `build`).
