# Skills directory

Canonical skill content for opentide. Each skill is a folder containing a required `SKILL.md` file following the [Agent Skills specification](https://agentskills.io/specification).

## Structure

```
<skill-name>/
├── SKILL.md
├── references/     # optional — loaded on demand
├── scripts/        # optional
└── assets/         # optional
```

## SKILL.md frontmatter

Every `SKILL.md` must start with YAML frontmatter:

```yaml
---
name: skill-name
description: Brief description of what this skill does and when to use it
---
```

The `name` must match the parent directory name (lowercase, hyphens, max 64 characters). The `description` is at most 1024 characters and says when to use the skill; quote it, or use a `>-` block, when it contains `: `, or it is not valid YAML.

## Skills index

### opentide content authoring
| Skill | Purpose |
|---|---|
| `opentide-threat` | TVM authoring |
| `opentide-objective` | DOM authoring |
| `opentide-rule` | MDR authoring |
| `opentide-visibility` | Visibility configuration — log sources, assets, external detectors |

### Detection-engineering practice
| Skill | Purpose |
|---|---|
| `detection-engineering` | Hunt-to-rule lifecycle, platform pairing |
| `threat-hunting` | ABLE hypothesis framework, hunt conversion |
| `mitre-attack` | ATT&CK mapping discipline (v19 baseline) |

### Languages & platforms (20)
`kusto-query-language`, `microsoft-sentinel`, `microsoft-defender-endpoint`, `entra-id`, `windows-event-logs`, `splunk-spl-processing`, `crowdstrike-falcon`, `carbon-black-cloud`, `sentinelone-singularity`, `harfanglab`, `elastic-security`, `sysdig-secure`, `bitdefender-gravityzone`, `graylog`, `exabeam-siem`, `google-secops`, `okta-identity`, `amazon-web-services`, `microsoft-azure`, `google-cloud-platform`

Every opentide platform (`configurations.<key>`) has a skill; [`coverage.json`](../coverage.json) is the map.

### Defensive internals (7)
`windows-internals`, `active-directory`, `identity-providers`, `network-protocols`, `email-and-collaboration`, `linux-internals`, `macos-internals`

Full descriptions: [`AGENTS.md`](../AGENTS.md#skills-index-skills).

## Adding or editing a skill

1. Create or edit `skills/<skill-name>/SKILL.md`.
2. A new skill also goes into `../skills.sh.json`, the index above, and `../AGENTS.md`; a platform skill also goes into `../coverage.json` and must name its `configurations.<key>`.
3. Run `../scripts/validate-skills.sh`.
4. Run `../scripts/build-manifest.sh` and commit the updated root `manifest.json`.
5. Open a pull request.

### Platform skills

A platform skill teaches the platform, not opentide's field list: rule types, query language idioms and pitfalls, field model, scheduling, exclusions, entity alignment, anti-patterns and an authoring checklist. Its opentide section says what `opentide deploy` does there, what `--live` validation and the offline engine check, and whether `opentide query` runs — taken from opentide's source and `AGENTS.md`, never assumed. Configuration structure is resolved from the engine's schema (`opentide://schemas/rule` or `.opentide/schemas/`), and capabilities from `opentide --json info --platform <key>`, as `opentide-rule` explains, so the skill does not go stale when a field is added.

Skills follow opentide's releases: see [Keeping skills in step with opentide](../AGENTS.md#keeping-skills-in-step-with-opentide).

Harness plugin manifests at the repo root reference `./skills/` automatically — no sync or copy step for those. The opentide CLI reads `manifest.json` for discover/show/install.
