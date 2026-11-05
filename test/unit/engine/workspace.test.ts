import * as assert from "node:assert/strict";
import {
  collectDocuments,
  isSuppliedPath,
  objectGlob,
  objectRoots,
  WorkspaceMirror,
} from "../../../src/engine/workspace";

const DEFAULTS = { threat: "objects/threats/", objective: "objects/objectives/", rule: "objects/rules/" };

describe("engine workspace (src/engine/workspace.ts)", () => {
  it("covers objects/ and each paths.toml object folder outside it, once", () => {
    assert.deepEqual(objectRoots(DEFAULTS), ["objects/"]);
    assert.deepEqual(objectRoots({ ...DEFAULTS, rule: "detections/rules/" }), [
      "detections/rules/",
      "objects/",
    ]);
    assert.deepEqual(objectRoots({ rule: "./detections\\rules" }), ["detections/rules/", "objects/"]);
    // Nothing outside the folder.
    assert.deepEqual(objectRoots({ rule: "../elsewhere/", threat: "/abs/" }), ["objects/"]);
    assert.equal(objectGlob(DEFAULTS), "objects/**/*.{yaml,yml}");
    assert.equal(objectGlob({ rule: "detections/rules/" }), "{detections/rules,objects}/**/*.{yaml,yml}");
  });

  it("tells object files apart", () => {
    const folders = { ...DEFAULTS, rule: "detections/rules/" };
    assert.equal(isSuppliedPath("objects/objectives/a.yaml", folders), true);
    assert.equal(isSuppliedPath("detections/rules/sub/b.yml", folders), true);
    assert.equal(isSuppliedPath("detections/other/c.yaml", folders), false);
    assert.equal(isSuppliedPath("objects/notes.md", folders), false);
    assert.equal(isSuppliedPath(".github/workflows/ci.yml", folders), false);
  });

  it("reads files in batches, yielding between them, and reports what it left out", async () => {
    const uris = Array.from(
      { length: 70 },
      (_, i) => `file:///w/objects/r${String(i).padStart(2, "0")}.yaml`,
    );
    let inFlight = 0;
    let peak = 0;
    const progress: number[] = [];
    const encoder = new TextEncoder();
    const { documents, skipped } = await collectDocuments(
      [...uris, "file:///w/objects/gone.yaml", "file:///w/objects/huge.yaml"],
      async (uri) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        if (uri.endsWith("gone.yaml")) throw new Error("EntryNotFound");
        if (uri.endsWith("huge.yaml")) return new Uint8Array(64);
        return encoder.encode(`name: ${uri}`);
      },
      { concurrency: 16, maxFileBytes: 32, onProgress: (done) => progress.push(done) },
    );
    assert.equal(documents.length, 70);
    assert.equal(peak, 16);
    assert.deepEqual(progress, [16, 32, 48, 64, 72]);
    assert.deepEqual(
      skipped.map((s) => [s.uri.split("/").pop(), s.reason]),
      [
        ["gone.yaml", "EntryNotFound"],
        ["huge.yaml", "larger than 32 bytes"],
      ],
    );
    assert.deepEqual(
      documents.map((d) => d.uri),
      [...uris].sort(),
    );
  });

  it("stops at the file limit", async () => {
    const uris = ["file:///w/objects/a.yaml", "file:///w/objects/b.yaml", "file:///w/objects/c.yaml"];
    const { documents, skipped } = await collectDocuments(uris, async () => new TextEncoder().encode("x"), {
      maxFiles: 2,
    });
    assert.equal(documents.length, 2);
    assert.deepEqual(skipped, [{ uri: "file:///w/objects/c.yaml", reason: "more than 2 object files" }]);
  });

  it("tells a change as a delta, and nothing when the server has the text", () => {
    const mirror = new WorkspaceMirror({
      documents: [
        { uri: "file:///w/objects/a.yaml", text: "a" },
        { uri: "file:///w/objects/b.yaml", text: "b" },
      ],
      visibility: "[[logsources]]",
    });
    assert.equal(mirror.apply([{ uri: "file:///w/objects/a.yaml", text: "a" }]), undefined);
    assert.equal(mirror.apply([{ uri: "file:///w/objects/missing.yaml", text: undefined }]), undefined);
    assert.equal(mirror.apply([], { text: "[[logsources]]" }), undefined);
    assert.deepEqual(
      mirror.apply([
        { uri: "file:///w/objects/a.yaml", text: "a2" },
        { uri: "file:///w/objects/b.yaml", text: undefined },
        { uri: "file:///w/objects/c.yaml", text: "c" },
      ]),
      {
        documents: [
          { uri: "file:///w/objects/a.yaml", text: "a2" },
          { uri: "file:///w/objects/c.yaml", text: "c" },
        ],
        removed: ["file:///w/objects/b.yaml"],
      },
    );
    assert.deepEqual(mirror.apply([], { text: undefined }), { documents: [], removed: [], visibility: null });
    assert.deepEqual(mirror.snapshot(), {
      documents: [
        { uri: "file:///w/objects/a.yaml", text: "a2" },
        { uri: "file:///w/objects/c.yaml", text: "c" },
      ],
    });
    assert.equal(mirror.size, 2);
  });
});
