---
name: elastic-security
description: "Elastic Security detection engineering for opentide's `elastic` platform (`configurations.elastic`, `platform::elastic::1.0`): choosing a rule type (custom query in Kibana KQL or Lucene, EQL including sequences, ES|QL, threshold, new terms, indicator match, machine learning), the idioms and pitfalls of each query language, ECS field discipline, index patterns and data views, interval and look-back scheduling against ingestion delay, alert suppression, exceptions, severity and risk overrides, ATT&CK mapping, and how opentide compiles, deploys, validates (offline engine and `--live` rule preview) and runs `opentide query`. Resolves block structure from the engine instead of pinning fields. Use when authoring, reviewing or tuning Elastic-keyed detection rules, or translating a hunt into a Kibana detection rule."
---

# Elastic Security — detection engineering

This skill carries what makes a `configurations.elastic` block a good Kibana detection rule: which rule type fits the behaviour, how each query language bites, and what opentide does with the block on its way to the detection engine. It does not carry the block's field list.

> **Pair with**: `opentide-rule` (the Detection Rule around this block), `detection-engineering` (hunt-to-rule lifecycle), `mitre-attack` (technique precision), `windows-event-logs` / `linux-internals` / `amazon-web-services` and peers for the telemetry under the ECS fields. Do not confuse Kibana KQL (`kuery`) with Microsoft KQL: `kusto-query-language` does not apply here.

---

## 0. Resolve the structure before authoring

The block's fields, enums and required-when rules belong to the installed engine, not to this skill. Resolve them in this order:

1. `opentide://schemas/rule` (MCP) or `.opentide/schemas/` (generated, `opentide generate schemas`): the `configurations.elastic` sub-schema for the declared `schema: platform::elastic::1.0`.
2. `opentide --json info --platform elastic` or `opentide://platforms`: what the installed version can do on Elastic.
3. `opentide new --platform elastic` or `.opentide/templates/`: a starting block.
4. The platform specification (elastic-1.0, RFC 0007) linked from the opentide docs' platform page for semantics.

A validator error outranks anything written here. Run `opentide validate` and `opentide lint` before trusting a block.

Structural concepts worth knowing before you read the schema:

- `type` picks the rule type, and the type picks the query language (§1). Types with settings have their own sub-block: `threshold`, `new_terms`, `threat` and `machine_learning` are required on their type, and `eql` is optional on `eql`. A sub-block on the wrong type, or a missing required one, is `type_block`.
- Settings are grouped (`scheduling`, `severity`, `risk`, `suppression`, `overrides`, `guide`, `exceptions`, `actions`). Kibana's flat names (`from`, `interval`, `max_signals`, `risk_score`, `note`, `alert_suppression`, `threat_index`, `timestamp_override`, ...) are refused in the block: author the grouped form, opentide compiles the flat one.
- `threat` in this block is the **indicator side of an indicator match rule**, not the ATT&CK array. ATT&CK comes from the rule's techniques (§9).
- `status` is required on the block, as on every platform, and maps through `deployment.toml` to a strategy.

---

## 1. Surface map — rule types

| `type` | Query language | Detects | Type-specific settings | Use when |
|---|---|---|---|---|
| `query` | Kibana KQL (`language: kuery`, the default) or Lucene (`language: lucene`) | Each matching event | none | One event is the signal |
| `eql` | EQL | Each matching event, or each matching `sequence` | `eql` (timestamp, event category, tiebreaker fields) | Ordered multi-event behaviour on one entity, process trees |
| `esql` | ES\|QL | Each row the pipeline returns | none (`FROM` names the sources) | Aggregations, computed fields, joins of evidence a filter cannot express |
| `threshold` | `kuery` or `lucene` | Count of matches per group (optionally distinct-value cardinality) | `threshold` (0–5 group-by fields, value ≥ 1, optional `cardinality`) | Volume per entity: spray, brute force, fan-out |
| `new_terms` | `kuery` or `lucene` | First time a value (or a combination of 1–3 values) appears within a history window | `new_terms` (`fields`, `history_window_start`) | Rarity: first-seen user/host/key/country combinations |
| `threat_match` (indicator match) | `kuery` or `lucene`, for both the event query and the indicator query | Events whose fields match indicator documents | `threat` (indicator `index`, `query`, `mapping` groups, optional `filters`, `indicator_path`) | Threat intel matching at scale |
| `machine_learning` | none | Anomalies above a score from **existing** anomaly jobs | `machine_learning` (`job_id`, `anomaly_threshold`) | A job already models the behaviour |

