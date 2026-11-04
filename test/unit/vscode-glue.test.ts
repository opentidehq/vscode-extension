// Modules that touch the VS Code API, against test/stubs/vscode.ts.
import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  convertShowReferencesArgs,
  DOCUMENT_SELECTOR,
  forwardNotification,
  LANGUAGE_IDS,
  readServerInfo,
} from "../../src/core/lsp";
import { RESTRICTED_SETTINGS, readSetting, runtimeSettings } from "../../src/core/services/settings";
import { FolderManager } from "../../src/core/services/workspace";
import type { CancellationToken } from "../../src/core/util/cancellation";
import type { Event } from "../../src/core/util/event";
import { Emitter } from "../../src/core/util/event";
import { contentSecurityPolicy, renderHtml } from "../../src/core/webview/html";
import { acceptMessage, is } from "../../src/core/webview/protocol";
import { stubState } from "../stubs/vscode";

describe("settings and trust", () => {
  beforeEach(() => stubState.reset());

  it("reads no restricted setting in Restricted Mode", () => {
    stubState.trusted = false;
    stubState.config = { "opentide.path": "/evil/opentide", "opentide.runtime": "auto" };
    const settings = runtimeSettings(undefined);
    assert.equal(settings.path(), undefined);
    assert.equal(settings.interpreter(), undefined);
    assert.equal(settings.uvUsePin(), undefined);
    for (const key of RESTRICTED_SETTINGS) assert.equal(readSetting(key), undefined);
    assert.equal(settings.runtime(), "auto");
    assert.deepEqual(stubState.readKeys, ["opentide.runtime"], "only the unrestricted key was read");
  });

  it("reads them when trusted", () => {
    stubState.config = { "opentide.path": "/opt/opentide" };
    assert.equal(runtimeSettings(undefined).path(), "/opt/opentide");
  });
});

describe("language client pieces", () => {
  it("hands opentide/catalogChanged to every subscriber from one client handler", () => {
    // Like vscode-languageclient: one handler per method, a second registration replaces the first.
    const handlers = new Map<string, (params: unknown) => void>();
    let registered = 0;
    const client = {
      onNotification(method: string, handler: (params: unknown) => void) {
        registered += 1;
        handlers.set(method, handler);
        return { dispose: () => handlers.delete(method) };
      },
    };
    const changed = new Emitter<{ root: string | null }>();
    forwardNotification(client, "opentide/catalogChanged", (params) => changed.fire(params));
    const seen: (string | null)[][] = [[], []];
    changed.event((e) => seen[0]?.push(e.root));
    changed.event((e) => seen[1]?.push(e.root));
    handlers.get("opentide/catalogChanged")?.({ root: "file:///w" });
    handlers.get("opentide/catalogChanged")?.({ root: null });
    handlers.get("opentide/catalogChanged")?.(undefined);
    assert.equal(registered, 1);
    assert.deepEqual(seen, [
      ["file:///w", null, null],
      ["file:///w", null, null],
    ]);
  });

  it("selects every server language by id and by pattern", () => {
    assert.deepEqual(LANGUAGE_IDS, [
      "opentide-yaml",
      "opentide-config",
      "kql",
      "spl",
      "esql",
      "eql",
      "kuery",
      "lucene",
      "falco",
    ]);
    assert.ok(
      DOCUMENT_SELECTOR.some((f) => "pattern" in f && f.pattern === "**/.opentide/configurations/**/*.toml"),
    );
    assert.ok(!LANGUAGE_IDS.includes("sql"));
  });

  it("reads capabilities.experimental.opentide and infers nothing", () => {
    const info = {
      host: { name: "opentide", version: "0.21.0" },
      engine: "0.9.0",
      catalog: "host",
      configurationChecks: true,
      configurationSchemas: true,
    };
    assert.deepEqual(readServerInfo({ opentide: info }), info);
    assert.equal(readServerInfo(undefined), undefined);
    assert.equal(readServerInfo({ opentide: { host: null } }), undefined);
  });

  it("converts the reference lens arguments [uri, position, Location[]] for editor.action.showReferences", () => {
    const location = {
      uri: "file:///r/objects/rules/a.yaml",
      range: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } },
    };
    const converted = convertShowReferencesArgs(
      ["file:///r/objects/objectives/o.yaml", { line: 2, character: 4 }, [location]],
      {
        asUri: (v) => vscode.Uri.parse(v),
        asPosition: (p) => new vscode.Position(p.line, p.character),
        asLocation: (l) =>
          new vscode.Location(
            vscode.Uri.parse(l.uri),
            new vscode.Range(
              l.range.start.line,
              l.range.start.character,
              l.range.end.line,
              l.range.end.character,
            ),
          ),
      },
    );
    assert.ok(converted);
    const [uri, position, locations] = converted;
    assert.equal(uri.path, "/r/objects/objectives/o.yaml");
    assert.deepEqual([position.line, position.character], [2, 4]);
    assert.equal(locations[0]?.uri.path, "/r/objects/rules/a.yaml");
    assert.equal(
      convertShowReferencesArgs(["x"], {
        asUri: vscode.Uri.parse,
        asPosition: () => new vscode.Position(0, 0),
        asLocation: () => ({}) as never,
      }),
      undefined,
    );
  });
});

