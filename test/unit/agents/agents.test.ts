import * as assert from "node:assert/strict";
import * as path from "node:path";
import type { CatalogDocument } from "../../../src/core/catalog/types";
import { which } from "../../../src/core/runtime/process";
import { forkTarget, mergeMcpEntry } from "../../../src/features/agents/forks";
import { parseJsonc, stripJsonc } from "../../../src/features/agents/jsonc";
import {
  decideMcp,
  definesOpentide,
  entryUsable,
  McpDecisionLog,
  type McpInputs,
  opentideEntryCommand,
  provideMode,
} from "../../../src/features/agents/mcp";
import { activeObjectPayload, diagnosticsPayload } from "../../../src/features/agents/tools";
import { fakeRuntime } from "../helpers";

describe("agents: JSONC", () => {
  it("drops comments and trailing commas, never inside strings", () => {
    const text = `{
      // a comment
      "servers": { "a": { "url": "http://x//y", "note": "keep /* this */, }" }, }, /* block */
    }`;
    assert.deepEqual(parseJsonc(text), {
      servers: { a: { url: "http://x//y", note: "keep /* this */, }" } },
    });
    assert.equal(stripJsonc('["a",]'), '["a"]');
    assert.equal(parseJsonc("{ nope"), undefined);
    assert.deepEqual(parseJsonc("\uFEFF{}"), {});
  });
});

describe("agents: MCP server", () => {
  const inputs = (overrides: Partial<McpInputs> = {}): McpInputs => ({
    trusted: true,
    mode: "auto",
    runtime: fakeRuntime({ env: { UV_X: "1" } }),
    hasMcpStart: true,
    folder: "/ws",
    workspaceDefines: false,
    ...overrides,
  });

  it("waits for the command tree after a trust grant instead of logging that there is no `mcp start`", () => {
    const loading = decideMcp(inputs({ hasMcpStart: undefined }));
    assert.deepEqual(loading, { provide: false, reason: "the command tree is loading", pending: true });
    const log = new McpDecisionLog();
    assert.equal(log.line(loading), undefined, "nothing while it is not known");
    const provided = decideMcp(inputs());
    assert.equal(log.line(provided), undefined, "provided at once: nothing to correct");
    assert.equal(log.line(provided), undefined);
    const never = decideMcp(inputs({ mode: "never" }));
    assert.equal(log.line(never), "MCP server not provided: opentide.mcp.provide is never");
    assert.equal(log.line(never), undefined, "once per change");
    assert.ok(provided.provide);
    assert.equal(log.line(provided), `MCP server provided: ${provided.server.command}`);
  });

  it("provides `opentide mcp start` with the resolved runtime, in the folder", () => {
    const decision = decideMcp(inputs({ proxy: "http://proxy:3128" }));
    assert.ok(decision.provide);
    const runtime = fakeRuntime();
    assert.deepEqual(decision.server, {
      label: "opentide",
      command: runtime.command,
      args: [...runtime.args, "mcp", "start"],
      cwd: "/ws",
      env: { UV_X: "1", OPENTIDE_REPO_ROOT: "/ws", OPENTIDE_PROXY: "http://proxy:3128" },
      version: "0.21.0",
    });
  });

  it("runs the bundled interpreter as the extension does", () => {
    const bundled = fakeRuntime({
      tier: 4,
      source: "bundled",
      command: "/ext/runtime/bin/python3",
      args: ["-I", "-X", "pycache_prefix=/gs/pycache", "-m", "opentide"],
    });
    const decision = decideMcp(inputs({ runtime: bundled }));
    assert.ok(decision.provide);
    assert.equal(decision.server.command, "/ext/runtime/bin/python3");
    assert.deepEqual(decision.server.args, [
      "-I",
      "-X",
      "pycache_prefix=/gs/pycache",
      "-m",
      "opentide",
      "mcp",
      "start",
    ]);
  });

  it("provides nothing in Restricted Mode, with `never`, or without a runtime that has `mcp start`", () => {
    assert.deepEqual(decideMcp(inputs({ trusted: false })), { provide: false, reason: "Restricted Mode" });
    assert.equal(decideMcp(inputs({ runtime: fakeRuntime({ restricted: true }) })).provide, false);
    assert.equal(decideMcp(inputs({ mode: "never" })).provide, false);
    assert.equal(decideMcp(inputs({ runtime: undefined })).provide, false);
    assert.equal(decideMcp(inputs({ runtime: fakeRuntime({ kind: "opentide-lsp" }) })).provide, false);
    assert.equal(decideMcp(inputs({ hasMcpStart: false })).provide, false);
    assert.equal(decideMcp(inputs({ folder: undefined })).provide, false);
  });

  it("leaves a workspace's own opentide server alone in auto, and provides anyway with always", () => {
    assert.deepEqual(decideMcp(inputs({ workspaceDefines: true })), {
      provide: false,
      reason: ".vscode/mcp.json already defines opentide",
    });
    assert.ok(decideMcp(inputs({ workspaceDefines: true, mode: "always" })).provide);
  });

  it("reads .vscode/mcp.json as setup mcp writes it, comments included", () => {
    assert.ok(
      definesOpentide('{ "servers": { "opentide": { "command": "opentide", "args": ["mcp", "start"] } } }'),
    );
    assert.ok(definesOpentide('{ // mine\n "servers": { "other": {}, "OpenTide": {}, } }'));
    assert.ok(definesOpentide('{ "mcpServers": { "opentide": {} } }'));
    assert.ok(!definesOpentide('{ "servers": { "other": {} } }'));
    assert.ok(!definesOpentide("not json"));
    assert.ok(!definesOpentide(undefined));
  });

  it("defers to a workspace opentide server only when VS Code can start its command", () => {
    const written = '{ "servers": { "opentide": { "command": "opentide", "args": ["mcp", "start"] } } }';
    assert.equal(opentideEntryCommand(written), "opentide");
    assert.equal(opentideEntryCommand('{ "servers": { "opentide": { "url": "http://x" } } }'), null);
    assert.equal(opentideEntryCommand('{ "servers": {} }'), undefined);
    const lookup = (onPath: string[], files: string[] = []) => ({
      isAbsolute: (file: string) => file.startsWith("/"),
      exists: (file: string) => files.includes(file),
      which: (name: string) => (onPath.includes(name) ? `/usr/bin/${name}` : undefined),
    });
    // `setup mcp --vscode` writes `opentide`; with only the bundled runtime it is on no PATH.
    assert.equal(entryUsable("opentide", lookup([])), false);
    assert.equal(entryUsable("opentide", lookup(["opentide"])), true);
    assert.equal(entryUsable("/venv/bin/opentide", lookup([], ["/venv/bin/opentide"])), true);
    assert.equal(entryUsable("/gone/opentide", lookup([])), false);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a VS Code variable, not a template
    assert.equal(entryUsable("${workspaceFolder}/.venv/bin/opentide", lookup([])), true);
    assert.equal(entryUsable(null, lookup([])), true);
  });

  it("finds an entry's `opentide.exe` on a Windows PATH, so the server is not provided twice", () => {
    const exe = path.join("C:\\tools", "opentide.exe");
    const lookup = {
      isAbsolute: () => false,
      exists: (file: string) => file === exe,
      which: (name: string) =>
        which(name, "C:\\tools", "win32", (file) => file === exe, ".COM;.EXE;.BAT;.CMD"),
    };
    assert.equal(lookup.which("opentide.exe"), exe);
    assert.equal(entryUsable("opentide.exe", lookup), true);
    assert.equal(lookup.which("opentide"), exe, "and the bare name with PATHEXT, as before");
    assert.equal(
      which("opentide.exe", "/usr/bin", "linux", () => false),
      undefined,
    );
  });

  it("reads the setting leniently", () => {
    assert.equal(provideMode("always"), "always");
    assert.equal(provideMode("never"), "never");
    assert.equal(provideMode(undefined), "auto");
    assert.equal(provideMode("bogus"), "auto");
  });
});

