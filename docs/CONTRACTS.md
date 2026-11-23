# Contracts between the extension, opentide and language-server

These are the interfaces the extension depends on. Each section names the issue that implements it. When an implementation must deviate, change this file in the same change.

The extension's identifier depends on the store: **`opentide.opentide-vscode`** on the Visual Studio Marketplace
(publisher `opentide`) and **`opentidehq.opentide`** on Open VSX (namespace `opentidehq`), name `opentide`
in both ([RELEASING.md](RELEASING.md#two-publishers-and-why)). The code takes it from `context.extension.id`.

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
| `opentide serve` | `args: ["serve"]` | A child process running the launcher with `OPENTIDE_WASI_MOUNTS` (the default, `opentide.wasi.host`), or under `@vscode/wasm-wasi` in the extension host where the launcher cannot run or the setting asks for `ms-vscode.wasm-wasi-core`; `opentide/fetch` answered by `FetchHost` either way |
| `opentide lsp start` | `args: ["lsp", "start"]` | As `serve`; `vscode-languageclient` over the process's pipes (`ReadableStreamMessageReader` and `WriteableStreamMessageWriter` under `@vscode/wasm-wasi`, stream readers on the child's stdio). The custom `opentide/*` requests are the native server's |
| `opentide mcp start`, `opentide <command>` where VS Code starts a process (MCP, tasks, terminals, the command tree) | VS Code's own Node (`process.execPath`, `ELECTRON_RUN_AS_NODE=1`) running `dist/wasi/launcher.cjs <module> <args>` under `node:wasi` | A process of VS Code's. It exits with the module's exit code and speaks stdio as `opentide` does. A tenant command there has no network and fails with `network_unavailable`, naming the native CLI |

- **Mounts.** `createRootFileSystem([{kind: "workspaceFolder"}, {kind: "vscodeFileSystem", uri: <global storage>, mountPoint: "/home/opentide"}])`: one folder at `/workspace`, several at `/workspaces/<name>`. The module sees guest paths only, so what goes in (a run's `cwd`, `argv` and `env`, the paths `invalidate` names, the language server's `file:` URIs and `rootPath`) is mapped to guest paths, and what comes out (every string of a document, a progress event or a language-server message) back to the host's (`src/core/wasi/paths.ts`). A paths-only mapping: it never rewrites a path that is under no mounted folder. The mounts are the window's folders when the process starts, so a change to them restarts it. The launcher mounts what `OPENTIDE_WASI_MOUNTS` (a JSON list of `{host, guest}` the extension host chooses: the folder itself on POSIX, `/workspace` or `/workspaces/<name>` on Windows) names, and the temporary folder; started by hand (MCP, a task, a terminal) it mounts the working directory and `OPENTIDE_REPO_ROOT` at themselves on POSIX, and the working directory at `/workspace` on Windows.
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

## The MCP bridge

`dist/mcp-wasi.js` (`src/mcp-wasi/main.ts`) is the opentide MCP server for editors with no opentide installed ([SPEC §12](SPEC.md#12-agents)). The editor starts it as a stdio MCP server with its own Node: `command: process.execPath`, `args: [<extension>/dist/mcp-wasi.js]`, `env: {ELECTRON_RUN_AS_NODE: "1", OPENTIDE_REPO_ROOT: <folder>, OPENTIDE_PROXY?: <http.proxy>}`, `cwd` the workspace folder.

- **A user-level MCP entry starts it through the launcher.** Kiro, Devin Desktop and Windsurf read a user-level file; its entry is `command: process.execPath`, `args: [<globalStorage>/mcp-launcher.cjs]`, `env: {ELECTRON_RUN_AS_NODE: "1", OPENTIDE_EXTENSIONS_DIR: <the editor's extensions folder>, OPENTIDE_EXTENSION_ID: <context.extension.id>, OPENTIDE_MCP_ENTRY_FILE: <the file>, OPENTIDE_PROXY?: <http.proxy>}` and no version in it, so it is byte-identical across extension updates. `dist/mcp-launcher.js` (`src/mcp-launcher/`) runs the newest installed `<id>-<version>[-<platform>]`'s `dist/mcp-wasi.js` (the id from `OPENTIDE_EXTENSION_ID`, the publisher differing between stores; an entry written before 0.3.1 has none, and the launcher takes the name of its own folder, the global storage, which VS Code names after the lower-cased id) (skipping a folder without it or listed in `<extensions folder>/.obsolete`) and passes stdio through. With none installed it writes one stderr line and answers the first request (a message with a string or numeric `id` and a `method`) with JSON-RPC error `-32603`, "the opentide extension is not installed; remove the opentide entry from <file> or reinstall", then exits 1. VS Code's own provider and Cursor's `registerServer` name the extension's current `dist/mcp-wasi.js` directly: the editor starts them from the running extension.
- **It runs the module in a child process,** `node dist/wasi/launcher.cjs dist/wasi/opentide.wasm mcp start` (`OPENTIDE_WASI_DIR` names another folder holding `launcher.cjs` and `opentide.wasm`; the default is `wasi/` beside the script). Not a worker thread: `node:wasi` is synchronous, so while the module waits for a tenant request's answer nothing in its process can do HTTP, and a worker's stdio is not an OS pipe. The child's stdio is an ordinary pipe the bridge reads with a free event loop.
- **The module starts at the first message that needs it** (`src/mcp-wasi/lazy.ts`, #96). The editor starts the server with the window and asks `initialize` and the lists of tools, prompts and resources at once; a window that never uses an opentide tool would pay the module's second and 100 MB for nothing. With `OPENTIDE_MCP_CACHE` naming a file (the provider and Cursor's registration pass `<globalStorage>/mcp-cache/<hash of the folder>.json`; a user-level file entry names none), the bridge keeps the module's answers to `initialize` and to `tools/list`, `prompts/list`, `resources/list` and `resources/templates/list` (asked with no cursor and answered in one page) there, with the module's sha256 (`wasi.json`) and the repository root it ran for, and answers those from the file when both match: `initialize` only for the protocol version it was kept for, and `ping` always. It starts no module for them or for the editor's notifications. Any other message (a tool call, `resources/read`, `logging/setLevel`, a page of a list, a batch, anything not in the cache) starts the module, which is first sent the `initialize` the editor sent (id `opentide-bridge-init`, its answer not passed on) and the `notifications/initialized`, then the message. With no file, or a file for another module or folder, the module starts at the first message and the file is written from its answers. What the module answers to these comes from its bundled manifest (opentide's `mcp/server.rs`), so it depends on the module and not on the repository or the client; the cache is still keyed on the module and the folder. `server/discover` (MCP 2026-07-28) is not cached: a client that opens with it starts the module at once, as before. A cache the bridge cannot read or write is ignored, with a line on stderr for a write; a value in it that is not a JSON object is left out. When the editor closes its input and no module ran, the bridge exits 0.
- **Editor to module:** every line, untouched. `server/discover` (MCP 2026-07-28) and a legacy `initialize` are the editor's and the module's to agree on.
- **Module to editor:** the module's MCP messages, in the order it wrote them, whole lines, nothing else. The bridge is `@opentide/wasi-host`'s `McpFetchBridge` (opentide's `docs/cli/mcp.md`, "Tenant requests over stdio"), which takes the private link out and forwards every other line unchanged; MCP's stdio transport carries MCP messages only, and a server must not write requests of its own to stdout (`test/scripts/mcp-bridge.test.mjs`, with both `server/discover` and `initialize` clients).
- **The private link, `OPENTIDE_FETCH=stdio`.** The bridge starts the module with it (`MCP_FETCH_ENVIRONMENT`). The module then writes each tenant request as an `opentide/fetch` JSON-RPC request line on stdout among its MCP messages, with `serve`'s params ([the table above](#opentide-serve-opentidehqopentide750)) and string ids `opentide-fetch-<token>-1`, `-2`, … (the token is 128 random bits the module picks at start, shown only on its stdout), and reads the answer on stdin. It withdraws a request with MCP's own `notifications/cancelled {requestId: "opentide-fetch-N"}` (not `$/cancelRequest`, which is `serve`'s). The bridge answers them with `FetchHost` (Node's HTTP stack, so the editor's proxy settings and certificate store apply), takes both kinds of line out, and writes the answers to the module's stdin one whole line at a time, so an answer never lands inside a client message. A module without the variable ignores it and its tenant operations fail with `network_unavailable`.
- **Two rules of the bridge's own** (`src/core/wasi/mcpGuard.ts`), kept on top of `McpFetchBridge`: a message of the editor's with no `method` and a string id starting `opentide-fetch-` is dropped and never reaches the module, because only the host answers a tenant request and the module would take it for the tenant's answer; and no line of the module's reaches the editor unless it is a JSON-RPC message that is not the private link (a method of `opentide/…`, or the withdrawal `notifications/cancelled` of an `opentide-fetch-` id): a line that is no JSON (a cut-short request included) is dropped, since an `opentide/fetch` line carries the tenant's credentials. Each drop is noted on stderr, without the line.
- **A running call.** The module has no thread to read stdin with, so while a call waits for a tenant answer the client's other messages (a `ping`, a list) are kept and answered after it. The client's `notifications/cancelled` for the call stops it at once, withdraws its request (the host aborts the HTTP request) and the server goes on; the module may still answer the cancelled call (it reads the cancellation inside the call), and `McpFetchBridge` drops the response to a request its client cancelled, as MCP has the receiver send none. The module has no clock: `FetchHost`'s `connect_timeout_ms` and `read_timeout_ms` are the only bound on a tenant that never answers.
- **End of input.** When the editor closes the bridge's stdin with a request unanswered, the bridge ends the module's stdin and aborts its HTTP request; the call fails with "the client closed its input before answering an opentide/fetch request", and the module exits.
- **Which tools work.** Without the delegation: those that need no network (search, validate, lint, new, the catalogue, a query's check, a deploy's dry run). With it: deploy (not a dry run), live validate and query. Needs opentide's `feat/mcp-wasi-fetch` (opentide#1742), in rc.3.
- **Where it runs, and a hint when it finds no repository** (`src/core/wasi/mcpHint.ts`). Its first line on stderr (the editor's log for the server) is `opentide mcp bridge: cwd=<dir>; OPENTIDE_REPO_ROOT=<path>|not set; repository root: <dir>|none found`, the root being `OPENTIDE_REPO_ROOT` when it names a folder, else the nearest folder at or above `cwd` with `.opentide/` or `objects/`. A tool result that says `workspace_not_found` gets one more text part: where the editor started the server, and to open the repository's folder or set `OPENTIDE_REPO_ROOT` in the entry's env. No other message is changed.
- **Exit:** the bridge exits with the module's exit code; the editor closing stdin ends the module's. SIGINT and SIGTERM go to the child.
