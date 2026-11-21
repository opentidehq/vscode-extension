---
name: sysdig-secure
description: "Sysdig Secure and Falco detection engineering for opentide `configurations.sysdig` blocks (platform::sysdig::1.0). Covers the Falco rule language (conditions, operators, macros, lists, exceptions, tunings through append_to_rule), event sources (syscall, k8s_audit, cloud and SaaS plugins), field classes, evt.type-first performance discipline, priority and output templates, container and Kubernetes context, and Sysdig Secure runtime policies. Explains what opentide derives and deploys through the Sysdig Secure runtime API (block macros and lists expanded into the condition, the Sysdig rule id in deployment state, policy membership), and that checking is offline only, through the analysis engine: no live validation and no opentide query. Includes anti-patterns, cross-platform entity alignment and an authoring checklist. Use when authoring, tuning, converting or reviewing Falco rules for Sysdig Secure in opentide detection rules."
---

# Sysdig Secure (Falco) — content authoring

Sysdig Secure runs Falco. An opentide `configurations.sysdig` block is one Falco rule —
a condition, its exceptions, and the macros and lists only that rule uses — or a tuning
of an existing rule. opentide deploys it through the Sysdig Secure runtime API and adds it
to runtime policies; it never runs a search on Sysdig.

Pair this skill with `opentide-rule` (structure and placement of the detection rule),
`linux-internals` (process model, namespaces, eBPF and where Falco sits among Linux
sensors — not repeated here), `detection-engineering` and `mitre-attack`.

---

## 1. Resolve the block's structure from the engine

Do not author the block from memory and do not expect a field table here: the block is
versioned with the engine. Resolve it, stopping at the first that answers:

1. MCP: `opentide://schemas/rule` (the `sysdig` property under `configurations`),
   `opentide://templates/rule`, and `opentide://platforms`.
2. `.opentide/schemas/` and `.opentide/templates/` in the repository, for the declared
   `metadata.schema`.
3. `opentide generate`, or scaffold one with `opentide new --platform sysdig`.

`opentide --json info --platform sysdig` reports the capability flags. Today they read
`can_deploy: true`, `can_validate: false`, `can_query: false` — believe the command, not
this sentence, if they ever differ.

The configuration key is exactly `sysdig` (schema `platform::sysdig::1.0`). Tenants live in
`platforms/sysdig.toml` (`opentide setup --sysdig`): a regional `url`, an `api_token` that
must be a `$NAME` placeholder, default `policies`, and `tags` added to every rule.

---

## 2. Surface map

| Surface | What it is | Who owns it |
|---|---|---|
| **Falco rule** | `condition` + `output` + `priority` + `source` + `tags` (+ `exceptions`) | The opentide block |
| **Macro** | A named condition fragment, referenced as a bare identifier | Block-private (`macros`), or the tenant / Falco defaults |
| **List** | A named set of values, referenced inside `in (…)` | Block-private (`lists`), or the tenant / Falco defaults |
| **Exception** | Structured `fields` / `comps` / `values` that Falco turns into `and not (…)` | The block |
| **Tuning** | Appends a condition and/or exceptions to an existing rule (`append_to_rule`) | The block; the tuned rule is Sysdig's or Falco's |
| **Runtime policy** | Groups rules; holds scope, actions and notifications | Sysdig Secure. opentide only adds or removes rule names |
| **Event source** | Where events come from: `syscall` (default), `k8s_audit`, plugin sources (`aws_cloudtrail`, `gcp_auditlog`, `okta`, `github`, …) | Agent and plugin configuration |

A rule that no policy names does not alert. Policy scope, actions (for example stopping a
container or taking a capture) and notification channels are set in Sysdig Secure, not by
opentide — check the Sysdig documentation for what a policy type supports.

---

## 3. What opentide deploys and stores

Deploy builds an `/api/secure/rules` body (`ruleType: FALCO`); `opentide deploy --dry-run`
shows it under `payloads.sysdig[].api_request`. Read the dry-run before the first real
deploy of any new block.

