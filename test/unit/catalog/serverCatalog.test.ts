import * as assert from "node:assert/strict";
import { RelationIndex } from "../../../src/core/catalog/relations";
import {
  fieldOf,
  isMethodNotFound,
  parseServerCatalog,
  rootOf,
  type ServerRoot,
  serverCatalogDocument,
  serverRelations,
} from "../../../src/core/catalog/serverCatalog";
import { isCatalogDocument } from "../../../src/core/catalog/types";
import { serverObjects } from "./serverFixture";

describe("the language server's opentide/catalog", () => {
  it("turns reference fields into the catalogue's edges, and finds signals in their objective", () => {
    const { edges, signals } = serverRelations(serverObjects());
    assert.deepEqual(
      edges.map((e) => [e.from, e.kind, e.to, e.missing]),
      [
        ["t1", "chains", "t2", false],
        ["s2", "parent", "s1", false],
        ["o1", "covers", "t1", false],
        ["r1", "implements", "o1", false],
        ["r2", "implements", "S1", false],
        ["r3", "implements", "gone", true],
      ],
    );
    assert.deepEqual(
      signals.map((s) => [s.uuid, s.name, s.objective, s.parent, s.line]),
      [
        ["s1", "Signal 1", "o1", null, 20],
        ["s2", "Signal 2", "o1", "s1", 30],
      ],
    );
  });

  it("inverts every object's references into what points to each one", () => {
    const index = new RelationIndex(serverRelations(serverObjects()));
    assert.deepEqual(
      index.of("o1").incoming.map((r) => [r.kind, r.other]),
      [["implements", "r1"]],
    );
    assert.deepEqual(
      index.of("s1").incoming.map((r) => [r.kind, r.other]),
      [
        ["implements", "r2"],
        ["signal", "o1"],
        ["parent", "s2"],
      ],
    );
    assert.deepEqual(
      index.of("t1").incoming.map((r) => [r.kind, r.other]),
      [["covers", "o1"]],
    );
    assert.deepEqual(index.of("gone").incoming, []);
    assert.equal(index.of("r3").outgoing[0]?.missing, true);
  });

  it("lists a reference the language server repeats once, as info catalog does", () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    const objects = serverObjects().map((o) =>
      o.uuid === "o1"
        ? {
            ...o,
            refs: [
              ...o.refs,
              { uuid: "t1", field_path: "objective.threats.1", range },
              { uuid: "t2", field_path: "objective.threats.2", range },
            ],
          }
        : o.uuid === "t1"
          ? { ...o, refs: [...o.refs, { uuid: "t2", field_path: "threat.chaining.1.vector", range }] }
          : o,
    );
    const index = new RelationIndex(serverRelations(objects));
    assert.deepEqual(
      index
        .of("o1")
        .outgoing.filter((r) => r.kind === "covers")
        .map((r) => [r.other, r.fieldPath]),
      [
        ["t1", "objective.threats"],
        ["t2", "objective.threats"],
      ],
    );
    assert.deepEqual(
      index.of("t1").incoming.map((r) => [r.kind, r.other]),
      [["covers", "o1"]],
    );
    assert.equal(index.of("t1").outgoing.filter((r) => r.kind === "chains").length, 1);
    assert.equal(fieldOf("objective.signals.1.parent"), "objective.signals.1.parent");
    assert.equal(fieldOf("detection_model"), "detection_model");
  });

  it("keeps only what has the documented shape", () => {
    assert.equal(parseServerCatalog(null), undefined);
    assert.equal(parseServerCatalog({}), undefined);
    const parsed = parseServerCatalog({
      roots: [
        {
          root: "file:///w",
          objects: [
            ...serverObjects().slice(0, 1),
            { uuid: 1, name: "bad" },
            { ...serverObjects()[3], refs: [{ uuid: "o1" }, ...(serverObjects()[3]?.refs ?? [])] },
          ],
        },
        { root: null, objects: "nope" },
        7,
      ],
    });
    assert.equal(parsed?.roots.length, 2);
    assert.deepEqual(
      parsed?.roots[0]?.objects.map((o) => [o.uuid, o.refs.length]),
      [
        ["t1", 1],
        ["r1", 1],
      ],
    );
    assert.deepEqual(parsed?.roots[1], { root: null, objects: [] });
  });

  it("finds a folder's root by path, whatever the URI spelling", () => {
    const catalog = {
      roots: [
        { root: "file:///C:/Repo%20One", objects: [] },
        { root: null, objects: [] },
      ],
    };
    assert.equal(rootOf(catalog, "c:\\repo one", "win32"), catalog.roots[0]);
    assert.equal(rootOf(catalog, "c:\\other", "win32"), undefined);
    const posix = { roots: [{ root: "file:///w/", objects: [] }] };
    assert.equal(rootOf(posix, "/w", "linux"), posix.roots[0]);
    assert.equal(rootOf(posix, "/W", "linux"), undefined);
  });

  it("builds the folder's catalogue document from its root, with only what the index knows", () => {
    const root = {
      root: "file:///w",
      objects: [...serverObjects(), { ...serverObjects()[0], uuid: "x", uri: "file:///elsewhere/x.yaml" }],
    } as ServerRoot;
    const doc = serverCatalogDocument(root, "/w", "linux");
    assert.equal(isCatalogDocument(doc), true);
    assert.equal(doc.command, "opentide/catalog");
    assert.equal(doc.objects.length, serverObjects().length, "an object outside the folder is left out");
    const o1 = doc.objects.find((o) => o.uuid === "o1");
    assert.deepEqual(
      o1 && { type: o1.type, path: o1.path, file: o1.file_path, line: o1.line, platforms: o1.platforms },
      {
        type: "objective",
        path: "objects/objectives/o1.yaml",
        file: "/w/objects/objectives/o1.yaml",
        line: 1,
        platforms: [],
      },
    );
    assert.deepEqual(doc.edges, serverRelations(serverObjects()).edges);
    assert.deepEqual(
      doc.signals.map((s) => s.uuid),
      ["s1", "s2"],
    );
    assert.equal("line" in (doc.signals[0] ?? {}), false);
    assert.deepEqual(doc.attack, { tactics: [], techniques: {} });
    assert.equal(doc.summary.objects, doc.objects.length);
    assert.equal(doc.summary.threats, 2);
    assert.equal(doc.summary.edges, doc.edges.length);
  });

  it("tells MethodNotFound from other failures", () => {
    assert.equal(isMethodNotFound({ code: -32601, message: "Unhandled method opentide/catalog" }), true);
    assert.equal(isMethodNotFound({ code: -32603 }), false);
    assert.equal(isMethodNotFound(new Error("x")), false);
    assert.equal(isMethodNotFound(undefined), false);
  });
});
