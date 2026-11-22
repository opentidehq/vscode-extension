---
name: bitdefender-gravityzone
description: "Bitdefender GravityZone (EDR/XDR) custom detection rule authoring for opentide's configurations.bitdefender block — the two rule kinds (Basic criteria on a detection target, or a YARA signature), how criteria are written (is / contains / any, wildcards, short registry hives, EDR versus XDR sensors, pairing rules) and checked by opentide validate against the engine's criteria catalogue, YARA under the engine's bitdefender profile (ASCII only, 30,000 characters, confirmed modules), automatic actions, severity, endpoint-tag and company targeting, and how deploy works over the Incidents API (whole-payload updates, the 24-hex rule id in deployment state, exclusion rules never touched). States plainly that there is no live validation and no opentide query. Use when writing, reviewing or deploying a bitdefender block in an opentide detection rule."
---

# Bitdefender GravityZone — custom detection rules

This skill covers authoring `configurations.bitdefender` blocks (`platform::bitdefender::1.0`) in opentide detection rules: GravityZone **custom detection rules**, deployed through the GravityZone Incidents API. It carries the judgement the schema cannot: which kind of rule to reach for, how GravityZone actually matches a criterion, and the traps that validate cleanly and still never fire.

Pair it with `opentide-rule` for the rule object around the block, `detection-engineering` for lifecycle, and `harfanglab` for general YARA craft (the language is the same; the profile differs).

---

## 1. Resolve the structure before authoring

Do not author field names, targets or enum values from memory, and do not treat the examples here as the catalogue. The block's structure and the criteria catalogue ship with the installed engine and move without this skill moving.

| Question | Where the answer lives |
|---|---|
| Keys of the block, required or optional | `opentide://schemas/rule` (MCP), `.opentide/schemas/`, or `opentide generate schemas` — as in `opentide-rule` |
| Which fields a target has, their relations, value kinds, enum values, sensors and pairing rules | The **criteria catalogue**: `catalogs/bitdefender/criteria.toml` in opentidehq/language-server, bundled verbatim in the opentide package at `opentide/data/bitdefender/criteria.toml` (`opentide.platforms.bitdefender.criteria.catalogue_path()` prints the installed copy) |
| The same, while typing | `opentide lsp start` (or the VS Code extension): completion and hover inside `configurations.bitdefender` come from that catalogue, including which relations a field takes and which actions the kind allows |
| What the platform can do on this install | `opentide --json info --platform bitdefender` or `opentide://platforms`: `can_deploy` true, `can_validate` false, `can_query` false |
| What a finding means | `opentide explain <code>` (for example `opentide explain bitdefender_criteria_combination`) |
| What would be sent | `opentide deploy --dry-run --platform bitdefender`: the `createCustomRule` JSON-RPC request per rule |

The catalogue is generated from Bitdefender's "Detection and exclusion criteria for Basic rules" page, and its header records the fetch date. When it and this skill disagree, the catalogue wins; when the catalogue and the vendor page disagree, report it rather than working around it.

---

## 2. Surface map

| GravityZone surface | opentide | Notes |
|---|---|---|
| Custom **detection** rule, Basic (criteria) | `configurations.bitdefender.detection` | API `type: 1`, `subtype: 0` |
| Custom **detection** rule, YARA | `configurations.bitdefender.yara` | API `type: 1`, `subtype: 1` |
| Custom **exclusion** rule | not supported | API `type: 2`. opentide never creates, updates or deletes one; an `exclusion:` key is refused as an unknown key, and a block with neither `detection` nor `yara` is `bitdefender_rule_kind` |
| Automatic actions on a detection | `actions` | Isolate, investigation package, sandbox, kill, scan, quarantine, risk scan |
| Scope (where the rule applies) | `targets`, and the tenant's `targets` default | Endpoint tags, or companies on a partner tenant; neither means the whole company |
| Telemetry search / hunting | none | No `opentide query` runner; hunt elsewhere and encode the result as criteria |

