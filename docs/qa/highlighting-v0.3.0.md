# Syntax highlighting latency, released 0.3.0 (2026-11-23)

Owner's report: "Syntax highlighting takes a moment to arrive, it's pretty slow". Measured in VS Code 1.147.0 with the
released `opentide-universal-0.3.0.vsix` (GitHub Release v0.3.0, SHA-256 `605a5f3e…426f`, matches `SHA256SUMS`; opentide
1.0.0-rc.3 module; the launcher host, because `ms-vscode.wasm-wasi-core` is not installed). Nothing in the extension was
changed and no issue was filed. Branch `test/wasi-e2e-2026-11-21`.

## Short answer

On this machine (Xvfb, software rendering, shared VM, Dark+) the colours come in two steps, and the second one is the slow one:

| Step | Small workspace (7 objects) | 1,000-rule workspace | Who |
|---|---|---|---|
| File text on screen (plain) | 1.5 s | 1.6 s | VS Code |
| **Grammar colours** (TextMate) | **2.5 s** | **2.7 s** | VS Code. The same 2.5 s with no extension installed and for a built-in YAML file |
| **Server colours** (semantic tokens) | **4.1 s** | **6.4–6.6 s** | the extension and the server |
| Server colours after that, per keystroke | 24 ms (KQL), 320 ms (ES\|QL) | same | |

All times are from process launch, medians of 5 fresh-window runs. The repaint when the server colours land is large and
visible: about 360 characters change colour in a 40-line view, **60 % of them outside the query** (the YAML keys, values,
dates and booleans).

## Method

- Playwright `_electron` under Xvfb 1600x1000 + openbox, `--no-sandbox`, `VSCODE_CLI=1`, fresh window each run, the profile
  already launched once (the very first launch of a fresh profile restarts the extension host and is slower), workspaceStorage
  and Backups deleted before each launch, the rule file passed on the command line (`code <folder> <file>`).
- An in-page `MutationObserver` + `requestAnimationFrame` recorder (`harness/highlighting/hl.js`) writes a timestamp
  (`Date.now()`) each time the **computed colour of any span in the open rule's query block** changes, so the times are
  not limited by a polling interval. "Grammar colours" = the first state with two or more colours in the query block;
  "server colours" = the first time the block shows the colours it finally settles on, which differ from the grammar-only
  final state (see the control).
- Control: `"[opentide-yaml]": { "editor.semanticHighlighting.enabled": false }`, same runs, same recorder.
- Rules: `hl-kql.yaml` (Sentinel KQL) and `hl-esql.yaml` (Elastic `type: esql`), both valid under `opentide validate`.
  Workspaces: `ws-hl-small` (7 objects, the two rules included) and `ws-hl-big` (1,007 objects, 500 KQL + 500 SPL variants).
- Step 3 opens the *other* kind with the server already running; step 4 types `x` at the end of query line 27, waits 2.5 s,
  Backspace, three times (6 samples per run).
- Kiro: **skipped**, its editor is behind the sign-in page.
- Screenshot runs use a CDP screencast; that costs about 0.5–1 s, so the timings below come from separate runs without it.

## Results (Dark+, medians of 5, ranges in brackets, ms)

`launch →` = from process launch. "Open" = the other rule opened with the server already running.

| Workspace | Rule | Semantic highlighting | Text on screen | **Grammar colours** | **Server colours** | Open: grammar | Open: server | Keystroke: first change | Keystroke: settled |
|---|---|---|---|---|---|---|---|---|---|
| small | KQL | on (default) | 1,543 (1,531–1,718) | 2,548 (2,495–2,792) | **4,098** (3,920–4,541) | 92 | 136 (113–144) | 24 | 24 (max 34) |
| small | ES\|QL | on | 1,583 (1,555–1,673) | 2,526 (2,379–2,779) | **4,102** (3,944–4,156) | 106 | 153 (138–194) | 19 | **319** (max 396) |
| 1,000 rules | KQL | on | 1,577 (1,523–1,662) | 2,707 (2,658–2,857) | **6,619** (6,126–6,732) | 100 | 144 (135–156) | 24 | 24 (max 67) |
| 1,000 rules | ES\|QL | on | 1,592 (1,529–1,616) | 2,710 (2,650–2,763) | **6,393** (6,110–6,695) | 112 | 165 (145–189) | 18 | **320** (max 332) |
| small | KQL | **off** (control) | 1,613 | 2,616 | never | 98 | – | 24 | 24 |
| small | ES\|QL | off | 1,566 | 2,521 | never | 108 | – | 16 | 16 |
| 1,000 rules | KQL | off | 1,621 | 2,732 | never | 97 | – | 22 | 22 |
| 1,000 rules | ES\|QL | off | 1,673 | 2,780 | never | 113 | – | 17 | 17 |

How to read the rows:

- **Step 1** (launch → colours): columns "Grammar colours" and "Server colours". The gap between them is **1.5 s on the small
  workspace and 3.7–3.8 s on the 1,000-rule one**.
