---
name: microsoft-defender
description: Microsoft Defender XDR advanced hunting and custom detection rules — Device*/Email*/Identity* table schemas, Timestamp discipline, ProcessUniqueId vs PID for temporal joins, FileProfile() prevalence enrichment, AdditionalFields parsing, required output columns, NRT constraints, and the opentide configurations.microsoft_defender block on the Microsoft Graph beta custom detection API (schedule frequency and lookback, alert template, entity mappings, automated actions, device-group scope, incident correlation, exclusions, uuid-addressed deploy). Always pair with kusto-query-language for language-level optimisation. Use for configurations.microsoft_defender blocks in opentide detection rules and Defender-first hypotheses.
---

# Microsoft Defender — advanced hunting and custom detection rules

Author and review KQL for Microsoft Defender XDR advanced hunting, and the opentide `configurations.microsoft_defender` block that deploys it as a custom detection rule. This skill covers Defender-native tables, operational specifics and the block; for identity/cloud/SaaS/network telemetry use **`microsoft-sentinel`**; for vendor-neutral KQL optimisation use **`kusto-query-language`**.
---

## 1. When to use Defender vs Sentinel

| Telemetry domain | Platform | Primary tables |
|---|---|---|
| Endpoint processes / file ops / registry | **Defender** | `DeviceProcessEvents`, `DeviceFileEvents`, `DeviceRegistryEvents` |
| Device-level network connections | **Defender** | `DeviceNetworkEvents`, `DeviceNetworkInfo` |
| Email (M365 Defender) | **Defender** | `EmailEvents`, `EmailUrlInfo`, `EmailAttachmentInfo`, `EmailPostDeliveryEvents` |
| Device inventory & compliance | **Defender** | `DeviceInfo`, `DeviceLogonEvents` |
| DLL / module loads | **Defender** | `DeviceImageLoadEvents` |
| Scheduled tasks, WMI, misc events | **Defender** | `DeviceEvents` |
| Code-signing validation | **Defender** | `DeviceFileCertificateInfo` |
| URL clicks (M365) | **Defender** | `UrlClickEvents` |
| Identity & authentication | **Sentinel** | `SigninLogs`, `AuditLogs` |
| Azure / cloud infrastructure | **Sentinel** | `AzureActivity`, `AzureDiagnostics` |
| SaaS activity | **Sentinel** | `OfficeActivity`, `CloudAppEvents` |
| Network appliances | **Sentinel** | `CommonSecurityLog`, `Syslog` |

**Cross-platform hypotheses** (e.g., credential phishing → endpoint execution): generate **separate queries per platform** with the correct platform tag. Do not attempt cross-platform joins.

---

## 2. Column authority — non-negotiable

> The tenant-specific table schema reference (typically `references/MDE-Tables.md` in your content repo) is the **only** source of truth for Defender table columns. Do not invent, guess, or recall column names from memory — always look them up.

### Procedure
1. Open the tenant's table reference.
2. Find the target table and confirm the column appears in its key columns.

### Critical Defender ↔ Sentinel column differences

Wrong column = guaranteed `SYNTAX_ERROR`. Common contamination traps:

| Concept | Defender column | Sentinel column |
|---|---|---|
| Timestamp | `Timestamp` | `TimeGenerated` |
| Device identifier | `DeviceId` (UUID) | `Computer` (hostname) |
| User account | `AccountName` | `SubjectUserName` / `TargetUserName` |
| User principal | `AccountUpn` | `UserPrincipalName` |
| Process command line | `ProcessCommandLine` | `CommandLine` |
| Source IP | `RemoteIP` | `IpAddress` / `CallerIpAddress` |

**Do not copy Sentinel column names into Defender queries.** Each table within Defender also has its own column subset — `AccountUpn` exists in `DeviceProcessEvents` but **not** in `DeviceNetworkEvents` (use `InitiatingProcessAccountName` there).

---

## 3. Authoring KQL for Defender

> For language-level optimisation, see **`kusto-query-language/SKILL.md`**.

### From hypothesis to queries

**Step 1 — decompose** the hypothesis into discrete observable telemetry events. Each step that produces telemetry in a different table becomes a separate query.