A block is **one rule of one kind**: exactly one of `detection` and `yara` (`bitdefender_rule_kind`). Changing the kind of a deployed rule is not an update — see section 8.

---

## 3. Choosing the kind

| Reach for | When |
|---|---|
| `detection` (Basic) | Behaviour on the endpoint or in XDR telemetry: a process tree, a command line, a file written by a given process, a registry write, a connection, a sign-in or cloud-resource operation |
| `yara` | Content: bytes in a file (or what the on-access and on-demand scanners read), structural PE/ELF properties, packer or configuration artefacts |

A command-line pattern belongs in a Basic rule, not in YARA. A byte pattern in a dropped binary belongs in YARA, not in `File.Name` guesses.

---

## 4. Basic rules — how criteria work

```yaml
detection:
  target: process          # one GravityZone detection target, as the API spells it
  # alert: <name>         # optional: a GravityZone alert (detection) name, sent as a filter
  criteria:                # at least one; ALL must match (AND)
    - field: Process.Name  # an API field name of that target, from the catalogue
      is: powershell.exe   # exactly one of: is | contains | any
```

**Relations.** Each criterion has `field` and exactly one relation (`bitdefender_criterion_shape`):

| Relation | Value | Matches |
|---|---|---|
| `is` | a string or an integer | the whole value |
| `contains` | a string | the whole value, with `*` and `?` as wildcards |
| `any` | a non-empty list | any one of the listed values |

`contains` is **not** a substring operator. GravityZone compares the whole value; without a wildcard it is an exact match. Write `"*-enc*"`, not `-enc` — opentide warns with `bitdefender_contains_no_wildcard`. Quote values that start with `*` in YAML.

There is no OR between criteria and no negation. Alternatives on one field go in `any`; alternatives across fields are separate rules.

**Targets and sensors.** Targets split into two families:

- **EDR targets** — `process`, `file`, `connection`, `registry`. The specification states their field lists, so an unknown field is an error (`bitdefender_criterion_field`).
- **XDR targets** — `user connection` and the cloud and collaboration resources (`email`, `application`, `key vault`, `role`, `policy`, …). Their field lists are open: an unknown field there is a **warning**, because GravityZone may still accept it. Treat that warning as "probably wrong", not as licence.

Resolve the exact target list from the schema or the catalogue; do not copy it from here.

Each field (and, for enums, each value) is evaluated by a sensor: `edr`, `xdr` or `both`. **EDR-only and XDR-only fields or values cannot be mixed in one rule** — for example `File.CreatedBy.*` (EDR) with `File.MD5` (XDR), or `File.Operation: rename` (EDR) with `downloaded` (XDR). That is `bitdefender_criteria_combination`; split the logic into two rules.

**Pairing rules.** The catalogue also carries dependencies the vendor imposes. Read them from the catalogue (`requires_any`, `detection_requires_any`, `incompatible`, per-value `incompatible`, the `rules` table). Representative ones:

- `File.CertificateSigner`, `File.CertificateIssuer` and `File.CertificateSignedStatus` need `File.Name` or `File.FullPathName`; `is_unsigned` excludes the signer and issuer fields.
- `Connection.Protocol` and `Connection.Domain` need each other; `smb` excludes the HTTP fields and `http/https` the SMB ones.
- `Registry.Data` needs `Registry.DataType`.
- A `connection` or `user connection` rule may name **one** XDR resource.
- On XDR rules, `alert` and an `*.Operation` criterion are mutually exclusive, and several XDR targets require one of the two.

**The alert filter is not a criterion.** Write the GravityZone alert name as `detection.alert`; deploy sends it as `filters`. A criterion with `field: detection` is rejected on every target.

**Value kinds.** `hash` fields (`*.MD5`, `*.SHA2`) take no wildcards and no `contains` (`bitdefender_criterion_relation`). `port` fields take integers in range, not strings. `enum` fields take exactly the catalogue's spelling (`http/https`, `value_written`, `is_unsigned`) — `bitdefender_criterion_value` otherwise.