- **Step 3** (server running, another file): the open row of the *KQL* line is the ES|QL file opening, and the other way
  round. Grammar colours in about 100 ms, server colours 40–60 ms after that. Not slow.
- **Step 4** (keystroke inside a query): the first colour change is 16–24 ms (the grammar). For KQL nothing changes
  afterwards. For **ES|QL the colours change again about 320 ms after the keystroke**, when the server's refreshed tokens
  arrive (the grammar leaves Elastic to the server). So a typed word in an ES|QL query can show one colour for a third
  of a second and then another.
- **Step 5**: KQL and ES|QL give the same launch timings; they differ only in the keystroke row.
- **Step 7 control**: with `editor.semanticHighlighting.enabled: false` the colours stop at the grammar state (about
  2.6 s), no later repaint, and the keystroke settles in 16–24 ms for both rules. The repaint is entirely the server's tokens.
- The profile's very first launch after installing (one run, screencast on) took 11.7 s to show the text, 14.6 s for the grammar and
  18.5 s for the server colours. That is the extension host restart on first start, not repeated afterwards; a user who has
  just installed the extension sees it once.

## Is the repaint visible? (step 6)

**Yes.** Before/after pairs, taken from a CDP screencast on the frames just before and just after the tokens landed (the
change is found at the recorder's timestamp, the frame lag is 40–70 ms):

| | Dark+ | Light+ |
|---|---|---|
| KQL rule, whole window | [before](screens/hl-kql-dark-1-before-semantic.png) · [after](screens/hl-kql-dark-2-after-semantic.png) | [before](screens/hl-kql-light-1-before-semantic.png) · [after](screens/hl-kql-light-2-after-semantic.png) |
| KQL query, zoomed (top before, bottom after) | [zoom](screens/hl-kql-dark-3-query-zoom-before-over-after.png) | [zoom](screens/hl-kql-light-3-query-zoom-before-over-after.png) |
| ES\|QL rule, whole window | [before](screens/hl-esql-dark-1-before-semantic.png) · [after](screens/hl-esql-dark-2-after-semantic.png) | [before](screens/hl-esql-light-1-before-semantic.png) · [after](screens/hl-esql-light-2-after-semantic.png) |
| ES\|QL query, zoomed | [zoom](screens/hl-esql-dark-3-query-zoom-before-over-after.png) | [zoom](screens/hl-esql-light-3-query-zoom-before-over-after.png) |
| Control (semantic off), settled | [kql dark](screens/hl-kql-dark-4-control-semantic-off-settled.png) · [kql light](screens/hl-kql-light-4-control-semantic-off-settled.png) · [esql dark](screens/hl-esql-dark-4-control-semantic-off-settled.png) · [esql light](screens/hl-esql-light-4-control-semantic-off-settled.png) | |
| Default, settled | [kql dark](screens/hl-kql-dark-5-default-settled.png) · [kql light](screens/hl-kql-light-5-default-settled.png) · [esql dark](screens/hl-esql-dark-5-default-settled.png) · [esql light](screens/hl-esql-light-5-default-settled.png) | |

Which spans change colour (DOM diff of every visible span, semantic on against off, 40-line view;
[`logs/highlighting/spandiff.json`](logs/highlighting/spandiff.json)). Dark+ names; Light+ is the same set of changes with the Light+ colours:

| Where | Change | Examples |
|---|---|---|
| KQL query | default text → variable | `TimeGenerated`, `EventID`, `NewProcessName`, `Account`, `Computer` |
| KQL query | default text → function | `ago`, `count`, `bin` |
| KQL query | default text → number / type | `1d`, `1h` / the table `SecurityEvent` (teal) |
| ES\|QL query | default text → variable | `process`, `name`, `args`, `count`, `host`, `user` |
| ES\|QL query | default text → keyword (purple) | `FROM`, `WHERE`, `AND`, `LIKE`, `STATS`, `BY`, `SORT`, `DESC` (the grammar paints none of the ES|QL keywords) |
| ES\|QL query | default → type / function | the index pattern `logs-endpoint.events.process-*`, `COUNT` |
| **Tide YAML, outside the query** | key colon `:` variable-blue → default text | all 19–27 colons |
| | plain values → string orange | `HL KQL`, `qa`, `Acme`, the description, `DESIGN`, `1h`, `STAGING`, `esql` |
| | numbers → string | the dates `2026-11-22` |
| | keyword blue → constant light blue | `true`, `false` |
| | plain → number / constant | the UUIDs; `amber`, `Informational` |

KQL: 363 characters change (135 in the query, 228 elsewhere); ES|QL: 317 (129 in the query, 188 elsewhere).
With the control the whole document looks like the grammar-only state until the end. The KQL rule also gets the
Sentinel CodeLens row ("No Sentinel tenant: configure one… | Compiled query") inserted above `SecurityEvent` in the same
frames, so its query block **moves down about 20 px** while it repaints (the ES|QL rule has no CodeLens).

## Where the time goes

Per-run timeline, medians from launch (small / 1,000 rules, KQL; ES|QL within 50 ms of it), from the extension's own log
lines and the language-server trace (`opentide.trace.server: verbose`, [`lsp-trace-*`](logs/highlighting/)):

| Event | small | 1,000 rules | |
|---|---|---|---|
| File text appears | 1.54 s | 1.58 s | VS Code window start-up |
| TextMate grammar colours | 2.55 s | 2.71 s | **before the extension is even active**; 2.49 s with no extension at all, 2.62 s for a built-in `.yaml` |
| Extension activated (log) | 2.88 s | 3.07 s | |
| Language server answers `initialize` | 3.23 s | 3.35 s | `initialize` took 482 ms / 401 ms (module instantiation) |
| `opentide serve` started | 3.58 s | 3.73 s | |
| **Server colours painted** | **4.10 s** | **6.62 s** | **0.87 s / 3.3 s after the server was ready** |

What the trace shows for the last step. After `initialize` the editor sends a burst of requests, in this order:
`textDocument/diagnostic`, **`workspace/diagnostic`**, `documentSymbol`, `codeAction`, `documentLink`, `inlayHint`,
`foldingRange`, `documentSymbol`, **`semanticTokens/full`**, … The server answers one at a time:

| | small | 1,000 rules |
|---|---|---|
| `workspace/diagnostic` | 811 ms | **2,214 ms** |
| `semanticTokens/full`, from the editor's side (queued) | 212 ms | **1,924 ms** |
| `semanticTokens/full`, a direct client on an idle server (`harness/highlighting/lspbench.js`, 5 runs) | first 155–168 ms, warm 6 ms | first 318–421 ms, warm 55–70 ms |
| `initialize` from a cold start, direct client | 200–215 ms | 191–218 ms |

So computing the colours is cheap (6 ms warm on the small workspace, about 60 ms on the large one). **The delay is that the
single-threaded server first answers the workspace-wide diagnostic pass (and the other requests sent before the
tokens), and `semanticTokens/full` waits behind it.** On the 1,000-rule workspace that pass takes about 2.2 s and the
tokens come out right after it ("in 1,924 ms" in the trace); the paint at 6.4–6.6 s is 3 s after the server is ready.
The same queue is why the small workspace needs 0.87 s even though the tokens cost milliseconds. Opening another file
with the server warm is fast (grammar 100 ms, server 140–165 ms), as is typing, so this is a start-up and
workspace-size cost, not a per-edit one.

## My read

1. **Two things get called "slow".** The first colour (grammar, 2.5 s here) is VS Code's own start-up: the identical
   figure appears with no extension and with the built-in YAML grammar, and it arrives before the extension is
   activated. The extension can't make that earlier. The second one, the server's colours at 4.1 s (small) and 6.4–6.6 s
   (1,000 rules), is what the owner is most likely seeing, because it **repaints most of the document, not only the query**:
   every `key:` colon changes colour and every plain value turns into a string colour.
2. **The slow part is queueing, not colouring.** The server is busy with the workspace diagnostics when the tokens
   are asked for. Any of these would shorten it, none of which I tried: answer `semanticTokens/full` (and
   `documentSymbol`, `foldingRange`) ahead of `workspace/diagnostic`, delay the workspace diagnostic pull until the
   open file's tokens have been returned, or give the pull its own process (the extension already runs `serve` in a second
   process). The gain would be up to about 0.9 s on a small repository and about 3 s on a 1,000-rule one.