**Step 2 — select tables** by behaviour:

| Behaviour | Primary table |
|---|---|
| Process execution, command lines | `DeviceProcessEvents` |
| File creation/modification/deletion | `DeviceFileEvents` |
| Network connections (device-level) | `DeviceNetworkEvents` |
| DLL / module loads | `DeviceImageLoadEvents` |
| Registry changes | `DeviceRegistryEvents` |
| Logon activity (device) | `DeviceLogonEvents` |
| Scheduled tasks, WMI, named pipes, etc. | `DeviceEvents` |
| Email delivery | `EmailEvents` (+ joins) |
| Code-signing validation | `DeviceFileCertificateInfo` |

**Step 3 — query body** with the mandatory header from `kusto-query-language`:

```kql
// ============================================================
// Hunt: <name>
// Purpose: <one-line description>
// Source intelligence: <reference>
// MITRE ATT&CK: <technique id - name>
// Platform: DEFENDER
// Precision: HIGH/MEDIUM/LOW | Recall risk: HIGH/MEDIUM/LOW
// ============================================================

let lookback = ago(30d);
let target_values = dynamic([...]);

DeviceProcessEvents
| where Timestamp > lookback
| where FileName in~ ("target.exe")
| where ProcessCommandLine has_any (target_values)
| where not(condition)  // exclusion explained
| project Timestamp, DeviceName, AccountName, FileName, ProcessCommandLine
| order by Timestamp desc
```

### Defender-specific optimisation

- Pre-filter `ProcessCommandLine` with `has_any` **before** `parse`/`extract`/`matches regex` — 10–100× faster on this high-cardinality column.
- Use `invoke FileProfile(SHA1, 1000)` **after** other filters to minimise enrichment lookups.
- Parse `AdditionalFields` with `parse_json()` only **after** filtering on `ActionType` — avoids parsing millions of irrelevant rows.

---

## 4. Multi-query correlation patterns

Thirteen worked correlation patterns live in [references/Multi-Query-Correlation-Patterns.md](references/Multi-Query-Correlation-Patterns.md) — sequential process to network, temporal joins, statistical anomaly, beaconing, prevalence hunting, baseline deviation, process-chain reconstruction, `materialize()` multi-stage, `leftanti` exclusion chains, DGA domains, certificate supply chain, multi-technique union, and named-pipe C2.

Load that file when you need a runnable query for one of these shapes. Read the pattern that matches the hypothesis rather than the whole file.

## 5. `AdditionalFields` parsing

Many `DeviceEvents` `ActionType`s store structured data in the `AdditionalFields` JSON column. Always parse:

```kql
| extend ParsedFields = parse_json(AdditionalFields)
| extend FieldValue = tostring(ParsedFields.FieldName)
```

Key action types with `AdditionalFields`:

| ActionType | Common fields |
|---|---|
| `NamedPipeEvent` | `PipeName`, `NamedPipeEnd` |
| `DnsQueryResponse` | `DnsQueryString`, `DnsQueryType` |
| `ServiceInstalled` | `ServiceName`, `ServiceType` |
| `PowerShellCommand` | `Command`, `ScriptBlockText` |

Always filter on `ActionType` first; only then parse `AdditionalFields` to avoid expensive parsing across the full table.

---

## 6. False-positive engineering for Defender

```kql
// Tuning thresholds with guidance
let threshold_connections = 50;     // Default 50 — lower for sensitive segments, raise for noisy networks
let threshold_unique_targets = 10;
let lookback = ago(7d);

// Environment filters
// --- BEGIN ENVIRONMENT FILTERS (customise per deployment) ---
| where DeviceName !startswith "SCAN-"            // exclude vulnerability scanners
| where AccountName !in~ ("svc_monitoring")       // exclude service accounts
// --- END ENVIRONMENT FILTERS ---

// Alert dedup via AlertInfo leftanti
| join kind=leftanti (
    AlertInfo
    | where Timestamp > ago(7d)
    | where Title has "related alert title"
    | project DeviceId
) on DeviceId

// net.exe / net1.exe deduplication: Windows maps net.exe to net1.exe internally
| where not(FileName =~ "net1.exe" and InitiatingProcessFileName =~ "net.exe")
```

