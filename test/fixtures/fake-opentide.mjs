#!/usr/bin/env node
// A fake `opentide` for tests: `--version`, `--json <command>` and `serve` (CONTRACTS.md).
// FAKE_VERSION sets the version; FAKE_NO_SERVE=1 leaves `serve` out of `commands`.
// Panels (query, deploy plan, matrix): `info` prints test/fixtures/panels/info.json (FAKE_TENANTS=1 adds
// tenants); `info catalog` with FAKE_CATALOG_FIXTURE=1 prints panels/catalog.json; `query` answers per
// tenant (FAKE_QUERY_TENANTS, default "prod"; a tenant named "dev" fails with 403; FAKE_QUERY_DELAY_MS
// waits, cancellably); `deploy --dry-run` prints panels/deploy-dry-run.json, and `deploy` without
// --dry-run fails with `fake_real_deploy`; `generate exports navigator` reports its layer file.
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
        return [envelope("info", infoDocument()), 0];
      }
      if (
        rest[0] === "catalog" &&
        process.env.FAKE_INFO_CATALOG === "1" &&
        process.env.FAKE_CATALOG_FIXTURE === "1"
      ) {
        return [JSON.parse(readFileSync(join(here, "panels", "catalog.json"), "utf8")), 0];
      }
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

function infoDocument() {
  const info = JSON.parse(readFileSync(join(here, "panels", "info.json"), "utf8"));
  if (process.env.FAKE_TENANTS === "1") {
    for (const platform of info.platforms) {
      platform.tenants = (process.env.FAKE_QUERY_TENANTS ?? "prod").split(",").map((name) => ({
        name,
        description: `${name} tenant`,
        strategies: ["PREVIEW", "RELEASE"],
        manual: false,
        variables: [{ name: "FAKE_SECRET", set: false }],
      }));
    }
  }
  return info;
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
