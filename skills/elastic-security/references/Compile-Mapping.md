# How an Elastic block compiles to a Kibana rule

What `opentide deploy` sends to `POST|PUT /api/detection_engine/rules` (in the tenant's Kibana space) for each block setting. Use it to read a `deploy --dry-run` body or to translate a rule exported from Kibana. `opentide deploy --dry-run --json` shows the real body for the installed version under `api_request.payload` (`api_request.block` is the rule's `elastic` block); trust it over this table.

## Identity and metadata

| Kibana field | Source |
|---|---|
| `rule_id` | Rule `metadata.uuid` (no deployment state file is kept) |
| `name` | Block `name`, else rule `name` |
| `description` | Rule `description` |
| `author` | `metadata.author` then `metadata.contributors`, de-duplicated |
| `references` | Rule public references, in key order |
| `tags` | `OpenTide`, then tenant `setup.tags`, then block `tags`, de-duplicated |
| `enabled` | From the status's strategy: `false` for `DISABLEMENT`, `true` otherwise |
| `threat` | Derived from the rule's ATT&CK techniques and those its objective carries (never from the block's `threat` key) |
| `note` | `guide.investigation`, else `response.procedure.analysis` |
| `setup` | `guide.setup` |

## Query and sources

| Kibana field | Source |
|---|---|
| `type` | `type` |
| `language` | `eql` for `eql`, `esql` for `esql`, none for `machine_learning`, else block `language` or `kuery` |
| `query` | `query` (not sent for `machine_learning`) |
| `index` | Block `index`, else tenant `setup.index`; not sent for `esql`, `machine_learning`, or when `data_view_id` is set |
| `data_view_id` | `data_view_id` |
| `filters` | `filters`; the phrase shorthand becomes a `match_phrase` filter with `meta.type: phrase` |

## Schedule

| Kibana field | Source |
|---|---|
| `interval` | `scheduling.interval` (default `5m`) |
| `from` | `now-` + (`interval` + `scheduling.lookback`, default `1m`) |
| `to` | `now` |
| `max_signals` | `scheduling.max_alerts` (omitted: Kibana's default) |

## Type-specific

| Kibana field | Source |
|---|---|
| `threshold.field`, `threshold.value`, `threshold.cardinality` | `threshold.field`, `threshold.value`, `[threshold.cardinality]` |
| `new_terms_fields`, `history_window_start` | `new_terms.fields`, `now-` + `new_terms.history_window_start` |
| `timestamp_field`, `event_category_override`, `tiebreaker_field` | `eql.*` |
| `threat_index`, `threat_query`, `threat_language`, `threat_filters`, `threat_indicator_path`, `threat_mapping` | `threat.index`, `.query`, `.language`, `.filters`, `.indicator_path`, `.mapping` (entries get `type: mapping`) |
| `machine_learning_job_id`, `anomaly_threshold` | `machine_learning.job_id` (string or list, unchanged), `.anomaly_threshold` |

## Severity, risk and overrides

| Kibana field | Source |
|---|---|
| `severity`, default `risk_score` | Block `severity` (or `severity.default`), else `response.alert_severity`: Informational → `low`/1, Low → `low`/21, Medium → `medium`/47, High → `high`/73, Critical → `critical`/99 |
| `risk_score` | `risk` (integer) or `risk.score`, replacing the default |
| `severity_mapping` | `severity.mapping` (operator `equals`) |
| `risk_score_mapping` | `risk.mapping` (operator `equals`) |
| `rule_name_override` | `overrides.name` |
| `timestamp_override`, `timestamp_override_fallback_disabled` | `overrides.timestamp`, `overrides.disable_fallback` |

## Suppression, exceptions, analyst content

| Kibana field | Source |
|---|---|
| `alert_suppression` | `suppression`: `group_by` and `missing_fields_strategy` (not on threshold), `duration` as `{value, unit}`; omitted entirely on a tenant with `setup.suppression = false` |
| `exceptions_list` | `exceptions.lists`, plus the agnostic `endpoint_list` when `exceptions.endpoint: true` |
| `investigation_fields` | `{field_names: highlighted_fields}` |
| `required_fields` | `required_fields`, sorted by name |
| `related_integrations` | `integration`; a bare string becomes `{package, version: "*"}` |
| `false_positives` | `false_positives` |
| `building_block_type` | `default` when `building_block: true` |

## Actions

| Kibana field | Source |
|---|---|
| `actions` | `actions.notify`, copied unchanged |
| `response_actions` | `actions.respond`: `endpoint` becomes `.endpoint` with `params.command` (and `config.field`; `kill-process` / `suspend-process` default to `process.entity_id`), `osquery` becomes `.osquery` |
| `timeline_id`, `timeline_title` | `actions.timeline.id`, `.title` |

## Kept from the live rule on update

When the block does not set them, these remote fields survive an update or a type-change recreate: `actions`, `exceptions_list`, `response_actions`, `timeline_id`, `timeline_title`, `concurrent_searches`, `items_per_search`, `meta`, `output_index`, `namespace`, `throttle`.

Server-owned fields (`id`, `version`, `revision`, `created_*`, `updated_*`, `execution_summary`, `immutable`, `rule_source`, `outcome`) are never sent. A remote rule that is prebuilt (`immutable`, or `rule_source.type: external`) is never modified.
