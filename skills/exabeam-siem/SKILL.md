---
name: exabeam-siem
description: >-
  Exabeam New-Scale SIEM detection engineering for opentide: correlation rules as configurations.exabeam
  blocks (sequences, any-match and threshold conditions, group-by, correlation windows, suppression,
  delay, schedule, outcomes, test mode), Exabeam Query Language filter idioms and pitfalls (not Elastic
  EQL), the engine's rule and search profiles, Common Information Model fields and context tables, and
  how opentide deploys (name check that refuses rather than adopts, 100-a-minute pacing, lower-case rule
  UUID in deployment state), what validate query --live checks and opentide query. Use when authoring
  or reviewing Exabeam-keyed detection rules, Exabeam hunts or .exabeam files, or translating a
  detection from another SIEM to Exabeam.
---

# Exabeam New-Scale SIEM: correlation rules

This skill encodes operational context for `configurations.exabeam` blocks in opentide detection
rules (`platform::exabeam::1.0`, "Exabeam New-Scale SIEM correlation rule"), and for `system: exabeam`
hunts. One block is one Exabeam **correlation rule** on the New-Scale Security Operations Platform.

> **Pair with**: `opentide-rule` (the rule object, description, response), `detection-engineering`
> (hunt-to-rule lifecycle), `windows-event-logs` and the identity skills (what the events mean),
> `mitre-attack` (technique mapping).

> **"EQL" is ambiguous.** Exabeam's guides call their search language "EQL", the Exabeam Query
> Language. Elastic's Event Query Language is also "EQL", and `eql` in opentide means Elastic's. Say
> "Exabeam Query Language"; opentide's language id is `exabeam`. Elastic EQL syntax (`process where
> …`, `sequence by …`) means nothing to Exabeam.

---

## 1. Resolve the structure from the engine, not from this skill

The block's fields, enums and limits are versioned with opentide and change without this skill
changing. Do not copy a field table from here or from memory. Resolve it, stopping at the first that
answers:

1. **MCP**: `opentide://schemas/rule` (the `configurations.exabeam` sub-schema), `opentide://platforms`
   for capabilities, `opentide://templates/rule` for the commented template.
2. **CLI**: `opentide --json info --platform exabeam`; `.opentide/schemas/` and `.opentide/templates/`
   in the repository (`opentide generate` when empty); `opentide new rule --name "…" --platform exabeam
   --objective <uuid>` starts a file from the template.
3. **Validators**: `opentide validate` (block constraints, the `exabeam_*` codes), `opentide validate
   query` (the language), `opentide lint`. A validator's finding outranks anything written here.

Run `opentide explain <code>` when a code is unfamiliar rather than guessing the fix.

What follows is the part the schema does not tell you: what each concept means on Exabeam, and what
separates a rule that works from one that only validates.

---

## 2. Surface map

| Surface | What it is | opentide's relation |
|---|---|---|
| **Correlation Rules** | Rules of one or more *sequences*: a filter plus a condition, correlated within a window | **Deployed** from `configurations.exabeam` |
| **Search** | Ad-hoc and API search over ingested events (`POST /search/v2/events`) | `validate query --live` checks each sequence filter here; `opentide query` runs hunts here |
| **Context tables** (Context Management) | Tenant lookup tables (`user IN "Privileged Accounts"`) | Referenced by name from queries; never created or synced by opentide |
| **Threat Center** | Where alerts and cases land for triage | The `outcome` of a deployed rule: `alert` (default) or `case` |
| **Advanced Analytics** | Behavioural analytics (UEBA): models and anomaly scoring | **Not** deployed by opentide. Correlation rules "supplement behaviour analytics" in Exabeam's words; they do not replace them |
| **Common Information Model (CIM)** | Exabeam's normalised field set, `activity_type` and `subject` values | The engine's field catalogue (ExabeamLabs/CIMLibrary) |

Decide first whether the behaviour is a **known pattern** (correlation rule: deterministic, versioned,
reviewable here) or a **deviation from baseline** (Advanced Analytics: configured in Exabeam, not
expressible as a block). Do not emulate UEBA with a hand-tuned threshold.

---

## 3. Anatomy of a correlation rule

### Sequences and conditions

A block holds one or more `sequences`, written **in the order the events happen**. Each sequence is a
**filter** (an Exabeam Query Language query under the `rule` profile) and a **condition**:

