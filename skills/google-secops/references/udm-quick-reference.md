# UDM and YARA-L quick reference

An orientation map, not a contract. The authoritative lists are the analysis
engine's catalogues (generated from Google's UDM field list and YARA-L function
list), which `opentide validate`, editor hover and completion read. When this
page and the engine disagree, the engine wins; when the engine and
`verifyRuleText` disagree, Google's compiler wins.

Taken from the engine catalogue of language-server 0.16.0 (fetched from Google's
pages 2026-11-12).

## Event nouns: who did what to whom

| Noun | Role | Typical use |
|---|---|---|
| `principal` | The acting entity that originates the activity | Logon source IP, parent process, the user running a command |
| `target` | The entity the event refers to, or an object on it | Logon account, child process, file written, destination IP and port |
| `src` | The source object of an action on two objects, with its machine | Original file of a copy or move. **Not** the network source |
| `intermediary` | An entity processing the activity | Proxy, mail relay, load balancer |
| `observer` | An entity that observes without being in the path | Sniffer, network scanner |
| `about` | Anything referenced and not in the other nouns | Indicators attached to the event |
| `security_result` | Repeated: the product's verdict | `action` (`ALLOW`, `BLOCK`, `FAIL`, `QUARANTINE`, `CHALLENGE`, …), `severity`, `rule_name` |
| `network` | Protocol detail | `network.dns.questions.name`, `network.http.user_agent`, `network.sent_bytes`, `network.application_protocol` |
| `metadata` | Event classification | `event_type` (enum), `log_type`, `product_name`, `vendor_name`, `event_timestamp`, `id` |
| `additional.fields["k"]` | Vendor fields with no UDM home | Free keys (a Struct); `any`/`all` not allowed on it |
| `extensions` | Event-specific first-class metadata | `extensions.auth.mechanism` |

Each noun is a `Noun` message: `hostname`, `ip` (repeated), `port`, `user.*`
(`userid`, `email_addresses` repeated, `windows_sid`), `process.*`
(`file.full_path`, `command_line`, `parent_process.*`), `file.*`
(`full_path`, `sha256`), `registry.*` (`registry_key`,
`registry_value_data`), `resource.name`, `asset_id`, `asset.hostname`,
`location.country_or_region`, `url`, `application`.

## `metadata.event_type` values, by family

Use the exact upper-case value; `nocase` is an error on an enum.

| Family | Values |
|---|---|
| Process | `PROCESS_LAUNCH`, `PROCESS_TERMINATION`, `PROCESS_INJECTION`, `PROCESS_PRIVILEGE_ESCALATION`, `PROCESS_OPEN`, `PROCESS_MODULE_LOAD`, `PROCESS_UNCATEGORIZED` |
| File | `FILE_CREATION`, `FILE_MODIFICATION`, `FILE_DELETION`, `FILE_READ`, `FILE_OPEN`, `FILE_COPY`, `FILE_MOVE`, `FILE_SYNC`, `FILE_UNCATEGORIZED` |
| Registry and settings | `REGISTRY_CREATION`, `REGISTRY_MODIFICATION`, `REGISTRY_DELETION`, `REGISTRY_UNCATEGORIZED`, `SETTING_CREATION`, `SETTING_MODIFICATION`, `SETTING_DELETION`, `SETTING_UNCATEGORIZED` |
| User and group | `USER_LOGIN`, `USER_LOGOUT`, `USER_CREATION`, `USER_DELETION`, `USER_CHANGE_PASSWORD`, `USER_CHANGE_PERMISSIONS`, `USER_RESOURCE_ACCESS`, `USER_RESOURCE_CREATION`, `USER_RESOURCE_UPDATE_CONTENT`, `USER_RESOURCE_UPDATE_PERMISSIONS`, `USER_RESOURCE_DELETION`, `USER_COMMUNICATION`, `USER_BADGE_IN`, `USER_STATS`, `USER_UNCATEGORIZED`, `GROUP_CREATION`, `GROUP_MODIFICATION`, `GROUP_DELETION`, `GROUP_UNCATEGORIZED` |
| Network | `NETWORK_CONNECTION`, `NETWORK_FLOW`, `NETWORK_DNS`, `NETWORK_HTTP`, `NETWORK_SMTP`, `NETWORK_FTP`, `NETWORK_DHCP`, `NETWORK_UNCATEGORIZED` |
| Email | `EMAIL_TRANSACTION`, `EMAIL_URL_CLICK`, `EMAIL_UNCATEGORIZED` |
| Services and tasks | `SERVICE_CREATION`, `SERVICE_MODIFICATION`, `SERVICE_START`, `SERVICE_STOP`, `SERVICE_DELETION`, `SCHEDULED_TASK_CREATION`, `SCHEDULED_TASK_MODIFICATION`, `SCHEDULED_TASK_ENABLE`, `SCHEDULED_TASK_DISABLE`, `SCHEDULED_TASK_DELETION` |
| Cloud resources | `RESOURCE_CREATION`, `RESOURCE_DELETION`, `RESOURCE_PERMISSIONS_CHANGE`, `RESOURCE_READ`, `RESOURCE_WRITTEN` |
| Audit and status | `SYSTEM_AUDIT_LOG_WIPE`, `SYSTEM_AUDIT_LOG_UNCATEGORIZED`, `STATUS_STARTUP`, `STATUS_SHUTDOWN`, `STATUS_UPDATE`, `STATUS_HEARTBEAT` |
| Scans | `SCAN_FILE`, `SCAN_PROCESS`, `SCAN_HOST`, `SCAN_NETWORK`, `SCAN_VULN_HOST`, `SCAN_VULN_NETWORK`, `SCAN_PROCESS_BEHAVIORS` |
| Other | `MUTEX_CREATION`, `DEVICE_CONFIG_UPDATE`, `DEVICE_FIRMWARE_UPDATE`, `GENERIC_EVENT`, `ENTITY_RISK_CHANGE`, the `ANALYST_*` values |

