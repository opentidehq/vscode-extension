# Elastic diagnostics — what the checks report

Lookup table for the codes opentide and its analysis engine report on `configurations.elastic` blocks. `opentide explain <code>` prints the current description, example and fix for any of them; that output, not this page, is authoritative. Codes are shared between the CLI and the editor (`opentide lsp start`).

Where they come from:

- **Block shape** — `opentide validate` (schema check) on the block itself.
- **Engine** — the offline query check of `opentide validate` (errors), `opentide lint` (warnings and notes), `opentide validate query --platform elastic`, the editor and MCP `validate_query`.
- **Advisory** — schedule and mapping advice from the elastic-1.0 specification; reported by the engine, `lint`, and `validate query --live`.

## Block shape

| Code | Raised when |
|---|---|
| `type_block` | Unknown `type`; a type sub-block on the wrong type or missing on its own (`threshold`, `new_terms` with `fields` and `history_window_start`, `threat` with `index`, `query`, `mapping`, `machine_learning` with `job_id` and `anomaly_threshold`); no `query` on a type that needs one; a Kibana flat key (`from`, `interval`, `max_signals`, `risk_score`, `note`, `threat_index`, `timestamp_override`, ...) used in the block; `actions` written as a list |
| `language` | `language` set on `eql`, `esql` or `machine_learning` |
| `esql_source` | `index`, `data_view_id` or `filters` on `esql` or `machine_learning` |
| `index_xor_data_view` | Both `index` and `data_view_id` |
| `index_list` | `index` or `threat.index` not a non-empty list of strings |
| `filter_shape` | A filter entry neither `{field, value, negate?}` nor `{meta, query}`, or mixing the two |
| `exception_type` | An exception list `type` other than `detection` or `rule_default` |
| `response_action` | A response action other than `{endpoint: isolate | kill-process | suspend-process | runscript, comment?, field?}` or `{osquery: {query, ...}}` |
| `suppression_shape` | Non-threshold suppression without 1–3 distinct `group_by` fields; threshold suppression with `group_by` or without `duration` |
| `new_terms_fields` | `new_terms.fields` not a list of 1–3 |
| `threshold_fields` | More than 5 `threshold.field` entries, or `value` below 1 |
| `severity` | A severity outside the `alert_severity` vocabulary |
| `risk_score` | A risk score outside 0–100 |
| `duration` | An unparseable or empty `interval`, `lookback`, `suppression.duration` or `history_window_start` |

## Advisories (schedule and mapping)

| Code | Raised when |
|---|---|
| `lookback_zero` | `scheduling.lookback` is zero |
| `lookback_long` | `scheduling.lookback` exceeds 1h (it is overlap added to `interval`) |
| `threshold_lookback` | A threshold rule's look-back exceeds its interval |
| `esql_metadata_id` | A non-aggregating ES\|QL query has no `METADATA _id` |
| `eql_maxspan_window` | A sequence `maxspan` exceeds `interval + lookback` |
| `eql_maxspan_lookback` | A sequence `maxspan` fits the window but exceeds `lookback` |
| `risk_band` | An explicit risk score outside its severity's band |
| `technique_not_enterprise` | A Mobile or ICS technique, left out of the Elastic `threat` array |
| `suppression_omitted_basic_license` | The tenant has `setup.suppression = false` and the rule configures suppression (live check and deploy) |

## Kibana KQL (`kuery`)

| Code | Meaning |
|---|---|
| `kuery_parse_error` | Does not parse |
| `kuery_escape` | A character needs escaping |
| `kuery_free_text` | A value with no field searches every field |
| `kuery_looks_like_lucene` | Reads like Lucene; `language: lucene` may be meant |
| `kuery_lucene_syntax` | Lucene syntax inside KQL |
| `kuery_question_mark` | `?` is a literal, not a wildcard |
| `kuery_quoted_wildcard` | `*` inside quotes is literal |
| `kuery_range_type` | A range compares a value of the wrong type |

## Lucene