Decisions that matter:

- **Prefer `query` or `eql` for single-event logic.** Reaching for ES|QL to filter is a cost with no benefit and changes alert content (§3.4).
- **Sequences are EQL.** Neither KQL, Lucene nor threshold expresses order.
- **`machine_learning` creates nothing.** The jobs must already run on the tenant; the block only references them. Document that in `guide.setup`.
- **The type cannot change in place.** Kibana refuses a type change on update; opentide deletes and recreates the rule with the same `rule_id` (§11). Pick the type deliberately.
- **ES|QL and `machine_learning` take no `index`, `data_view_id` or `filters`** (`esql_source`): ES|QL names its sources in `FROM`, and ML jobs carry their own datafeeds. `language` is refused on `eql`, `esql` and `machine_learning` (`language`).

---

## 2. Sources: index patterns and data views

- **`index` is always a list** of patterns, even for one (`[logs-endpoint.events.process-*]`); a bare string is `index_list`.
- **`data_view_id` replaces `index`**; setting both is `index_xor_data_view`. It must name a data view that already exists — opentide never creates one, and a deploy or `--live` check fails the rule if it cannot be read.
- **Omitting both** uses the tenant's `setup.index` from `.opentide/configurations/platforms/elastic.toml`. That is convenient and opaque: a reviewer cannot see what the rule reads. Prefer an explicit `index` on production rules.
- **Scope patterns to the data stream** (`logs-system.security-*`, `logs-aws.cloudtrail-*`), not `logs-*`. Narrow patterns are cheaper, make field checks meaningful, and let the engine apply ECS checks.
- **Declare datasets** in `visibility.toml` as `[[logsources]]` with `system = "elastic"`; the `name` is the index pattern or data stream. Once the workspace declares any elastic log source, an undeclared pattern is `elastic_dataset_not_declared` (warning). Declared `columns` teach the engine custom fields and their types. Data views are not declarable.

---

## 3. Query languages — idioms and pitfalls

The offline engine checks every one of these (§12). The codes in brackets are what it reports; `opentide explain <code>` describes each, and `references/Engine-Diagnostics.md` lists them all.

### 3.1 Kibana KQL (`kuery`)

```
event.category : "process" and event.type : "start"
  and process.name : ("powershell.exe" or "pwsh.exe")
  and process.args : ("-enc" or "-encodedcommand")
  and not process.parent.name : "ccmexec.exe"
```

- `field : value`, `and` / `or` / `not` (case-insensitive; write them lower case), parentheses, value lists `field : (a or b)`, ranges `field >= 10`.
- `*` is a wildcard **only outside quotes**; `"*.exe"` is a literal asterisk [`kuery_quoted_wildcard`]. `?` is a literal, not a single-character wildcard [`kuery_question_mark`].
- A value with no field searches every field — slow and noisy [`kuery_free_text`].
- No Lucene syntax: no `/regex/`, no `[a TO b]` ranges, no `_exists_`, `&&`/`||`, fuzzy `~` or boost `^` [`kuery_lucene_syntax`, `kuery_looks_like_lucene`]. Upper-case `AND`/`OR`/`NOT` are valid KQL operators (in Lucene, by contrast, lower case is a search term).
- Special characters need escaping [`kuery_escape`]; range types must match the field [`kuery_range_type`].
- `opentide query` can only run KQL through a rule preview (§13).

### 3.2 Lucene (`language: lucene`)

```
event.code:"4625" AND event.outcome:"failure" AND NOT user.name:("ANONYMOUS LOGON" OR "-")
```

