# opentide for VS Code

The opentide workbench for detection engineers, in VS Code and its forks (Cursor, Windsurf, VSCodium
and others through Open VSX).

- Live checks for Tide objects and their KQL, SPL, ES|QL, EQL, Kibana KQL, Lucene and Falco queries.
- New objects from templates.
- A catalogue, a graph and the ATT&CK coverage of how detections connect.
- Query results and deploy previews.
- An MCP server for agents.

It works on install: the platform packages bundle an opentide runtime, so a machine without Python
gets every feature, offline. When the repository has its own opentide (a `.venv`, the Python
extension's interpreter, `opentide` on `PATH`, or `opentide.path`), the extension uses it, so the
editor checks what CI checks.

## Features

<!-- Each feature adds its section here, with a short GIF. -->

### Languages

| Language | Files | Id |
|----------|-------|----|
| Tide YAML | `objects/**/*.yaml`, and the object folders `paths.toml` names | `opentide-yaml` |
| opentide configuration | `.opentide/configurations/**/*.toml` | `opentide-config` |
| KQL (Microsoft) | `.kql` | `kql` |
| SPL | `.spl` | `spl` |
| ES\|QL | `.esql` | `esql` |
| EQL | `.eql` | `eql` |
| Kibana KQL | `.kuery` | `kuery` |
| Lucene | `.lucene` | `lucene` |
| Falco | `.falco` | `falco` |

Queries embedded in a rule (`configurations.sentinel.query`, `splunk.query`, …) are highlighted,
commented and bracket-matched in their own language.

### Status

The status bar shows the opentide version in use and the workspace's problem counts. Its menu
restarts the server, switches the runtime and shows the output. When the repository pins a different
opentide, it says so and offers the pinned version.

## Runtime

The first that answers wins:

1. `opentide.path`: an `opentide` executable, or `opentide-lsp` for editor features only.
2. The workspace's environment: `opentide.interpreter`, the Python Environments or Python extension's
   interpreter, `.venv`, then `PATH`.
3. With `opentide.uv.usePin`: `uv tool run --from opentide==<pin>`.
4. The bundled runtime.

## Restricted Mode

In an untrusted folder only the language server runs, from the bundled runtime, with no access to the
workspace's executables. Commands, tasks, panels and MCP need a trusted folder.

## Settings

| Setting | |
|---------|-|
| `opentide.path` | An `opentide` or `opentide-lsp` executable (machine-overridable, not synced) |
| `opentide.interpreter` | A Python interpreter with opentide installed (machine-overridable, not synced) |
| `opentide.runtime` | `auto` or `bundled` |
| `opentide.uv.usePin`, `opentide.uv.path` | Run the repository's pinned opentide with uv |
| `opentide.envFile` | A `.env` file whose variables reach commands that contact a tenant |
| `opentide.backend.serve` | `auto` (one warm `opentide serve`) or `never` (spawn each command) |
| `opentide.trace.server` | Language server protocol trace |

Fix-all on save (`source.fixAll.opentide`) is off by default. To apply every suggestion on save, set
`"editor.codeActionsOnSave": { "source.fixAll.opentide": "explicit" }` for the language; fixes rewrite
query text.

No telemetry.

## Related

[opentidehq/opentide](https://github.com/opentidehq/opentide) (the CLI, models and MCP server) ·
[opentidehq/language-server](https://github.com/opentidehq/language-server) (the analysis engine and
language server). Design: [`docs/SPEC.md`](docs/SPEC.md).

## Licence

MIT. The bundled opentide runtime and engine are EUPL-1.2 and CPython is PSF-2.0; they ship as
separate programs with their own licence files ([`NOTICE`](NOTICE)).
