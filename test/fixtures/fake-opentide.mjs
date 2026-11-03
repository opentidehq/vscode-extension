#!/usr/bin/env node
// A fake `opentide` for tests: `--version`, `--json <command>` and `serve` (CONTRACTS.md).
// FAKE_VERSION sets the version; FAKE_NO_SERVE=1 leaves `serve` out of `commands`; FAKE_TENANTS=1 gives
// `info` platforms their tenants.
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
    case "explain":
      // `explain` lists every code; `explain <code>` explains one (the real shapes, abridged).
      if (rest[0] === undefined)
        return [
          envelope("explain", {
            codes: [
              { code: "vocab_unknown", meaning: "A value is not in the vocabulary its field uses." },
              { code: "workspace_not_found", meaning: "No workspace here." },
            ],
            summary: { codes: 2 },
          }),
          0,
        ];
      if (rest[0] === "vocab_unknown")
        return [
          envelope("explain", {
            code: "vocab_unknown",
            meaning: "A value is not in the vocabulary its field uses.",
            markdown: "# vocab_unknown\n\nA value is not in the vocabulary its field uses.\n",
          }),
          0,
        ];
      return [
        envelope("explain", {}, 2, { code: "usage_invalid_value", message: `Unknown code: ${rest[0]}` }),
        2,
      ];
    case "info":
      // `info` with no section: platforms; FAKE_TENANTS=1 adds their tenants (opentide#754).
      if (rest[0] === undefined || rest[0].startsWith("--")) {
        const tenants = (name) =>
          process.env.FAKE_TENANTS === "1"
            ? {
                tenants:
                  name === "sentinel"
                    ? [
                        {
                          name: "prod",
                          description: "Production workspace",
                          strategies: ["RELEASE"],
                          manual: false,
                          variables: [
                            { name: "AZURE_CLIENT_ID", set: Boolean(env.AZURE_CLIENT_ID) },
                            { name: "FAKE_SECRET", set: Boolean(env.FAKE_SECRET) },
                          ],
                        },
                      ]
                    : [],
              }
            : {};
        const platforms = [
          { name: "sentinel", enabled: true, can_deploy: true, can_validate: true, can_query: true },
          { name: "splunk", enabled: false, can_deploy: true, can_validate: true, can_query: true },
        ].map((platform) => ({ ...platform, ...tenants(platform.name) }));
        return [envelope("info", { version, platforms, summary: { rules: 0 } }), 0];
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