---

## 7. Custom detection rules (Defender)

> Detection rule design is covered in `detection-engineering/SKILL.md`. This section lists Defender-specific query constraints; §10 is the opentide block that carries them.

### Required output columns

Custom detection rules in Defender XDR enforce specific columns. Missing required columns → rule creation fails (unlike hunting queries where output columns are flexible). `opentide validate --live` fails such a query before deploy.

**Endpoint tables** (`DeviceProcessEvents`, `DeviceFileEvents`, `DeviceNetworkEvents`, `DeviceRegistryEvents`, etc.):

| Column | Required | Purpose |
|---|---|---|
| `Timestamp` | YES | Alert timestamp |
| `DeviceId` | YES | Maps alert to device entity |
| `ReportId` | YES | Event deduplication |

**Non-endpoint tables** (`EmailEvents`, `IdentityLogonEvents`, etc.):

| Column | Required | Purpose |
|---|---|---|
| `Timestamp` | YES | Alert timestamp |
| `ReportId` | YES | Event deduplication |

Detection rule queries MUST include these in `| project`, plus every column the block's `entities`, `actions` and `alert.custom_details` name. Hunting queries don't — but detection rules enforce the schema.

### Lookback is the engine's

The detection engine reads each run's window from the rule's schedule (`schedule.frequency`, and `schedule.lookback` when set). **Do not** add explicit `Timestamp > ago()` filters to detection rule queries.

### NRT constraints

NRT (`schedule.frequency: NRT`, sent as `PT0S`) runs continuously but is strictly limited:

| Constraint | Detail |
|---|---|
| Single table only | No `join`, `union`, multi-table references |
| No KQL comments | `//` comments cause NRT compilation errors |
| No `externaldata()` | External references unsupported |
| No `lookback` | opentide rejects `schedule.lookback` with `NRT` (`microsoft_defender_lookback`) |

**NRT-supported tables**:

| Category | Tables |
|---|---|
| Endpoint | `DeviceProcessEvents`, `DeviceNetworkEvents`, `DeviceFileEvents`, `DeviceRegistryEvents`, `DeviceLogonEvents`, `DeviceImageLoadEvents`, `DeviceEvents` |
| Email | `EmailEvents`, `EmailUrlInfo`, `EmailAttachmentInfo`, `EmailPostDeliveryEvents` |
| Identity / Cloud | `CloudAppEvents`, `IdentityLogonEvents`, `IdentityDirectoryEvents` |

**NRT example**:

```kql
DeviceProcessEvents
| where FileName in~ ("certutil.exe", "bitsadmin.exe")
| where ProcessCommandLine has_any ("-urlcache", "-decode", "/transfer")
| project Timestamp, DeviceId, ReportId, DeviceName, AccountName,
    FileName, ProcessCommandLine, InitiatingProcessFileName
```

No comments, no joins, no explicit time filter — the NRT engine manages all of this.

### Entity columns

Project the columns an entity needs to resolve, then map them in `entities` (§10). Typical columns from the Defender for Endpoint tables:

| Entity (`entities.<kind>`) | Typical columns |
|---|---|
| `hosts` | `DeviceId`, `DeviceName` |
| `accounts` | `AccountSid`, `AccountName`, `AccountDomain`, `AccountUpn`, `AccountObjectId` |
| `files` | `FileName`, `SHA1`, `SHA256` |
| `processes` | `InitiatingProcessSHA1`, `InitiatingProcessSHA256` |
| `ips` | `RemoteIP` (`RemoteIPType` as `scope`) |
| `urls` | `RemoteUrl` |
| `mailboxes`, `mail_messages` | `RecipientEmailAddress`, `NetworkMessageId`, `SenderFromAddress` |

Graph does not say which fields a mapping needs to resolve an entity; map every identifying column the query returns.

### Automated actions — conservative defaults

Start new detections with `initiate_investigations` (or no action). Reserve `isolate_devices`, `stop_and_quarantine_files`, `disable_users` and the email deletions for high-confidence, critical rules, and escalate only after the rule has been stable in production. Never allow and block the same file in one rule.