/** Cursor's `${workspaceFolder}`, which the editor expands (spelled so that no linter takes it for a template). */
const WORKSPACE_FOLDER = ["$", "{workspaceFolder}"].join("");

describe("agents: forks without the provider API", () => {
  it("knows Cursor's and Windsurf's user-level MCP files", () => {
    assert.deepEqual(forkTarget("Cursor", "/home/me"), {
      editor: "Cursor",
      file: path.join("/home/me", ".cursor", "mcp.json"),
      workspaceVariable: true,
    });
    assert.equal(
      forkTarget("Windsurf", "/home/me")?.file,
      path.join("/home/me", ".codeium", "windsurf", "mcp_config.json"),
    );
    assert.equal(forkTarget("Visual Studio Code", "/home/me"), undefined);
  });

  it("adds opentide to the file, keeping every other server", () => {
    const entry = {
      command: "/ext/runtime/bin/python3",
      args: ["-I", "-m", "opentide", "mcp", "start"],
      env: {},
    };
    const merged = mergeMcpEntry('{ "theme": 1, "mcpServers": { "other": { "command": "x" } } }', entry);
    assert.ok("text" in merged);
    assert.deepEqual(JSON.parse(merged.text), {
      theme: 1,
      mcpServers: { other: { command: "x" }, opentide: { command: entry.command, args: entry.args } },
    });
    const fresh = mergeMcpEntry(undefined, { ...entry, env: { OPENTIDE_REPO_ROOT: WORKSPACE_FOLDER } });
    assert.ok("text" in fresh);
    assert.deepEqual(JSON.parse(fresh.text).mcpServers.opentide.env, {
      OPENTIDE_REPO_ROOT: WORKSPACE_FOLDER,
    });
    assert.deepEqual(mergeMcpEntry("[1]", entry), { error: "is not a JSON object" });
    assert.deepEqual(mergeMcpEntry('{"mcpServers": []}', entry), {
      error: "has an `mcpServers` that is not an object",
    });
  });
});

