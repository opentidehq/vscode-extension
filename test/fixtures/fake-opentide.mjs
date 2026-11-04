#!/usr/bin/env node
// A fake `opentide` for tests: `--version`, `--json <command>` and `serve` (CONTRACTS.md).
// FAKE_VERSION sets the version; FAKE_NO_SERVE=1 leaves `serve` out of `commands`; FAKE_LINT_FILE=1 adds
// `lint --file` (opentide#755); FAKE_INFO_CATALOG=1 adds `info catalog`; FAKE_TENANTS=1 adds tenants to
// `info` (opentide#754); FAKE_SETUP_PLAN=1 adds `setup --plan` and its flags (opentide#751);
// FAKE_DEPLOY_SELECT=1 adds `deploy --uuid/--file` (opentide#753).
// `validate`, `lint`, `explain`, `new`, `info`, `doctor` and `setup …` follow the real shapes and rules:
// findings carry `end_line`; `--file` takes only files directly in a family folder (lint fails with
// command_failed, validate answers scope_no_match); `new` gives a taken name the UUID's first 8 characters
// and refuses only a file named with `--path` (path_exists).
// Panels (query, deploy plan, matrix): `info catalog` with FAKE_CATALOG_FIXTURE=1 prints panels/catalog.json;
// `query` answers per tenant (FAKE_QUERY_TENANTS, default "prod"; a tenant named "dev" fails with 403;
// FAKE_QUERY_DELAY_MS waits, cancellably); `deploy --dry-run` prints panels/deploy-dry-run.json, and
// `deploy` without --dry-run fails with `fake_real_deploy`; `generate exports navigator` reports its layer
// file. FAKE_INFO_PLAIN=1 makes `info` with no section a usage error.
// Graph and search: FAKE_CATALOG_FILE names a JSON file whose keys (objects, edges, signals, attack,
// summary) `info catalog` prints; FAKE_UNREVIEWED lists the paths (comma-separated) `rules unreviewed` reports.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const version = process.env.FAKE_VERSION ?? "0.21.0";
const argv = process.argv.slice(2);

function envelope(command, extra = {}, exitCode = 0, failure = null) {
  return {
    ok: exitCode === 0,
    status: exitCode === 0 ? "completed" : "failed",
    message: failure ? failure.message : "done",
    schema_version: 1,
    command,
    duration_ms: 1,
    exit_code: exitCode,
    summary: {},
    next_actions: [],
    failure,
    ...extra,
  };
}

function commandsDocument() {
  const fixture = JSON.parse(readFileSync(join(here, "commands-0.20.1.json"), "utf8"));
  fixture.version = version;
  if (process.env.FAKE_NO_SERVE !== "1") {
    fixture.commands.push({
      path: "serve",
      name: "serve",
      summary: "Serve CLI commands over JSON-RPC on stdio",
      group: false,
      runs_alone: true,
      subcommands: [],
      deprecated: false,
      arguments: [],
      options: [],
      output_schema: null,
    });
  }
  if (process.env.FAKE_LINT_FILE === "1") {
    const lint = fixture.commands.find((c) => c.path === "lint");
    lint.options.push({
      name: "file",
      flags: ["--file"],
      secondary_flags: [],
      type: "text",
      choices: null,
      default: null,
      required: false,
      multiple: true,
      is_flag: false,
      envvars: [],
      help: "Lint only this object file (repeatable)",
    });
  }
  if (process.env.FAKE_DEPLOY_SELECT === "1") {
    const deploy = fixture.commands.find((c) => c.path === "deploy");
    for (const name of ["uuid", "file"]) {
      deploy.options.push({
        name,
        flags: [`--${name}`],
        secondary_flags: [],
        type: "string",
        choices: null,
        default: null,
        required: false,
        multiple: true,
        is_flag: false,
        envvars: [],
        help: `Read the rule with this ${name} (repeatable)`,
      });
    }
  }
  if (process.env.FAKE_INFO_CATALOG === "1") {
    const info = fixture.commands.find((c) => c.path === "info");
    info.arguments[0].choices.push("catalog");
  }
  if (process.env.FAKE_SETUP_PLAN === "1") {
    const flag = (name, extra = {}) => ({
      name,
      flags: [`--${name}`],
      secondary_flags: [],
      type: "boolean",
      is_flag: true,
      ...extra,
    });
    for (const command of fixture.commands.filter((c) => c.path.startsWith("setup"))) {
      command.options.push(flag("plan"));
      if (command.path !== "setup") continue;
      const hosts = (name, choices) =>
        flag(name, { type: "choice", is_flag: false, multiple: true, choices });
      command.options.push(
        hosts("mcp", ["vscode", "cursor", "claude-code", "generic"]),
        hosts("skills", ["claude-code", "cursor", "github-copilot", "generic"]),
        flag("plugin"),
        flag("hooks"),
        flag("env"),
      );
    }
  }
  return envelope("commands", fixture);
}