| Condition | Written as | Meaning |
|---|---|---|
| Any match | no `threshold` | Every matching event satisfies the sequence |
| Threshold | `threshold` with a function, an operator, a value and a window (`within`) | `count` (events, or a field's values), `unique_count`, `max`, `min`, `sum`, `average` compare with `more_than`/`less_than` and a number (`count` and `unique_count`: a non-negative integer). `value` compares with `in`/`not_in` and a non-empty list, and takes nothing else |

`group_by` on a sequence (one to three fields) evaluates the threshold **per value**. It does **not**
de-duplicate triggers: an any-match sequence still triggers on every matching event. To trigger once
per value, also set `suppression.group_by` to the same fields (Exabeam's granular suppression).

### Correlation and timing

Two or more sequences need `correlation` (a window, `within`, and optionally up to three fields every
sequence shares); one sequence must not have it (`exabeam_correlation`). Exabeam evaluates ordered
sequences with a one-minute step: it waits a minute before the next sequence, and an any-match
sequence after the first looks at events for one minute. So the window must be **more than**:

> sum of each sequence's `threshold.within` (1 minute for an any-match sequence) + 1 minute per
> sequence after the first

A window no longer than that earns the `exabeam_correlation_window` warning: the rule can never
trigger. Example: a 5-minute threshold then an any-match sequence needs more than 5 + 1 + 1 = 7
minutes; `30m` is fine.

### Response settings

| Concept | What to know |
|---|---|
| `outcome` | `alert` (Threat Center alert, the default), `case`, or `none`. `none` with no `email` only writes a rule-trigger event nobody is told about (`exabeam_outcome_silent`) |
| `email` | Optional extra notification, alongside the outcome |
| `suppression` | Suppress repeated triggers for a duration (`w` allowed here), optionally per field values |
| `delay` | Evaluation delay, 7 to 180 minutes; raise it for late-arriving sources rather than widening windows |
| `schedule` | Active hours, in **UTC**; omitted means always active |
| `test_mode` | The rule triggers and writes a `rule-trigger-test` event, with no outcome. Defaults to the tenant's `test_mode`, so a staging tenant can set it once |
| `severity` | `none` to `critical`; when omitted it is derived from `response.alert_severity` (`Informational` becomes `none`) |
| `name` | The Exabeam rule name, at most 128 characters; defaults to the opentide rule name |

Durations everywhere are a whole number and one unit, no spaces: `30m`, `4h`, `1d` (`2w` only in
`suppression`). Compound or ISO 8601 forms (`1h30m`, `PT1H`) fail `exabeam_duration`.

### Worked block

A brute-force-then-success rule, per source address. Every query here passes the engine cleanly.

```yaml
configurations:
  exabeam:
    enabled: true
    schema: platform::exabeam::1.0
    status: STAGING
    outcome: case
    sequences:
      - name: Burst of failed logins from outside
        query: |
          activity_type:"app-login" AND outcome:"fail"
          AND NOT src_ip:[10.0.0.0/8] AND NOT src_ip:[172.16.0.0/12] AND NOT src_ip:[192.168.0.0/16]
        group_by: [src_ip]
        threshold:
          function: count
          operator: more_than
          value: 10
          within: 5m
      - name: Then a successful login from the same address
        query: |
          activity_type:"app-login" AND outcome:"success"
          AND NOT src_ip:[10.0.0.0/8] AND NOT src_ip:[172.16.0.0/12] AND NOT src_ip:[192.168.0.0/16]
        group_by: [src_ip]
    correlation:
      within: 30m
      group_by: [src_ip]
    suppression:
      for: 1h
      group_by: [src_ip]
```

Confirm the structure against the schema you resolved in section 1 before copying it.

---

## 4. Exabeam Query Language: filter idioms

A sequence query is a **filter**: field terms combined with `AND`, `OR`, `NOT` and parentheses.

| Intent | Write | Not |
|---|---|---|
| Exact value | `process_name:"cmd.exe"` (double-quoted) | `process_name:cmd.exe` (`exabeam_unquoted_value`) |
| One of several | `process_name:("powershell.exe", "pwsh.exe")` | `process_name IN (…)` |
| Exclude | `AND NOT user:"svc_backup"` | `user != "…"` (`exabeam_not_equal`); a bare `NOT` with no `AND`/`OR` before it (`exabeam_implicit_operator`) |
| Field present | `NOT process_command_line:null` | `exists(…)` |
| Contains / wildcard | `process_path:WLDi("*\\appdata\\local\\temp\\*")` | `contains(…)`, `LIKE(…)` (`exabeam_unknown_function`); a SQL-style `field LIKE "…"` is not reported at all, so never write it |
| Regular expression | `url:RGXi("\\.(aspx|php)$")` | a value between slashes, `url:"/adm.n/"` (`exabeam_legacy_regex`); look-around or back-references (not RE2, `exabeam_regex`) |
| Number comparison | `bytes_out:>1000000`, `dest_port:[1 TO 1023]` | a comparison on a string field |
| String field holding digits | `event_code:("4625", "4771")` | `event_code:4625` (`exabeam_string_field_number`) |
| IPv4 network | `src_ip:[10.0.0.0/8]` or `dest_ip:[192.168.10.0 TO 192.168.10.255]` | IPv6 ranges or CIDR (`exabeam_ipv6_range`: IPv4 only) |
| Time | `time:[2026-11-01T00:00:00Z TO *]` | `time:"…"`: time fields take a range only (`exabeam_time_exact`) |
| Context table | `user IN "Privileged Accounts"`, `NOT src_host IN "Jump Hosts"."Hostname"` | under `OR` (`exabeam_context_table_or`), more than two per query |

Further rules the engine enforces:

- **Functions**: `RGX` and `WLD` are case-sensitive, `RGXi` and `WLDi` case-insensitive. Each takes one
  double-quoted pattern. Foreign functions get a hint naming the Exabeam form.
- **Patterns are RE2**, read from the string's value: `\\` in the query is one backslash in the pattern.
  Single-backslash escapes (`\s`, `\.`) mean the same either way; prefer them where they suffice.
- **Wildcards do not expand inside a quoted phrase with a space** (`"* -enc *"`,
  `exabeam_wildcard_in_phrase`): use `WLDi("* -enc *")`.
- **Parenthesise mixed `AND`/`OR`.** Exabeam does not document precedence (`exabeam_mixed_boolean`),
  and parentheses around a single expression are an error in Exabeam's guide (`exabeam_single_group`).
- **Context-table sequences trigger on any match.** A sequence whose query looks a value up in a
  context table cannot have a `threshold` (`exabeam_context_table_trigger`).

### Fields and values come from the CIM

Use CIM field names: `user`, `src_ip`, `dest_ip`, `src_host`, `dest_host`, `host`, `process_name`,
`parent_process_name`, `process_command_line`, `process_path`, `activity_type`, `subject`, `outcome`.
The editor (`opentide lsp`) completes and hovers them. Two limits of the offline check:

- An unknown field is only a **warning** (`exabeam_unknown_field`, with a near-miss suggestion),
  because a tenant's parsers may define fields. `c_` (custom) and `m_` (metadata) fields are accepted.
  Treat the warning as a typo until proven otherwise.
- **`activity_type`, `subject` and `outcome` values are checked only by newer releases.** opentide
  0.28.0 (engine 0.16.0) does not check them: a misspelt value passes silently. A release whose
  engine has the CIM value check reports it as the warning `exabeam_unknown_value` in `opentide lint`
  and the editor, with a near-miss suggestion.
  `activity_type:"network-connection"` is not a CIM activity type (the CIM has `network-traffic`,
  `network-session`, and others). Confirm each value through the editor's completion or hover, or
  against events in Search, before relying on it. `activity_type` is `<subject>-<activity>`: `process-create`,
  `app-login`, `registry-modify`, `dns-request`.
- Field names in `group_by`, `threshold.field`, `suppression.group_by` and `correlation.group_by`
  are not catalogue-checked either. Check them as carefully as the query.

---

## 5. Profiles: `rule` versus `search`

The engine checks the `exabeam` language under one of two profiles:

| Profile | Applies to | Accepts |
|---|---|---|
| `rule` | `configurations.exabeam.sequences[].query` | The filter only |
| `search` | `response.procedure.searches[]` with `system: exabeam`; `.exabeam` files | The filter plus the advanced operators: `SELECT`, `FROM`, `WHERE`, `AS`, `GROUP-BY`, `ORDER-BY`, `LIMIT`, pipes, `FOREACH`, aggregations, `RGX_EXTRACT` |

A `SELECT … GROUP-BY` in a sequence is `exabeam_advanced_in_rule`: aggregation in a rule belongs in the
sequence's `threshold` and `group_by`, not in the query. Hunts are where the advanced form fits:

```text
SELECT user, src_ip, COUNT(*) AS failures
WHERE activity_type:"app-login" AND outcome:"fail"
GROUP-BY user, src_ip
ORDER-BY failures DESC
LIMIT 50
```

Search-profile rules: clauses in the order `SELECT FROM WHERE AS GROUP-BY ORDER-BY LIMIT`
(`exabeam_clause_order`); keywords all upper or all lower case (`Group-By` is `exabeam_keyword_case`);
every selected column grouped or aggregated (`exabeam_group_by_column`); `GROUP-BY` is one hyphenated
word; at most five pipes and three `RGX_EXTRACT`; an `AS` name is not a reserved word.

---

## 6. How opentide compiles and deploys

Deploy derives part of the rule; know what you do not control:

- **Name**: the block's `name`, else the rule's `name`. Two enabled blocks resolving to the same name
  (case-insensitive) fail `validate` with `exabeam_name_duplicate`.
- **Description**: the rule's `description` with **all whitespace collapsed to single spaces**, then an
  `ATT&CK:` line from the rule's techniques and an `opentide: <uuid>` marker. Markdown headings and lists
  in the opentide description arrive in Exabeam as one paragraph; write the first sentence so it stands
  alone in a console list.
- **Severity**: as in section 3.

The lifecycle, through the Correlation Rules API (`/correlation-rules/v2/rules`):

| Situation | What deploy does |
|---|---|
| No binding in `.opentide/states/deployment/` | Checks the name is free (`nameContains`, then an exact case-insensitive compare). A rule of that name **fails** the create (`exabeam_name_conflict`): deploy **never adopts** a console rule, by name or by the `opentide:` marker. Rename the block or remove the other rule |
| Create succeeds | Stores the returned rule id, **lower-cased canonical UUID**, in the deployment-state shard. Any other spelling in a shard is `deployment_state_shape` |
| Create gets no answer or a `5xx` | **Never resent** (`exabeam_create_unconfirmed`): the rule may exist. Find it in the console; delete it, or record its id in the shard deliberately |
| Update | `PUT` with the **whole** rule every time: edits made in the console are overwritten |
| `DISABLEMENT` strategy | The same `PUT` with `enabled: false` |
| Bound rule gone (`404`) | Created again (`exabeam_rule_recreated`), or the id dropped under `DISABLEMENT` |
| Removing `schedule` from a block | The `PUT` may leave the old schedule on the rule: `exabeam_schedule_retained` asks you to clear it in the console |
| Exabeam stopped the rule | `exabeam_rule_auto_disabled`. Exabeam disables a rule whose sequences match more than 500 times, or that triggers more than 50 times, in five minutes, or whose query or context table is broken. Tighten the filter; do not just redeploy |

All Exabeam requests in a run share one pacer, **100 a minute across every Exabeam tenant** (Exabeam's
limit is per source IP), and a `429` is waited out. A large first deploy is slow by design. A `401`
or `403` stops the tenant (`exabeam_tenant_unauthorized`), a `409` means the subscription lacks the
feature (`exabeam_feature_unavailable`).

Tenants live in `.opentide/configurations/platforms/exabeam.toml` (`opentide setup platforms
--exabeam`): a `region` (required; calls go to `https://api.<region>.exabeam.cloud`), an optional
`api_url` that replaces that base URL, `client_id` and `client_secret` as `$VAR`s, and an optional tenant `test_mode`. Run `opentide deploy
--dry-run` first: it shows the exact create request per tenant.

---

## 7. What `--live` checks, and `opentide query`

`opentide validate query --platform exabeam --live` sends **each sequence filter** to Search as the
`filter` of `POST /search/v2/events`, one row over the last 15 minutes (the console's "Test Last 15
mins"). A `200` passes, a `400` fails with Exabeam's message, and anything else is an error, never a
pass. It proves the tenant **parses** the filter, nothing more:

- It does **not** check the condition, windows, grouping, correlation or outcomes: no Exabeam API
  previews a rule. Those are checked offline only.
- Zero rows is still a pass. A filter on a misspelt `activity_type` value parses and matches nothing.
  Read the row count, and run the filter over a longer window with `opentide query` before promoting.

`opentide query --platform exabeam` runs a query through the same Search API, read-only, at most 3,000
rows (`--limit` is capped with a warning). `--rule <uuid>` or `--file <path>` runs each sequence's
filter as its own result, without the condition or correlation, and says so for a sequence with a
`threshold` or `group_by`. Both need an API key with
**Search, Analyze and Export**. The search is synchronous with no cancel: a search that outlives
`--timeout` is abandoned by closing the connection.

Offline checks run everywhere with no tenant: `opentide validate`, `opentide validate query
--platform exabeam`, `opentide lint`, and the editor. An engine that lacks the `exabeam` language fails
the check as `engine_unavailable`, never as a pass.

---

## 8. Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Calling it "EQL" in a rule, ticket or hunt label | "Exabeam Query Language"; `eql` is Elastic's |
| `SELECT`/`GROUP-BY` in a sequence query | Move the aggregation into `threshold` and `group_by` |
| Relying on sequence `group_by` to stop duplicate alerts | Add `suppression.group_by` with the same fields |
| Correlation window equal to the sum of the sequence windows | Make it strictly more, including a minute per step |
| Context-table lookup with a threshold, or under `OR` | Any-match only; combine lookups with `AND` / `AND NOT` |
| Unquoted digits on string fields (`event_code:4625`) | Quote them |
| Trusting a clean offline check for `activity_type` values | Confirm the value in the CIM or in Search |
| Editing a deployed rule in the console | Edit the block; the next `PUT` overwrites console edits |
| Creating a rule in the console with the name a block will use | Expect `exabeam_name_conflict`; one owner per name |
| Resending after `exabeam_create_unconfirmed` | Check the console first; a duplicate is worse than a delay |
| `outcome: none` with no `email` in production | Use `test_mode` while staging, then a real outcome |
| Schedules written in local time | `schedule` times are UTC (`08:00Z`) |
| Very broad any-match sequence (`activity_type:"process-create"` alone) | Exabeam auto-disables noisy rules; narrow the filter |
| Emulating behavioural baselines with thresholds | That is Advanced Analytics' job, outside opentide |

---

## 9. Entity alignment across platforms

When an objective's signal is implemented on Exabeam and on other platforms, keep the entity fields
equivalent so analysts and correlation pivot cleanly. Exabeam names are CIM fields after parsing; the
source field depends on the tenant's parser, so confirm in Search.

| Concept | Exabeam CIM | Microsoft Defender | Sentinel (typical) | Splunk CIM |
|---|---|---|---|---|
| User | `user`, `user_upn`, `user_sid` | `AccountName`, `AccountUpn`, `AccountSid` | `UserPrincipalName`, `Account` | `user` |
| Host | `host`, `src_host`, `dest_host` | `DeviceName` | `Computer` | `dest`, `src` |
| Network | `src_ip`, `dest_ip`, `dest_port` | `LocalIP`, `RemoteIP`, `RemotePort` | `IPAddress` | `src_ip`, `dest_ip`, `dest_port` |
| Process | `process_name`, `process_command_line`, `parent_process_name` | `FileName`, `ProcessCommandLine`, `InitiatingProcessFileName` | n/a (table-specific) | `process_name`, `process`, `parent_process_name` |
| File hash | `hash_sha256` | `SHA256` | `FileHash` | `file_hash` |

Use the same fields in `group_by`, `correlation.group_by` and `suppression.group_by` that the hunt in
`response.procedure.searches` pivots on, so the analyst's first search lands on the alert's entity.

---

## 10. Authoring checklist

- [ ] The behaviour is a known pattern (correlation rule), not a baseline deviation (Advanced Analytics).
- [ ] Block structure resolved from the installed schema or template, not from memory.
- [ ] Each sequence query is a filter (`rule` profile): no `SELECT`, `WHERE` or pipes.
- [ ] String values double-quoted, digits on string fields quoted, mixed `AND`/`OR` parenthesised.
- [ ] Fields are CIM names; any `exabeam_unknown_field` warning explained or fixed.
- [ ] Every `activity_type`, `subject` and `outcome` value confirmed against the CIM or Search.
- [ ] Field names in `group_by`, `threshold.field`, `suppression.group_by` and `correlation.group_by` checked by hand.
- [ ] Context-table sequences have no threshold; the tables exist on every target tenant.
- [ ] `correlation.within` exceeds the sequence windows plus a minute per step.
- [ ] Granular suppression set when triggers should be once per entity.
- [ ] `outcome` deliberate; `test_mode` used for staging rather than `outcome: none`.
- [ ] Exabeam rule name at most 128 characters, unique among enabled blocks and on the tenant.
- [ ] Description's first sentence reads well collapsed to one line.
- [ ] `opentide validate` and `opentide lint` clean (`lint` reports the `exabeam_*` warnings;
      `validate` reports errors only); `--live` passed and the
      filter returned rows over a realistic window with `opentide query`.
- [ ] `opentide deploy --dry-run` reviewed before the first real deploy.

---

## 11. When unsure

Exabeam publishes no grammar. opentide's engine follows the exabeam-1.0 language specification and
its reference checker, which agree with Exabeam's own published correlation rules; the only true
oracle is a tenant's Search API. If a construct is not covered here and the engine rejects or does not
know it, check Exabeam's Search and Correlation Rules documentation on docs.exabeam.com and test it in
Search. Never invent syntax to get past a diagnostic.