| Falco / Sysdig field | Comes from |
|---|---|
| `name` | Block `name`, else the detection rule's `name`. A tuning sends the tuned rule's name |
| `description` | The detection rule's `description`, whitespace collapsed |
| `condition` | Block `condition`, lines stripped and joined with single spaces, block lists and macros written in (§6) |
| `priority` | Block `priority`, else `response.alert_severity` (Critical→CRITICAL, High→ERROR, Medium→WARNING, Low→NOTICE, Informational→INFORMATIONAL), else WARNING |
| `output` | Block `output` on one line, else `<name> \| <default fields>` for `syscall`, `k8s_audit` and `aws_cloudtrail`; **any other source gets the bare name** |
| `tags` | Block `tags`, then ATT&CK technique ids (including those inherited through `detection_model`), `mitre_<tactic>` tags, a maturity tag (`maturity_stable`, `maturity_incubating` or `maturity_sandbox`, from the status strategy), then the tenant's `tags` |
| `source` | Block `source`, default `syscall` |
| `minimumEngineVersion` | Block `minimum_engine_version`, only when set |

Lifecycle, per tenant, planned from deployment state before any request:

- **Create** — POST the rule, record Sysdig's integer rule id in
  `.opentide/states/deployment/<uuid>.json`, then add the rule name to each policy the
  block's `policies` names (else the tenant's `policies`). A policy that does not exist
  fails the rule (`sysdig_policy_missing` in the error): deploy never creates or deletes
  a policy.
- **Update** — GET by id, PUT the new body; a renamed rule is renamed in its policies.
- **Disablement** — the rule stays on the tenant but leaves its policies, so it stops
  alerting. A tuning cannot be disabled: it is deleted and its id forgotten.
- **Delete** — leave the policies, delete the rule, forget the id.
- **Rule gone on Sysdig (404)** — recreated with a warning (`sysdig_rule_recreated`), or,
  under disablement, the stale id is forgotten.

A failed rule is recorded and the run carries on; a refused token (401/403) or an
unreachable tenant fails every rule on that tenant. Tunings join no policy — the tuned
rule's membership already applies.

---

## 4. Checking: offline only

| Check | Sysdig |
|---|---|
| `opentide validate` (schema + `queries`) | ✅ block constraints and the Falco condition |
| `opentide lint` | ✅ Falco warnings (performance, deprecated fields, unknown macros) |
| `opentide validate query --platform sysdig [--file x.falco]` | ✅ offline, analysis engine |
| `opentide validate query --platform sysdig --live` | ❌ `supported: false` — Sysdig has no rule preview |
| `opentide query --platform sysdig` | ❌ exits `2`: there is no query runner |
| Editor (`opentide lsp start`) | ✅ diagnostics, hover and completion on `condition`, exceptions, macros, lists, `output` |

Never claim a rule was validated live, and never fabricate a result for `--live` or
`opentide query`. The engine ports libsinsp's parser and compiler and Falco's rule
loader, and checks against a catalogue of libsinsp and published-plugin fields and the
Falco default rules. Two consequences:

- A **field that only the Sysdig agent adds** is reported as unknown (an error), as Falco
  OSS would. Do not paper over it; confirm the field in Sysdig's documentation and say so
  in the review.
- An **unknown macro, list or tuned rule** is a warning (`falco_unknown_macro`,
  `falco_unknown_list`, `falco_unknown_rule`): the tenant may define it, as Sysdig does
  for its managed macros. Confirm it exists on every target tenant.

Frequent codes, with the fix (full list and examples: opentide's diagnostics reference,
`falco_*` and `sysdig_*`):

| Code | Fix |
|---|---|
| `falco_no_evttype` | Narrow with `evt.type` or a macro that does (§5) |
| `falco_misplaced_list` | Write `in (my_list)`, never `in my_list` or a list as a macro |
| `falco_regex_simple` | Use `=`, `contains`, `startswith` or `endswith` instead of `regex` |
| `falco_field_as_value` | Compare two fields with `val(other.field)` |
| `falco_newer_syntax` | Modifiers (`oneof`, `anyof`, `allof`), `join`, `concat`, `getopt` need a recent agent: confirm the fleet runs one, or rewrite |
| `falco_deprecated_field` | `evt.dir`, `evt.latency*` no longer carry a value: drop the check |
| `falco_unsafe_na_check` | Do not test `ka.` / `jevt.` fields against `<NA>`; use `exists` |
| `falco_append_condition` | A tuning's condition starts with `and` (or `or`); a new rule's must not |
| `sysdig_rule_shape` | A new rule needs a non-blank `condition`; a tuning needs a condition, exceptions, or both |
| `sysdig_tuning_keys` | A tuning inherits `output`, `priority`, `policies`, `source` and `name`: remove them |
| `sysdig_definition_order` | A block macro may use only macros defined **before** it |
| `sysdig_list_in_value` | A block list name inside an exception value must be the whole value, under a list comparison |