- Operators are upper case; lower-case `and`/`or`/`not` are search terms [`lucene_lowercase_operator`].
- Mixing `AND` and `OR` without parentheses does not bind as it reads [`lucene_mixed_operators`]. Always parenthesise.
- An unescaped `/` opens a regular expression [`lucene_unescaped_slash`]; Windows paths and URLs need escaping [`lucene_escape`]. `/regex/` bodies are Lucene RegExp, not PCRE, and can be expensive [`lucene_regexp`].
- `field:> 10`, with a space, searches the field for the text `>`; the value must follow the operator directly (`field:>10`), or use a range `field:[10 TO *]` [`lucene_range_operator`].
- Choose Lucene only for a reason (regex, an imported rule); KQL is the default and is more readable.

### 3.3 EQL

```
sequence by host.id with maxspan=2m
  [process where event.type == "start" and process.name : "winword.exe"]
  [process where event.type == "start" and process.parent.name : "winword.exe"
     and process.name : ("cmd.exe", "powershell.exe", "pwsh.exe")]
```

With the default schedule (`interval: 5m`, `lookback: 1m`) a `maxspan=2m` sequence earns `eql_maxspan_lookback`: set `scheduling.lookback` to `2m` or more for it, so a sequence that straddles two runs is still seen.

- `==` is case-sensitive and takes no wildcards; `:` is case-insensitive and takes wildcards. Prefer `:` for process and file names [`eql_case_sensitive`, `eql_literal_wildcard`]. `like~`, `in~`, `regex~` are the case-insensitive forms.
- **Always set `maxspan` on a sequence** [`eql_maxspan_missing`]; it is mandatory with missing-event terms `![ ]`. Units must be ones Elasticsearch accepts [`eql_maxspan_unit`].
- **Size `maxspan` against the schedule.** A `maxspan` longer than `interval + lookback` cannot match a whole sequence [`eql_maxspan_window`]; longer than `lookback` misses sequences that straddle two runs [`eql_maxspan_lookback`].
- `by` joins on shared values across events; key on stable identifiers (`host.id`, `process.entity_id`), not names.
- `until` expires a partial sequence; `runs` and `![ ]` are not allowed on `until` [`eql_until_term`].
- EQL cannot compare one field to another [`eql_field_comparison`]; Endgame-era pipes (`count`, `unique`, `filter`, ...) are unsupported [`eql_unsupported`].
- The `eql` sub-block sets `timestamp_field`, `event_category_override` and `tiebreaker_field` for non-ECS data; a custom timestamp field must be mapped `date` or `date_nanos` (checked before deploy).

### 3.4 ES|QL

```
FROM logs-system.security-*, logs-windows.forwarded-*
| WHERE event.code == "4625" AND winlog.event_data.SubStatus == "0xC000006A"
| STATS failures = COUNT(*), accounts = COUNT_DISTINCT(user.name) BY source.ip
| WHERE accounts >= 8 AND failures >= 20
```

- **Aggregating queries** (`STATS ... BY`) raise one alert per row, and the alert holds **only the `BY` fields and computed values** — not the source event. Put every entity the analyst needs in `BY`.
- **Non-aggregating queries** raise one alert per event and deduplicate on `_id`. Before stack 9.4 add `METADATA _id` to `FROM` [`esql_metadata_id`]; a `KEEP` or `DROP` that removes `_id` breaks deduplication.
- `suppression.group_by` must name a column the query returns [`esql_group_by_column`]; the pre-flight checks it against the real columns.
- Commands and functions are gated by stack version [`esql_unavailable`]. Declare `version` (`MAJOR.MINOR` such as `9.5`, or `serverless`) in each tenant's `[tenants.setup]`; the engine checks a rule against the **lowest** version of the tenants it targets. Without it, the query is checked against the whole supported range.
- `LIKE` / `RLIKE` escaping differs from how it reads [`esql_pattern`]. `LIMIT` caps results per run along with `scheduling.max_alerts` (the lower wins).

---

## 4. ECS field discipline

