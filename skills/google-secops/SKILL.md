---
name: google-secops
description: Google Security Operations (Google SecOps, formerly Chronicle) detection engineering in YARA-L 2.0 — UDM events and the entity graph, single-event versus multi-event rules, match windows, outcome and risk score, condition counting, reference lists and data tables, curated detections versus custom rules, run frequency and retrohunts, UDM search. Covers YARA-L idioms and pitfalls, how opentide assembles a rule from the sections of a configurations.google_secops block plus derived meta, the Chronicle API v1 deploy flow and its ru_ rule id in deployment state, DELETION archive versus delete, what the offline engine and --live verifyRuleText each catch, opentide query through udmSearch, and UDM principal/target/src alignment with other platforms. Use when authoring or reviewing google_secops configurations or google_secops hunts in opentide detection rules, or translating a detection from KQL, SPL or CQL into YARA-L.
---

# Google Security Operations (YARA-L 2.0) — content authoring

This skill carries the operational context for detection content destined for
`configurations.google_secops` blocks (`platform::google_secops::1.0`) in opentide
detection rules, and for hunts with `system: google_secops`. Google SecOps
normalises every log into the **Unified Data Model (UDM)**; rules are written in
**YARA-L 2.0**, which shares its name with YARA and nothing else.

Pair with `opentide-rule` (object structure, response procedure, exclusions),
`google-cloud-platform` (GCP audit telemetry that often feeds SecOps),
`detection-engineering` and `mitre-attack`.

---

## 1. Surface identification

| Surface | What it is | Managed by opentide? |
|---|---|---|
| **Custom rule, single-event** | One event variable, no `match`; streams in near real time | Yes: a `google_secops` block |
| **Custom rule, multi-event** | Two or more event variables joined by placeholders inside a `match` window; runs on a schedule | Yes |
| **Composite rule** | A rule over detections (`$d.detection.detection.rule_name`) rather than raw events | Yes (it is still a custom rule) |
| **Curated detections** | Google-maintained rule packs | No: console. Composite rules may consume them by name |
| **Rule exclusions, reference lists, data tables** | Tenant-side content the rule reads | No: console. `verifyRuleText` resolves them, the offline engine never calls them unknown |
| **Retrohunt** | Running a rule over past data; writes detections | No: console. Never a substitute for `opentide query` |
| **Rule tests** | Console test runs | No |
| **UDM search** | Interactive YARA-L search (bare UDM paths, no `$e.`) | Read-only: `opentide query --platform google_secops`, hunts in `response.procedure.searches` |

Decide first whether the intent is a **rule** (alerting, `rule` profile) or a
**search** (a hunt, `search` profile). The two profiles accept different sections,
functions and window limits; the engine checks each against its own.

---

## 2. Resolve the structure from the engine, not from this skill

Do not author the block from memory, and do not expect a field table here. The
block's keys, the UDM type graph and the YARA-L function catalogue all ship with
the installed opentide and its analysis engine, and they move.

1. **Block keys**: `opentide://schemas/rule` (MCP), else `.opentide/schemas/` for
   the rule's `metadata.schema`, else `opentide generate schemas`. `opentide new rule
   --name "…" --platform google_secops --objective <uuid>` scaffolds a rule whose
   block has `events`, `outcome` and `condition` already present.
2. **Capability**: `opentide --json info --platform google_secops` or
   `opentide://platforms`. Google SecOps deploys, validates live, checks offline,
   and runs `opentide query`.
3. **UDM fields, enum values, functions**: the engine's catalogues (generated from
   Google's UDM field list and function list). Use editor hover and completion
   (`opentide lsp start`, or `opentide tui`) on `$e.` and after
   `metadata.event_type =`. The engine reports a wrong path as
   `yaral_unknown_udm_field` with the closest field.
4. **Any finding code**: `opentide explain <code>`.

[`references/udm-quick-reference.md`](references/udm-quick-reference.md) is an
orientation map of the UDM nouns, the common event types and the function
namespaces. Where it and the engine disagree, the engine wins.

---

## 3. How opentide builds the rule

You write **sections**; opentide writes everything else.