---

## 5. Writing conditions

Operators (from libsinsp): `=`/`==`, `!=`, `<`, `<=`, `>`, `>=`, `contains`, `icontains`,
`bcontains`, `startswith`, `bstartswith`, `endswith`, `glob`, `iglob`, `regex`, `in`,
`intersects`, `pmatch`, `exists`; boolean `and`, `or`, `not`; transformers `tolower`,
`toupper`, `b64`, `basename`, `len` and (newer agents) `join`, `concat`, `getopt`;
`val(field)` on the right-hand side. Which operator applies to which field type is checked
by the engine (`falco_operator_type`) — hover the field rather than guessing.

### Performance discipline

1. **Scope by event type first.** Falco buckets rules by `evt.type`; a rule it cannot
   narrow runs on every event (`falco_no_evttype`). Start with `evt.type in (…)` or a
   macro that wraps it: `spawned_process` (`execve`, `execveat`), `open_write`,
   `open_read`, `outbound`, `inbound_outbound`, `rename`, `remove`, `mkdir`.
2. **Positive event types only.** `evt.type != open` matches almost every syscall.
3. **Parenthesise `or`.** `and` binds tighter: `spawned_process and proc.name = curl or
   proc.name = wget` matches *every* `wget` event of any type. Write
   `spawned_process and proc.name in (curl, wget)`.
4. **Most selective positive filters next**, then exclusions.
5. **Cheap operators.** `startswith` / `endswith` over `contains`; `regex` is the slowest
   check. Sets of values go in a list with `in`; sets of path prefixes with `pmatch`.
6. **`and not (…)`, not `or` with negation.**
7. **Beware high-volume syscalls** (`read`, `write`, `sendto`, …): CPU cost and
   kernel-side drops on busy nodes.

### Field classes

Fields are per event source. Learn the classes, then resolve the exact field with editor
hover/completion or Falco's *Supported Fields* reference.

| Prefix | Source | Covers |
|---|---|---|
| `evt.*` | all (`evt.hostname`, `evt.time`) / `syscall` (`evt.type`, `evt.arg.*`, `evt.res`) | The event itself |
| `proc.*`, `thread.*` | `syscall` | Process, parent (`proc.pname`), ancestors (`proc.aname[N]`), `proc.exepath`, `proc.cmdline`, `proc.args`, `proc.tty`, `proc.is_exe_upper_layer` |
| `user.*`, `group.*` | `syscall` | `user.name`, `user.uid`, `user.loginuid` (the audit uid, stable across `sudo`) |
| `fd.*`, `fs.path.*`, `fdlist.*` | `syscall` | Files (`fd.name`, `fd.directory`, `fd.filename`) and sockets (`fd.sip`, `fd.sport`, `fd.rip`, `fd.l4proto`) |
| `container.*`, `k8s.*` | `syscall` (container plugin) | `container.id`, `container.image.repository`, `.tag`, `.digest`, `container.privileged`, `k8s.ns.name`, `k8s.pod.name`, `k8s.pod.label[key]` |
| `ka.*`, `jevt.*`, `json.*` | `k8s_audit` | API-server audit: `ka.verb`, `ka.user.name`, `ka.target.*`, `ka.req.*`, `ka.uri.param[key]` |
| `ct.*`, `s3.*`, `ec2.*`, `iam.*` | `aws_cloudtrail` | CloudTrail events |
| `gcp.*`, `okta.*`, `github.*` | `gcp_auditlog`, `okta`, `github` | Plugin sources |

A field used under the wrong `source` is an error. A source the engine does not catalogue
is a warning (`falco_unknown_source`) and its fields go unchecked — review those rules by
hand against the plugin's README.