- **Write ECS, not vendor field names**, whenever the integration maps them: `process.name`, `process.command_line`, `process.parent.executable`, `user.name`, `source.ip`, `host.id`, `event.category` / `event.type` / `event.action` / `event.outcome`. Vendor fields (`winlog.event_data.*`, `aws.cloudtrail.*`) are for detail ECS does not carry.
- **Filter on the categorisation fields first** (`event.category`, `event.type`, `event.dataset`, `event.code`), then on entities.
- **Know the mapping type.** `keyword` is exact and case-sensitive; `wildcard` and `match_only_text` behave differently under wildcards and aggregation; `text` cannot be aggregated. Group-by, threshold, cardinality and new-terms fields must be aggregatable — checked with `_field_caps` before deploy.
- The engine checks fields against its ECS catalogue (and the columns `visibility.toml` declares) **only when every index the query reads starts with `logs-`** and is written in the block: `ecs_unknown_field` (warning, for a likely typo of an ECS field such as `process.nmae`; integration namespaces like `winlog.*` and other custom fields pass silently, so a clean run does not prove every field is ECS) and `ecs_type_mismatch` (error). Queries over a data view, the tenant default index, or non-`logs-` patterns get no field check — review those by hand.
- Record the fields the rule needs in `required_fields` with their mapping types, and the integrations in `integration`. Both are informational in Kibana; they tell the SOC what must be onboarded.

---

## 5. Scheduling, overlap and ingestion delay

opentide compiles `from = now-(interval + lookback)`, `to = now`. `scheduling.lookback` is **additional overlap**, not the window. Defaults: `interval: 5m`, `lookback: 1m`. `max_alerts` (Kibana `max_signals`) defaults to the engine's 100; a lower system setting wins.

| Situation | Guidance | Code |
|---|---|---|
| `lookback: 0m` | Late events and delayed runs are missed; keep at least `1m` | `lookback_zero` |
| `lookback` over `1h` | Usually a misunderstanding of what look-back means | `lookback_long` |
| `threshold` with `lookback > interval` | Threshold counts across the whole window and does not deduplicate overlapping runs: alerts repeat | `threshold_lookback` |
| EQL `maxspan` vs schedule | See §3.3 | `eql_maxspan_*` |

Ingestion delay: when events land well after `@timestamp` (cloud audit APIs, forwarded logs), a look-back sized to the delay keeps windows overlapping, or set `overrides.timestamp` to an ingest-time field such as `event.ingested` so the window runs on arrival time. A timestamp override must be mapped `date` / `date_nanos`; `overrides.disable_fallback` stops Kibana falling back to `@timestamp` for documents without it.

Durations: shorthand (`5m`, `1h10m`; units `d h m s`, lower case, in that order, ASCII digits) or ISO 8601 (`PT1H`, `P14D`).

---

## 6. Alert suppression

- `suppression.group_by` takes 1–3 distinct fields on every type except `threshold`, where it is **forbidden**: threshold suppression is a `duration` only, and its grouping is the threshold's own `field` list.
- `duration` sets the suppression window; omitted on non-threshold types, suppression lasts one rule execution.
- `missing_fields_strategy`: `suppress` (default) groups alerts missing a field together; `doNotSuppress` raises each.
- Group-by fields must be aggregatable (ES|QL: returned columns).
- A tenant with `setup.suppression = false` (a licence without alert suppression) compiles the rule **without** suppression and warns `suppression_omitted_basic_license`. A rule whose noise budget depends on suppression is not equivalent there — say so in the description.
- Suppression hides duplicates; it does not fix a noisy query. Tune the query first.

---

## 7. Exceptions and filters

- `exceptions.lists` attaches **existing** exception lists by `id`, `list_id`, `namespace_type` (`single` or `agnostic`) and `type` (`detection` or `rule_default`). opentide does not create lists or items; manage them in Kibana and reference them here.
- `exceptions.endpoint: true` attaches the Elastic Endpoint exception list.
- On update, Kibana-side `exceptions_list`, `actions`, `response_actions` and the timeline are **kept** when the block does not set them, so analyst-added exceptions survive a redeploy. Setting `exceptions` in the block replaces them.
- `filters` are rule query filters (not Elastic Defend event filters), in one of two shapes per entry: the phrase shorthand `{field, value, negate?}` or a raw `{meta, query}`. Mixing shapes in one entry is `filter_shape`. Filters are not applied by `opentide query`.
- Prefer an exception list over a `not` clause for environment-specific allow-listing: it is tenant-local, auditable and editable without a redeploy. Keep logic that defines the behaviour in the query.

