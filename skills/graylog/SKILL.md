---
name: graylog
description: "Graylog detection engineering for opentide — event definitions of the Filter & Aggregation type (streams, search query, aggregation condition, group-by, search window and interval, event fields and key, notifications), the Lucene-based Graylog search dialect and its traps (analysed versus keyword fields, case sensitivity and the lower-cased-copy pipeline pattern, leading wildcards, Lucene regex limits, backslash escaping, _exists_, open ranges), Graylog Information Model field naming, how opentide builds each request for Graylog 6.3 to 7.2 and checks the query with /api/search/validate before every save, opentide query, anti-patterns and an authoring checklist. Resolves block structure from the installed engine. Use when authoring or reviewing configurations.graylog blocks of detection rules, Graylog search queries, or Graylog event definitions."
---

# Graylog — event definitions

This skill carries the operational context for `configurations.graylog` blocks
(`platform::graylog::1.0`) in opentide detection rules. One block is one Graylog
**event definition** of the Filter & Aggregation type: a search query over one or
more streams, run on a schedule, optionally aggregated and compared with a
condition. Event definitions exist in every Graylog edition, Graylog Open
included.

opentide deploys them over the REST API to **Graylog 6.3, 7.0, 7.1 and 7.2**,
checks the query with Graylog itself before every save, and searches messages
read-only with `opentide query`.

---

## 1. Resolve the structure before authoring

Do not author the block from memory, and do not expect a field table here. The
block's keys, types and defaults ship with the engine and move with it.

1. **MCP**: `opentide://schemas/rule` (the `graylog` key under `configurations`),
   `opentide://templates/rule`, and `opentide://platforms` for capabilities.
2. **CLI**: `opentide --json info --platform graylog`; `opentide new rule --name "…"
   --platform graylog --objective <uuid>` scaffolds a rule with the block's template.
3. **Repository**: `.opentide/schemas/` and `.opentide/templates/`, or generate
   them with `opentide generate`.

The normative contract is the platform specification **graylog-1.0**
(opentidehq/specifications, `specs/platforms/graylog-1.0.md`). Where this skill
and a validator finding disagree, the validator wins: run `opentide validate` and
`opentide validate query --platform graylog`.

What this skill holds is the part the schema cannot say: what the fields do in
Graylog, which queries silently match nothing, and what deploy does with them.

---

## 2. Surface map

| Graylog concept | What it is | In the opentide block |
|---|---|---|
| **Stream** | A routed subset of messages, by id (24 hex) | `streams`: aliases from the tenant's `stream_ids` table; else the tenant's default `streams` |
| **Stream category** | Graylog's grouping of streams by category | `stream_categories`, sent as written |
| **Search query** | Graylog search syntax: Lucene `query_string` passed to OpenSearch or Elasticsearch | `query` |
| **Filter** | An event per matching message | a block with no `aggregation` |
| **Aggregation** | Series (`count()`, `card(field)` …) per group, compared with a condition | `aggregation.group_by`, `aggregation.condition` |
| **Search within the last** | The time range each run searches | `schedule.window` (default: `every`) |
| **Execute search every** | The interval | `schedule.every` (default `5m`), or `schedule.cron` (Quartz) with `timezone` |
| **Event limit** | Most events one filter run creates | `event_limit`, 1–1,000, filters only (default 100) |
| **Event fields** | Values copied onto the fired event | `event_fields` |
| **Event key** | Event fields that identify "the same" event | `event_key` |
| **Notifications** | Slack, email, HTTP … by id | `notifications`: aliases from the tenant's `notification_ids` |
| **Grace period / message backlog** | Notification throttle per event key; messages attached | `grace_period`, `backlog` |
| **Priority** | 0–4 (Informational exists from 7.1) | `priority`, else derived from `response.alert_severity` |
| **Alert vs event** | Whether a fired event is an alert | `alert` (default `true`) |
| **Summary / remediation** | Event summary template (7.1+), remediation steps | `summary`, `remediation` |

Stream and notification ids never appear in a rule: blocks name **aliases**, and
each tenant in `platforms/graylog.toml` maps them to ids. A missing alias is
`graylog_alias_unknown` before any call for that rule.

The title is the block's `name`, else the rule's `name`. The description,
priority, tags and ATT&CK ids are derived from the rule; do not duplicate them in
the block.

---

## 3. A block, end to end