3. **The grammar and the server paint very different colours**, which makes the late repaint obvious: the YAML grammar
   leaves values default-coloured and colons in the variable colour, while the server turns values into strings and
   colons into plain text; for ES|QL the grammar paints none of the keywords. If the grammar's YAML scopes agreed with
   the server's token types for the common cases (values as strings, colon as punctuation), the second step would only
   add the query's own colours.
4. **ES|QL keystrokes recolour after 320 ms** because the grammar can't colour it and the server's refresh comes after
   the edit. It's small, but it is a visible flicker on every typed word in an Elastic query.
5. Layout shift: the KQL CodeLens row arrives with the tokens and pushes the query down 20 px.

Caveats: one VM under software rendering, so absolute times will differ on a real desktop (the editor start-up share
will be smaller, the server share about the same since it is CPU-bound WASM); the large workspace is synthetic (500 + 500
near-identical rules); one VS Code version; Dark+/Light+ only; the keystroke test types a letter at the end of one line.

## Files

- Harness: [`harness/highlighting/`](harness/highlighting/): `hl.js` (recorder + driver), `batch.sh`, `ana.js`, `spans.js`, `spandiff.js`, `trace.js`, `lspbench.js`, `pick.py` (frame picker).
- Data: [`logs/highlighting/`](logs/highlighting/): per-run series for every configuration, the span diff, the LSP direct-client results, the first requests of the traces.
- Screenshots: `screens/hl-*`.