| Block key | Form | Notes |
|---|---|---|
| `events` | YARA-L text, block scalar | Required |
| `condition` | YARA-L text, block scalar | Required |
| `outcome`, `setup`, `export` | YARA-L text, block scalar | Optional |
| `match` | YAML: `group_by` (list of `$placeholders`), `window`, `type` (`hop` default, `tumbling`, `sliding` with `pivot` and `direction`) | Required with two or more event variables |
| `options` | YAML: `allow_zero_values`, `suppression_window` | Optional |
| `name` | YARA-L identifier | Default: the rule title in `snake_case` (`r_` prefix if it starts with a digit or is a keyword) |
| `severity`, `priority` | `Info`, `Low`, `Medium`, `High`, `Critical` | Severity defaults to `response.alert_severity` mapped, else `Medium`; priority to the severity |
| `meta` | string map | Extra meta keys, written after the derived ones |
| `alerting`, `run_frequency`, `schedule` | run state | See section 5 |

**Derived `meta`**, in order: `author` (metadata author plus block
`contributors`), `description` (whitespace collapsed), `severity`, `priority`,
`technique` (the rule's ATT&CK techniques, including those inherited through
`detection_model`, sorted and comma-separated, which is what Google's coverage
matrix reads), `opentide_uuid`, `opentide_version`, then the block's own `meta`.
A block `meta` key that repeats a derived key, is a keyword or is not a string is
`google_secops_meta_key`.