```yaml
configurations:
  graylog:
    enabled: true
    schema: platform::graylog::1.0
    status: STAGING
    streams: sysmon
    schedule: {every: 5m, window: 15m}
    aggregation:
      group_by: source
      condition: count() >= 3 OR card(parent_image_lc) >= 2
    event_fields:
      host: source                                   # copy a message field
      account: "${source.User}@${source.Domain}"     # a Graylog template
      owner: {lookup: {table: asset-owners, key_field: source}}
      family: {template: LOLBin}                     # constant text
    event_key: host
    grace_period: 30m
    notifications: soc-slack
    summary: Obfuscated PowerShell from ${source.ParentImage} on ${source.source}
    remediation: Isolate the host and collect the process tree.
    query: >-
      EventID:1
      AND parent_image_lc:/.*\\(winword|excel|powerpnt|outlook)\.exe/
      AND image_lc:/.*\\(powershell|pwsh)\.exe/
      AND command_line_lc:/.*( -enc | -encodedcommand |frombase64string|iex\().*/
      AND NOT command_line_lc:/.*\\program files\\contoso\\admintools\\.*/
```

In a template, `${source.X}` reads field `X` of the message that fired the event:
`source` there names the *message*, not the message's `source` field, so the host
is `${source.source}`. A bare string that is neither a field name nor contains
`${` is `graylog_event_field`; write constant text as `{template: "…"}`.

---

## 4. The query dialect

Graylog hands the query to OpenSearch or Elasticsearch `query_string` unchanged.
The default operator is **OR**, and an unqualified term searches every field.
The engine checks it offline as Lucene in a **Graylog dialect**; every finding
below was checked against the answers of Graylog 7.2.2 and 6.3.5's own validator.

### Case and analysed fields — the first thing to get right

| Field | Indexed as | Consequence |
|---|---|---|
| `message`, `full_message` | analysed: tokenised and lower-cased | match words or a phrase (`message:"powershell -enc"`); a regex, wildcard or range sees single tokens (`graylog_analyzed_field`) |
| `source` | lower-cased keyword | match lower case |
| every other string field | exact, **case-sensitive** keyword | `Image:powershell.exe` does not match `PowerShell.exe` |

The search syntax has **no case-insensitive flag**, and Lucene regex has no
`(?i)`. The pattern for case-insensitive rules has two halves:

1. a tenant **pipeline rule** (which opentide does not manage) writes lower-cased
   copies of the fields rules match on;
2. rules match those copies with lower-case regex and alternation.

```text
rule "lowercase CommandLine"
when
  has_field("CommandLine")
then
  set_field("command_line_lc", lowercase(to_string($message.CommandLine)));
end
```

Record the `_lc` fields a rule depends on in its description, so a tenant without
the pipeline is visibly not covered. Graylog's own documentation describes the
default analysis slightly differently (it lists `source` among the analysed
fields); opentide's verified behaviour above is what deploy is checked against —
confirm on your tenant with `opentide query` when it matters.

Graylog Illuminate fields typed `keyword/loweronly` in the GIM schema are
lower-cased at index time: match them in lower case.

### Idioms and the traps behind them

| Want | Write | Not | Why |
|---|---|---|---|
| A field is present | `_exists_:CommandLine` | `CommandLine:*` | a leading `*` is refused (`graylog_leading_wildcard`) |
| Every message in the streams | `_exists_:source` | `*`, `*:*` | Graylog's validator refuses both, so deploy saves nothing |
| Ends with | `image_lc:/.*\\mshta\.exe/` | `image_lc:*\\mshta.exe` | leading wildcards are off by default (`allow_leading_wildcard_searches`) |
| Starts with | `image_lc:c\:\\windows\\*` or a regex | — | a trailing wildcard is fine |
| Case-insensitive | a `_lc` copy and lower-case regex | `/(?i)mimikatz/` | Lucene has no inline flags: matches nothing, silently (`graylog_regex_unsupported`) |
| Word boundary | explicit context (`/.* -enc .*/`) | `\b`, `\B` | Graylog refuses them |
| Non-capturing / lookaround / backreference | rewrite as alternation | `(?:…)`, `(?=…)`, `\1` | `(?:` and lookarounds are literal text and match nothing; `\1` is the digit 1 and silently matches something else |
| Literal `@ # & < > ~` in a regex | `\@`, `\#` … | `/.*@contoso\.com/` | operators in Lucene regex; `@` is "any string" (`graylog_regex_operator`) |
| One literal backslash | `\\` | `\\\\` | `\\` is already one backslash; four match two (`graylog_double_backslash`) |
| At least *n* | `bytes:>=1` | `bytes:[1 TO *]` | an open range is refused (`graylog_open_range`) |
| Range | `EventID:[4624 TO 4625]` | `EventID:> 10` | the value must follow the operator (`lucene_range_operator`) |
| AND / OR / NOT | upper case | `and`, `or`, `not` | lower case are searched as words (`lucene_lowercase_operator`) |
| Two values of a field | `user:(alice OR bob)` | `user:alice bob` | `bob` is searched in every field (`lucene_bare_term`) |
| A path value | `resource:\/posts\/45326` | `resource:/posts/45326` | `/…/` is a regex (`lucene_unescaped_slash`) |