**Registry hives.** GravityZone stores keys under short hive names. `HKEY_LOCAL_MACHINE\…` validates, deploys and never matches (`bitdefender_registry_full_hive`). Write `HKLM`, `HKCU`, `HKCR`, `HKCC`; `HKU` for a user's hive (`HKEY_USERS\<SID>…`) and `HKLU` for any other `HKEY_USERS\…` key.

**Case sensitivity.** Neither opentide nor the vendor criteria page states whether string matching is case-sensitive. Do not rely on either behaviour: confirm on a staging tenant, or check Bitdefender's documentation for your console version.

---

## 5. YARA under the bitdefender profile

`yara.signature` is a whole YARA source — imports, then one or more rules — written out in the block (not a YAML alias, `yara_signature_alias`). Deploy sends it verbatim as `settings.yaraQuery`, with line endings normalised to `\n` and one trailing newline. The engine checks it offline as YARA-X 1.x compiles it — what YARA-X refuses is an error — under the **bitdefender profile**:

| Constraint | Code | Severity |
|---|---|---|
| ASCII only — **including comments and `meta` strings** | `bitdefender_yara_ascii` | error |
| At most 30,000 characters | `bitdefender_yara_size` | error |
| No `include` | `yara_include` | error |
| At least one rule that is neither `private` nor `global` | `yara_empty_signature` | error |
| No rule name used twice | `yara_duplicate_rule` | error |
| No syntax only YARA-X has — `with`, digit separators, float meta, `"""` strings, `.len()`, the 64-bit and float readers (`uint64`, `float32`, …), `(?` regexp groups — until GravityZone is confirmed to take it | `yara_x_only_syntax` | error |
| Modules: `pe`, `elf`, `math`, `hash`, `time` are confirmed on GravityZone; another known module (`crx` and `zip` included) is flagged | `yara_module_unconfirmed` | warning (`opentide lint`) |
| Known modules are YARA-X's default modules less `vt`: `console`, `crx`, `cuckoo`, `dex`, `dotnet`, `elf`, `hash`, `lnk`, `macho`, `math`, `pe`, `string`, `time`, `zip`. `import "magic"` (not a YARA-X default) and `import "vt"` (VirusTotal's own scan metadata) are refused, and the message says why | `yara_unknown_module` | error |
| Any syntax or semantic error | `yara_*` | error |

The ASCII rule bites in prose: an en dash, a curly apostrophe or an accented name in `meta.description` fails the rule. Write meta in plain ASCII, and use hex strings or escapes for non-ASCII content.

`yara.on_access` (default `true`) enables on-access scanning; `false` keeps the rule for on-demand scans only (deployed with `status: 0`).

Unlike HarfangLab, the Bitdefender block has no decomposed form and no `meta.context` convention. For YARA technique — anchoring, modules over brute-force strings, condition cost — use the `harfanglab` skill's YARA discipline; it applies unchanged except for the profile above.

---

## 6. Actions, severity, scope, name and tags

**Actions** (`actions`) map to GravityZone automatic action types. What each kind allows (`bitdefender_action_scope`):

| Action | Value | Basic rule | YARA rule |
|---|---|---|---|
| `isolate` | `true` | yes | yes |
| `collect_investigation_package` | `true` | yes | yes |
| `antimalware_scan` | `quick` or `full` | yes | yes |
| `risk_scan` | `true` | yes | yes |
| `sandbox` | `true` | `process`/`file` target, or a `*.CreatedBy.*` criterion | yes |
| `quarantine` | `true` or `{include_parent, include_children}` | as `sandbox` | yes |
| `kill_process` | `true` or `{include_parent, include_children}` | as `sandbox` | **no** |