---

## 8. Severity, risk and overrides

| `alert_severity` | Kibana severity | Default risk score | Band an explicit score should fall in |
|---|---|---|---|
| Informational | `low` | 1 | 0–21 |
| Low | `low` | 21 | 0–21 |
| Medium | `medium` | 47 | 22–47 |
| High | `high` | 73 | 48–73 |
| Critical | `critical` | 99 | 74–100 |

- Severity comes from the block's `severity` (a string, or `{default, mapping}`), else the rule's `response.alert_severity`. Values outside the vocabulary are `severity`.
- An explicit `risk` (0–100) outside the severity's band is `risk_band`. Justify a score in the description.
- `severity.mapping`: alerts whose `field` equals `value` take another severity (`equals` is the only operator). `risk.mapping`: the alert's score comes from a numeric field. On threshold rules only the group-by fields carry data for overrides.
- `overrides.name` sets the alert title from an event field — useful for "what" at a glance (`process.command_line`, `source.ip`).

---

## 9. ATT&CK mapping

The compiled `threat` array is derived, never authored: opentide takes the rule's `techniques` plus those inherited through `detection_model` (the objective's ATT&CK techniques), groups them by tactic in ATT&CK order and nests sub-techniques under their parents. Consequences:

- Map techniques on the Detection Rule or its objective, precisely (`mitre-attack`); there is no ATT&CK key in the Elastic block.
- Mobile and ICS techniques are dropped from the Elastic array (`technique_not_enterprise`).
- ATT&CK v19 splits Defense Evasion: Elastic rules carry TA0005 **Stealth** and TA0112 **Defense Impairment**.

---

## 10. Analyst-facing content

