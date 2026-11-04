import * as assert from "node:assert/strict";
import type { CatalogState } from "../../../src/core/catalog/store";
import { hostValidators, webviewValidators } from "../../../src/features/graph/protocol";
import {
  exportBytes,
  folderWithNode,
  graphData,
  inFolder,
  ModelCache,
  objectAtPath,
  parseOpenArgs,
  parseRevealArgs,
  pathKey,
  problemMap,
  problemsFor,
} from "../../../src/features/graph/state";
import { sampleCatalog, UUID } from "../catalogFixture";

const state = (patch: Partial<CatalogState>): CatalogState => ({
  folder: "/ws",
  status: "empty",
  refreshing: false,
  ...patch,
});

describe("graph host state", () => {
  const catalog = sampleCatalog();

  it("sends the model once the catalogue is ready, built once per document", () => {
    const cache = new ModelCache();
    const ready = graphData(state({ status: "ready", catalog }), "ws", cache);
    assert.equal(ready.status, "ready");
    assert.equal(ready.folder, "ws");
    assert.ok(ready.model);
    assert.equal(
      graphData(state({ status: "ready", catalog, refreshing: true }), "ws", cache).model,
      ready.model,
    );
    assert.notEqual(
      graphData(state({ status: "ready", catalog: sampleCatalog() }), "ws", cache).model,
      ready.model,
    );
  });

  it("keeps the last catalogue after a failed refresh and says so", () => {
    const data = graphData(state({ status: "error", catalog, error: "boom" }), "ws", new ModelCache());
    assert.equal(data.status, "ready");
    assert.equal(data.message, "Showing the last catalogue: boom");
  });

  it("says a newer opentide is needed without info catalog (0.21.0)", () => {
    const data = graphData(
      state({
        status: "unavailable",
        unavailable: { reason: "needs-command", command: "info catalog", message: "…" },
        symbols: [{ name: "R", family: "rule", uri: "file:///ws/r.yaml", line: 0, character: 0 }],
      }),
      "ws",
      new ModelCache(),
    );
    assert.equal(data.status, "unavailable");
    assert.equal(data.needs, "info catalog");
    assert.equal(data.reason, "needs-command");
    assert.match(data.message ?? "", /needs a newer opentide: one with `info catalog`/);
    assert.equal(data.model, undefined, "symbols have no edges to draw");
  });

  it("passes the other unavailable reasons and errors through", () => {
    const untrusted = graphData(
      state({ status: "unavailable", unavailable: { reason: "untrusted", message: "Trust this folder." } }),
      "ws",
      new ModelCache(),
    );
    assert.equal(untrusted.reason, "untrusted");
    assert.equal(untrusted.message, "Trust this folder.");
    assert.equal(
      graphData(state({ status: "loading", refreshing: true }), "ws", new ModelCache()).status,
      "loading",
    );
    assert.match(
      graphData(state({ status: "error", error: "x" }), "ws", new ModelCache()).message ?? "",
      /failed to load: x/,
    );
  });

  it("finds the object a file holds, case-insensitively on Windows", () => {
    assert.equal(objectAtPath(catalog, "/ws/objects/rules/suspicious-lsass-access.yaml", "linux"), UUID.rule);
    assert.equal(objectAtPath(catalog, "/WS/objects/rules/suspicious-lsass-access.yaml", "linux"), undefined);
    assert.equal(
      objectAtPath(catalog, "\\WS\\objects\\rules\\suspicious-lsass-access.yaml", "win32"),
      UUID.rule,
    );
    assert.equal(objectAtPath(catalog, "/ws/objects/rules/bad.yaml", "linux"), "file:objects/rules/bad.yaml");
    assert.equal(pathKey("C:\\A", "win32"), "c:/a");
  });

  it("counts problems per node from the Problems panel's files", () => {
    const map = problemMap(
      catalog,
      [
        { file: "/ws/objects/rules/suspicious-lsass-access.yaml", errors: 2, warnings: 1 },
        { file: "/ws/objects/rules/other.yaml", errors: 1, warnings: 0 },
        { file: "/ws/objects/rules/broken-reference.yaml", errors: 0, warnings: 0 },
      ],
      "linux",
    );
    assert.deepEqual(map, { [UUID.rule]: { errors: 2, warnings: 1 } });
  });

  it("finds the folder whose catalogue has a node", () => {
    const states = [state({ folder: "/a" }), state({ folder: "/ws", status: "ready", catalog })];
    assert.equal(folderWithNode(states, UUID.rule), "/ws");
    assert.equal(folderWithNode(states, UUID.signal), "/ws");
    assert.equal(folderWithNode(states, "nope"), undefined);
  });

  it("writes PNG bytes from base64 and text as UTF-8", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    assert.deepEqual([...exportBytes("png", png)], [0x89, 0x50, 0x4e, 0x47]);
    assert.deepEqual([...exportBytes("png", `data:image/png;base64,${png}`)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(new TextDecoder().decode(exportBytes("svg", "<svg>é</svg>")), "<svg>é</svg>");
  });
});

describe("graph protocol", () => {
  it("accepts only known exports and actions from the webview", () => {
    assert.ok(hostValidators.export({ format: "svg", data: "<svg/>" }));
    assert.ok(!hostValidators.export({ format: "html", data: "x" }));
    assert.ok(!hostValidators.export({ format: "png" }));
    assert.ok(hostValidators.action("refresh"));
    assert.ok(!hostValidators.action("workbench.action.terminal.new"));
    assert.ok(hostValidators.open(UUID.rule));
    assert.ok(!hostValidators.open(42));
    assert.ok(!hostValidators.copy("x".repeat(10_001)));
    assert.ok(hostValidators.ready(undefined));
  });

  it("checks the host's messages on the webview side", () => {
    assert.ok(webviewValidators.data({ status: "loading", folder: "ws", refreshing: true }));
    assert.ok(
      !webviewValidators.data({ status: "ready", folder: "ws", refreshing: false, model: { nodes: [] } }),
    );
    assert.ok(webviewValidators.focus({ ids: [UUID.rule], explicit: true }));
    assert.ok(!webviewValidators.focus({ ids: [1], explicit: true }));
    assert.ok(webviewValidators.problems({}));
  });
});

describe("graph command arguments", () => {
  it("reads opentide.graph.open and opentide.graph.reveal arguments", () => {
    assert.deepEqual(parseOpenArgs({ uuids: ["a", 1, "b"], folder: "/ws", mode: "focus" }), {
      uuids: ["a", "b"],
      folder: "/ws",
      mode: "focus",
    });
    assert.deepEqual(parseOpenArgs({ mode: "everything" }), {});
    assert.deepEqual(parseOpenArgs(undefined), {});
    assert.equal(parseRevealArgs({ uuid: UUID.rule }), UUID.rule);
    assert.equal(parseRevealArgs(UUID.rule), UUID.rule);
    assert.equal(parseRevealArgs({ uuid: "" }), undefined);
    assert.equal(parseRevealArgs(null), undefined);
  });
});

describe("graph: problems of the folder shown", () => {
  it("is an empty map while a switched-to folder's catalogue loads, never the previous folder's", () => {
    assert.deepEqual(
      problemsFor(undefined, [{ file: "/a/objects/x.yaml", errors: 1, warnings: 0 }], "linux"),
      {},
    );
  });

  it("counts only the folder's own files, not a sibling whose path starts the same", () => {
    assert.ok(inFolder("/repo", "/repo/objects/x.yaml", "linux"));
    assert.ok(!inFolder("/repo", "/repo-2/objects/x.yaml", "linux"));
    assert.ok(inFolder("C:\\Repo\\", "c:\\repo\\objects\\x.yaml", "win32"));
  });
});
