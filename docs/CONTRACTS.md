# Contracts between the extension, opentide and language-server

These are the interfaces the extension depends on. Each section names the issue that implements it. When an implementation must deviate, change this file in the same change.

The extension's identifier is **`opentidehq.opentide`** (publisher `opentidehq`, name `opentide`).

## `opentide serve` (opentidehq/opentide#750)

JSON-RPC 2.0, **one JSON message per line** (newline-delimited, as MCP stdio is), on stdin/stdout. Stdout carries nothing else; logs go to stderr.

| Message | Kind | Params | Result |
|---------|------|--------|--------|
| `initialize` | request | `{}` | `{protocol: 1, version: "<opentide version>", commands_digest: "<sha256 of opentide --json commands>"}` |
| `run` | request | `{argv: string[], cwd?: string, env?: {[name]: string}}` | `{document: object, exit_code: number}` |
| `invalidate` | notification | `{paths: string[]}` (absolute) | — |
| `progress` | notification, server → client | `{id: <run request id>, event: <progress event>}` | — |
| `$/cancelRequest` | notification | `{id}` | the cancelled `run` answers with its document and `exit_code: 130` |
| `shutdown` | request | — | `null` |
| `exit` | notification | — | the process exits `0` |

**`run` semantics:**
- `argv` is what follows `opentide` on a command line, without `--json`: `["validate", "--file", "objects/rules/x.yaml"]`. `serve` always behaves as `--json`. `--repo` may appear in `argv`.
- `document` is exactly what `opentide --json <argv>` prints (the envelope included), and `exit_code` is the process exit code that command would have had.
- **A command failure is not a JSON-RPC error.** JSON-RPC errors are only for protocol problems: a malformed message, an unknown method, a `run` with no `argv`.
- **Prompts:** a command that would prompt behaves as under `--json` (`usage_needs_input`).
- **Crashes:** an unexpected exception answers `failure.code: "internal"` with its crash log, and the server keeps serving.
- **Order:** requests are handled one at a time, in order.
- **Workspace:** each `run` resolves its workspace from `--repo`, else `cwd`, else `OPENTIDE_REPO_ROOT` from `env`, else the server's cwd. One server serves several workspace folders.
- **Caching:** the server may keep imports, parsed configuration and the registry per workspace between runs. `invalidate` must drop anything those paths affect, before the next `run` is handled.

## `opentide --json info catalog` (opentidehq/opentide#749)

The envelope's keys, plus:

```jsonc
{
  "objects": [
    {
      "uuid": "…", "type": "rule", "schema": "rule::1.1", "name": "…",
      "path": "objects/rules/x.yaml",          // workspace-relative, forward slashes
      "file_path": "/abs/objects/rules/x.yaml",
      "line": 3,                                // 1-based line of the `name:` key, or 1
      "tlp": "amber", "author": "…", "created": "2026-10-23", "modified": "2026-10-23",
      "reviewed": null,
      "platforms": [ { "id": "sentinel", "enabled": true, "status": "DESIGN", "strategy": "INERT" } ],
      "deployment": [ { "platform": "sentinel", "tenant": "prod", "deployed": true, "rule_id": "…" } ],
      "techniques": { "own": ["T1003.001"], "inherited": ["T1003"] },
      "tactics": ["credential-access"],
      "actors": ["APT29"],
      "load_error": null                        // or { "code": "yaml_parse", "message": "…", "line": 12 }
    }
  ],
  "edges": [
    // `kind` is one of: covers (objective → threat), implements (rule → objective | signal),
    // parent (signal → parent signal), chains (threat → threat, with relation),
    // technique (object → ATT&CK id), logsource (signal → visibility.toml log source name)
    { "from": "<uuid>", "to": "<uuid | technique id | log source name>", "kind": "implements",
      "field_path": "detection_model", "relation": null, "missing": false }
    // missing: true when `to` should be an object UUID and no object carries it
  ],
  "signals": [ { "uuid": "…", "name": "…", "objective": "<uuid>", "parent": null } ],
  "attack": {
    "tactics": [ { "id": "TA0006", "shortname": "credential-access", "name": "Credential Access",
                   "techniques": ["T1003", "…"] } ],
    "techniques": { "T1003": { "name": "OS Credential Dumping", "parent": null,
                               "subtechniques": ["T1003.001"] },
                    "T1003.001": { "name": "LSASS Memory", "parent": "T1003", "subtechniques": [] } }
  },
  "summary": { "objects": 3, "threats": 1, "objectives": 1, "rules": 1, "signals": 0, "edges": 2,
               "load_errors": 0 }
}
```