const ENV_KEYS = [
  "OPENTIDE_REPO_ROOT",
  "NO_COLOR",
  "OPENTIDE_PROXY",
  "OPENTIDE_PROGRESS",
  "FAKE_SECRET",
  "PATH",
  "COLUMNS",
  "OPENTIDE_LINKS",
];
const PLATFORMS = [
  ["carbon_black_cloud", true, true],
  ["crowdstrike", false, true],
  ["defender_for_endpoint", true, true],
  ["elastic", true, true],
  ["harfanglab", false, true],
  ["sentinel", true, true],
  ["sentinel_one", true, true],
  ["splunk", true, true],
  ["sysdig", false, false],
];
const TENANT_VARIABLES = ["AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"];
const isSet = (env, name) => typeof env[name] === "string" && env[name] !== "";

/** `info`: platforms (sentinel and splunk enabled), and with FAKE_TENANTS=1 sentinel's `prod` tenant. */
function infoDocument(env) {
  const platforms = PLATFORMS.map(([name, canValidate, canQuery]) => ({
    name,
    enabled: name === "sentinel" || name === "splunk",
    can_deploy: true,
    can_validate: canValidate,
    can_query: canQuery,
    ...(process.env.FAKE_TENANTS === "1"
      ? {
          tenants:
            name === "sentinel"
              ? [
                  {
                    name: "prod",
                    description: "Production",
                    strategies: ["PREVIEW", "RELEASE"],
                    manual: false,
                    variables: TENANT_VARIABLES.map((v) => ({ name: v, set: isSet(env, v) })),
                  },
                ]
              : [],
        }
      : {}),
  }));
  return envelope("info", { version, platforms, counts: { rules: 1, threats: 1, objectives: 1 } });
}

/** `doctor`: a few checks, and sentinel/prod's `credentials` from the environment, as doctor reads it. */
function doctorDocument(env, offline) {
  const unset = TENANT_VARIABLES.filter((v) => !isSet(env, v));
  const checks = [
    { code: "opentide_version", status: "pass", message: `opentide ${version}`, fix: null, subject: null },
    {
      code: "opentide_latest",
      status: offline ? "skip" : "pass",
      message: offline ? "Not checked: --offline" : "Up to date",
      fix: null,
      subject: null,
    },
    {
      code: "templates_fresh",
      status: "warn",
      message: "1 template(s) differ from what this version generates",
      fix: "opentide generate templates",
      subject: null,
    },
    {
      code: "credentials",
      status: unset.length ? "warn" : "pass",
      message: unset.length
        ? `sentinel/prod: ${unset.length} of 2 variables unset: ${unset.join(", ")}`
        : "sentinel/prod: 2 variables set",
      fix: unset.length ? `set ${unset.join(", ")} in the environment (or a .env file you load)` : null,
      subject: "sentinel/prod",
    },
  ];
  const warnings = checks.filter((c) => c.status === "warn").length;
  return envelope("doctor", {
    checks,
    summary: {
      checks: checks.length,
      passed: checks.filter((c) => c.status === "pass").length,
      warnings,
      failed: 0,
    },
  });
}