### Alert limits

- Max **150 alerts per rule run**. Excess results are dropped silently — design queries to stay below.
- Duplicate handling: rows with the same `ReportId` + `Timestamp` as an existing alert are deduplicated automatically.

### Detection query template

```kql
// Detection: <Detection Name>
// Frequency: <schedule.frequency> | NRT
// MITRE: <Technique ID - Technique Name>
// Entities: hosts (DeviceId, DeviceName), accounts (AccountSid, AccountName)
DeviceProcessEvents
| where /* filters — no explicit time filter, engine manages lookback */
| where /* additional behavioural filters */
| where not(/* false-positive exclusions */)
| project Timestamp, DeviceId, ReportId, DeviceName, AccountName, AccountSid,
    FileName, ProcessCommandLine, FolderPath,
    InitiatingProcessFileName, InitiatingProcessCommandLine
```

Drop the comment header for an NRT rule.

---

## 8. Quality checklist — Defender-specific

> Reject-list companion: [references/Anti-Patterns.md](references/Anti-Patterns.md) catalogues the query anti-patterns this checklist is meant to catch. Consult it when reviewing someone else's query.

> Language-level checks live in `kusto-query-language/SKILL.md`.

- [ ] Platform tag set to **DEFENDER**.
- [ ] Table exists in tenant (verified against tenant table reference).
- [ ] Time field is `Timestamp` (not `TimeGenerated`).
- [ ] No Sentinel column contamination (`TimeGenerated`, `UserPrincipalName`, `Computer` should not appear in Defender queries).
- [ ] Detection rules include mandatory output columns: `Timestamp`, `DeviceId`, `ReportId`.
- [ ] NRT rules: single table, no comments, no joins.
- [ ] `materialize()` used when subquery referenced 2+ times.
- [ ] `AdditionalFields` parsed via `parse_json()` after `ActionType` filter.
- [ ] `FileProfile()` results handle `isempty()` for missing prevalence.
- [ ] Multi-table joins time-windowed; PIDs replaced with `*UniqueId` where applicable.
- [ ] `configurations.microsoft_defender` sets `query` and `schedule.frequency`; no `lookback` with `NRT`, none shorter than `frequency`.
- [ ] Every column named in `entities`, `actions` and `alert.custom_details` is projected, in the query's spelling.
- [ ] At least one entity mapped (no `microsoft_defender_no_entities` advisory).
- [ ] Automated actions proportionate to confidence; no allow and block of the same file.
- [ ] `metadata.uuid` unchanged on an already-deployed rule (it is the Defender rule id).

---

## 9. Common Defender errors

| Error pattern | Cause | Fix |
|---|---|---|
| `The query references unknown table` | Table not in tenant schema | Verify against tenant table reference |
| `Failed to resolve column` | Column doesn't exist in this table | Look up correct column |
| `TimeGenerated > ago(7d)` rejected | Wrong time field | Replace with `Timestamp` |
| `Query exceeds the allowed limits` | Too many rows / too long | Add `take`, `summarize`, tighter time filter |
| HTTP 429 | Rate limit exceeded | Wait ~65 s; stop if persistent |

### Forensic lookback

| Hunt category | Default lookback | Rationale |
|---|---|---|
| Persistence mechanisms | 30 days | Defender retention cap |
| Lateral movement | 30 days | Active movement |
| Initial access / phishing | 14–30 days | Campaign windows |
| Active C2 beaconing | 7 days | Current state |
| Data exfiltration | 7–14 days | Recent activity, high data volume |

> Defender retention is typically capped at 30 days. Sentinel allows longer lookbacks via the same `Device*` tables ingested through the M365 Defender connector — when 30 days is insufficient, write a Sentinel-side query against the same logical schema.

---

## 10. The opentide `configurations.microsoft_defender` block

`configurations.microsoft_defender` is a Microsoft Defender XDR custom detection rule, deployed through the Microsoft Graph **beta** custom detection API, `https://graph.microsoft.com/beta/security/rules/detectionRules`. The schema is `platform::microsoft_defender::1.0`. Resolve the exact structure from the engine (`opentide://schemas/rule`, `opentide://templates/rule`, or `.opentide/templates/`), not from this section; it explains what each key does and how deploy sends it.