Gotchas: `proc.name` is truncated to 16 characters — match long names on `proc.exepath`.
`proc.aname` without an index matches *any* ancestor. `container` (the macro) is
`container.id != host`; host processes carry `container.id = host`. Container and
Kubernetes metadata can lag behind the first events of a new container.

---

## 6. Macros and lists — reuse and expansion

Falco macros and lists are **global** to a tenant's ruleset: two rules defining the same
name would overwrite each other. So opentide makes block `macros` and `lists` private to
the rule and writes them into what it sends:

- **Lists** expand as text, as Falco's loader does: every delimited occurrence of the name
  becomes its comma-joined items — **including occurrences inside quoted strings**. Give
  block lists distinctive names (`allowed_debug_images`, not `images`).
- A list item naming an *earlier* block list is flattened into it; a list naming itself
  keeps its name as a literal (`sysdig_list_self_reference`, a warning).
- **Macros** become `(<expanded condition>)` wherever their bare name stands as a check.
  A macro sees only the block macros defined before it.
- **Names the block does not define are sent as written** and resolve on the tenant
  (Sysdig-managed macros, Falco defaults such as `spawned_process`, `shell_procs`,
  `container_entrypoint`, `shell_binaries`).

Use a block macro for an exclusion hook (`user_known_<behaviour>`) or a fragment reused
inside the same rule. Reference default and Sysdig macros instead of re-implementing them,
but remember a tenant can redefine them.

---

## 7. Exceptions discipline

Exceptions keep the condition readable and are what Sysdig tooling tunes. Two shapes:

```yaml
exceptions:
- name: build_namespaces          # single field: comps default `in`
  fields: k8s.ns.name
  values: [ci, builds]
- name: known_shell_parents       # tuple: comps default `=` per field
  fields: [proc.pname, container.image.repository]
  comps: ['=', startswith]
  values:
  - [kubectl, registry.example.com/ops/]
```

Falco appends `and not ((f1 cmp v1 and f2 cmp v2) or …)`. Rules:

- One exception per *reason*, named for it; unique names (Falco warns on duplicates).
- Prefer tuples that pin the actor **and** the context (process + image, user +
  namespace) over a single broad field.
- `startswith` on an image repository needs the trailing `/`; a bare registry host
  excludes every image in it.
- Record ticket, owner and review date in the detection rule's description — the block
  has no field for them.

---

## 8. Tuning an existing rule

```yaml
configurations:
  sysdig:
    schema: platform::sysdig::1.0
    status: PRODUCTION
    append_to_rule: Terminal shell in container
    condition: and not proc.pname in (ci_runners)
    lists:
    - name: ci_runners
      items: [gitlab-runner, buildkite-agent]
```

- The condition is appended to the tuned rule's, so it starts with `and` (an `or …`
  append widens the rule and can lose its event-type scoping).
- Do not set `output`, `priority`, `policies`, `source` or `name`.
- The tuned rule must exist on every target tenant (`falco_unknown_rule` warns when it is
  not a Falco default).
- Prefer a tuning over copying a vendor rule: the copy forks and stops receiving fixes.

---

## 9. Priority and output

- Leave `priority` unset and let `response.alert_severity` derive it, unless Falco's
  priority must differ from the opentide severity. Allowed: EMERGENCY, ALERT, CRITICAL,
  ERROR, WARNING, NOTICE, INFORMATIONAL (or INFO), DEBUG.
- Write `output` for any non-default source, and for every rule an analyst will triage.
  Falco's style: a short sentence, `|`, then `snake_case=%field` pairs — user, process,
  parent, command line, terminal, container and image (or the source's actor, verb and
  target).
- Every `%field` must exist for the `source` (`falco_output_syntax`,
  `falco_unknown_field`). Lists and macros are **not** expanded in `output`.

---

## 10. Worked example