Every update sends every action type the kind allows, enabled or not, so removing an action from the block disables it on the tenant. A tenant with `automatic_actions = false` deploys the rule without actions and warns (`bitdefender_actions_unsupported`). Start new rules without containment actions; add them once the rule has a clean run in production.

**Severity.** GravityZone has three levels. The block's `severity` (`Low`, `Medium`, `High`) wins; otherwise it derives from `response.alert_severity`: Critical and High → High, Medium → Medium, Low and Informational → Low; with neither, Medium. A Critical or Informational rule without a block `severity` earns `bitdefender_severity_collapsed` — set `severity` to make the choice explicit.

**Scope.** `targets` sets exactly one of `endpoint_tags` and `companies` (partner tenants), each a non-empty list of **aliases** from the tenant's `endpoint_tags` and `companies` tables in `platforms/bitdefender.toml`, never raw GravityZone ids (`bitdefender_targets_shape`, `bitdefender_target_unknown`). Leave `targets` out for the tenant's default, or the whole company when the tenant sets none. An empty list never means "everything".

**Name.** The GravityZone name is the block `name`, else the rule `name`, with `< > ' "` replaced and cut at 128 characters. GravityZone refuses two rules with one name in a company; `opentide validate` reports `bitdefender_name_duplicate` across enabled blocks, and deploy refuses to adopt an existing rule of that name (`bitdefender_name_conflict`).

**Tags and description.** Deploy derives them: the block `tags`, the rule's ATT&CK technique ids, `opentide`, `opentide:<uuid>` and the tenant's tags; the description is the rule `description`, whitespace collapsed, cut at 1,024 characters. Do not hand-write ATT&CK ids into block `tags`; put them in the rule's `techniques`.

---

## 7. Validation: what is checked, and what is not

| Check | Covers | Command |
|---|---|---|
| Block constraints | kind, target, criterion shape, field, relation, value, pairing, action scope, targets shape, severity | `opentide validate` (schema), the editor |
| Advisories | full registry hive, `contains` without a wildcard, collapsed severity, unknown field on an XDR target | `opentide validate` and `opentide lint` (warnings) |
| YARA | the bitdefender profile and the YARA language | `opentide validate` (queries), `opentide validate query --platform bitdefender`, `validate_query` (MCP, `live: false`), the editor |
| Live validation | **none** | `--live` and MCP `live: true` return `supported: false` |
| Telemetry query | **none** | `opentide query --platform bitdefender` exits `2` |

GravityZone has no dry run for custom rules. A `supported: false` answer means **not validated** — never report it as a pass, and never fake a check by calling the API some other way. Block constraints are evaluated only once the block has a `status`; a block without one reports the missing field alone.

What no offline check can tell you: whether the rule fires on real telemetry, how noisy it is, and whether the sensor that evaluates it (EDR or XDR) is licensed and deployed on the scoped endpoints. Stage it (`status` mapped to a preview strategy, narrow `targets`), observe, then promote.

---

## 8. How opentide deploys

- **Transport.** JSON-RPC 2.0 `POST <url>/v1.0/jsonrpc/incidents`: `createCustomRule`, `updateCustomRule`, `deleteCustomRule`. On-premises GravityZone has no Incidents API (`bitdefender_incidents_api_unavailable`). The API key is a `$NAME` placeholder in the tenant setup; `key_type` is `personal` (HTTP Basic) or `service` (`X-API-Key`).
- **State, not lookup.** The create returns GravityZone's 24-hex rule id, which opentide records in `.opentide/states/deployment/`. Every later update, disable and delete is planned from that record; deploy never lists rules or finds one by name or tag.
- **Whole payload on every update.** GravityZone keeps any optional parameter an update omits, so opentide sends everything: no `targets` becomes `targets: {}` (the whole company), no `alert` becomes `filters: []`, and every action type is listed. Edit the block, not the console: a console change is overwritten at the next deploy.
- **Disable and delete.** A disabling status deploys `status: 0`. Deletion removes the rule and its record; a rule already gone on the tenant is forgotten.
- **Drift.** A recorded rule missing on update is created again (`bitdefender_rule_recreated`), or under disablement just forgotten (`bitdefender_rule_missing`).
- **Kind changes.** `updateCustomRule` takes no `subtype`; turning a Basic rule into YARA or back is refused (`bitdefender_kind_changed`). Deploy the rule with its deletion status first, then deploy the new kind.
- **Pacing and failures.** Creates and deletes are paced at five per rolling minute per API key; rate limits are waited out. A create with no answer is retried once and, if still unconfirmed, reported (`bitdefender_create_unconfirmed`) for a human to resolve in the console. A failed rule does not stop the run; a refused key stops that tenant.
- **Exclusion rules** (`type: 2`) are never sent, read or removed. Tuning by exclusion stays a console decision outside opentide; document expected false positives in the rule's description.