Shared keys (`enabled`, `name`, `schema`, `status`, `tenants`, `flags`, `contributors`) follow `opentide-rule`. The block takes no `rule_id`, `rule_id_bundle` or `rule_id::<tenant>` (`external_id_in_rule`), and any unknown key, at any level, fails validation.

### Keys

| Key | Required | Sent as | Notes |
|---|---|---|---|
| `query` | yes | `queryCondition.queryText` | KQL, compiled with the tenant's matching `exclusions` |
| `schedule` | yes (`frequency`) | `schedule` | How often the rule runs, and how far back each run reads |
| `alert` | no | `detectionAction.alertTemplate` | Every field has a deploy-time default |
| `entities` | no | `alertTemplate.entityMappings` | Result columns mapped to the alert's entities |
| `actions` | no | `detectionAction.automatedActions` | Automated actions on the entities a detection finds |
| `scope` | no | `detectionAction.organizationalScope` | `device_groups`; omitted, every device |
| `incident` | no | `detectionAction.incidentConfiguration` | **Beta-only.** Incident correlation |
| `exclusions` | no | appended to `queryText` | Per-tenant KQL fragments, the Sentinel exclusion shape |

`displayName` is the block `name`, else the rule `name`; `description` is the rule `description`; `status` follows the deployment status (below). A key left unset is omitted from the request, never sent as `null`.

### `schedule`

| Key | Values | Sent as |
|---|---|---|
| `frequency` | `NRT`, `<n>H` or `<n>D` (`n` positive, no leading zero) | `NRT` → `PT0S`, `1H` → `PT1H`, `1D` → `P1D` |
| `lookback` | **Beta-only.** `<n>H` or `<n>D` | ISO 8601 the same way; omitted, Defender derives it from the frequency |

`lookback` must not be shorter than `frequency` (`1D` counts as `24H`) and cannot be set with `NRT`: both are `microsoft_defender_lookback`. opentide does not limit which frequencies or how long a lookback Defender accepts — Defender answers that at deploy. The frequencies Defender has offered are `NRT`, `1H`, `3H`, `12H` and `24H`; stay on those.

### `alert`

| Key | Default | Sent as | Notes |
|---|---|---|---|
| `title` | rule `name` | `alertTemplate.title` | |
| `description` | rule `description` | `alertTemplate.description` | |
| `severity` | `response.alert_severity`, else `Medium` | `alertTemplate.severity` | `Informational`, `Low`, `Medium`, `High` or `Critical`; sent lower-cased, `Critical` as `high` |
| `recommendation` | not sent | `alertTemplate.recommendedActions` | Free text for the analyst |
| `techniques` | the objective's techniques | `alertTemplate.tactics` | ATT&CK technique or sub-technique ids; empty list = unset |
| `custom_details` | not sent | `alertTemplate.customDetails` | Detail name → result column |
| `grouping` | not sent (one alert per event) | `alertTemplate.eventGroupingKind` | **Beta-only.** `alert_per_event` (`alertPerEvent`) or `single_alert` (`singleAlert`) |

`single_alert` groups the events of one run into one alert; it does not merge alerts across runs.

**Techniques and tactics.** There is no `alert.tactics` key: deploy derives Graph's `tactics` from the technique ids, through the bundled `att&ck` vocabulary. The ids are `alert.techniques` when set and not empty, otherwise the rule's objective's; the two are never merged. Only Enterprise ids are kept: a Mobile, ICS or unknown id is left out with a `technique_not_enterprise_left_out` warning. Each id is sent under every tactic its stage maps to, grouped as parent technique with its sub-techniques. Stealth, Defense Impairment and the legacy Defense Evasion all become `DefenseEvasion`. With no technique left, `tactics` is not sent.

### `entities`

Each key is an entity kind holding a list of mappings; each mapping maps a field to a result column. A field is its Graph property without the `Column` suffix, in snake_case.