| Code | Meaning |
|---|---|
| `lucene_parse_error` | Does not parse |
| `lucene_bare_term` | A term with no field searches every field |
| `lucene_escape` | A character needs escaping |
| `lucene_fuzzy` | Fuzziness other than 0, 1, 2 or `AUTO` |
| `lucene_kuery_syntax` | KQL syntax inside Lucene |
| `lucene_looks_like_kuery` | Reads like KQL; `language: kuery` may be meant |
| `lucene_lowercase_operator` | Lower-case `and`/`or`/`not` are search terms |
| `lucene_mixed_operators` | `AND` and `OR` mixed without parentheses |
| `lucene_range_operator` | `f:> 10` searches for the text `>` |
| `lucene_regexp` | A `/regexp/` body Lucene rejects or finds too costly |
| `lucene_unescaped_slash` | An unescaped `/` opens a regular expression |

(`lucene_elasticsearch_only` concerns Carbon Black's dialect, not Elastic.)

## EQL

| Code | Meaning |
|---|---|
| `eql_parse_error` | Does not parse |
| `eql_unsupported` | A construct Elasticsearch EQL does not support (Endgame pipes, relationships) |
| `eql_unknown_function` / `eql_function_arity` / `eql_argument_type` | Function not in the catalogue, wrong argument count, wrong literal type |
| `eql_case_sensitive` | A case-sensitive comparison where the insensitive form may be meant |
| `eql_literal_wildcard` | A wildcard compared literally; use `:` or `like` |
| `eql_field_comparison` | Both sides read fields |
| `eql_not_boolean` | A string or number used as a condition |
| `eql_regex` | A Lucene RegExp pitfall |
| `eql_maxspan_missing` | A sequence with no `maxspan` |
| `eql_maxspan_unit` | A `maxspan` unit Elasticsearch rejects |
| `eql_until_term` | `runs` or `![ ]` on `until` |
| `eql_runs_ignored` | A decimal `runs` count is truncated |
| `eql_nested_comment` | `/* */` nests; the comment ends later than it looks |
| `eql_expression_depth` | Nesting deeper than Elasticsearch accepts |

## ES|QL

| Code | Meaning |
|---|---|
| `esql_parse_error` | Does not parse |
| `esql_unknown_command` / `esql_unknown_function` / `esql_unknown_type` | Not in the Elasticsearch catalogue |
| `esql_unavailable` | Missing or in preview on a targeted stack version (tenant `setup.version`) |
| `esql_group_by_column` | A `suppression.group_by` field the query does not return |
| `esql_pattern` | A `LIKE` / `RLIKE` pattern that escapes or matches differently than it reads |
| `esql_expression_depth` | Nesting deeper than Elasticsearch accepts |

## ECS and datasets

| Code | Meaning |
|---|---|
| `ecs_unknown_field` | A near miss of an ECS field (a likely typo, such as `process.nmae`), not declared in `visibility.toml` (warning). Integration namespaces (`winlog.*`, `aws.*`, …), `labels.*` and other custom fields are never reported. Only on queries whose written indices all start with `logs-` |
| `ecs_type_mismatch` | The operation cannot apply to the field's type (error) |
| `elastic_dataset_not_declared` | An `index`, `threat.index` or ES\|QL `FROM` pattern no `visibility.toml` elastic log source covers (warning, opt-in once any elastic log source exists) |

## Live and deploy pre-flight failures

These are messages rather than codes, from `validate query --live` and every deploy:

- ES\|QL `parsing_exception` on the `| LIMIT 0` pre-flight fails the rule; a `verification_exception` whose `FROM` sources resolve to nothing warns ("not onboarded yet").
- A `data_view_id` that cannot be read fails the rule.
- An aggregation field (`suppression.group_by`, `threshold.field`, `threshold.cardinality.field`, `new_terms.fields`) missing or not aggregatable fails the rule.
- A custom timestamp field (`overrides.timestamp`, `eql.timestamp_field`) mapped as anything but `date` / `date_nanos` fails the rule.
- An indicator-match mapping field that is not searchable fails the rule.
- Errors in the Kibana preview's logs fail the rule; HTTP 400 is a schema error; 401/403 or a missing preview-index privilege fails the tenant.
