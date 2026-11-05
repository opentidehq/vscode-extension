// VS Code for the Web (@vscode/test-web, Chromium) on test/fixtures/workspace, mounted as
// `vscode-test-web://mount/`: a virtual workspace, as on vscode.dev and github.dev. The engine (WASM)
// runs in a Web Worker, fed the workspace through VS Code's file system.
import * as vscode from "vscode";
import type { EngineSession } from "../../src/web/session";

function ok(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 30_000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function session(): Promise<EngineSession> {
  const extension = vscode.extensions.getExtension<{ session?: EngineSession }>("opentidehq.opentide");
  ok(extension, "the extension is installed");
  const api = await extension.activate();
  ok(api?.session, "the test API exposes the engine session");
  const current = api.session;
  await waitFor(() => current.current);
  return current;
}

function fixture(...segments: string[]): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  ok(folder, "the fixture folder is open");
  return vscode.Uri.joinPath(folder.uri, ...segments);
}

const code = (d: vscode.Diagnostic) => String(typeof d.code === "object" ? d.code.value : d.code);

describe("the web extension: the engine (WASM) in a Web Worker", () => {
  it("runs in a virtual workspace, as on vscode.dev", async () => {
    ok(vscode.env.uiKind === vscode.UIKind.Web, "VS Code for the Web");
    ok(fixture().scheme !== "file", `a virtual folder: ${fixture().toString()}`);
    const engine = await session();
    const info = engine.current?.initializeResult?.capabilities.experimental as
      | { opentide?: { engine?: string; host?: unknown } }
      | undefined;
    ok(info?.opentide?.engine, "initialize names the engine");
    ok(info.opentide.host === null, "hosted by nothing: no opentide");
  });

  it("reports diagnostics on a broken object, its objective resolved from the fed workspace", async () => {
    await session();
    const uri = fixture("detections", "rules", "misspelled-tlp.yaml");
    await vscode.window.showTextDocument(uri);
    const diagnostics = await waitFor(() => {
      const found = vscode.languages.getDiagnostics(uri);
      return found.some((d) => code(d) === "vocab_unknown") ? found : undefined;
    });
    const tlp = diagnostics.find((d) => code(d) === "vocab_unknown");
    ok(tlp && /ambr/.test(tlp.message) && tlp.range.start.line === 4, `the tlp finding: ${tlp?.message}`);
    ok(!diagnostics.some((d) => code(d) === "invalid_ref"), diagnostics.map(code).join(", "));
  });

  it("hovers the objective a rule implements", async () => {
    await session();
    const uri = fixture("detections", "rules", "misspelled-tlp.yaml");
    const hovers = await waitFor(async () => {
      const found = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        uri,
        new vscode.Position(5, 25),
      );
      return found && found.length > 0 ? found : undefined;
    });
    const text = hovers
      .flatMap((hover) => hover.contents)
      .map((content) => (typeof content === "string" ? content : content.value))
      .join("\n");
    ok(/Detect LSASS access/.test(text), text);
  });

  it("completes Tide keys", async () => {
    await session();
    const uri = fixture("detections", "rules", "misspelled-tlp.yaml");
    const list = await waitFor(async () => {
      const found = await vscode.commands.executeCommand<vscode.CompletionList>(
        "vscode.executeCompletionItemProvider",
        uri,
        new vscode.Position(7, 2),
      );
      return found && found.items.length > 0 ? found : undefined;
    });
    const labels = list.items.map((item) => (typeof item.label === "string" ? item.label : item.label.label));
    ok(labels.includes("splunk"), labels.join(", "));
  });

  it("lists the Catalogue from opentide/catalog, paths.toml object folders included", async () => {
    const engine = await session();
    await vscode.commands.executeCommand("opentide.sidebar.catalogue.focus");
    const objects = await waitFor(async () => {
      const found = await engine.catalog();
      return found.length >= 4 ? found : undefined;
    });
    const files = objects.map((object) => object.uri.split("/").slice(-2).join("/")).sort();
    ok(
      JSON.stringify(files) ===
        JSON.stringify([
          "objectives/detect-lsass-access.yaml",
          "rules/custom-folder-rule.yaml",
          "rules/misspelled-tlp.yaml",
          "rules/suspicious-lsass-access.yaml",
        ]),
      files.join(", "),
    );
    ok(
      objects.every((object) => object.uri.startsWith(fixture().toString())),
      "the objects keep the workspace's own URIs",
    );
  });

  it("explains a command that needs opentide instead of failing", async () => {
    await session();
    const commands = await vscode.commands.getCommands(true);
    ok(commands.includes("opentide.diagnostics.validateWorkspace"), "registered in web mode");
    ok(commands.includes("opentide.search.open"), "Find Detection runs here");
  });
});