- **Signals** are objects that live inside objectives. They appear in `signals`, not in `objects`, and are edge endpoints.
- **The `attack` skeleton** is the Enterprise matrix from the bundled `att&ck` vocabulary.

## Tenants (opentidehq/opentide#754)

`opentide --json info` (and `info --platform <id>`): each `platforms[]` entry gains

```jsonc
"tenants": [ { "name": "prod", "description": "…", "strategies": ["PREVIEW", "RELEASE"], "manual": false,
               "variables": [ { "name": "AZURE_CLIENT_SECRET", "set": false } ] } ]
```

A variable's value never appears.

## Other CLI additions

| Issue | Addition |
|-------|----------|
| opentidehq/opentide#751 | `setup --plan`: writes nothing; prints `steps[]{step, files[{path, action: "create"\|"merge"\|"skip"\|"delete"}], warnings}` and `summary{create, merge, skip, delete}`; `delete` is a file the step removes (a stale skill file it replaces). The extension drops an action it does not know. New flags on `setup`: `--mcp vscode\|cursor\|claude-code\|generic` (repeatable), `--skills claude-code\|cursor\|github-copilot\|generic` (repeatable), `--plugin`, `--hooks`, `--env` |
| opentidehq/opentide#753 | `deploy --uuid <uuid>` and `--file <path>` (both repeatable) select rules. They are a usage error with `--all` and replace the git-diff default |
| opentidehq/opentide#755 | `end_line` (1-based) on every validate and lint finding; `lint --file <path>` (repeatable) |
| opentidehq/opentide#756 | With `OPENTIDE_PROGRESS=json`, NDJSON events on stderr: `{"event": "progress", "step": "…", "done": 1, "total": 6}` and `{"event": "tenant", "platform": "…", "tenant": "…", "status": "ok"\|"failed", "rows": 120, "elapsed_ms": 1800}`. Under `serve`, the same events arrive as `progress` notifications |
| opentidehq/opentide#752 | Snippets get `scope: "yaml,opentide-yaml"`; `setup vscode` recommends `opentidehq.opentide` and writes no `yaml.schemas` |

## language-server

| Issue | Addition |
|-------|----------|
| opentidehq/language-server#195 | The ES\|QL grammar's `scopeName` is `source.opentide.esql` |
| opentidehq/language-server#196 | Each release carries `SHA256SUMS` and build-provenance attestations |
| opentidehq/language-server#197 | `DOCUMENT_SELECTOR` includes `opentide-config`; a scheme-less `WEB_DOCUMENT_SELECTOR` |
| opentidehq/language-server#198 | `opentide/catalog {root?}` (params may be omitted or `null`) → `{roots: [{root, objects: [{uuid, object_type, schema, name, uri, range, refs: [{uuid, field_path, range}]}]}]}` and the notification `opentide/catalogChanged {root}`, also sent when a root appears or goes (`root: null` for the root-less set). `refs` are the reference fields only, not every UUID-valued string. A `root` keeps its own URI scheme (`vscode-vfs://…` in a virtual workspace); a trailing slash still matches |

## Versions the extension gates on

The extension never compares version numbers to decide a feature. It reads `opentide --json commands` and checks that the command path and the options it needs are there:

| Feature | Needs |
|---------|-------|
| Warm backend | the `serve` command |
| Catalogue, graph, matrix, search | `info catalog` |
| Tenants in the Platforms view | the `tenants` key in `info` (read at run time) |

Without them, it falls back: spawning instead of `serve`; names and locations from `workspace/symbol` instead of the catalogue; the version needed shown instead of the graph and the matrix.