- `guide.investigation` becomes the Kibana investigation guide (Markdown); without it, `response.procedure.analysis` is used. Write it for the alert as it lands: which fields to pivot on, what benign looks like.
- `guide.setup` states prerequisites: integrations, audit policy, ML jobs, aggregatable fields.
- `highlighted_fields` puts the decision-making fields at the top of the alert flyout.
- `false_positives` lists known benign causes; keep it in step with the exceptions.
- `building_block: true` hides alerts from the default Alerts view — for low-fidelity signals that feed correlation or risk, not for silencing a noisy rule.
- `actions.notify` (connector actions in Kibana's shape, copied unchanged), `actions.respond` (`endpoint: isolate | kill-process | suspend-process | runscript`, or `osquery`), `actions.timeline`. Response actions act on hosts: gate them behind high-fidelity rules and say so in the containment procedure.
- A `response.procedure.searches` entry with `system: elastic` needs its own `language` (`esql`, `eql`, `kuery`, `lucene`) to be analysed; the language is never guessed from the text.

---

## 11. How opentide compiles and deploys

- **Identity.** Kibana `rule_id` is the rule's `metadata.uuid`. Elastic keeps **no deployment state file**: rules are addressed by UUID. Never change a deployed rule's UUID.
- **Body.** Name from the block's `name` or the rule's; description from the rule; `author` from metadata author and contributors; `references` from public references; tags are `OpenTide`, then the tenant's `setup.tags`, then the block's `tags`. Server-owned fields never leave opentide.
- **Status.** The status maps to a strategy: active strategies create or update (`enabled` true, or false for `DISABLEMENT`), `DELETION` deletes (a 404 counts as done), inert statuses are skipped.
- **Upsert.** GET by `rule_id`; 404 creates, 200 updates. A type change deletes then recreates with preserved fields. **Prebuilt (immutable or external) rules are never modified**: duplicate them under your own UUID instead (`opentide generate extract elastic --include-prebuilt` converts them).
- **Failure scope.** HTTP 401/403 fails the tenant, and its remaining rules are not attempted; any other error fails only that rule and the run continues. The run lists every failure and exits 1 (see `opentide-rule`). A `GET`, `PUT` or `DELETE` is retried after 408, 429, 502, 503 or 504; a `POST` is sent once, so a create is never sent twice.
- **Pre-flight.** The Elasticsearch checks in §12 run before every deploy; a rule that fails them is not sent.
- **Inspect before sending.** `opentide deploy --dry-run --json` (and the SDKs' `deploy_plan`) show each rule's `api_request` as `{payload, block}`: `payload` is the Kibana rule, compiled for the first Elastic tenant the run reaches (named in the entry's `tenant`, with that tenant's modifiers, `tags`, `index` and `suppression`), and `block` is the rule's `elastic` block, which the Elasticsearch checks read. A script that read the Kibana rule from `api_request` must read `api_request.payload`. `references/Compile-Mapping.md` maps block settings to Kibana fields.
- **Import.** `opentide generate extract elastic --space <space>` writes a Kibana space's custom rules to `Imported/` as Tide rules (rule_id becomes `metadata.uuid`; disabled rules import as `DISABLED`).

---

## 12. Validation

| Check | Command | What it catches |
|---|---|---|
| Schema and compile | `opentide validate` | Block shape codes (`type_block`, `language`, `esql_source`, `index_xor_data_view`, `filter_shape`, `suppression_shape`, `duration`, `severity`, `risk_score`, ...), and any rule the Elastic compiler cannot build |
| Offline engine | `opentide validate query --platform elastic` (or the `queries` check of `validate`/`lint`, the editor, MCP `validate_query` with `language` and `stack`) | Parse errors and semantic checks in KQL, Lucene, EQL and ES\|QL by the block's `type` and `language`; ECS fields on `logs-*` indices; schedule advisories; ES\|QL against the tenants' stack version |
| Style | `opentide lint` | The engine's warnings and notes (`lookback_zero`, `risk_band`, `kuery_free_text`, ...) |
| Live | `opentide validate query --platform elastic --live` | Advisories, the Elasticsearch pre-flight, then a Kibana **rule preview** of the compiled rule |

The live check and every deploy run the same pre-flight with the tenant API key: ES|QL sent with `| LIMIT 0` (a parsing error fails; unresolved sources warn), `data_view_id` resolved, aggregation fields existing and aggregatable, timestamp overrides mapped as dates, indicator-match fields searchable. Unonboarded indices warn rather than fail, so a rule can be validated before data arrives.

The preview (`invocationCount: 1`) creates no rule but writes its alerts to the preview index, `.preview.alerts-security.alerts-<space>`, which Kibana cleans up. Errors in its logs fail the rule; a missing preview-index privilege fails the tenant. `--check-timeout` bounds each request.

---

## 13. `opentide query`

- `--language esql` (default), `eql`, `lucene` run on Elasticsearch and return events; EQL sequences come back numbered (`_sequence`). Index: `--index`, else the rule's index or data view, else the tenant's `setup.index`.
- `--language kuery` runs as a **rule preview**: the rows are the preview's alerts with `kibana.*` bookkeeping removed, capped at 1,000 per preview. This is the command's one write, to the preview index.
- `--rule <uuid>` / `--file` runs the query deploy would send. For `threshold`, `new_terms` and `threat_match` only the event query runs, and block `filters` are not applied; `machine_learning` has no query. Treat the rows as candidates, not alerts.

---

## 14. Anti-patterns

| Anti-pattern | Fix |
|---|---|
| ES\|QL used as a filter | `query` or `eql`; keep ES\|QL for aggregation |
| Aggregating ES\|QL whose `BY` omits the entity | Put host / user / source in `BY`: the alert holds nothing else |
| Non-aggregating ES\|QL without `METADATA _id` on stacks before 9.4, or a `KEEP` that drops `_id` | Add `METADATA _id`; keep `_id` |
| EQL `==` on process names | `:` (case-insensitive, wildcards) |
| Sequence without `maxspan`, or `maxspan` larger than the window | Set it, and size `interval` / `lookback` to it |
| Quoted wildcard in KQL (`"*.exe"`) | Unquoted `*.exe`, escaping as needed |
| Lowercase `and`/`or` in Lucene | Upper case, parenthesised |
| `index: [logs-*]` or no index on a production rule | The specific data streams |
| `lookback: 0m`, or a 1-day look-back "to see a day" | `interval` is the cadence; `lookback` is overlap for delay |
| Threshold with look-back above interval | Keep look-back ≤ interval |
| Suppression as the noise fix | Tune the query; suppress to merge true duplicates |
| Allow-listing with `not` clauses per tenant | Exception lists, referenced from the block |
| Writing an ATT&CK array or `threat` for ATT&CK | Techniques on the rule or objective; `threat` is indicator match |
| `machine_learning` rule for a job that is not running | Create and start the job first; document it in `guide.setup` |
| Editing a prebuilt rule by UUID | opentide refuses; duplicate it under your own UUID |
| Group-by on a `text` field | An aggregatable `keyword` field |

---

## 15. Entity identifier alignment

| Concept | Elastic (ECS) | Microsoft Defender | CrowdStrike | SentinelOne |
|---|---|---|---|---|
| Host | `host.id`, `host.name` | `DeviceId`, `DeviceName` | `aid`, `ComputerName` | `agent.uuid`, `endpoint.name` |
| User | `user.name`, `user.domain`, `user.id` | `AccountName`, `AccountUpn`, `AccountSid` | `UserName`, `UserSid` | `user.name` |
| Process correlation | `process.entity_id` (stable), not `process.pid` | `ProcessUniqueId` | `ContextProcessId_decimal` | `process.storyline.id` |
| Hash | `process.hash.sha256`, `file.hash.sha256` | `SHA256` | `SHA256HashData` | `tgt.process.image.sha256` |
| Network | `source.ip`, `destination.ip` | `RemoteIP` | `RemoteAddressIP4` | `dst.ip.address` |

Key sequences and suppression on the stable identifiers (`host.id`, `process.entity_id`), not on names or PIDs, which collide and recycle. `process.entity_id` is populated by Elastic Defend; other integrations may leave it empty, so check the data stream first. Cross-platform correlation happens at the SOAR / SIEM layer, never through direct cross-vendor joins.

---

## 16. Authoring checklist

- [ ] Structure resolved from the engine (schema / template / `info --platform elastic`); block declares `schema: platform::elastic::1.0` and a `status`.
- [ ] `type` chosen for the behaviour (§1); type sub-block present and no other.
- [ ] `language` set only for `query`, `threshold`, `new_terms`, `threat_match`; Lucene chosen for a reason.
- [ ] `index` (a list of specific data streams) or an existing `data_view_id`, not both; datasets declared in `visibility.toml`.
- [ ] ECS fields; aggregation fields are aggregatable; custom timestamp fields are dates.
- [ ] EQL: `:` for names, `maxspan` set and no longer than `lookback` (never longer than `interval + lookback`), `by` on stable IDs.
- [ ] ES\|QL: entity in `BY` when aggregating; `METADATA _id` when not (pre-9.4); tenant `version` declared.
- [ ] `scheduling.lookback` ≥ `1m`, sized to ingestion delay; threshold look-back ≤ interval.
- [ ] Suppression: 1–3 `group_by` fields (none on threshold, `duration` instead); licence of each tenant considered.
- [ ] Exceptions reference existing lists; allow-lists live in lists, not the query.
- [ ] Severity calibrated; any explicit risk score inside its band and justified.
- [ ] ATT&CK techniques on the rule or objective; nothing Mobile/ICS expected in Elastic.
- [ ] `required_fields`, `integration`, `guide.investigation`, `guide.setup`, `highlighted_fields`, `false_positives` filled.
- [ ] Response actions only on high-fidelity rules.
- [ ] `opentide validate` and `opentide lint` clean; `validate query --platform elastic --live` passes on a staging tenant; `deploy --dry-run` body reviewed.

---

## Collaboration with neighbouring skills

- **`opentide-rule`** for the Detection Rule around the block: description, response procedure, exclusion discipline.
- **`opentide-objective`** for the signal this configuration implements; **`opentide-visibility`** for `visibility.toml` log sources.
- **`detection-engineering`** and **`threat-hunting`** for turning an `opentide query` hunt into a rule.
- **`mitre-attack`** for technique precision.
- Telemetry skills (`windows-event-logs`, `linux-internals`, `amazon-web-services`, `entra-id`, ...) for what the ECS fields hold.