This block (trimmed from opentide's test fixtures):

```yaml
configurations:
  google_secops:
    schema: platform::google_secops::1.0
    enabled: true
    status: PRODUCTION
    name: password_spray_then_success
    severity: High
    run_frequency: LIVE_CUSTOMIZABLE
    events: |
      $fail.metadata.event_type = "USER_LOGIN"
      $fail.security_result.action = "BLOCK"
      $fail.principal.ip = $ip
      $fail.target.user.userid = $user

      $success.metadata.event_type = "USER_LOGIN"
      $success.security_result.action = "ALLOW"
      $success.principal.ip = $ip
      $success.target.user.userid = $user

      $fail.metadata.event_timestamp.seconds < $success.metadata.event_timestamp.seconds
    match:
      group_by: [$user, $ip]
      window: 30m
    outcome: |
      $risk_score = max(80)
      $risk_entity_to_score = $user
      $failed_attempts = count_distinct($fail.metadata.id)
    condition: |
      #fail >= 10 and $success
    options:
      suppression_window: 1h
```

deploys as `rule password_spray_then_success {`, the derived `meta:` (here
`severity = "High"`, `technique = "T1078,T1110.003"`), then `events:`, `match:`
rendered as `$user, $ip over 30m`, `outcome:`, `condition:` and `options:`
rendered as `suppression_window = 1h`. `deploy --dry-run` shows the exact text.

Rules of the block:

- **Never paste a whole rule.** A `rule x {` header, a section label
  (`events:`) or a lone brace inside a section is `yaral_section_header`.
- **Always use `|`, never an alias.** `condition: #fail >= 10` as a plain scalar
  is a YAML comment, loads as null, and fails as `yaral_section_empty`; an alias
  is `yaral_section_alias`.
- Backslashes in a `|` block are literal. In a YARA-L regex `/\\powershell\.exe$/`,
  `\\` matches one backslash; do not double it again for YAML.
- Rule names are unique across enabled blocks, ignoring case
  (`google_secops_name_duplicate`): composite rules address producers by name.

---

## 4. YARA-L idioms and pitfalls

### Event variables and scoping

- Every predicate in a rule reads through an event variable: `$e.principal.hostname`,
  never a bare `principal.hostname` (that is search syntax).
- **Put `metadata.event_type` (or `metadata.log_type` / `metadata.product_name`)
  equality first** on every event variable. Google applies filters in order and
  recommends equality filters before regexes. An event variable without one is
  `yaral_unfiltered_event`; an expensive rule can be `LIMITED` or `PAUSED` by
  Google (`google_secops_rule_execution_limited` at deploy).
- An enum field takes an enum value: `"PROCESS_LAUNCH"`, not `"process_launch"`
  (`yaral_enum_value`), and `nocase` on an enum is an error
  (`yaral_nocase_on_enum`).

### Placeholders and joins

- `$e.principal.ip = $ip` binds a placeholder. The same placeholder on two event
  variables is the join; multi-event correlation without a placeholder join is
  refused by Google's compiler (checked by `--live` only).
- Every multi-event rule needs `match` (`yaral_multi_event_match`), and every
  `group_by` entry must be a placeholder bound in `events` (`yaral_match_variable`).
- **Zero values join.** A missing field equals the empty value, so two empty
  `userid`s join. Match variables drop zero values by default
  (`allow_zero_values` turns that off — rarely what you want); for other joins add
  an explicit `!= ""` guard.
- Order events with timestamps:
  `$a.metadata.event_timestamp.seconds < $b.metadata.event_timestamp.seconds`.

### Repeated fields

`principal.ip`, `target.ip`, `security_result.action` and
`principal.user.email_addresses` are repeated. Unmodified, each element is
evaluated separately, and a placeholder bound from a repeated field binds per
element, which can multiply matches. `any` / `all` work on repeated fields only,
never in a placeholder assignment or with a reference list.

### Strings, regex and nocase

- `= "x" nocase` for case-insensitive equality; `= /pattern/ nocase` for regex.
- Regexes are RE2: no lookaround, no backreferences (`yaral_regex`). Anchor them;
  a leading unanchored `.*` is `yaral_leading_wildcard_regex`.
- Double-quoted strings document only `\\`, `\"`, `\n`, `\r`, `\t`
  (`yaral_string_escape` otherwise). Back-quoted strings are raw.

### Match windows

| Window | Syntax (`match.type`) | Rule limit |
|---|---|---|
| Hop (default) | `$a, $b over 30m` (`hop`) | 14d |
| Sliding | `$a over 1h after $e1` (`sliding`, `pivot`, `direction`) | 14d |
| Tumbling | `$a by 1h` (`tumbling`) | 72h |

Searches have tighter limits (the engine knows them). A longer window costs more
and runs less often: Google runs multi-event rules with windows over 48 hours at
roughly `window / 10`, without true-up runs. Pick the shortest window that holds
the behaviour.

### Condition

- `$e` means "at least one"; `#e >= 10` counts distinct events in the window.
- Non-existence (`$a and !$b`) needs a `match` window and a bounded event
  variable (`yaral_condition_shape`).
- `or` across event variables is limited; `not` on an event term is refused;
  every event variable must appear in the condition or be read through a
  placeholder or outcome that does (`yaral_undefined_variable`).
- Outcome variables can be compared in the condition (`$e and $failed > 5`).

### Outcome and risk score

- Assign `$risk_score` in every rule. Without it every detection gets the
  instance default (40 when alerting, 15 otherwise) and opentide warns
  (`google_secops_risk_score_missing`). Google's recommended bands: 90–100
  critical, 80–89 high, 50–79 medium, 20–49 low, 1–19 observation.
- `$risk_entity_to_score` (and `$risk_entity_to_score_<suffix>`) attributes risk to
  a specific user or asset instead of every entity in the sampled events.
- With `match`, every event field in `outcome` must be aggregated: `max`, `min`,
  `sum`, `count`, `count_distinct`, `array`, `array_distinct`, `window.*`
  (`yaral_outcome_aggregation`). Write `$risk_score = max(80)` in a multi-event
  rule. `avg`, `stddev`, `earliest`, `latest` are search-only.
- At most 20 outcome variables (`yaral_outcome_limit`): surface the analyst's
  pivots (host, user, command line), not every field.

### Reference lists and data tables

- `in %list`, `in regex %list`, `in cidr %list`; data tables as `%table.column`.
  `in %list` without a column is `yaral_reference_list_deprecated` — prefer data
  tables (see Google's deprecations page for the timeline).
- At most 10 `in` statements per rule (5 `regex`, 5 `cidr`).
- Contents live in the tenant: reviewers cannot see them in the rule. Name the
  list in the description's Exclusion Criteria, and keep exclusions rule-specific.

### Entity graph

Entity variables read `graph.*` (`$g.graph.entity.hostname`,
`$g.graph.metadata.entity_type = "ASSET"`). Filter on
`graph.metadata.entity_type` (and `source_type`: `ENTITY_CONTEXT`,
`DERIVED_CONTEXT`, `GLOBAL_CONTEXT`) the way you filter events on
`metadata.event_type`. A rule built only from entities is refused by Google.

---

## 5. Run state, deploy and state

### Strategy to run state

| Strategy (from `status` via `deployment.toml`) | Google rule deployment |
|---|---|
| `PREVIEW` | `enabled`, `alerting: false` |
| `RELEASE`, `UNIVERSAL` | `enabled`, `alerting: true` |
| `DISABLEMENT` | `enabled: false`, `alerting: false` (even when the new text fails to verify; an archived rule stays archived) |
| `DELETION` | archived (tenant `deletion = "archive"`, default) or deleted without `force` (`deletion = "delete"`) |

Block `alerting` overrides the strategy's default. `run_frequency` is `LIVE`,
`LIVE_CUSTOMIZABLE`, `HOURLY_CUSTOMIZABLE` or `DAILY`; legacy `HOURLY` is refused.
It is sent only when the block names it, so Google's default and legacy schedules
are left alone. `LIVE` is for single-event rules only
(`google_secops_live_frequency_unavailable`, then
`google_secops_run_frequency_not_allowed` at deploy): write `LIVE_CUSTOMIZABLE`.
`schedule` (`ensure_enrichment_completeness`, `late_arriving_data_adjustment`)
applies to the two `_CUSTOMIZABLE` frequencies only.

### Deploy flow

1. Assemble the text; `verifyRuleText` before every create and every changed
   text. A refusal fails the rule before anything is written.
2. **Create**: `POST …/rules`, record the returned `ru_<uuid>` in
   `.opentide/states/deployment/`, then set the run state through
   `rules/{id}/deployment`. A create is never resent after a 5xx or no answer
   (`google_secops_create_unconfirmed`): check the console before rerunning.
3. **Update** a bound rule: read it and its deployment, unarchive if archived, then
   update the text, the data access `scope` and the run state, each only where it
   differs. An unchanged text is not resent, so the rule keeps its revision. An
   `etag` mismatch is `google_secops_rule_conflict`.
4. A bound rule that returns 404 is recreated (`google_secops_rule_recreated`;
   its old detections are not carried over), or forgotten when retiring
   (`google_secops_rule_missing`).

Deploy never lists rules or finds one by name: **commit
`.opentide/states/deployment/`**, or the next run creates a duplicate.

### DELETION semantics

- **Archive** (default): disables, then archives. The binding is kept, so moving
  the rule back to an active status unarchives the same `ru_` id.
- **Delete** (`deletion = "delete"` on the tenant): deletes without `force`, so
  detections are never deleted. Google refuses a non-forced delete of a rule
  with detections or retrohunts; opentide then archives it and keeps the binding
  (`google_secops_delete_refused`).

Tenant settings (`project`, `location`, `instance`, `credentials`,
`data_access_scope`, `deletion`, optional `endpoint`) live in
`.opentide/configurations/platforms/google_secops.toml`, written by
`opentide setup platforms --google-secops`; the bundled file lists the IAM
permissions each command needs.

---

## 6. What each check catches

| Check | Command | Catches |
|---|---|---|
| Block constraints | `opentide validate` | `google_secops_*` constraint codes, `yaral_section_*`, `yaral_match_shape`, `yaral_match_window`, `yaral_option`, duplicate names |
| Offline engine | `opentide validate` and `validate query --platform google_secops` (no `--live`) for errors; `lint --check queries` and the editor for warnings | Parse errors, UDM fields and enum values, functions and arity, scope across sections, windows, outcome aggregation, condition shape, RE2 regexes, reference-list limits. The `yaral_*` warnings (`yaral_unfiltered_event`, `yaral_leading_wildcard_regex`, `yaral_reference_list_deprecated`, `yaral_string_escape`) appear in `lint`, except in opentide 0.28.0 and earlier, which show them only in the editor (`opentide lsp start`, `opentide tui`); `validate` and `lint` report the `google_secops_*` advisories |
| Live compile | `opentide validate query --platform google_secops --live` | Google's compiler through `verifyRuleText` (creates nothing): unjoined event variables, entity-only rules, tumbling-window `or`, the tenant's reference lists and data tables, allowed run frequencies. Diagnostics are mapped back to the section key and line |

The offline engine is an **approximation** (Google publishes no grammar or
compiler): never report an offline pass as a compile. Run `--live` before
`RELEASE` where credentials exist. `.yaral` / `.yl2` files: `opentide validate
query --file`; MCP `validate_query` takes `google_secops`.

---

## 7. Hunting with `opentide query`

`opentide query --platform google_secops` sends a **search** to `udmSearch`
(`queryDialect=YL2`): read-only, saves nothing. A filter returns events; a search
with `match` or `outcome` returns statistics. A truncated result warns.

```yaml
response:
  procedure:
    searches:
      - system: google_secops
        purpose: Blocked logins per user and source address, last day
        query: |
          metadata.event_type = "USER_LOGIN"
          security_result.action = "BLOCK"
          $user = target.user.userid
          $ip = principal.ip
          match:
            $user, $ip
          outcome:
            $attempts = count(metadata.id)
          order:
            $attempts desc
          limit:
            50
```

Search syntax uses bare paths and may hold `order`, `limit`, `dedup`, `select`,
which a rule may not. `--rule` is refused for `google_secops`: a rule runs in the
detection engine, and a retrohunt writes detections. To check a rule against
history, write its search form as a hunt and run that.

---

## 8. Entity alignment across platforms

UDM puts every entity in a **noun** by role, not by field name. Get the role right
before translating a query.

| Concept | UDM | Defender / Sentinel | Splunk CIM | Falcon |
|---|---|---|---|---|
| Acting host | `principal.hostname`, `principal.asset_id` | `DeviceName`, `DeviceId` | `src` / `dest` (by data model) | `ComputerName`, `aid` |
| Acting user | `principal.user.userid` | `AccountName`, `InitiatingProcessAccountName` | `user` / `src_user` | `UserName` |
| Target user (logon) | `target.user.userid` | `AccountName` (`SigninLogs` `UserPrincipalName`) | `user` | `UserName` |
| Network source IP | `principal.ip` | `RemoteIP` (inbound), `IPAddress` | `src_ip` | `RemoteAddressIP4` (inbound) |
| Network destination | `target.ip`, `target.port` | `RemoteIP`, `RemotePort` (outbound) | `dest_ip`, `dest_port` | `RemoteAddressIP4`, `RemotePort` (outbound) |
| Child process | `target.process.*` | `FileName`, `ProcessCommandLine` | `process`, `process_name` | `ImageFileName`, `CommandLine` |
| Parent process | `principal.process.*` | `InitiatingProcess*` | `parent_process` | `ParentBaseFileName` |

Pitfall: **`src` is not the network source.** In UDM `src` is the source object
of an action on two objects (the original file of a copy, and its machine). The
initiator of a connection or logon is `principal`. Which side a parser fills
varies by log type: check with a UDM search before trusting a mapping.

Correlate across platforms at the analyst or SOAR layer, and keep outcome names
consistent (`$host`, `$user`, `$command_line`) so pivots line up.

---

## 9. Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Whole `rule … { }` pasted into `events` | Split into section keys; opentide writes header and meta |
| Plain-scalar `condition: #e > 0` | Block scalar `\|` |
| No `metadata.event_type` filter, or a regex first | Equality on event type first, then equalities, then regexes |
| `$risk_score` missing or constant across every rule | Score by impact, documented in the description |
| Event fields unaggregated in a multi-event `outcome` | `max()`, `array_distinct()`, `count_distinct()` |
| `run_frequency: LIVE` on a multi-event rule | `LIVE_CUSTOMIZABLE` |
| Matching a producer by literal `ru_…` id | `detection.detection.rule_name` |
| 14-day window "to be safe" | Shortest window that holds the behaviour |
| Exclusions buried in an unexplained reference list | Name the list and the reason in the description |
| Using a retrohunt or `--rule` to test | Run the hunt form with `opentide query`, then `--live` |
| `.opentide/states/deployment/` not committed | Commit it; deploy never adopts by name |
| Assuming `src.ip` is the attacker | `principal.ip` |

---

## 10. Authoring checklist

- [ ] Rule versus search decided; single- or multi-event decided.
- [ ] Block keys checked against the resolved schema, not memory.
- [ ] Sections only, each a `|` block scalar; no header, labels or aliases.
- [ ] Every event variable filtered on `metadata.event_type` (or log type / product) first.
- [ ] UDM paths and enum values confirmed by the engine (hover, completion or `validate`).
- [ ] Joins use placeholders; empty-value joins guarded.
- [ ] `match` present for two or more event variables; window as short as the behaviour allows.
- [ ] Condition counts (`#e`) and non-existence shape correct.
- [ ] `$risk_score` assigned and justified; `$risk_entity_to_score` set when the risky entity is clear.
- [ ] Multi-event outcomes aggregated; at most 20 outcomes.
- [ ] `run_frequency` only when needed, `LIVE` only for single-event rules.
- [ ] `name` unique (ignoring case) if composites will consume it.
- [ ] `opentide validate` clean, and every `yaral_*` warning and `google_secops_*` advisory resolved or understood (`lint --check queries`, or the editor on opentide 0.28.0).
- [ ] `validate query --platform google_secops --live` run before `RELEASE` where credentials exist.
- [ ] A `system: google_secops` hunt in `response.procedure.searches` for analyst pivots.
- [ ] Tenant `deletion` choice understood before setting a status that maps to `DELETION`.
- [ ] `.opentide/states/deployment/` committed after deploy.

---

## 11. Vendor references

For syntax not covered here, or any doubt about a limit, go to Google's pages under
`docs.cloud.google.com/chronicle/docs/`: `yara-l/…` (section syntax, functions,
repeated fields, reference lists), `reference/udm-field-list`,
`detection/run-frequency`, `detection/yara-l-best-practices`. Community rules:
`chronicle/detection-rules` on GitHub. The engine and `verifyRuleText` outrank this skill.