/** `setup [sub] … --plan | --yes`, as #751 and 0.21.0 print them. */
function setupDocument(args) {
  const [sub] = args;
  const plan = args.includes("--plan");
  if (plan && process.env.FAKE_SETUP_PLAN !== "1")
    return [envelope("setup", {}, 2, { code: "usage_error", message: "No such option: --plan" }), 2];
  if (!plan && !args.includes("--yes"))
    return [
      envelope("setup", {}, 2, { code: "usage_needs_input", message: "setup needs --yes under --json" }),
      2,
    ];
  const files = {
    repo: ["README.md", ".gitignore", ".opentide/configurations/platforms/sentinel.toml"],
    ci: [".github/workflows/opentide.yml"],
    env: [".env.example", ".gitignore"],
    hooks: [".pre-commit-config.yaml", ".opentide/hooks/pre-commit"],
    mcp: [".cursor/mcp.json"],
    skills: [".agents/skills/opentide-detection-rule/SKILL.md", "AGENTS.md"],
  };
  const steps = sub && !sub.startsWith("-") ? [sub === "repo" ? "repo" : sub] : ["repo", "platforms"];
  if (!sub || sub.startsWith("-")) {
    if (args.includes("--ci")) steps.push("ci");
    for (const [flag, step] of [
      ["--env", "env"],
      ["--hooks", "hooks"],
      ["--mcp", "mcp"],
      ["--skills", "skills"],
    ])
      if (args.includes(flag)) steps.push(step);
  }
  if (plan) {
    const seen = new Set();
    const planned = steps.map((step) => ({
      step,
      files: (files[step] ?? []).map((path) => {
        const action = seen.has(path) ? "merge" : "create";
        seen.add(path);
        return { path, action };
      }),
      warnings: [],
    }));
    const count = (a) => planned.reduce((n, s) => n + s.files.filter((f) => f.action === a).length, 0);
    return [
      envelope("setup", {
        plan: true,
        path: process.cwd(),
        steps: planned,
        warnings: [],
        summary: { create: count("create"), merge: count("merge"), skip: 0, steps: planned.length },
      }),
      0,
    ];
  }
  if (steps.length === 1) return [envelope(`setup ${sub}`, { files: files[sub] ?? [] }), 0];
  return [
    envelope("setup", {
      steps: steps.map((step) => ({ step, message: `${step} done`, files: files[step] ?? [] })),
    }),
    0,
  ];
}

const pick = (env) =>
  Object.fromEntries(ENV_KEYS.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));

/** The values of a repeatable option. */
const optionValues = (args, flag) =>
  args.flatMap((a, i) => (a === flag && args[i + 1] !== undefined ? [args[i + 1]] : []));

/** The family folders: objects/{threats,objectives,rules}/, or what paths.toml `[paths.objects]` names. */
function familyFolders(root) {
  const folders = { threat: "objects/threats/", objective: "objects/objectives/", rule: "objects/rules/" };
  const toml = join(root, ".opentide", "configurations", "paths.toml");
  if (existsSync(toml))
    for (const m of readFileSync(toml, "utf8").matchAll(/^\s*(threat|objective|rule)\s*=\s*"([^"]+)"/gm))
      folders[m[1]] = m[2].endsWith("/") ? m[2] : `${m[2]}/`;
  return Object.values(folders);
}

/** As the real CLI: `--file` takes only a YAML file directly in a family folder. */
function directlyInFamily(root, file) {
  const rel = relative(root, file).split("\\").join("/");
  return familyFolders(root).some((dir) => rel.startsWith(dir) && !rel.slice(dir.length).includes("/"));
}

function objectFiles(root) {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.ya?ml$/.test(name)) out.push(full);
    }
  };
  walk(join(root, "objects"));
  for (const dir of familyFolders(root)) if (!dir.startsWith("objects/")) walk(join(root, dir));
  return [...new Set(out)].sort();
}

/** Code points, 1-based, as the CLI counts columns. */
const codePointColumn = (line, utf16) => [...line.slice(0, utf16)].length + 1;