describe("agents: language-model tools", () => {
  it("merges a file's diagnostics, most severe first, 1-based", () => {
    const at = (line: number, character: number) => ({ line, character });
    const payload = diagnosticsPayload("/ws/r.yaml", [
      { message: "w", severity: 1, source: "opentide lint", range: { start: at(4, 0), end: at(4, 3) } },
      { message: "e2", severity: 0, code: { value: "schema" }, range: { start: at(9, 2), end: at(10, 0) } },
      {
        message: "e1",
        severity: 0,
        code: "vocab_unknown",
        source: "opentide",
        range: { start: at(1, 7), end: at(1, 11) },
      },
    ]);
    assert.deepEqual(payload.counts, { error: 2, warning: 1, information: 0, hint: 0 });
    assert.deepEqual(
      payload.diagnostics.map((d) => [
        d.severity,
        d.code,
        d.line,
        d.column,
        d.end_line,
        d.end_column,
        d.source,
      ]),
      [
        ["error", "vocab_unknown", 2, 8, 2, 12, "opentide"],
        ["error", "schema", 10, 3, 11, 1, null],
        ["warning", null, 5, 1, 5, 4, "opentide lint"],
      ],
    );
  });

  const catalog = {
    objects: [
      {
        uuid: "r1",
        type: "rule",
        schema: "rule::1.1",
        name: "LSASS access",
        path: "objects/rules/r.yaml",
        file_path: "/ws/objects/rules/r.yaml",
        line: 3,
        tlp: "amber",
        platforms: [{ id: "sentinel", enabled: true, status: "DESIGN", strategy: "INERT" }],
        deployment: [],
        techniques: { own: ["T1003.001"], inherited: [] },
        tactics: ["credential-access"],
        actors: [],
        load_error: null,
      },
      { uuid: "o1", type: "objective", name: "Detect LSASS access", file_path: "/ws/objects/o.yaml" },
    ],
    edges: [
      {
        from: "r1",
        to: "o1",
        kind: "implements",
        field_path: "detection_model",
        relation: null,
        missing: false,
      },
      {
        from: "r1",
        to: "T1003.001",
        kind: "technique",
        field_path: "techniques",
        relation: null,
        missing: false,
      },
      { from: "o1", to: "t9", kind: "covers", field_path: "threats", relation: null, missing: true },
      { from: "x1", to: "r1", kind: "chains", field_path: "chaining", relation: "precedes", missing: false },
    ],
    signals: [],
    attack: {
      tactics: [],
      techniques: { "T1003.001": { name: "LSASS Memory", parent: "T1003", subtechniques: [] } },
    },
  } as unknown as CatalogDocument;

  it("gives the active object and its one-hop neighbourhood", () => {
    const payload = activeObjectPayload("/ws/objects/rules/r.yaml", catalog, undefined, false);
    assert.ok(payload.object);
    assert.equal(payload.object.uuid, "r1");
    assert.equal(payload.object.tlp, "amber");
    assert.ok("neighbours" in payload);
    assert.deepEqual(
      payload.neighbours.map((n) => [n.direction, n.kind, n.id, n.name, n.type]),
      [
        ["out", "implements", "o1", "Detect LSASS access", "objective"],
        ["out", "technique", "T1003.001", "LSASS Memory", "technique"],
        ["in", "chains", "x1", null, null],
      ],
    );
  });

  it("says why there is no object", () => {
    assert.deepEqual(activeObjectPayload(undefined, catalog, undefined), {
      file: null,
      object: null,
      reason: "No file is open in the editor.",
    });
    assert.equal(
      activeObjectPayload("/ws/x.yaml", undefined, "needs info catalog").object === null &&
        "reason" in activeObjectPayload("/ws/x.yaml", undefined, "needs info catalog"),
      true,
    );
    const other = activeObjectPayload("/ws/README.md", catalog, undefined);
    assert.ok("reason" in other && /not an object/.test(other.reason));
    const caseless = activeObjectPayload(
      "C:\\WS\\objects\\rules\\r.yaml",
      {
        ...catalog,
        objects: [{ ...(catalog.objects[0] as object), file_path: "c:/ws/objects/rules/r.yaml" }],
      } as unknown as CatalogDocument,
      undefined,
      true,
    );
    assert.equal(caseless.object?.uuid, "r1");
  });
});
