import * as assert from "node:assert/strict";
import type { Finding } from "../../../src/features/diagnostics/findings";
import { FindingsModel, fileKey, isInside } from "../../../src/features/diagnostics/model";

const finding = (file: string, code = "c", source: "validate" | "lint" = "validate"): Finding => ({
  source,
  file,
  code,
  severity: "error",
  message: code,
  help: null,
  span: { line: 1 },
  fix: null,
  related: [],
});

const WS = { kind: "workspace", folder: "/ws" } as const;

describe("diagnostics: model", () => {
  it("replaces a folder's findings with a workspace run", () => {
    const model = new FindingsModel("linux");
    model.apply("validate", model.begin(), WS, [finding("/ws/a.yaml"), finding("/ws/b.yaml")]);
    const changed = model.apply("validate", model.begin(), WS, [finding("/ws/b.yaml", "d")]);
    assert.deepEqual(changed.sort(), ["/ws/a.yaml", "/ws/b.yaml"]);
    assert.equal(model.get("validate", "/ws/a.yaml").length, 0);
    assert.equal(model.get("validate", "/ws/b.yaml")[0]?.code, "d");
  });

  it("a files run replaces only the files it named", () => {
    const model = new FindingsModel("linux");
    model.apply("validate", model.begin(), WS, [finding("/ws/a.yaml"), finding("/ws/b.yaml")]);
    model.apply("validate", model.begin(), { kind: "files", folder: "/ws", files: ["/ws/a.yaml"] }, [
      finding("/ws/b.yaml", "ignored"),
    ]);
    assert.equal(model.get("validate", "/ws/a.yaml").length, 0);
    assert.equal(model.get("validate", "/ws/b.yaml")[0]?.code, "c");
  });

  it("drops a file's findings on edit, and a run that started before the edit cannot bring them back", () => {
    const model = new FindingsModel("linux");
    model.apply("validate", model.begin(), WS, [finding("/ws/a.yaml")]);
    const running = model.begin();
    assert.equal(model.edited("/ws/a.yaml"), true);
    assert.equal(model.has("/ws/a.yaml"), false);
    model.apply("validate", running, WS, [finding("/ws/a.yaml")]);
    assert.equal(model.has("/ws/a.yaml"), false, "stale is worse than missing");
    model.apply("validate", model.begin(), WS, [finding("/ws/a.yaml")]);
    assert.equal(model.has("/ws/a.yaml"), true, "the next run shows them again");
  });

  it("an older run's result never overwrites a newer one", () => {
    const model = new FindingsModel("linux");
    const older = model.begin();
    const newer = model.begin();
    model.apply("validate", newer, { kind: "files", folder: "/ws", files: ["/ws/a.yaml"] }, []);
    model.apply("validate", older, WS, [finding("/ws/a.yaml"), finding("/ws/b.yaml")]);
    assert.equal(model.has("/ws/a.yaml"), false);
    assert.equal(model.has("/ws/b.yaml"), true);
  });

  it("keeps validate and lint apart, and skips files the caller says are dirty", () => {
    const model = new FindingsModel("linux");
    model.apply(
      "lint",
      model.begin(),
      WS,
      [finding("/ws/a.yaml", "l", "lint"), finding("/ws/b.yaml", "l", "lint")],
      (file) => file.endsWith("b.yaml"),
    );
    assert.equal(model.get("lint", "/ws/a.yaml").length, 1);
    assert.equal(model.get("validate", "/ws/a.yaml").length, 0);
    assert.equal(model.has("/ws/b.yaml"), false);
  });

  it("forgets deleted files, removed folders, and everything", () => {
    const model = new FindingsModel("linux");
    model.apply("validate", model.begin(), WS, [finding("/ws/a.yaml"), finding("/ws/b.yaml")]);
    model.apply("validate", model.begin(), { kind: "workspace", folder: "/other" }, [
      finding("/other/c.yaml"),
    ]);
    assert.equal(model.removed("/ws/a.yaml"), true);
    assert.deepEqual(model.removeFolder("/ws"), ["/ws/b.yaml"]);
    assert.deepEqual(model.files(), ["/other/c.yaml"]);
    assert.deepEqual(model.clear(), ["/other/c.yaml"]);
    assert.deepEqual(model.files(), []);
  });

  it("does not treat a sibling folder with a common prefix as inside", () => {
    assert.ok(isInside("/ws", "/ws/a.yaml", "linux"));
    assert.ok(!isInside("/ws", "/ws2/a.yaml", "linux"));
    const model = new FindingsModel("linux");
    model.apply("validate", model.begin(), WS, [finding("/ws2/a.yaml")]);
    assert.equal(model.has("/ws2/a.yaml"), false, "a folder's run only lands inside it");
  });

  it("folds case on Windows and macOS", () => {
    assert.equal(fileKey("C:\\WS\\A.yaml", "win32"), fileKey("c:\\ws\\a.yaml", "win32"));
    assert.notEqual(fileKey("/ws/A.yaml", "linux"), fileKey("/ws/a.yaml", "linux"));
  });
});