/** `validate`: a `vocab_unknown` finding (with its fix) for each `tlp: ambr`, on each file or every object file. */
function validate(root, args) {
  const files = optionValues(args, "--file").map((f) => resolve(root, f));
  const outside = files.filter((f) => !directlyInFamily(root, f));
  if (files.length > 0 && outside.length === files.length)
    return [
      envelope(
        "validate",
        {
          status: "failed",
          workspace: root,
          report: {
            ok: false,
            issues: [
              {
                code: "scope_no_match",
                severity: "error",
                object_uuid: "",
                object_type: "",
                file_path: null,
                yaml_line: null,
                field_path: [],
                message: "No objects matched the validation scope (check --file, --uuid, --type)",
                path: null,
                line: null,
                column: null,
                end_line: null,
                end_column: null,
              },
            ],
            warnings: [],
          },
        },
        1,
        { code: "issues_found", message: "Validation failed" },
      ),
      1,
    ];
  const issues = [];
  for (const file of files.length > 0 ? files : objectFiles(root)) {
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((text, index) => {
      const at = text.indexOf("ambr");
      if (at < 0 || !/tlp:/.test(text)) return;
      const column = codePointColumn(text, at);
      issues.push({
        code: "vocab_unknown",
        severity: "error",
        object_uuid: "",
        object_type: "rule",
        file_path: file,
        yaml_line: index,
        field_path: ["metadata", "tlp"],
        message: "Value 'ambr' is not a valid 'tlp::1.0' vocabulary entry",
        suggestion: "amber",
        context: { vocab: "tlp::1.0", value: "ambr" },
        path: relative(root, file).split("\\").join("/"),
        line: index + 1,
        column,
        end_line: index + 1,
        end_column: column + 4,
        help: "did you mean 'amber'?",
        fix: {
          safe: false,
          edits: [
            { line: index + 1, column, end_line: index + 1, end_column: column + 4, replacement: "amber" },
          ],
        },
        explain: "opentide explain vocab_unknown",
      });
    });
  }
  const exit = issues.length > 0 ? 1 : 0;
  return [
    envelope(
      "validate",
      {
        status: exit ? "failed" : "passed",
        workspace: root,
        report: { ok: exit === 0, issues, warnings: [] },
        summary: { objects: files.length, errors: issues.length, warnings: 0 },
      },
      exit,
      exit ? { code: "issues_found", message: "Validation failed" } : null,
    ),
    exit,
  ];
}

/** `lint`: a `placeholder` warning per `# opentide:placeholder` line. */
function lint(root, args) {
  const targets = optionValues(args, "--file");
  if (targets.length > 0 && process.env.FAKE_LINT_FILE !== "1")
    return [envelope("lint", {}, 2, { code: "usage_no_such_option", message: "No such option: --file" }), 2];
  const outside = targets.filter(
    (t) => existsSync(resolve(root, t)) && !directlyInFamily(root, resolve(root, t)),
  );
  if (outside.length > 0) {
    const message = `No object file directly in ${familyFolders(root)
      .map((d) => d.replace(/\/$/, ""))
      .join(", ")} matched: ${outside.join(", ")}`;
    return [
      envelope(
        "lint",
        { path: root, findings: [], count: 0, fixed: 0, unmatched: outside, error: message },
        1,
        {
          code: "command_failed",
          message,
        },
      ),
      1,
    ];
  }
  const files = targets.length > 0 ? targets.map((f) => resolve(root, f)) : objectFiles(root);
  const unmatched = targets.filter((t) => !existsSync(resolve(root, t)));
  const findings = [];
  for (const file of files.filter((f) => existsSync(f))) {
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((text, index) => {
        if (!text.includes("# opentide:placeholder")) return;
        const key = text.indexOf(text.trimStart());
        findings.push({
          check: "placeholders",
          severity: "warning",
          path: relative(root, file).split("\\").join("/"),
          yaml_line: index,
          uuid: null,
          help: "replace the value, then delete the '# opentide:placeholder' comment",
          line: index + 1,
          column: key + 1,
          end_line: index + 1,
          end_column: key + 2,
          message: "holds a placeholder value written by opentide new",
          code: "placeholder",
          field_path: [],
          fix: null,
          explain: "opentide explain placeholder",
        });
      });
  }
  if (unmatched.length > 0)
    return [
      envelope("lint", { path: root, findings: [], scope: "selected", unmatched }, 1, {
        code: "usage_bad_parameter",
        message: `--file matched no object file: ${unmatched.join(", ")}`,
        argument: "--file",
      }),
      1,
    ];
  return [
    envelope("lint", {
      status: findings.length ? "issues" : "passed",
      path: root,
      findings,
      count: findings.length,
      fixed: 0,
      ...(targets.length ? { scope: "selected", unmatched: [] } : {}),
      summary: {
        files: files.length,
        findings: findings.length,
        errors: 0,
        warnings: findings.length,
        notes: 0,
      },
    }),
    0,
  ];
}