---

## 9. Worked patterns

Field names below were checked against the bundled catalogue when this skill was written; re-check them against yours.

**Office application spawning encoded PowerShell (process).**

```yaml
configurations:
  bitdefender:
    enabled: true
    schema: platform::bitdefender::1.0
    status: STAGING
    severity: High
    targets:
      endpoint_tags: [pilot-workstations]
    detection:
      target: process
      criteria:
        - field: Process.Parent.Name
          any: [winword.exe, excel.exe, powerpnt.exe]
        - field: Process.Name
          any: [powershell.exe, pwsh.exe]
        - field: Process.CommandLine
          contains: "*-enc*"
```

**Run-key persistence written by a script host (registry).** Short hive, wildcard suffix, enum operation.

```yaml
    detection:
      target: registry
      criteria:
        - field: Registry.Key
          contains: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run*"
        - field: Registry.Operation
          any: [value_created, value_written]
        - field: Registry.CreatedBy.Name
          any: [wscript.exe, cscript.exe, mshta.exe, powershell.exe]
```

**Unsigned executable dropped in a user's temp folder by Office (file, EDR only).** The signature criterion is paired with `File.Name`, and every field is EDR-evaluated, so the rule stays on one sensor and may quarantine.

```yaml
    actions:
      quarantine: true
    detection:
      target: file
      criteria:
        - field: File.Operation
          is: create
        - field: File.Path
          contains: "*\\AppData\\Local\\Temp\\*"
        - field: File.Name
          contains: "*.exe"
        - field: File.CreatedBy.Name
          any: [winword.exe, excel.exe, outlook.exe]
        - field: File.CertificateSignedStatus
          is: is_unsigned
```

**Loader with an encrypted configuration blob (YARA).** ASCII meta, confirmed module, helper rule kept `private`.

```yaml
    severity: High
    yara:
      signature: |
        import "pe"

        private rule MZ_Header {
          condition:
            uint16(0) == 0x5A4D
        }

        rule Loader_Stage1_Config {
          meta:
            description = "Stage-1 loader carrying an encrypted config blob"
          strings:
            $cfg = { 43 46 47 21 [4-16] 00 01 }
          condition:
            MZ_Header and pe.number_of_sections > 3 and $cfg
        }
```

---

## 10. Anti-patterns