describe("webview helpers", () => {
  it("allow nothing remote: scripts only with the nonce", () => {
    const csp = contentSecurityPolicy("vscode-webview://x", "abc");
    assert.match(csp, /^default-src 'none'/);
    assert.match(csp, /script-src 'nonce-abc'/);
    assert.ok(!csp.includes("unsafe"));
    const html = renderHtml({
      cspSource: "vscode-webview://x",
      scriptUri: "s.js",
      styleUri: "b.css",
      title: "<Graph>",
      nonce: "abc",
    });
    assert.match(html, /<script nonce="abc" src="s.js">/);
    assert.match(html, /<title>&lt;Graph&gt;<\/title>/);
  });

  it("accept only messages whose type has a validator that passes", () => {
    const validators = { open: is.string, refresh: is.nothing };
    assert.deepEqual(acceptMessage({ type: "open", payload: "uuid" }, validators), {
      type: "open",
      payload: "uuid",
    });
    assert.equal(acceptMessage({ type: "open", payload: 3 }, validators), undefined);
    assert.equal(acceptMessage({ type: "toString", payload: undefined }, validators), undefined);
    assert.equal(acceptMessage("nope", validators), undefined);
  });
});

describe("vscode compatibility of the core's own types", () => {
  it("accepts a vscode.CancellationToken where the backend takes a CancellationToken (compile-time)", () => {
    const fromVscode = (token: vscode.CancellationToken): CancellationToken => token;
    const asEvent = (event: vscode.Event<number>): Event<number> => event;
    assert.equal(typeof fromVscode, "function");
    assert.equal(typeof asEvent, "function");
  });
});

// The window's opentide folders follow `opentide setup` without a reload (#44).
describe("folders: an opentide folder created in the window (#44)", () => {
  let dir: string;
  const workspace = vscode.workspace as unknown as { workspaceFolders: unknown[] };
  beforeEach(() => {
    stubState.reset();
    dir = mkdtempSync(path.join(tmpdir(), "opentide-fresh-"));
    workspace.workspaceFolders = [{ uri: vscode.Uri.file(dir), name: "fresh", index: 0 }];
  });
  afterEach(() => {
    workspace.workspaceFolders = [];
    rmSync(dir, { recursive: true, force: true });
  });

  it("becomes an opentide folder when setup creates .opentide/, and stops when it goes", () => {
    const folders = new FolderManager();
    const changes: number[] = [];
    folders.onDidChange((all) => changes.push(all.length));
    assert.equal(folders.all.length, 0);
    mkdirSync(path.join(dir, ".opentide"));
    stubState.fileEvent("create", path.join(dir, ".opentide"));
    assert.equal(folders.all.length, 1, "seen without a reload");
    assert.deepEqual(changes, [1]);
    assert.ok(
      stubState.executed.some(
        (e) => e.command === "setContext" && e.args[0] === "opentide.hasWorkspace" && e.args[1],
      ),
    );
    rmSync(path.join(dir, ".opentide"), { recursive: true });
    stubState.fileEvent("delete", path.join(dir, ".opentide"));
    assert.equal(folders.all.length, 0);
    folders.dispose();
    assert.equal(stubState.watchers.length, 0, "every watcher is disposed");
  });

  it("also for objects/ alone", () => {
    const folders = new FolderManager();
    mkdirSync(path.join(dir, "objects"));
    stubState.fileEvent("create", path.join(dir, "objects"));
    assert.equal(folders.all.length, 1);
    folders.dispose();
  });
});