const slug = (name) =>
  name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "object";

/** `new threat|objective|rule`: writes the file the way the real templates do, with placeholders. */
function newObject(root, type, args) {
  const name = optionValues(args, "--name")[0];
  if (!name)
    return [
      envelope(`new ${type}`, {}, 2, { code: "usage_needs_input", message: "Missing option '--name'." }),
      2,
    ];
  if (!existsSync(join(root, "objects")) && !existsSync(join(root, ".opentide")))
    return [
      envelope(`new ${type}`, {}, 1, { code: "workspace_not_found", message: "No opentide workspace here." }),
      1,
    ];
  const objective = optionValues(args, "--objective")[0];
  if (objective === "00000000-0000-0000-0000-000000000000")
    return [
      envelope(`new ${type}`, {}, 2, {
        code: "reference_not_found",
        message: `No objective in objects/objectives has uuid ${objective}`,
        argument: "--objective",
      }),
      2,
    ];
  const target = optionValues(args, "--path")[0];
  const uuid = randomUUID();
  let folder = join(root, "objects", `${type}s`);
  let file = join(folder, `${slug(name)}.yaml`);
  const explicitFile = Boolean(target?.endsWith(".yaml"));
  if (target) {
    const full = isAbsolute(target) ? target : resolve(root, target);
    if (explicitFile) file = full;
    else {
      folder = full;
      file = join(full, `${slug(name)}.yaml`);
    }
  }
  // As the real CLI: a name taken in the folder gets the UUID's first 8 characters; only a file named
  // with --path is refused.
  if (!explicitFile && existsSync(file)) file = join(folder, `${slug(name)}-${uuid.slice(0, 8)}.yaml`);
  if (existsSync(file))
    return [
      envelope(`new ${type}`, {}, 1, {
        code: "path_exists",
        message: `${relative(root, file).split("\\").join("/")} already exists; new never overwrites a file`,
        argument: "--path",
      }),
      1,
    ];
  const platforms = optionValues(args, "--platform");
  const lines = [
    `name: ${name}`,
    "",
    "metadata:",
    `  uuid: ${uuid}`,
    "  tlp: amber",
    "description: |  # opentide:placeholder",
    "  ...",
  ];
  if (type === "rule") {
    lines.push(`detection_model: ${objective ?? "...  # opentide:placeholder"}`, "configurations:");
    for (const platform of platforms)
      lines.push(`  ${platform}:`, "    enabled: true", "    query: |  # opentide:placeholder", "      ...");
  }
  if (type === "objective")
    for (const threat of optionValues(args, "--threat")) lines.push(`threats: [${threat}]`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join("\n")}\n`);
  const placeholders = lines.filter((l) => l.includes("# opentide:placeholder")).length;
  return [
    envelope(`new ${type}`, {
      path: relative(root, file).split("\\").join("/"),
      file_path: file,
      uuid,
      type,
      name,
      platforms,
      placeholders: Array.from({ length: placeholders }, (_, i) => `placeholder.${i}`),
      message: `Created ${relative(root, file)} · ${placeholders} placeholders to replace`,
      summary: { created: 1, placeholders },
    }),
    0,
  ];
}

/** Run one command; `emit` sends a progress event; resolves to [document, exitCode]. */
async function runCommand(args, { env, cwd, emit, cancelled }) {
  const [name, ...rest] = args;
  const root = env.OPENTIDE_REPO_ROOT ?? cwd;
  switch (name) {
    case "validate":
      return validate(root, rest);
    case "lint":
      return lint(root, rest);
    case "new":
      if (["threat", "objective", "rule"].includes(rest[0])) return newObject(root, rest[0], rest.slice(1));
      return [envelope("new", {}, 2, { code: "usage_needs_input", message: "Missing command." }), 2];
    case "commands":
      return [commandsDocument(), 0];
    case "crash-once":
    case "echo":
      return [envelope("echo", { argv: args, env: pick(env), cwd }), 0];
    case "fail":
      return [envelope("fail", {}, 1, { code: "workspace_not_found", message: "no workspace" }), 1];
    case "progress":
      emit({ event: "progress", step: "load", done: 1, total: 2 });
      emit({ event: "tenant", platform: "sentinel", tenant: "prod", status: "ok", rows: 3, elapsed_ms: 5 });
      return [envelope("progress"), 0];
    case "slow": {
      const ms = Number(rest[0] ?? 5000);
      const started = Date.now();
      while (Date.now() - started < ms) {
        if (cancelled())
          return [envelope("slow", {}, 130, { code: "cancelled", message: "Interrupted" }), 130];
        await new Promise((r) => setTimeout(r, 20));
      }
      return [envelope("slow"), 0];
    }
    case "explain":
      // `explain` lists every code; `explain <code>` explains one (the real shapes, abridged).
      if (rest[0] === undefined)
        return [
          envelope("explain", {
            codes: [
              { code: "vocab_unknown", meaning: "A value is not in the vocabulary its field uses." },
              { code: "placeholder", meaning: "A template placeholder is still in the file." },
              { code: "workspace_not_found", meaning: "No workspace here." },
            ],
            summary: { codes: 3 },
          }),
          0,
        ];
      if (rest[0] === "vocab_unknown" || rest[0] === "placeholder")
        return [
          envelope("explain", {
            code: rest[0],
            meaning: "A value is not in the vocabulary its field uses.",
            markdown: `# ${rest[0]}\n\nA value is not in the vocabulary its field uses.\n`,
          }),
          0,
        ];
      return [
        envelope("explain", {}, 2, {
          code: "usage_invalid_choice",
          message: `No diagnostic code '${rest[0]}'. Run 'opentide explain' to list them.`,
          argument: "code",
        }),
        2,
      ];
    case "doctor":
      return [doctorDocument(env, rest.includes("--offline")), 0];
    case "setup":
      return setupDocument(rest);
    case "query":
      return runQuery(rest, { emit, cancelled });
    case "deploy":
      return runDeploy(rest);
    case "generate":
      if (rest[0] === "exports" && rest[1] === "navigator") {
        return [
          envelope("generate exports navigator", {
            target: "navigator",
            steps: [
              {
                name: "navigator",
                status: "ok",
                count: 1,
                unit: "layer",
                seconds: 0.1,
                where: ".opentide/exports/attack-navigator.json",
              },
            ],
          }),
          0,
        ];
      }
      return [
        envelope("generate", {}, 2, {
          code: "usage_unknown_command",
          message: "fake: only exports navigator",
        }),
        2,
      ];
    case "info":
      if ((rest[0] === undefined || rest[0].startsWith("--")) && !process.env.FAKE_INFO_PLAIN) {
        return [infoDocument(env), 0];
      }
      if (
        rest[0] === "catalog" &&
        process.env.FAKE_INFO_CATALOG === "1" &&
        process.env.FAKE_CATALOG_FIXTURE === "1"
      ) {
        return [JSON.parse(readFileSync(join(here, "panels", "catalog.json"), "utf8")), 0];
      }
      if (rest[0] === "catalog" && process.env.FAKE_INFO_CATALOG === "1") {
        const catalog = process.env.FAKE_CATALOG_FILE
          ? JSON.parse(readFileSync(process.env.FAKE_CATALOG_FILE, "utf8"))
          : { objects: [], edges: [], signals: [], attack: { tactics: [], techniques: {} } };
        return [envelope("info", catalog), 0];
      }
      return [
        envelope("info", {}, 2, {
          code: "usage_invalid_choice",
          message: `Unknown info section: ${rest[0]}`,
        }),
        2,
      ];
    case "rules":
      if (rest[0] === "unreviewed") {
        const at = rest.indexOf("--older-than");
        const window = at >= 0 ? rest[at + 1] : "90d";
        const paths = (process.env.FAKE_UNREVIEWED ?? "").split(",").filter(Boolean);
        const rules = paths.map((path) => ({ path, schema: "rule::1.1", reason: "absent", reviewed: null }));
        return [
          envelope("rules", { evaluated_at: "2026-11-03T00:00:00Z", window, count: rules.length, rules }),
          0,
        ];
      }
      return [envelope("rules", {}, 2, { code: "usage_missing_command", message: "Missing command." }), 2];
    default:
      return [
        envelope(name ?? "", {}, 2, { code: "usage_unknown_command", message: `No such command '${name}'.` }),
        2,
      ];
  }
}