Lucene regex is **anchored**: it must match the whole value, hence the leading
and trailing `.*`. It supports alternation `(a|b)`, classes, repeats, numeric
intervals `<16-31>`, `\d`, `\w`, `\s`. Outside a regex, escape
`& | : \ / + - = ! ( ) { } [ ] ^ " ~ * ?` with a backslash; `<` and `>` cannot be
escaped, so quote the value or avoid them.

### YAML quoting

Write the query as a plain scalar, a single-quoted scalar, or a `>-` / `|` block:
backslashes reach Graylog as written. **Avoid double quotes**: YAML turns `\\`
into `\`, and `\.` is a YAML error. Folded `>-` joins lines with a space, which is
what a multi-line query wants.

### Leading wildcards per tenant

`allow_leading_wildcard = true` on a tenant mirrors the server setting; opentide
drops `graylog_leading_wildcard` only when **every** tenant the block reaches sets
it. Offline, with no tenant, it stays an error. Prefer the regex form: it is
portable across tenants.

---

## 5. Aggregations and schedules

### The condition grammar

```text
condition  = or ;  or = and *("OR" and) ;  and = not *("AND" not)
not        = "NOT" not / primary ;  primary = "(" condition ")" / series op number
series     = function "(" [ field [ "," number ] ] ")"
op         = ">=" / ">" / "<=" / "<" / "=="
```

Functions: `avg`, `card`, `count`, `latest`, `max`, `min`, `percentage`,
`percentile`, `stddev`, `sum`, `sumofsquares`, `variance`. `count` takes no field
or one; `percentile` a field and a percentile `0 < p ≤ 100`
(`percentile(bytes, 95)`); every other function exactly one field. Nesting is at
most 32 deep. The block never lists series: deploy derives one per distinct call.

Typical shapes:

| Intent | Condition |
|---|---|
| Burst per host | `group_by: source`, `count() >= 20` |
| Spray: one source, many accounts | `group_by: source_ip`*, `card(user_name) >= 10` |
| Either volume or variety | `count() >= 3 OR card(parent_image_lc) >= 2` |
| Volume outlier | `sum(bytes) > 500000000` |

\* Whatever field your tenant's parsing actually writes; check with `opentide query`.

### Window versus interval

- **Filter**: keep `window` equal to `every` (a tumbling window, the default).
  A longer window makes each message alert once per overlapping run
  (`graylog_overlapping_window`).
- **Aggregation**: a window longer than the interval is the point (a sliding
  count over 15 minutes, evaluated every 5). Pair it with `event_key` and a
  `grace_period` so one burst does not notify three times.
- **Cron**: `cron` is Quartz, 6 or 7 fields, with `?` in exactly one of day of
  month and day of week (`0 */10 * * * ?`); `window` is then required, and
  `timezone` is an IANA name (default `UTC`). `every` and `cron` are exclusive.
- Durations follow the Elastic duration grammar (`5m`, `1h10m`, `PT15M`).

### Event fields and keys

- Every `event_key` item must be an `event_fields` name (`graylog_event_key`).
  Key on the entity a responder acts on (host, account), not on a message id.
- `event_limit` is filters-only; an aggregation creates one event per group.
- `backlog` attaches messages to notifications; keep it small on noisy rules.

---

## 6. Versions as opentide handles them

Deploy reads `GET /api/system` once per tenant, before any write, and builds every
body for that version. A body never carries a property the version lacks:
Graylog 6.3 accepts an unknown property on create and silently drops it.

| Server | Create body | `summary` | `tags`, `tactics_techniques` | `Informational` |
|---|---|---|---|---|
| below 6.3 | tenant stops, `graylog_version_unsupported` | | | |
| 6.3.x | the definition, `share_request` beside it | left out | left out; ATT&CK in description and an `attack_techniques` event field | sent as Low (1) |
| 7.0.x | `{entity, share_request}` | left out | as 6.3 | sent as Low (1) |
| 7.1.x | as 7.0 | sent | as 6.3 | sent as 0 |
| 7.2.x+ | as 7.0 | sent | sent | sent as 0 |

A field left out because of the version earns `graylog_field_unsupported_version`;
a collapsed priority earns `graylog_priority_collapsed`. Servers below 6.3.12,
7.0.16 or 7.1.12 earn `graylog_version_vulnerable` (GHSA-j769-9gv9-65gr, access
tokens not reliably revoked) — deploy carries on, but tell the owner.

On 7.2+, tags are the block `tags`, `opentide`, `opentide.<uuid>` and the tenant
`tags`, lower-cased and normalised to `[a-z0-9_.-]`. The `opentide.<uuid>` tag is
for analysts; deploy never finds a definition by it.

---

## 7. How opentide validates and deploys

| Step | What happens |
|---|---|
| `opentide validate` | block constraints (`graylog_*` codes at fixed field paths), condition grammar, advisories (`graylog_overlapping_window`, `graylog_all_streams`, `graylog_title_duplicate`), and the query in the Graylog dialect (errors only) |
| `opentide lint --check queries` | the query's warnings (`graylog_analyzed_field`, `graylog_regex_operator`, `graylog_regex_quote`, `graylog_double_backslash`). opentide 0.28.0 and earlier drop them from `lint`: see them in the editor (`opentide lsp start`) or `opentide tui` |
| `opentide validate query --platform graylog` | the query offline; `.lucene` files too |
| `… --live` | `POST /api/search/validate` per tenant, with the block's streams and a relative range of `window`: no search runs |
| `opentide deploy --dry-run` | the requests, built for 7.2 without asking a server |
| `opentide deploy` | version read; query validated; create, update, unschedule or delete |

Before **every create and every update except a disable**, deploy sends the query
to `/api/search/validate`. `ERROR` fails the rule with `graylog_query_invalid` and
nothing is saved — Graylog would otherwise store an unparseable query without
complaint. `UNKNOWN_FIELD` is `graylog_unknown_field` and `INVALID_VALUE_TYPE` is
`graylog_value_type` (warnings): the query will match nothing until messages in
those streams carry the field, or compare a number field with text. A disable
skips the check, so a rule stays disableable after Graylog starts refusing it.

State and lifecycle:

- Graylog's 24-hex definition id lives in `.opentide/states/deployment/`, never
  in the rule. Commit it. Deploy never lists definitions, nor finds one by title
  or tag.
- Every `PUT` carries `?schedule=true|false`; a disable is an unscheduled update.
  A `PUT` answering 404 re-creates the definition (`graylog_definition_recreated`);
  under `DISABLEMENT` the id is removed instead (`graylog_definition_missing`).
- A create that gets no answer is **not retried** (`graylog_create_unconfirmed`):
  titles are not unique, and a retry could create a duplicate. Find it by title
  (or the `opentide.<uuid>` tag on 7.2), then delete it or record its id.
- Deploy never calls `/execute`, which creates real events and notifications.
- A definition installed by a content pack or Illuminate is not `DEFAULT` scope:
  `graylog_definition_immutable`. Never point a binding at one.

The token's user needs `eventdefinitions:create`, `read`, `edit` and `delete`,
and `streams:read` on every stream a definition names; a missing stream
permission is the usual `graylog_forbidden`.

---

## 8. Trying a query against data

```bash
opentide query --platform graylog --tenant graylog-prod --since 24h \
  'EventID:1 AND image_lc:/.*\\mshta\.exe/'