`GENERIC_EVENT` and the `*_UNCATEGORIZED` values are where weak parsers put
events. A rule keyed on them needs a `metadata.log_type` or
`metadata.product_name` filter as well.

## Entity graph

Entity variables read `graph.*`: `graph.metadata.entity_type` (`ASSET`, `USER`,
`GROUP`, `RESOURCE`, `IP_ADDRESS`, `CIDR_BLOCK`, `FILE`, `DOMAIN_NAME`, `URL`,
`MUTEX`, …), `graph.metadata.source_type` (`ENTITY_CONTEXT`, `DERIVED_CONTEXT`,
`GLOBAL_CONTEXT`), `graph.entity.*` (the same `Noun`), `graph.relations`.

## Detections (composite rules)

Detection variables read the detection model: `$d.detection.detection.rule_name`,
`$d.detection.detection.risk_score`. Match producers by `rule_name`, never by a
literal `ru_` id.

## Function namespaces

| Namespace | Functions |
|---|---|
| `strings` | `to_lower`, `to_upper`, `contains`, `starts_with`, `ends_with`, `concat`, `coalesce`, `length`, `split`, `trim`, `ltrim`, `rtrim`, `reverse`, `count_substrings`, `extract_domain`, `extract_hostname`, `base64_decode`, `from_base64`, `from_hex`, `url_decode` |
| `re` | `regex`, `capture`, `capture_all`, `replace` (RE2) |
| `net` | `ip_in_range_cidr` |
| `timestamp` | `current_seconds`, `now`, `get_hour`, `get_minute`, `get_date`, `get_day_of_week`, `get_week`, `get_timestamp`, `as_unix_seconds` |
| `math` | `abs`, `ceil`, `floor`, `log`, `pow`, `sqrt`, `is_increasing`, `random`, `geo_distance` (rules); `round` (search) |
| `arrays` | `concat`, `contains`, `length`, `size`, `join_string`, `max`, `min`, `index_to_str`, `index_to_int`, `index_to_float` |
| `cast` | `as_bool`, `as_int`, `as_uint`, `as_float`, `as_string` |
| `hash` | `sha256`, `fingerprint2011` (rules) |
| `bytes` | `to_base64` |
| `window` | `avg`, `first`, `last`, `median`, `mode`, `range`, `stddev`, `variance` |
| `metrics` | Risk Analytics metrics (`auth_attempts_fail`, `network_bytes_outbound`, …), rules only, named arguments |
| Aggregations | `count`, `count_distinct`, `sum`, `max`, `min`, `array`, `array_distinct`; search adds `avg`, `stddev`, `earliest`, `latest` |

A function outside its profile is `yaral_function_unavailable`; a name or arity
Google does not list is `yaral_unknown_function`. `if(cond, then, else)` is an
expression, usable in outcomes.

## Limits worth remembering

| Limit | Rule | Search |
|---|---|---|
| Hop / sliding window | 1m to 14d | 1m to 48h |
| Tumbling window | 1m to 72h | 1m to 30d (48h with a join) |
| Outcome variables | 20 | 20 |
| `in` reference-list statements | 10 (5 `regex`, 5 `cidr`) | 7 (4 `regex`, 2 `cidr`) |
| `suppression_window` | longer than the match window | n/a (`options` is rule-only) |