/** Every value of a repeatable flag. */
function values(args, flag) {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag && i + 1 < args.length) out.push(args[++i]);
  return out;
}

async function runQuery(args, { emit, cancelled }) {
  const platform = values(args, "--platform")[0] ?? "";
  const configured = (process.env.FAKE_QUERY_TENANTS ?? "prod").split(",");
  let tenants = values(args, "--tenant");
  if (tenants.includes("all")) tenants = configured;
  const base = {
    platform,
    source: values(args, "--rule").length || values(args, "--file").length ? "rule" : "query",
  };
  if (tenants.length === 0) {
    if (configured.length > 1) {
      const message = `${platform} has ${configured.length} tenants (${configured.join(", ")}): name one with --tenant, or pass --tenant all`;
      return [
        envelope("query", { ...base, choices: [...configured, "all"], error: message }, 2, {
          code: "usage_invalid_value",
          message,
          argument: "--tenant",
          suggestion: null,
          crash_log: null,
        }),
        2,
      ];
    }
    tenants = configured;
  }
  const limit = Number(values(args, "--limit")[0] ?? 100);
  const delay = Number(process.env.FAKE_QUERY_DELAY_MS ?? 0);
  const results = [];
  for (const tenant of tenants) {
    const started = Date.now();
    while (Date.now() - started < delay) {
      if (cancelled())
        return [envelope("query", base, 130, { code: "interrupted", message: "Interrupted" }), 130];
      await new Promise((r) => setTimeout(r, 20));
    }
    if (tenant === "dev") {
      results.push({
        tenant,
        status: "failed",
        error: "HTTP 403 Forbidden",
        detail: "AuthorizationFailed",
        warnings: [],
        elapsed_ms: 40,
      });
      emit({ event: "tenant", platform, tenant, status: "failed", rows: 0, elapsed_ms: 40 });
      continue;
    }
    const all = Array.from({ length: 3 }, (_, i) => ({
      TimeGenerated: `2026-11-03T09:1${i}:00Z`,
      DeviceName: `ws-${i}`,
      Count: i * 10,
    }));
    const rows = all.slice(0, limit);
    results.push({
      tenant,
      status: "ok",
      columns: [
        { name: "TimeGenerated", type: "datetime" },
        { name: "DeviceName", type: "string" },
        { name: "Count", type: "long" },
      ],
      rows,
      row_count: rows.length,
      truncated: all.length > limit,
      sent: "DeviceProcessEvents | take 3",
      vendor_query_id: `fake-${tenant}`,
      warnings: [],
      elapsed_ms: 1800,
    });
    emit({ event: "tenant", platform, tenant, status: "ok", rows: rows.length, elapsed_ms: 1800 });
  }
  const failed = results.filter((r) => r.status === "failed");
  const rowCount = results.reduce((n, r) => n + (r.rows?.length ?? 0), 0);
  const extra = {
    ...base,
    tenants,
    results,
    row_count: rowCount,
    argv: args,
    window: { from: "2026-11-02T00:00:00Z", to: "2026-11-03T00:00:00Z" },
    limit,
  };
  if (failed.length > 0) {
    const message = `${failed.length} of ${results.length} queries failed on ${tenants.length} ${platform} tenants`;
    return [envelope("query", extra, 1, { code: "command_failed", message }), 1];
  }
  return [envelope("query", extra), 0];
}