| Kind | Fields |
|---|---|
| `hosts` | `device_id`, `name`, `dns_domain`, `netbios_name`, `nt_domain` |
| `accounts` | `aad_user_id`, `sid`, `upn`, `upn_suffix`, `name`, `nt_domain`, `dns_domain` |
| `mailboxes` | `primary_address` |
| `files` | `name`, `sha1`, `sha256` |
| `processes` | `sha1`, `sha256` |
| `ips` | `address`, `scope` |
| `urls` | `address` |
| `dns` | `domain_name`, `host_ip_address`, `server_ip` |
| `registry_values` | `key`, `value_name` |
| `mail_messages` | `network_message_id`, `recipient`, `sender`, `subject` |
| `mail_clusters` | `query`, `source` |
| `cloud_applications` | `app_id`, `name` |
| `oauth_applications` | `oauth_app_id` |
| `security_groups` | `object_id`, `sid`, `distinguished_name` |
| `azure_resources` | `resource_id` |
| `amazon_resources` | `amazon_resource_id` |
| `google_cloud_resources` | `full_resource_name` |

Defender for Endpoint tables yield hosts, accounts, files, processes, ips, urls and registry values; the other kinds come from the Office 365, Identity and Cloud Apps tables. A mapping has at least one field. A block that maps no entity gets the advisory `microsoft_defender_no_entities`: the alert cannot be triaged or acted on by entity, so map at least the device or account.

**Column names** (entity fields, action columns, `custom_details` values) are sent verbatim, in the case the query's output spells them (`DeviceId`). Validation only checks they are non-blank (`microsoft_defender_column`); Defender checks they exist at deploy, so project every one of them.

### `actions`

Each key is an automated action holding a non-empty list of targets.

| Action | Target fields |
|---|---|
| `isolate_devices` | `device_id`, `isolation_type` (`full` or `selective`) |
| `collect_investigation_packages`, `run_antivirus_scans`, `initiate_investigations`, `restrict_app_executions` | `device_id` |
| `allow_files`, `block_files` | `sha1`, `sha256`, `device_groups` (omitted: every device group) |
| `stop_and_quarantine_files` | `device_id`, `sha1` |
| `disable_users`, `force_user_password_resets` | `account_sid` |
| `mark_users_as_compromised` | `account_object_id` |
| `soft_delete_emails`, `hard_delete_emails`, `move_emails_to_deleted_items`, `move_emails_to_inbox`, `move_emails_to_junk` | `network_message_id`, `recipient` |

Fields other than `isolation_type` and `device_groups` take a column name. A target has at least one field and only its action's fields (`microsoft_defender_action_target`).

### `scope` and `incident`