| Anti-pattern | Why it fails | Fix |
|---|---|---|
| `contains: -enc` | Exact match, never a substring | `contains: "*-enc*"` |
| `HKEY_LOCAL_MACHINE\…` in `Registry.Key` | Accepted, never matches | `HKLM\…` |
| Guessing a field (`Process.Hash`, `Process.ParentName`) | Unknown field; on XDR targets only a warning, so it can ship | Resolve from the catalogue or editor completion |
| Mixing EDR-only and XDR-only fields to "widen" a rule | Rejected (`bitdefender_criteria_combination`) | Two rules, one per sensor |
| `contains` on a hash, or a port as a string | Wrong relation or kind | `is`/`any` with full hashes; integer ports |
| `field: detection` criterion | The alert filter is not a criterion | `detection.alert` |
| `kill_process` on a YARA rule | Not allowed for the kind | `quarantine`, or a Basic rule |
| Containment actions on a first deployment | Automatic isolation or kills on an untested rule | Stage without actions; add after a clean run |
| Raw GravityZone tag or company ids in `targets` | Aliases only; ids live in the tenant file | Add an alias to `platforms/bitdefender.toml` |
| `targets: {endpoint_tags: []}` to mean "everywhere" | Refused, never the whole company | Leave `targets` out |
| Editing the deployed rule in the console | The next update sends the whole payload and overwrites it | Change the block |
| Expecting opentide to manage exclusion rules | Never touched | Console decision; document FPs in the rule |
| Em dash or curly quote in YARA `meta` | Not ASCII: the rule fails | Plain ASCII |
| Reporting `supported: false` as validated | No live check exists | Say "offline checks only" |

---

## 11. Cross-platform entity alignment

GravityZone criteria name **what to match**, not output columns. There is no host criterion: host scope is `targets` (endpoint tags). When the same signal is implemented on several platforms, align the concepts:

| Concept | GravityZone criterion | Microsoft Defender | CrowdStrike |
|---|---|---|---|
| Image name | `Process.Name` | `FileName` | `ImageFileName` |
| Command line | `Process.CommandLine` | `ProcessCommandLine` | `CommandLine` |
| Parent image | `Process.Parent.Name` | `InitiatingProcessFileName` | `ParentBaseFileName` |
| User | `Process.User` | `AccountName` | `UserName` |
| SHA-256 | `Process.SHA2`, `File.SHA2` | `SHA256` | `SHA256HashData` |
| Remote IP | `Connection.DestinationIP` | `RemoteIP` | `RemoteAddressIP4` |
| Registry key | `Registry.Key` (short hive) | `RegistryKey` (full hive) | `RegObjectName` |

Matching semantics differ too: GravityZone has whole-value wildcards and AND-only criteria, where KQL has `has`/`contains` and arbitrary boolean logic. Translate the intent of the signal, not the operator. Correlation across vendors happens in the SIEM or SOAR, not in the rule.

---

## 12. Authoring checklist

- [ ] Kind chosen deliberately: behaviour → `detection`, content → `yara`; exactly one present.
- [ ] `enabled`, `schema: platform::bitdefender::1.0` and `status` set.
- [ ] Target and every field resolved from the catalogue or editor, not memory.
- [ ] Every `contains` carries the wildcards it means; hashes use `is` or `any`.
- [ ] Registry keys use short hive names.
- [ ] One sensor per rule (no EDR-only with XDR-only); pairing rules satisfied.
- [ ] Alert filter, if any, in `detection.alert`.
- [ ] YARA: ASCII only, under 30,000 characters, no `include`, no YARA-X-only syntax, one public rule at least, confirmed modules.
- [ ] Actions allowed for the kind and target; containment held back until the rule is proven.
- [ ] `severity` set when `alert_severity` is Critical or Informational.
- [ ] `targets` uses tenant aliases, or is left out on purpose.
- [ ] GravityZone name unique among enabled blocks.
- [ ] `opentide validate` and `opentide lint` clean, warnings read and resolved.
- [ ] `opentide deploy --dry-run --platform bitdefender` reviewed; no claim of live validation.
- [ ] Expected false positives and sensor or licence prerequisites stated in the rule's description.

---

## 13. Neighbouring skills

- **`opentide-rule`** — the detection rule around the block, schema resolution, response procedures.
- **`harfanglab`** — YARA authoring discipline shared by both YARA platforms.
- **`windows-internals`**, **`windows-event-logs`** — process, registry and persistence semantics behind the criteria.
- **`detection-engineering`** — staging, promotion and tuning lifecycle.
- **`mitre-attack`** — technique ids for the rule's `techniques`, which deploy turns into tags.
