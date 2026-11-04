# Changelog

All notable changes to the opentide extension (`opentidehq.opentide`). The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Stable releases use even minor versions and
pre-releases odd ones.

## [Unreleased]

### Added

- Languages for Tide YAML (`opentide-yaml`, on `objects/**` and the object folders `paths.toml`
  names), opentide configuration TOML (`opentide-config`) and the query languages `kql`, `spl`,
  `esql`, `eql`, `kuery`, `lucene` and `falco`, with grammars from the language-server highlights zip
  (ES|QL under `source.opentide.esql`), embedded query regions and language configurations.
- Runtime resolution in four tiers: `opentide.path`, the workspace's environment, uv with the
  repository's pin (opt-in), and the bundled runtime; a version check, pin-mismatch detection, a
  status bar item and a language status item.
- The language server: one client per window with pulled diagnostics, the reference lens's
  `opentide.showReferences`, and fix-all on save off by default.
- The backend: `opentide serve` when the runtime has it, spawning `opentide --json` otherwise, with
  cancellation, capability gating from `opentide --json commands`, and an activity log.
- Restricted Mode: only the bundled language server runs, with `PATH` limited to the runtime.
- Settings `opentide.path`, `opentide.interpreter`, `opentide.runtime`, `opentide.uv.usePin`,
  `opentide.uv.path`, `opentide.envFile`, `opentide.backend.serve` and `opentide.trace.server`.