- `scope: {device_groups: [...]}` — a non-empty list of device group names. Omitted, the rule applies to every device. An empty list is rejected (`microsoft_defender_scope`).
- `incident: {exclude_from_correlation: true|false}` — **beta-only**. `true` opens a single-alert incident per alert; `false` (Defender's default) lets Defender correlate it with related alerts.

### `exclusions`

The Sentinel exclusion shape: `query` (a KQL fragment appended after the base query; required, may be empty), `reason` (required, never sent), optional `tenant` (limits it to that tenant) and `let` (KQL `let` bindings). Use them for tenant-specific tuning; keep shared filters in `query`.

### Example

```yaml
configurations:
  microsoft_defender:
    schema: platform::microsoft_defender::1.0
    status: STAGING
    query: |
      DeviceProcessEvents
      | where FileName =~ "powershell.exe" and ProcessCommandLine has "-enc"
      | project Timestamp, DeviceId, ReportId, DeviceName, AccountSid, AccountName,
          AccountDomain, ProcessCommandLine
    schedule:
      frequency: 1H
      lookback: 4H  # beta-only
    alert:
      severity: High
      recommendation: Decode the command line and review the device timeline.
      techniques: [T1059.001]
      custom_details:
        CommandLine: ProcessCommandLine
      grouping: single_alert  # beta-only
    entities:
      hosts:
        - device_id: DeviceId
          name: DeviceName
      accounts:
        - sid: AccountSid
          name: AccountName
          nt_domain: AccountDomain
    actions:
      initiate_investigations:
        - device_id: DeviceId
    scope:
      device_groups: [Tier 0]
    incident:  # beta-only
      exclude_from_correlation: false
```

### Validation codes

| Code | Rejects |
|---|---|
| `microsoft_defender_schema` | `schema` other than `platform::microsoft_defender::1.0` |
| `microsoft_defender_frequency` | `schedule.frequency` not `NRT`, `<n>H` or `<n>D` |
| `microsoft_defender_lookback` | `schedule.lookback` malformed, set with `NRT`, or shorter than `frequency` |
| `microsoft_defender_severity` | `alert.severity` outside `Informational`…`Critical` |
| `microsoft_defender_grouping` | `alert.grouping` not `alert_per_event` or `single_alert` |
| `microsoft_defender_custom_details` | `alert.custom_details` not a map of non-blank names to strings |
| `microsoft_defender_entity_kind` | an unknown kind under `entities` |
| `microsoft_defender_entity_mapping` | a kind that is not a list, an empty mapping, or a field not of its kind |
| `microsoft_defender_action_kind` | an unknown action under `actions` |
| `microsoft_defender_action_target` | an empty action list, an empty target, a field not of its action, or empty `device_groups` |
| `microsoft_defender_isolation_type` | `isolation_type` not `full` or `selective` |
| `microsoft_defender_column` | a blank column name |
| `microsoft_defender_scope` | `scope` not a non-empty `device_groups` list |
| `microsoft_defender_incident` | `incident` not `{exclude_from_correlation: <boolean>}` |

`microsoft_defender_no_entities` is an advisory (warning), never a rejection. Run `opentide explain <code>` for any of them.

### Deploy

The Defender rule id **is** the rule's `metadata.uuid` (lowercase, canonical): the create body's `id` and the `{id}` of every update and delete. There is **no deployment state** for this platform — nothing is read from or written to `.opentide` state, and no Defender id is stored anywhere. Never change a deployed rule's `metadata.uuid`: Defender would see a new rule.

| Status strategy | Calls | Graph `status` |
|---|---|---|
| `PREVIEW`, `RELEASE`, `UNIVERSAL` | `PATCH {base}/{uuid}`; on `404`, `POST {base}` with `id`; if that `POST` answers `409` (created concurrently), one more `PATCH` — never a second `POST` | `enabled` |
| `DISABLEMENT` | `PATCH {base}/{uuid}` with the status; on `404` nothing is created (`microsoft_defender_rule_absent`, skipped) | `disabled` |
| `DELETION` | `DELETE {base}/{uuid}`; a `404` is skipped as already gone | — |
| `INERT` | none | — |

- A `404` on `PATCH` is the only signal that the rule is absent: deploy never lists remote rules or matches display names.
- Defender sets `autoDisabled` on a rule that keeps failing; the next deploy with an active status sends `enabled` again.
- Any other non-2xx answer fails that rule on that tenant; deploy continues with the other tenants and rules and exits `1`.
- `--prune` retires a rule removed from the repository by `DELETE {base}/{uuid}`.
- `opentide deploy --dry-run` makes no call and shows the first call it would make.

Tenants live in `.opentide/configurations/platforms/microsoft_defender.toml`, with an Entra app registration's `tenant_id`, `client_id` and `client_secret` (client credentials for `https://graph.microsoft.com/.default`). Live query checks and `opentide query` run through Graph advanced hunting, which needs `ThreatHunting.Read.All`.

### Query checks and hunting

- `opentide validate` checks the KQL offline with Defender's table catalogue: an unknown table is an error (`kql_unknown_table`) under `microsoft_defender`. Declare a custom table as a log source with `system = "microsoft_defender"`.
- `opentide validate query --platform microsoft_defender --live` runs the compiled query for one row over the last minute against the tenant's advanced hunting, and fails a query whose output lacks the columns a custom detection needs. It creates no rule.
- `opentide query --platform microsoft_defender` runs a hunt.

### Authoring notes

- The MDR `description` and `response.*` carry the narrative and severity; `alert.*` overrides them only for the Defender alert.
- Inline KQL still carries the header block, comment discipline and FP engineering above — except NRT, which takes no comments.
- Coordinate with `opentide-rule` for structural placement and `detection-engineering` for hunt-to-rule conversion discipline.
