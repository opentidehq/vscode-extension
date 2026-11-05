// The real engine (the pinned opentide-wasm-web zip) in plain node: the worker host and the client
// transport around it, spoken to with vscode-jsonrpc as the language client speaks. The zip is unpacked
// into .cache/ (downloaded once) by scripts/engine-lib.mjs, as `npm run build` does.
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createMessageConnection, type MessageConnection } from "vscode-jsonrpc/node";
import { parseServerCatalog, rootOf, serverCatalogDocument } from "../../../src/core/catalog/serverCatalog";
import { type EngineModule, serveEngine } from "../../../src/engine/host";
import { engineTransports } from "../../../src/engine/transport";
import type { SuppliedDocument } from "../../../src/engine/workspace";
import { fakeEnginePort } from "./fakes";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const WORKSPACE = path.join(ROOT, "test", "fixtures", "workspace");

interface Glue {
  initSync(module: { module: Uint8Array }): unknown;
  LanguageServer: new () => { handle(message: string): string[]; readonly closed: boolean; free(): void };
  version(): string;
}

/** The pinned engine, unpacked into .cache/. */
async function loadRealEngine(): Promise<EngineModule> {
  const lib = (await import(pathToFileURL(path.join(ROOT, "scripts", "engine-lib.mjs")).href)) as {
    prepareEngine(root: string, pin: unknown): Promise<string>;
    GLUE: string;
    WASM: string;
  };
  const pins = JSON.parse(readFileSync(path.join(ROOT, "pins.json"), "utf8")) as { engine: unknown };
  const dir = await lib.prepareEngine(ROOT, pins.engine);
  const glue = (await import(pathToFileURL(path.join(dir, lib.GLUE)).href)) as Glue;
  glue.initSync({ module: readFileSync(path.join(dir, lib.WASM)) });
  return { createSession: () => new glue.LanguageServer(), version: () => glue.version() };
}

function document(relative: string): SuppliedDocument {
  const file = path.join(WORKSPACE, ...relative.split("/"));
  return { uri: pathToFileURL(file).href, text: readFileSync(file, "utf8") };
}

/** The host on one end of an in-memory channel, a JSON-RPC connection on the other. */
function connect(module: EngineModule): { connection: MessageConnection; done: Promise<void> } {
  const client = fakeEnginePort();
  let toClient: (data: unknown) => void = () => undefined;
  const done = serveEngine(
    {
      postMessage: (text) => setImmediate(() => client.message(text)),
      onMessage: (listener) => {
        toClient = listener;
      },
      close: () => setImmediate(() => client.exit()),
    },
    () => module,
  );
  const port = { ...client.port, post: (text: string) => setImmediate(() => toClient(text)) };
  const { reader, writer } = engineTransports(port);
  const connection = createMessageConnection(reader, writer);
  connection.listen();
  return { connection, done };
}

describe("the engine (WASM), for real", function () {
  this.timeout(120_000);
  let module: EngineModule;

  before(async () => {
    module = await loadRealEngine();
  });

  it("is the pinned version", () => {
    const pins = JSON.parse(readFileSync(path.join(ROOT, "pins.json"), "utf8")) as {
      engine: { version: string };
    };
    assert.equal(module.version(), pins.engine.version);
  });

  it("answers diagnostics, hover and opentide/catalog from the workspace it is given", async () => {
    const { connection, done } = connect(module);
    const diagnostics = new Promise<{ code?: unknown; message: string }[]>((resolve) =>
      connection.onNotification("textDocument/publishDiagnostics", (params: { diagnostics: [] }) =>
        resolve(params.diagnostics),
      ),
    );
    const root = pathToFileURL(WORKSPACE).href;
    const init = (await connection.sendRequest("initialize", {
      processId: null,
      rootUri: root,
      workspaceFolders: [{ uri: root, name: "workspace" }],
      capabilities: {},
      initializationOptions: {
        workspace: {
          documents: [
            document("objects/objectives/detect-lsass-access.yaml"),
            document("objects/rules/suspicious-lsass-access.yaml"),
          ],
        },
      },
    })) as { capabilities: { experimental: { opentide: { engine: string; host: unknown } } } };
    assert.equal(init.capabilities.experimental.opentide.engine, module.version());
    assert.equal(init.capabilities.experimental.opentide.host, null);
    await connection.sendNotification("initialized", {});

    const broken = document("detections/rules/misspelled-tlp.yaml");
    await connection.sendNotification("textDocument/didOpen", {
      textDocument: { ...broken, languageId: "opentide-yaml", version: 1 },
    });
    const found = await diagnostics;
    assert.ok(
      found.some((d) => d.code === "vocab_unknown" && /ambr/.test(d.message)),
      JSON.stringify(found),
    );
    // The objective is only in the supplied workspace: no invalid_ref.
    assert.equal(
      found.some((d) => d.code === "invalid_ref"),
      false,
    );

    const hover = (await connection.sendRequest("textDocument/hover", {
      textDocument: { uri: broken.uri },
      position: { line: 5, character: 25 },
    })) as { contents: { value: string } } | null;
    assert.match(hover?.contents.value ?? "", /Detect LSASS access/);

    const catalog = parseServerCatalog(await connection.sendRequest("opentide/catalog", {}));
    assert.ok(catalog);
    const folder = rootOf(catalog, WORKSPACE);
    assert.ok(folder, "the workspace folder is a root");
    const doc = serverCatalogDocument(folder, WORKSPACE);
    assert.deepEqual(doc.objects.map((o) => o.name).sort(), [
      "Detect LSASS access",
      "Misspelled TLP",
      "Suspicious LSASS Access",
    ]);
    assert.ok(doc.edges.some((e) => e.kind === "implements" && !e.missing));

    await connection.sendRequest("shutdown");
    await connection.sendNotification("exit");
    await done;
    connection.dispose();
  });
});
