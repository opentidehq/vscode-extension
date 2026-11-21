# Contracts between the extension, opentide and language-server

These are the interfaces the extension depends on. Each section names the issue that implements it. When an implementation must deviate, change this file in the same change.

The extension's identifier is **`opentidehq.opentide`** (publisher `opentidehq`, name `opentide`).

## `opentide serve` (opentidehq/opentide#750)

JSON-RPC 2.0, **one JSON message per line** (newline-delimited, as MCP stdio is), on stdin/stdout. Stdout carries nothing else; logs go to stderr.

| Message | Kind | Params | Result |
|---------|------|--------|--------|
| `initialize` | request | `{}`, or `{capabilities: {fetch: true}}` to have the client make tenant requests (below) | `{protocol: 1, version: "<opentide version>", commands_digest: "<sha256 of opentide --json commands>"}`, plus `capabilities: {fetch: true}` when it was asked for |
| `run` | request | `{argv: string[], cwd?: string, env?: {[name]: string}}` | `{document: object, exit_code: number}` |
| `invalidate` | notification | `{paths: string[]}` (absolute) | — |
| `progress` | notification, server → client | `{id: <run request id>, event: <progress event>}` | — |
| `$/cancelRequest` | notification | `{id}` | the cancelled `run` answers with its document and `exit_code: 130` |
| `shutdown` | request | — | `null` |
| `exit` | notification | — | the process exits `0` |
| `opentide/fetch` | request, server → client, only after `initialize` asked for it | one tenant request: `{run, platform, tenant, method, url, headers: [[name, value]], body: base64 \| null, connect_timeout_ms, read_timeout_ms, tls: {verify, ca_bundles}, proxy}` | `{status, headers, url, body: base64, elapsed_ms?}`, or a JSON-RPC error whose `data.kind` is `connect`, `timeout`, `aborted`, `unreachable` or `answer` |