opentide query --platform graylog --rule <rule-uuid> --since 7d --limit 50
opentide query --platform graylog --index sysmon --index dns '_exists_:command_line_lc'
```

`POST /api/search/messages`, read-only. `--index` takes stream aliases (or ids);
the default is the rule's streams, else the tenant's. Before 7.2 Graylog returns
only the fields asked for (timestamp, source, message and the fields the query
names), and on 6.3 and 7.0 a dotted field name is not requested at all.

Run the query on real telemetry before shipping: a query that validates but
returns nothing is usually a case or analysed-field mistake, not a quiet estate.

---

## 9. Field naming and cross-platform alignment

Graylog has no fixed message schema: field names are whatever inputs, extractors
and pipelines write. Two conventions are common:

- **Raw source names**, e.g. Sysmon through Winlogbeat: `EventID`, `Image`,
  `CommandLine`, `ParentImage`, `User` — case-sensitive keywords.
- **Graylog Information Model (GIM)**, written by Illuminate: snake_case fields
  such as `user_name`, `user_domain`, `process_name`, `process_parent_name`,
  `process_command_line`, `application_name`, `event_outcome`, and the
  categorisation `gim_event_class`, `gim_event_category`,
  `gim_event_subcategory`, `gim_event_type`, `gim_event_type_code` (for example
  `190000` process started, `100000` logon). Matching on `gim_event_type_code`
  survives a change of log source; matching on a raw `EventID` does not.

Confirm which a tenant uses before writing a rule, and check GIM names against
Graylog's schema documentation rather than guessing a prefix.

| Concept | Graylog (built-in / GIM) | Defender | Sentinel | Elastic ECS |
|---|---|---|---|---|
| Host | `source` (sending host) | `DeviceName` | `Computer` | `host.name` |
| User | `user_name`, `user_domain` | `AccountName`, `AccountDomain` | `Account`, `TargetUserName` | `user.name`, `user.domain` |
| Process | `process_name` | `FileName` | `NewProcessName` | `process.name` |
| Parent | `process_parent_name` | `InitiatingProcessFileName` | `ParentProcessName` | `process.parent.name` |
| Command line | `process_command_line` | `ProcessCommandLine` | `CommandLine` | `process.command_line` |

Expose the same entities as `event_fields` (`host`, `user`, `process`) across
rules, so a SOAR or the analyst can pivot between platforms on one name.

---

## 10. Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Matching mixed-case values on a keyword field | A pipeline `_lc` copy and lower-case regex |
| `(?i)`, `\b`, `(?:…)` in a regex | Lucene syntax only; alternation and explicit context |
| Regex or wildcard on `message` | A parsed keyword field, or a phrase |
| `field:*` or `*` | `_exists_:field`, `_exists_:source` |
| `[n TO *]` | `field:>=n` |
| No `streams` on block or tenant | Name streams: otherwise every readable stream is searched |
| Filter with `window` longer than `every` | Equal them, or make it an aggregation |
| `event_limit` on an aggregation | Remove it; key and throttle instead |
| Two rules resolving to one title | Give one a `configurations.graylog.name` |
| Stream or notification ids in the rule | Aliases, mapped per tenant |
| Hand-writing ATT&CK into `event_fields` or the description | Set the rule's `techniques`; deploy derives them per version |
| Editing a deployed definition in the Graylog UI | Change the rule: the next deploy overwrites the whole definition |
| Pointing a binding at a content-pack definition | Let deploy create its own |
| Double-quoted YAML around a regex | Plain, single-quoted or block scalar |

---

## 11. Authoring checklist

- [ ] Block structure resolved from the engine; `schema: platform::graylog::1.0`, `status` set.
- [ ] `streams` (or the tenant's default) names the streams that carry the data.
- [ ] Every matched field confirmed to exist in those streams (`opentide query`, no `graylog_unknown_field`).
- [ ] Case handled: `_lc` copies or GIM `loweronly` fields; pipeline dependency written in the description.
- [ ] No regex or wildcard on `message` / `full_message`.
- [ ] No leading wildcard, open range, `*` match-all, `(?i)`, `\b` or lookaround.
- [ ] Operators upper case; multi-value matches grouped `field:(a OR b)`.
- [ ] Backslashes: `\\` per literal backslash; query not double-quoted in YAML.
- [ ] Filter: `window` equals `every`. Aggregation: condition in the grammar, `group_by` on the acting entity.
- [ ] `event_fields` expose host, user and process; `event_key` uses them; `grace_period` set on noisy rules.
- [ ] `summary` (7.1+) and `remediation` give the analyst the next step.
- [ ] `opentide validate` clean, and every `graylog_*` warning from `opentide lint` (or the editor) resolved; `opentide validate query --platform graylog --live` accepted.
- [ ] `opentide deploy --dry-run` reviewed; deployment state committed after deploy.

---

## 12. Collaboration with neighbouring skills

- **`opentide-rule`** for the rule around the block: description, response,
  exclusions, ATT&CK.
- **`detection-engineering`** for the hunt-to-rule lifecycle and thresholds.
- **`windows-event-logs`**, **`linux-internals`** for what the source events mean.
- **`mitre-attack`** for technique precision; deploy carries the ids to Graylog.
- Vendor syntax not covered here: Graylog's search syntax reference and GIM
  schema at go2docs.graylog.org — verify there rather than inventing syntax.
