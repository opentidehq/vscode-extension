#!/usr/bin/env node
// A fake `opentide` for tests: `--version`, `--json <command>` and `serve` (CONTRACTS.md).
// FAKE_VERSION sets the version; FAKE_NO_SERVE=1 leaves `serve` out of `commands`.
// FAKE_INFO_CATALOG=1 adds `info catalog`; FAKE_TENANTS=1 adds tenants to `info` (opentide#754);
// FAKE_SETUP_PLAN=1 adds `setup --plan` and its flags (opentide#751). `info`, `doctor`, `setup …` and
// `migrate objects` answer with the shapes the real commands print.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  if (!fixture.commands.some((c) => c.path === "migrate objects")) {
    fixture.commands.push({
      path: "migrate objects",
      name: "objects",
      summary: "Move a legacy layout into objects/ and .opentide/",
      group: false,
      subcommands: [],
      deprecated: false,
      arguments: [],
      options: [
        { name: "apply", flags: ["--apply"], secondary_flags: [], type: "boolean", is_flag: true },
        { name: "copy", flags: ["--copy"], secondary_flags: [], type: "boolean", is_flag: true },
      ],
      output_schema: null,
    });
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

/** Run one command; `emit` sends a progress event; resolves to [document, exitCode]. */
async function runCommand(args, { env, cwd, emit, cancelled }) {
  const [name, ...rest] = args;
  switch (name) {
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
    case "doctor":
      return [doctorDocument(env, rest.includes("--offline")), 0];
    case "setup":
      return setupDocument(rest);
    case "migrate":
      if (rest[0] !== "objects")
        return [
          envelope("migrate", {}, 2, {
            code: "usage_unknown_command",
            message: `No such command '${rest[0]}'.`,
          }),
          2,
        ];
      return [
        envelope("migrate objects", {
          dry_run: !rest.includes("--apply"),
          copy: rest.includes("--copy"),
          operations: [
            { from: "Configurations", to: ".opentide/configurations", action: "move" },
            { from: "Objects/Detection Rules", to: "objects/rules", action: "move" },
            {
              from: "Objects/Detection Objectives",
              to: "objects/objectives",
              action: "skip",
              reason: "source missing",
            },
          ],
          planned: 2,
          skipped: 1,
          applied: rest.includes("--apply"),
        }),
        0,
      ];
    case "info":
      if (rest.length === 0) return [infoDocument(env), 0];
      if (rest[0] === "catalog" && process.env.FAKE_INFO_CATALOG === "1") {
        return [
          envelope("info", { objects: [], edges: [], signals: [], attack: { tactics: [], techniques: {} } }),
          0,
        ];
      }
      return [
        envelope("info", {}, 2, {
          code: "usage_invalid_choice",
          message: `Unknown info section: ${rest[0]}`,
        }),
        2,
      ];
    default:
      return [
        envelope(name ?? "", {}, 2, { code: "usage_unknown_command", message: `No such command '${name}'.` }),
        2,
      ];
  }
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
    if (method === "initialize")
      return send({ id, result: { protocol: 1, version, commands_digest: "fake-digest" } });
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