**`run` semantics:**
- `argv` is what follows `opentide` on a command line, without `--json`: `["validate", "--file", "objects/rules/x.yaml"]`. `serve` always behaves as `--json`. `--repo` may appear in `argv`.
- `document` is exactly what `opentide --json <argv>` prints (the envelope included), and `exit_code` is the process exit code that command would have had.
- **A command failure is not a JSON-RPC error.** JSON-RPC errors are only for protocol problems: a malformed message, an unknown method, a `run` with no `argv`.
- **Prompts:** a command that would prompt behaves as under `--json` (`usage_needs_input`).
- **Crashes:** an unexpected exception answers `failure.code: "internal"` with its crash log, and the server keeps serving.
- **Order:** requests are handled one at a time, in order.
- **Workspace:** each `run` resolves its workspace from `--repo`, else `cwd`, else `OPENTIDE_REPO_ROOT` from `env`, else the server's cwd. One server serves several workspace folders.
- **Caching:** the server may keep imports, parsed configuration and the registry per workspace between runs. `invalidate` must drop anything those paths affect, before the next `run` is handled.
- **`opentide/fetch`** (opentidehq/opentide#1103, `docs/cli/serve.md`): the WASI build has no sockets, so with the capability every HTTP request of every run (tenants, CVE lookups, `doctor`'s release check, `skills`) is a request from the server to the client. The server's ids are strings (`"h1"`, …); the client answers each with Node's HTTP stack in the extension host (`@opentide/wasi-host`'s `FetchHost`, so VS Code's proxy settings and certificate store apply); the server withdraws one with `$/cancelRequest {id}`. A native server does the same when asked, so one client drives both builds; the extension asks only for the WASI module's.

## The WASI module (opentide 1.0, opentidehq/opentide `docs/internal/vscode-wasi.md`)

opentide's CLI compiled to `wasm32-wasip1` is the release asset `opentide-wasm32-wasip1.wasm` (from 1.0.0-rc.3; `pins.json` `wasi` names its URL and SHA-256). One module serves every platform: it is `opentide` with no terminal UI, no threads, no processes and no sockets. The extension runs it as the runtime when no opentide is installed (tier 4, [SPEC §4](SPEC.md#4-the-runtime-resolution-processes-status)).

| Process | Started with | Where |
|---------|--------------|-------|
| `opentide serve` | `args: ["serve"]` | The extension host, under `@vscode/wasm-wasi`, with `opentide/fetch` answered by `FetchHost` |
| `opentide lsp start` | `args: ["lsp", "start"]` | The extension host, under `@vscode/wasm-wasi`; `vscode-languageclient` over `ReadableStreamMessageReader` and `WriteableStreamMessageWriter` on the process's pipes. The custom `opentide/*` requests are the native server's |
| `opentide mcp start`, `opentide <command>` where VS Code starts a process (MCP, tasks, terminals, the command tree) | VS Code's own Node (`process.execPath`, `ELECTRON_RUN_AS_NODE=1`) running `dist/wasi/launcher.cjs <module> <args>` under `node:wasi` | A process of VS Code's. It exits with the module's exit code and speaks stdio as `opentide` does. A tenant command there has no network and fails with `network_unavailable`, naming the native CLI |

- **Mounts.** `createRootFileSystem([{kind: "workspaceFolder"}, {kind: "vscodeFileSystem", uri: <global storage>, mountPoint: "/home/opentide"}])`: one folder at `/workspace`, several at `/workspaces/<name>`. The module sees guest paths only, so what goes in (a run's `cwd`, `argv` and `env`, the paths `invalidate` names, the language server's `file:` URIs and `rootPath`) is mapped to guest paths, and what comes out (every string of a document, a progress event or a language-server message) back to the host's (`src/core/wasi/paths.ts`). A paths-only mapping: it never rewrites a path that is under no mounted folder. The mounts are the window's folders when the process starts, so a change to them restarts it. The launcher mounts the working directory (and `OPENTIDE_REPO_ROOT`, and the temporary folder) at itself on POSIX, and the working directory at `/workspace` on Windows.
- **Environment.** The module sees only what it is given: `PWD` (the first folder's guest path), `HOME` and `XDG_STATE_HOME` under `/home/opentide`, `NO_COLOR=1`, `OPENTIDE_*` (VS Code's `http.proxy` as `OPENTIDE_PROXY`), the proxy variables and `TZ`. No path variable (`PATH`, `SSL_CERT_FILE`): it could not open one. Tenant credentials travel in a `run`'s `env`, as on the native `serve`.
- **A trap ends the process.** The extension restarts it as it restarts a native one that crashed (`BackendError` `crashed`: one retry of a read-only request).
- **One request at a time**, in order, as native. No threads: a long run delays the next.
- **Gating.** As everywhere, by `opentide --json commands`: the module's tree is read once per version through the launcher, never by comparing version numbers.

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
      "load_error": null                        // or { "code": "yaml_parse", "message": "…", "line": 12 | null }
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

- **Nullable fields**, as opentide's `output_schema` has them: an object's `uuid`, `type`, `schema`, `path` and
  `file_path`; `load_error.line`; a platform's `status` and `strategy`; a signal's `objective`; an ATT&CK
  tactic's `id`. Every consumer copes with `null` in each.
- **Files that did not load** (`load_error` set) carry what could be read of them: `uuid` is `null` when
  there is none, and may equal a loaded object's (a broken copy of a file, or `duplicate_id`). They have no
  edges. The extension keys them `file:<path>`, never by UUID, and keeps them out of every by-UUID map, so a
  broken copy never replaces the object it was copied from (`src/core/catalog/rows.ts`).
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

language-server is merged into opentide (opentidehq/opentide ADR 0004): its engine, grammars and `docs/engine/EDITORS.md` ship in opentide's releases (`pins.json` `highlights` and `engine`, from v1.0.0-rc.2 on). The issues below were language-server's.

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
| Warm backend | the `serve` command (the WASI module always has it) |
| Catalogue, graph, matrix, search | `info catalog` |
| Tenants in the Platforms view | the `tenants` key in `info` (read at run time) |

The engine's workspace is the object files, the paths.toml object folders **and the folder's `.opentide/configurations/*.toml`**, which the 1.0 engine reads as `validate` does in the browser (`docs/engine/EDITORS.md`): without `paths.toml` it does not check a rule in a custom object folder.

Without them, it falls back: spawning instead of `serve`; names and locations from `workspace/symbol` instead of the catalogue; the version needed shown instead of the graph and the matrix.