function runDeploy(args) {
  if (!args.includes("--dry-run")) {
    return [
      envelope("deploy", { argv: args }, 99, {
        code: "fake_real_deploy",
        message: "the fake refuses a real deploy",
      }),
      99,
    ];
  }
  const unmatched = values(args, "--uuid").filter((u) => u === "nope");
  if (unmatched.length > 0) {
    return [
      envelope("deploy", { argv: args, unmatched, scope: "selected" }, 1, {
        code: "command_failed",
        message: "1 selection matched no rule",
      }),
      1,
    ];
  }
  const plan = JSON.parse(readFileSync(join(here, "panels", "deploy-dry-run.json"), "utf8"));
  return [
    {
      ...plan,
      argv: args,
      ...(values(args, "--uuid").length || values(args, "--file").length ? { scope: "selected" } : {}),
    },
    0,
  ];
}

async function serve() {
  const invalidated = [];
  const cancels = new Set();
  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const queue = [];
  let busy = false;
  const pump = async () => {
    if (busy) return;
    busy = true;
    while (queue.length > 0) {
      const message = queue.shift();
      await handle(message);
    }
    busy = false;
  };
  const handle = async (message) => {
    const { id, method, params } = message;
    if (method === "initialize") {
      // FAKE_SERVE_INIT_DELAY_MS answers late; FAKE_SERVE_PROTOCOL answers with another protocol.
      const delay = Number(process.env.FAKE_SERVE_INIT_DELAY_MS ?? 0);
      if (delay > 0) await new Promise((done) => setTimeout(done, delay));
      const protocol = Number(process.env.FAKE_SERVE_PROTOCOL ?? 1);
      return send({ id, result: { protocol, version, commands_digest: "fake-digest" } });
    }
    if (method === "shutdown") return send({ id, result: null });
    if (method === "run") {
      if (!params || !Array.isArray(params.argv))
        return send({ id, error: { code: -32602, message: "run needs argv" } });
      if (params.argv[0] === "crash") process.exit(3);
      if (params.argv[0] === "crash-once" && !existsSync(process.env.FAKE_CRASH_FILE)) {
        writeFileSync(process.env.FAKE_CRASH_FILE, "crashed");
        process.exit(3);
      }
      if (params.argv[0] === "invalidated")
        return send({
          id,
          result: { document: envelope("invalidated", { paths: invalidated }), exit_code: 0 },
        });
      const [document, exit_code] = await runCommand(params.argv, {
        env: {
          ...(params.env ?? {}),
          NO_COLOR: process.env.NO_COLOR,
          OPENTIDE_PROXY: process.env.OPENTIDE_PROXY,
        },
        cwd: params.cwd,
        emit: (event) => send({ method: "progress", params: { id, event } }),
        cancelled: () => cancels.has(id),
      });
      return send({ id, result: { document, exit_code } });
    }
    if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  };
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return send({ id: null, error: { code: -32700, message: "Parse error" } });
    }
    // Notifications act at once; requests are handled one at a time, in order.
    if (message.method === "$/cancelRequest") return void cancels.add(message.params?.id);
    if (message.method === "invalidate") return void invalidated.push(...(message.params?.paths ?? []));
    if (message.method === "exit") process.exit(0);
    queue.push(message);
    void pump();
  });
}

if (argv[0] === "--version") {
  process.stdout.write(`opentide ${version}\n`);
} else if (argv[0] === "serve") {
  if (process.env.FAKE_SERVE_BROKEN === "1") {
    process.stderr.write("serve: cannot start\n");
    process.exit(2);
  }
  await serve();
} else {
  const args = argv.filter((a) => a !== "--json");
  let interrupted = false;
  process.on("SIGINT", () => {
    interrupted = true;
  });
  const emit = (event) => {
    if (process.env.OPENTIDE_PROGRESS === "json") process.stderr.write(`${JSON.stringify(event)}\n`);
  };
  if (args[0] === "garbage") {
    process.stdout.write("this is not json\n");
    process.stderr.write("Traceback: boom\n");
    process.exit(1);
  }
  process.stderr.write("a log line\n");
  const [document, exitCode] = await runCommand(args, {
    env: process.env,
    cwd: process.cwd(),
    emit,
    cancelled: () => interrupted,
  });
  process.stdout.write(`${JSON.stringify(document)}\n`);
  process.exit(exitCode);
}