```yaml
configurations:
  sysdig:
    enabled: true
    schema: platform::sysdig::1.0
    status: STAGING
    condition: >
      open_write
      and container
      and fd.directory in (watched_bin_dirs)
      and not proc.name in (image_build_tools)
    output: >
      Write below a binary directory in a container |
      user=%user.name process=%proc.name file=%fd.name parent=%proc.pname
      command=%proc.cmdline container_id=%container.id
      image=%container.image.repository
    exceptions:
    - name: ci_build_images
      fields: [container.image.repository, proc.name]
      comps: [startswith, '=']
      values:
      - [registry.example.com/ci/, make]
    lists:
    - name: watched_bin_dirs
      items: [/bin, /sbin, /usr/bin, /usr/sbin, /usr/local/bin]
    - name: image_build_tools
      items: [apk, apt, apt-get, dpkg, rpm, yum, dnf, pip, pip3]
    tags: [container, filesystem]
```

The condition and output above pass the engine clean. Verify your own with
`opentide validate` and `opentide deploy --dry-run` before review.

---

## 11. Anti-patterns

| Anti-pattern | Fix |
|---|---|
| No `evt.type` scoping, or `evt.type != x` | Positive event types or a scoping macro first |
| Unparenthesised `or` | Parenthesise, or fold into `in (…)` |
| `regex` for a literal | `=`, `startswith`, `endswith`, `contains` |
| `in my_list` without parentheses | `in (my_list)` |
| Generic block list name (`users`) | Distinctive names: list expansion is textual |
| Copying a Sysdig/Falco rule to change one exclusion | `append_to_rule` tuning |
| Overriding output/priority in a tuning | Not allowed; tune the condition or exceptions only |
| Omitting `output` on a plugin source | The deployed output would be the bare rule name |
| Assuming a policy exists | Create it in Sysdig Secure first; name it in the block or tenant |
| Reporting `--live` or `opentide query` results for Sysdig | Neither exists — say so |
| `<NA>` comparisons on `ka.*` | `exists` / `not … exists` |
| Operator modifiers on an older agent fleet | Confirm agent versions or rewrite; consider `minimum_engine_version` |

---

## 12. Cross-platform entity alignment

| Concept | Falco (Sysdig) | Defender for Endpoint | CrowdStrike | Elastic (ECS) |
|---|---|---|---|---|
| Host | `evt.hostname` | `DeviceName` | `ComputerName` | `host.name` |
| Container | `container.id`, `container.image.repository` | — | — | `container.id`, `container.image.name` |
| Kubernetes | `k8s.ns.name`, `k8s.pod.name`; audit `ka.target.namespace` | — | — | `orchestrator.namespace` |
| User | `user.name`, `user.uid`, `user.loginuid`; audit `ka.user.name` | `AccountName` | `UserName` | `user.name` |
| Process | `proc.pid` + `proc.pid.ts` (+ `container.id`) | `ProcessUniqueId` | `ContextProcessId_decimal` | `process.entity_id` |
| Executable | `proc.exepath` | `FolderPath` + `FileName` | `ImageFileName` | `process.executable` |
| Hash | none in a Falco condition; use `container.image.digest` for images | `SHA256` | `SHA256HashData` | `process.hash.sha256` |

Correlate at the SIEM/SOAR layer; inside a container the PID is per namespace
(`proc.vpid`), so pair PIDs with `container.id`.

---

## 13. Authoring checklist

- [ ] Block structure resolved from the engine; key is exactly `sysdig`, schema `platform::sysdig::1.0`.
- [ ] New rule vs tuning decided; vendor rules tuned, not copied.
- [ ] `source` set when not `syscall`; every field belongs to that source.
- [ ] Condition starts with a positive `evt.type` scope (or a macro that has one); `or` parenthesised.
- [ ] No `regex` where a plain operator works; lists used as `in (…)`.
- [ ] Block macros/lists have distinctive names and are defined before use; tenant macros relied on are confirmed.
- [ ] Exceptions are named per reason, scoped by actor and context; justification in the description.
- [ ] `output` written for analysts (and always for plugin sources); `priority` derived unless deliberately set.
- [ ] Target policies exist on every tenant (block `policies` or tenant `policies`).
- [ ] Newer syntax (`oneof`, `join`, …) only on agents that support it.
- [ ] `opentide validate` and `opentide lint` clean; `opentide deploy --dry-run` body read.
- [ ] Nobody claims live validation or a query run for Sysdig.
