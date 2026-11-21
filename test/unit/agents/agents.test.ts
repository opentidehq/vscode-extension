import * as assert from "node:assert/strict";
import * as path from "node:path";
import type { CatalogDocument } from "../../../src/core/catalog/types";
import { which } from "../../../src/core/runtime/process";
import { cursorMcp, cursorRegistration } from "../../../src/features/agents/cursor";
import {
  chooseMcpMechanism,
  configProblem,
  forkTarget,
  hasOurEntry,
  MARKER_ENV,
  MARKER_VALUE,
  mergeMcpEntry,
  removeMcpEntry,
} from "../../../src/features/agents/forks";
import { parseJsonc, stripJsonc } from "../../../src/features/agents/jsonc";
import {
  cursorWorkspaceDiscovered,
  decideMcp,
  definesOpentide,
  entryUsable,
  environmentLookup,
  expandEnvironment,
  MCP_LABEL,
  MCP_SEPARATE_LABEL,
  McpDecisionLog,
  type McpInputs,
  mcpBridge,
  opentideEntryCommand,
  opentideServerCommand,
  provideMode,
  USER_CONFIG_ORDER,
  WORKSPACE_CONFIG_ORDER,
  type WorkspaceEntry,
  workspaceMcpFiles,
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
    workspaceEntries: [],
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
      bridge: false,
    });
  });

  it("runs `python -m opentide` as the extension does", () => {
    const runtime = fakeRuntime({
      tier: 2,
      source: "python",
      command: "/usr/bin/python3",
      args: ["-m", "opentide"],
    });
    const decision = decideMcp(inputs({ runtime }));
    assert.ok(decision.provide);
    assert.equal(decision.server.command, "/usr/bin/python3");
    assert.deepEqual(decision.server.args, ["-m", "opentide", "mcp", "start"]);
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

  /** A workspace entry; its order is VS Code's for that file: 0 for `.vscode/mcp.json`, else 1. */
  const entry = (file: string, usable: boolean, command: string | null = "opentide"): WorkspaceEntry => ({
    file,
    command,
    usable,
    order: file.endsWith(".vscode/mcp.json") ? 0 : 1,
  });

  it("leaves a workspace's own opentide server alone in auto, and provides anyway with always", () => {
    assert.deepEqual(decideMcp(inputs({ workspaceEntries: [entry("ws/.vscode/mcp.json", true)] })), {
      provide: false,
      reason: "ws/.vscode/mcp.json already defines opentide",
    });
    const always = decideMcp(
      inputs({ workspaceEntries: [entry("ws/.vscode/mcp.json", true)], mode: "always" }),
    );
    assert.ok(always.provide);
    assert.equal(always.server.label, MCP_LABEL, "one opentide: VS Code keeps the file's");
    assert.equal(always.note, undefined);
  });

  it("defers to the root .mcp.json setup mcp --claude-code writes when VS Code can start it", () => {
    assert.deepEqual(decideMcp(inputs({ workspaceEntries: [entry("ws/.mcp.json", true)] })), {
      provide: false,
      reason: "ws/.mcp.json already defines opentide",
    });
  });

  it("provides its server under a label VS Code does not dedupe when the file's opentide cannot start", () => {
    for (const file of ["ws/.mcp.json", "ws/.vscode/mcp.json"])
      for (const mode of ["auto", "always"] as const) {
        const decision = decideMcp(inputs({ mode, workspaceEntries: [entry(file, false)] }));
        assert.ok(decision.provide, `${file} ${mode}`);
        assert.equal(decision.server.label, MCP_SEPARATE_LABEL);
        assert.notEqual(MCP_SEPARATE_LABEL.toLowerCase(), MCP_LABEL, "VS Code compares labels without case");
        assert.equal(
          decision.note,
          `${file}'s opentide server runs \`opentide\`, which is not found, and VS Code keeps one server named opentide`,
        );
      }
    const plain = decideMcp(inputs());
    assert.ok(plain.provide);
    assert.equal(plain.server.label, MCP_LABEL, "no workspace entry: the shared label");
  });

  it("follows the entry VS Code keeps: .vscode/mcp.json before .mcp.json", () => {
    const usableFirst = [entry("ws/.vscode/mcp.json", true), entry("ws/.mcp.json", false)];
    assert.equal(decideMcp(inputs({ workspaceEntries: usableFirst })).provide, false);
    const brokenFirst = [entry("ws/.vscode/mcp.json", false), entry("ws/.mcp.json", true)];
    const decision = decideMcp(inputs({ workspaceEntries: brokenFirst }));
    assert.ok(decision.provide, "VS Code keeps the broken one, so deferring would leave no server");
    assert.equal(decision.server.label, MCP_SEPARATE_LABEL);
    const reversed = decideMcp(inputs({ workspaceEntries: [entry("ws/.mcp.json", true), ...usableFirst] }));
    assert.equal(reversed.provide, false, "the order VS Code gives each file counts, not the list's");
  });

  it("takes the separate label when VS Code may keep any of several equal-order entries that cannot start", () => {
    // `.mcp.json` and `.cursor/mcp.json` (and every folder's `.mcp.json`) share order 1: VS Code keeps
    // whichever registered first, which a file created during the session changes.
    for (const entries of [
      [entry("a/.mcp.json", true), entry("a/.cursor/mcp.json", false)],
      [entry("a/.cursor/mcp.json", true), entry("a/.mcp.json", false)],
      [entry("a/.mcp.json", true), entry("b/.mcp.json", false)],
    ]) {
      const decision = decideMcp(inputs({ workspaceEntries: entries }));
      assert.ok(decision.provide, entries.map((e) => e.file).join(", "));
      assert.equal(decision.server.label, MCP_SEPARATE_LABEL);
      assert.match(decision.note ?? "", new RegExp(`^${entries[1]?.file}'s opentide server`));
    }
    const allUsable = [entry("a/.mcp.json", true), entry("b/.mcp.json", true)];
    assert.deepEqual(decideMcp(inputs({ workspaceEntries: allUsable })), {
      provide: false,
      reason: "a/.mcp.json already defines opentide",
    });
    const shadowed = [
      entry("a/.vscode/mcp.json", true),
      entry("a/.mcp.json", false),
      entry("b/.mcp.json", true),
    ];
    assert.equal(decideMcp(inputs({ workspaceEntries: shadowed })).provide, false, "order 0 wins outright");
  });

  it("counts a .code-workspace's and the user's mcp.servers, which also outrank the extension", () => {
    const configured = (file: string, usable: boolean, order: number): WorkspaceEntry => ({
      file,
      command: "opentide",
      usable,
      order,
    });
    const user = configured("the user's mcp.json", false, USER_CONFIG_ORDER);
    const workspace = configured("team.code-workspace", true, WORKSPACE_CONFIG_ORDER);
    const onlyUser = decideMcp(inputs({ workspaceEntries: [user] }));
    assert.ok(onlyUser.provide);
    assert.equal(onlyUser.server.label, MCP_SEPARATE_LABEL, "the user's broken opentide would win");
    assert.match(onlyUser.note ?? "", /^the user's mcp\.json's opentide server/);
    assert.deepEqual(decideMcp(inputs({ workspaceEntries: [user, workspace] })), {
      provide: false,
      reason: "team.code-workspace already defines opentide",
    });
    const brokenWorkspace = decideMcp(
      inputs({ workspaceEntries: [configured("team.code-workspace", false, WORKSPACE_CONFIG_ORDER)] }),
    );
    assert.ok(brokenWorkspace.provide);
    assert.equal(brokenWorkspace.server.label, MCP_SEPARATE_LABEL);
    assert.equal(
      decideMcp(inputs({ workspaceEntries: [user, entry("ws/.mcp.json", true)] })).provide,
      false,
      "a folder file comes first",
    );
    assert.ok(
      WORKSPACE_CONFIG_ORDER > 1 && USER_CONFIG_ORDER < 300,
      "between the folder files and the extension",
    );
  });

  it("reads the opentide server of a configuration's mcp.servers", () => {
    assert.equal(
      opentideServerCommand({ opentide: { command: " /venv/bin/opentide " } }),
      "/venv/bin/opentide",
    );
    assert.equal(opentideServerCommand({ OpenTide: { url: "http://x" } }), null);
    assert.equal(opentideServerCommand({ other: { command: "x" } }), undefined);
    assert.equal(opentideServerCommand(undefined), undefined);
    assert.equal(opentideServerCommand([]), undefined);
  });

  it("logs once why it provides the server under the other label", () => {
    const log = new McpDecisionLog();
    const broken = decideMcp(inputs({ workspaceEntries: [entry("ws/.mcp.json", false)] }));
    assert.equal(
      log.line(broken),
      'MCP server provided as "opentide (VS Code)": ws/.mcp.json\'s opentide server runs `opentide`, which is not found, and VS Code keeps one server named opentide',
    );
    assert.equal(log.line(broken), undefined, "once");
    const plain = decideMcp(inputs());
    assert.ok(plain.provide);
    assert.equal(log.line(plain), `MCP server provided: ${plain.server.command}`);
  });

  it("reads the files VS Code 1.145 reads: .vscode/mcp.json, .mcp.json, and .cursor/mcp.json when discovered", () => {
    assert.deepEqual(
      workspaceMcpFiles(undefined).map((file) => file.segments.join("/")),
      [".vscode/mcp.json", ".mcp.json"],
    );
    assert.deepEqual(
      workspaceMcpFiles({ "cursor-workspace": true }).map((file) => file.kind),
      ["vscode", "root", "cursor"],
    );
    assert.equal(cursorWorkspaceDiscovered(true), true, "the legacy boolean applies to every source");
    assert.equal(cursorWorkspaceDiscovered(false), false);
    assert.equal(cursorWorkspaceDiscovered({ "cursor-global": true }), false);
    assert.equal(cursorWorkspaceDiscovered({ "cursor-workspace": "yes" }), false);
  });

  it("reads the root .mcp.json as setup mcp --claude-code writes it, and its unwrapped form", () => {
    const written = JSON.stringify({
      mcpServers: {
        opentide: {
          command: "opentide",
          args: ["mcp", "start"],
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands it, not JavaScript
          env: { OPENTIDE_REPO_ROOT: "${CLAUDE_PROJECT_DIR}" },
        },
      },
    });
    assert.equal(opentideEntryCommand(written, "root"), "opentide");
    assert.equal(
      opentideEntryCommand('{ "opentide": { "command": "/venv/bin/opentide" } }', "root"),
      "/venv/bin/opentide",
    );
    assert.equal(opentideEntryCommand('{ "OpenTide": { "url": "http://x" } }', "root"), null);
    assert.equal(
      opentideEntryCommand('{ "mcpServers": { "other": {} }, "opentide": {} }', "root"),
      undefined,
    );
    assert.equal(opentideEntryCommand('{ "servers": { "opentide": {} } }', "root"), undefined);
    assert.equal(opentideEntryCommand('{ "mcpServers": [] }', "root"), undefined);
    assert.equal(opentideEntryCommand('{ "opentide": "nope" }', "root"), undefined);
    assert.ok(definesOpentide(written, "root"));
    assert.equal(opentideEntryCommand('{ "mcpServers": { "opentide": { "command": "x" } } }', "cursor"), "x");
    assert.equal(
      opentideEntryCommand('{ "servers": { "opentide": { "command": "x" } } }', "cursor"),
      undefined,
    );
  });

  it("reads .cursor/mcp.json as strictly as VS Code, which ignores a file with comments or trailing commas", () => {
    const lenient = '{ // mine\n "mcpServers": { "opentide": { "command": "x" }, } }';
    assert.equal(opentideEntryCommand(lenient, "cursor"), undefined, "VS Code reads no server from it");
    assert.equal(opentideEntryCommand(lenient, "root"), "x", ".mcp.json allows both");
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
    // `setup mcp --vscode` writes `opentide`; with opentide run as `python -m opentide` it is on no PATH.
    assert.equal(entryUsable("opentide", lookup([])), false);
    assert.equal(entryUsable("opentide", lookup(["opentide"])), true);
    assert.equal(entryUsable("/venv/bin/opentide", lookup([], ["/venv/bin/opentide"])), true);
    assert.equal(entryUsable("/gone/opentide", lookup([])), false);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a VS Code variable, not a template
    assert.equal(entryUsable("${workspaceFolder}/.venv/bin/opentide", lookup([])), true);
    assert.equal(entryUsable(null, lookup([])), true);
  });

  it("expands only what VS Code expands in each file before checking the command", () => {
    const lookup = (env: Record<string, string>, files: string[] = []) => ({
      isAbsolute: (file: string) => file.startsWith("/"),
      exists: (file: string) => files.includes(file),
      which: () => undefined,
      env: environmentLookup(env, "linux"),
    });
    const project = ["$", "{CLAUDE_PROJECT_DIR}/.venv/bin/opentide"].join("");
    const folder = ["$", "{workspaceFolder}/.venv/bin/opentide"].join("");
    // .vscode/mcp.json: VS Code's variable resolver handles both.
    assert.equal(entryUsable(folder, lookup({}), "variables"), true);
    // .mcp.json: only `${VAR}` from VS Code's environment; CLAUDE_PROJECT_DIR is Claude Code's, unset here.
    assert.equal(entryUsable(project, lookup({}), "environment"), false);
    assert.equal(entryUsable(folder, lookup({}), "environment"), false, "no workspaceFolder variable");
    const venv = "/p/.venv/bin/opentide";
    assert.equal(entryUsable(project, lookup({ CLAUDE_PROJECT_DIR: "/p" }, [venv]), "environment"), true);
    assert.equal(entryUsable(project, lookup({ CLAUDE_PROJECT_DIR: "/p" }), "environment"), false);
    // .cursor/mcp.json: nothing is expanded.
    assert.equal(entryUsable(folder, lookup({}), "none"), false);
    assert.equal(entryUsable(project, lookup({ CLAUDE_PROJECT_DIR: "/p" }, [venv]), "none"), false);
    assert.equal(entryUsable(null, lookup({}), "none"), true, "a URL server");
  });

  it("expands VAR and VAR-with-a-default references as VS Code's root .mcp.json does", () => {
    const ref = (body: string) => ["$", "{", body, "}"].join("");
    const env = environmentLookup({ HOME: "/h", EMPTY: "" }, "linux");
    assert.equal(expandEnvironment(`${ref("HOME")}/bin`, env), "/h/bin");
    assert.equal(expandEnvironment(`${ref("NOPE")}/bin`, env), `${ref("NOPE")}/bin`, "unset: as written");
    assert.equal(expandEnvironment(ref("NOPE:-/opt/x"), env), "/opt/x");
    assert.equal(expandEnvironment(ref("EMPTY:-/opt/x"), env), "", "set but empty: empty, not the default");
    assert.equal(
      expandEnvironment(ref(`NOPE:-${ref("HOME")}`), env),
      ref("HOME"),
      "a default is not expanded",
    );
    assert.equal(expandEnvironment("$HOME/bin", env), "$HOME/bin", "bare $VAR stays literal");
    assert.equal(expandEnvironment(ref("env:HOME"), env), ref("env:HOME"));
    assert.equal(expandEnvironment(`${ref("HOME")}${ref("HOME")}`, env), "/h/h");
    const windows = environmentLookup({ Path: "C:\\bin", CLAUDE_PROJECT_DIR: "C:\\p" }, "win32");
    assert.equal(windows("PATH"), "C:\\bin", "without case on Windows");
    assert.equal(windows("claude_project_dir"), "C:\\p");
    assert.equal(environmentLookup({ Path: "x" }, "linux")("PATH"), undefined);
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

describe("agents: editors that take a user-level MCP file (Kiro, Devin Desktop, Windsurf)", () => {
  const entry = {
    command: "/usr/share/kiro/kiro",
    args: ["/home/me/.kiro/extensions/opentidehq.opentide-0.3.0/dist/mcp-wasi.js"],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };

  it("knows each editor's file, and has none for VS Code or Cursor (Cursor has an API)", () => {
    assert.equal(
      forkTarget("Kiro", "/home/me")?.file,
      path.join("/home/me", ".kiro", "settings", "mcp.json"),
    );
    assert.equal(
      forkTarget("Devin Desktop", "/home/me", "linux")?.file,
      path.join("/home/me", ".config", "devin", "mcp_config.json"),
    );
    assert.equal(
      forkTarget("Devin", "/home/me", "win32", "C:\\Users\\me\\AppData\\Roaming")?.file,
      "C:\\Users\\me\\AppData\\Roaming\\devin\\mcp_config.json",
    );
    assert.equal(
      forkTarget("Windsurf", "/home/me")?.file,
      path.join("/home/me", ".codeium", "windsurf", "mcp_config.json"),
    );
    assert.equal(forkTarget("Cursor", "/home/me"), undefined);
    assert.equal(forkTarget("Visual Studio Code", "/home/me"), undefined);
    // The URI scheme names the host too.
    assert.equal(forkTarget("Code - OSS", "/home/me", "linux", undefined, "kiro")?.editor, "Kiro");
    assert.equal(forkTarget("Code - OSS", "/home/me", "linux", undefined, "windsurf")?.editor, "Windsurf");
  });

  describe("chooseMcpMechanism: by host, not by API presence (#84)", () => {
    const base = {
      cursor: false,
      appName: "Kiro",
      uriScheme: "kiro",
      home: "/home/me",
      platform: "linux",
    } as const;
    const kiroFile = path.join("/home/me", ".kiro", "settings", "mcp.json");

    it("gives Kiro its MCP file although its Code OSS core has the provider API, and registers the provider too", () => {
      // The regression: Kiro's core has registerMcpServerDefinitionProvider, kiro-agent never reads it, and the
      // file used to be skipped because the API was there.
      const withApi = chooseMcpMechanism({ ...base, hasProviderApi: true });
      assert.equal(withApi.fork?.file, kiroFile);
      assert.equal(withApi.provider, true);
      assert.equal(withApi.cursor, false);
      assert.match(withApi.description, /Kiro/);
      assert.match(withApi.description, /has the MCP server definition provider API/);
      assert.match(withApi.description, /user-level MCP file .*mcp\.json and the provider/);
      const without = chooseMcpMechanism({ ...base, hasProviderApi: false });
      assert.equal(without.fork?.file, kiroFile);
      assert.equal(without.provider, false);
    });

    it("does the same for Devin Desktop and Windsurf, whether or not they have the API, by name or scheme", () => {
      for (const [appName, uriScheme, editor] of [
        ["Devin Desktop", "devin", "Devin Desktop"],
        ["Windsurf", "windsurf", "Windsurf"],
        ["Code - OSS", "windsurf", "Windsurf"],
      ] as const)
        for (const hasProviderApi of [true, false]) {
          const chosen = chooseMcpMechanism({ ...base, appName, uriScheme, hasProviderApi });
          assert.equal(chosen.fork?.editor, editor, `${appName} ${uriScheme}`);
          assert.equal(chosen.provider, hasProviderApi);
        }
    });

    it("gives VS Code and other hosts the provider only, and Cursor its own API", () => {
      const code = chooseMcpMechanism({
        ...base,
        appName: "Visual Studio Code",
        uriScheme: "vscode",
        hasProviderApi: true,
      });
      assert.equal(code.fork, undefined);
      assert.equal(code.provider, true);
      assert.match(code.description, /an MCP server definition provider/);
      const cursor = chooseMcpMechanism({
        ...base,
        cursor: true,
        appName: "Cursor",
        uriScheme: "cursor",
        hasProviderApi: true,
      });
      assert.deepEqual([cursor.cursor, cursor.provider, cursor.fork], [true, false, undefined]);
      const none = chooseMcpMechanism({
        ...base,
        appName: "Other",
        uriScheme: "other",
        hasProviderApi: false,
      });
      assert.deepEqual([none.cursor, none.provider, none.fork], [false, false, undefined]);
      assert.match(none.description, /none/);
    });

    it("logs the host, its scheme and what is used", () => {
      assert.match(chooseMcpMechanism({ ...base, hasProviderApi: true }).description, /^host Kiro \(kiro\):/);
    });
  });

  it("writes a marked opentide entry, keeping every other server and key, and the file's indent", () => {
    const merged = mergeMcpEntry(
      '{\n    "theme": 1,\n    "mcpServers": { "other": { "command": "x" } }\n}\n',
      entry,
    );
    assert.equal(merged.kind, "write");
    if (merged.kind !== "write") return;
    assert.match(merged.text, /^\{\n {4}"theme": 1,/);
    assert.deepEqual(JSON.parse(merged.text), {
      theme: 1,
      mcpServers: {
        other: { command: "x" },
        opentide: {
          command: entry.command,
          args: entry.args,
          env: { ELECTRON_RUN_AS_NODE: "1", [MARKER_ENV]: MARKER_VALUE },
        },
      },
    });
    const fresh = mergeMcpEntry(undefined, entry);
    assert.equal(fresh.kind, "write");
    assert.equal(mergeMcpEntry("  \n", entry).kind, "write");
  });

  it("is idempotent: the entry it wrote is the same, and a changed command or version rewrites only it", () => {
    const first = mergeMcpEntry('{"mcpServers": {"other": {"command": "x"}}}', entry);
    assert.equal(first.kind, "write");
    if (first.kind !== "write") return;
    assert.deepEqual(mergeMcpEntry(first.text, entry), { kind: "same" });
    const moved = {
      ...entry,
      args: ["/home/me/.kiro/extensions/opentidehq.opentide-0.4.0/dist/mcp-wasi.js"],
    };
    const second = mergeMcpEntry(first.text, moved);
    assert.equal(second.kind, "write");
    if (second.kind !== "write") return;
    assert.deepEqual(JSON.parse(second.text).mcpServers.opentide.args, moved.args);
    assert.deepEqual(JSON.parse(second.text).mcpServers.other, { command: "x" });
    assert.equal(hasOurEntry(second.text), true);
  });

  it("never touches an opentide server the user wrote, a file it cannot read, or one with comments", () => {
    const own = '{"mcpServers": {"opentide": {"command": "/opt/opentide", "args": ["mcp", "start"]}}}';
    assert.deepEqual(mergeMcpEntry(own, entry), { kind: "foreign" });
    assert.deepEqual(removeMcpEntry(own), { kind: "none" });
    assert.equal(hasOurEntry(own), false);
    assert.deepEqual(mergeMcpEntry("[1]", entry), { kind: "error", error: "is not a JSON object" });
    assert.deepEqual(mergeMcpEntry("{ nope", entry), { kind: "error", error: "is not valid JSON" });
    assert.deepEqual(mergeMcpEntry('{"mcpServers": []}', entry), {
      kind: "error",
      error: "has an `mcpServers` that is not an object",
    });
    const commented = mergeMcpEntry('{\n  // mine\n  "mcpServers": {}\n}', entry);
    assert.equal(commented.kind, "error");
    assert.match(commented.kind === "error" ? commented.error : "", /comments/);
  });

  it("removes its own entry, and `mcpServers` with it only when it was the last server", () => {
    const written = mergeMcpEntry('{"theme": 1, "mcpServers": {"other": {"command": "x"}}}', entry);
    assert.equal(written.kind, "write");
    if (written.kind !== "write") return;
    const removed = removeMcpEntry(written.text);
    assert.equal(removed.kind, "write");
    if (removed.kind !== "write") return;
    assert.deepEqual(JSON.parse(removed.text), { theme: 1, mcpServers: { other: { command: "x" } } });
    const only = mergeMcpEntry('{"theme": 1}', entry);
    assert.equal(only.kind, "write");
    if (only.kind !== "write") return;
    const removedOnly = removeMcpEntry(only.text);
    assert.equal(removedOnly.kind, "write");
    if (removedOnly.kind !== "write") return;
    assert.deepEqual(JSON.parse(removedOnly.text), { theme: 1 });
  });

  describe("malformed files give a clear error and are never rewritten or crashed on", () => {
    const malformed: [string, string, RegExp][] = [
      ["a JSON string", '"hello"', /not a JSON object/],
      ["a JSON number", "42", /not a JSON object/],
      ["null", "null", /not a JSON object/],
      ["an array", "[]", /not a JSON object/],
      ["truncated JSON", '{"mcpServers": {"opentide": ', /not valid JSON/],
      ["binary noise", "\u0000\u0001\u0002", /not valid JSON/],
      ["a null mcpServers", '{"mcpServers": null}', /`mcpServers` that is not an object/],
      ["a string mcpServers", '{"mcpServers": "x"}', /`mcpServers` that is not an object/],
      ["a numeric mcpServers", '{"mcpServers": 3}', /`mcpServers` that is not an object/],
      ["comments", '{\n  // mine\n  "mcpServers": {}\n}', /comments/],
    ];
    for (const [name, text, pattern] of malformed) {
      it(`${name}`, () => {
        const merged = mergeMcpEntry(text, entry);
        assert.equal(merged.kind, "error");
        assert.match(merged.kind === "error" ? merged.error : "", pattern);
        const removed = removeMcpEntry(text);
        assert.equal(removed.kind, "error");
        assert.match(removed.kind === "error" ? removed.error : "", pattern);
        assert.match(configProblem(text) ?? "", pattern);
        assert.equal(hasOurEntry(text), false);
      });
    }

    it("treats an entry that is not an object as the user's own, without throwing", () => {
      for (const value of [
        "null",
        "7",
        '"x"',
        "[]",
        "true",
        '{"env": null}',
        '{"env": "x"}',
        '{"env": []}',
      ]) {
        const text = `{"mcpServers": {"opentide": ${value}}}`;
        assert.deepEqual(mergeMcpEntry(text, entry), { kind: "foreign" }, value);
        assert.deepEqual(removeMcpEntry(text), { kind: "none" }, value);
        assert.equal(hasOurEntry(text), false, value);
        assert.equal(configProblem(text), undefined, value);
      }
    });

    it("rewrites its own entry even when the entry's other fields are malformed", () => {
      const ours = `{"mcpServers": {"opentide": {"command": 5, "args": "x", "env": {"${MARKER_ENV}": "${MARKER_VALUE}"}}}}`;
      const merged = mergeMcpEntry(ours, entry);
      assert.equal(merged.kind, "write");
      if (merged.kind !== "write") return;
      assert.equal(JSON.parse(merged.text).mcpServers.opentide.command, entry.command);
      assert.equal(removeMcpEntry(ours).kind, "write");
    });

    it("has no problem with an empty or missing file", () => {
      assert.equal(configProblem(undefined), undefined);
      assert.equal(configProblem(" \n"), undefined);
    });
  });
});

describe("agents: Cursor's extension API", () => {
  const plan = {
    label: "opentide",
    command: "/Applications/Cursor.app/Contents/MacOS/Cursor",
    args: ["/ext/dist/mcp-wasi.js"],
    cwd: "/ws",
    env: { ELECTRON_RUN_AS_NODE: "1", OPENTIDE_REPO_ROOT: "/ws" },
    version: "1.0.0-rc.3",
    bridge: true,
  };

  it("is found only where cursor.mcp.registerServer and unregisterServer are", () => {
    const api = { registerServer: () => undefined, unregisterServer: () => undefined };
    assert.equal(cursorMcp({ cursor: { mcp: api } }), api);
    assert.equal(cursorMcp({ cursor: { mcp: { registerServer: () => undefined } } }), undefined);
    assert.equal(cursorMcp({ cursor: {} }), undefined);
    assert.equal(cursorMcp({}), undefined);
    assert.equal(cursorMcp(undefined), undefined);
  });

  it("registers the same stdio command as everywhere else, by the server's label", () => {
    assert.deepEqual(cursorRegistration(plan), {
      name: "opentide",
      server: { command: plan.command, args: plan.args, env: plan.env },
    });
  });
});

describe("agents: the bundled MCP bridge", () => {
  const bridge = {
    command: "/usr/share/code/code",
    args: ["/ext/dist/mcp-wasi.js"],
    env: { ELECTRON_RUN_AS_NODE: "1" },
    version: "1.0.0-rc.3",
  };
  const inputs = (overrides: Partial<McpInputs> = {}): McpInputs => ({
    trusted: true,
    mode: "auto",
    runtime: undefined,
    hasMcpStart: undefined,
    folder: "/ws",
    workspaceEntries: [],
    bridge,
    ...overrides,
  });

  it("is the server where no native opentide resolves: the editor's own Node runs the bridge, in the folder", () => {
    const decision = decideMcp(inputs());
    assert.ok(decision.provide);
    assert.equal(decision.server.command, "/usr/share/code/code");
    assert.deepEqual(decision.server.args, ["/ext/dist/mcp-wasi.js"]);
    assert.deepEqual(decision.server.env, { ELECTRON_RUN_AS_NODE: "1", OPENTIDE_REPO_ROOT: "/ws" });
    assert.equal(decision.server.cwd, "/ws");
    assert.equal(decision.server.label, MCP_LABEL);
    assert.equal(decision.server.version, "1.0.0-rc.3");
    const proxied = decideMcp(inputs({ proxy: "http://proxy:3128" }));
    assert.ok(proxied.provide);
    assert.equal(proxied.server.env.OPENTIDE_PROXY, "http://proxy:3128");
  });

  it("is the server when the bundled WASI module is the runtime, and needs no command tree", () => {
    const wasi = fakeRuntime({ tier: 4, source: "wasi", wasi: { module: "/m.wasm", launcher: "/l.cjs" } });
    const decision = decideMcp(inputs({ runtime: wasi, hasMcpStart: undefined }));
    assert.ok(decision.provide);
    assert.equal(decision.server.args[0], "/ext/dist/mcp-wasi.js");
  });

  it("runs a native opentide's own `mcp start` when it is the runtime (opentide.runtime: installed), else the bridge", () => {
    const native = fakeRuntime();
    const first = decideMcp(inputs({ runtime: native, hasMcpStart: true }));
    assert.ok(first.provide);
    assert.equal(first.server.command, native.command);
    assert.deepEqual(first.server.args.slice(-2), ["mcp", "start"]);
    // With the bundled module as the runtime (the default), every editor gets the bridge, even where the
    // command tree of an installed opentide has `mcp start`.
    const wasi = fakeRuntime({ tier: 4, source: "wasi", wasi: { module: "/m.wasm", launcher: "/l.cjs" } });
    const bundled = decideMcp(inputs({ runtime: wasi, hasMcpStart: true }));
    assert.ok(bundled.provide);
    assert.equal(bundled.server.args[0], "/ext/dist/mcp-wasi.js");
  });

  it("is off in Restricted Mode and with `never`, and without a bridge falls back to what it was", () => {
    assert.deepEqual(decideMcp(inputs({ trusted: false })), { provide: false, reason: "Restricted Mode" });
    assert.equal(decideMcp(inputs({ mode: "never" })).provide, false);
    const without = decideMcp(inputs({ bridge: undefined }));
    assert.deepEqual(without, { provide: false, reason: "no opentide runtime with commands" });
    assert.equal(decideMcp(inputs({ folder: undefined })).provide, false);
  });

  it("keeps the label and dedup rules: defers to a workspace entry VS Code can start, else takes the other label", () => {
    const usable = (usableEntry: boolean): WorkspaceEntry => ({
      file: "ws/.mcp.json",
      command: "/opt/opentide",
      usable: usableEntry,
      order: 1,
    });
    assert.equal(decideMcp(inputs({ workspaceEntries: [usable(true)] })).provide, false);
    const separate = decideMcp(inputs({ workspaceEntries: [usable(false)] }));
    assert.ok(separate.provide);
    assert.equal(separate.server.label, MCP_SEPARATE_LABEL);
    assert.equal(decideMcp(inputs({ workspaceEntries: [usable(true)], mode: "always" })).provide, true);
  });

  it("is built from the extension folder: its script and the module's manifest must be there", () => {
    const exists = (file: string) => file === path.join("/ext", "dist", "mcp-wasi.js");
    assert.deepEqual(mcpBridge("/ext", "/node", { version: "1.0.0" }, exists, true), {
      command: "/node",
      args: [path.join("/ext", "dist", "mcp-wasi.js")],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      version: "1.0.0",
    });
    assert.equal(mcpBridge("/ext", "/node", undefined, exists, true), undefined);
    assert.equal(mcpBridge("/ext", "/node", { version: "1.0.0" }, exists, false), undefined);
    assert.equal(
      mcpBridge("/ext", "/node", { version: "1.0.0" }, () => false, true),
      undefined,
    );
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
      {
        uuid: "o1",
        type: "objective",
        name: "Detect LSASS access",
        path: "objects/o.yaml",
        file_path: "/ws/objects/o.yaml",
        load_error: null,
      },
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
