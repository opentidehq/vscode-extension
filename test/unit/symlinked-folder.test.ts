// A folder opened through a symlink: opentide reports real paths, the workspace uses the link's.
import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { inFolderSpelling } from "../../src/core/catalog/store";
import type { CatalogDocument, CatalogObject } from "../../src/core/catalog/types";
import { folderSpelling } from "../../src/core/util/paths";
import { lintFindings, validateFindings } from "../../src/features/diagnostics/findings";
import { FindingsModel } from "../../src/features/diagnostics/model";
import { createdOf } from "../../src/features/new-object/flow";

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "otide-link-")));
const real = path.join(scratch, "ws");
const link = path.join(scratch, "link");
mkdirSync(path.join(real, "objects", "rules"), { recursive: true });
let linked = true;
try {
  symlinkSync(real, link, "junction");
} catch {
  linked = false;
}
const realFile = path.join(real, "objects", "rules", "lsass-0.yaml");
const linkFile = path.join(link, "objects", "rules", "lsass-0.yaml");

describe("a folder opened through a symlink", () => {
  before(function () {
    if (!linked) this.skip();
  });

  it("maps real paths back to the folder's spelling, and leaves others alone", () => {
    const spell = folderSpelling(link);
    assert.equal(spell(realFile), linkFile);
    assert.equal(spell(real), link);
    assert.equal(spell("/elsewhere/x.yaml"), "/elsewhere/x.yaml");
    assert.equal(folderSpelling(real)(realFile), realFile, "no link, no change");
  });

  it("keeps validate and lint findings, workspace and files runs", () => {
    const validate = {
      workspace: real,
      report: {
        issues: [
          {
            code: "invalid_uuid",
            severity: "error",
            message: "bad uuid",
            path: "objects/rules/lsass-0.yaml",
            file_path: realFile,
            line: 7,
            context: { original: { file_path: realFile, name: "other" } },
          },
        ],
        warnings: [],
      },
    };
    const lint = {
      path: real,
      findings: [
        {
          check: "metadata",
          code: "metadata_recommended",
          severity: "info",
          message: "m",
          path: "objects/rules/lsass-0.yaml",
          line: 1,
        },
      ],
    };
    const v = validateFindings(validate, link).findings;
    const l = lintFindings(lint, link).findings;
    assert.equal(v[0]?.file, linkFile);
    assert.equal(v[0]?.related[0]?.file, linkFile);
    assert.equal(l[0]?.file, linkFile);

    const model = new FindingsModel("linux");
    assert.deepEqual(model.apply("validate", model.begin(), { kind: "workspace", folder: link }, v), [
      linkFile,
    ]);
    assert.equal(model.get("validate", linkFile).length, 1);
    const files = new FindingsModel("linux");
    files.apply("lint", files.begin(), { kind: "files", folder: link, files: [linkFile] }, l);
    assert.equal(files.get("lint", linkFile).length, 1);
  });

  it("opens a created object under the folder's spelling", () => {
    const created = createdOf({ ok: true, file_path: realFile, placeholders: [] }, link);
    assert.equal(created?.file, linkFile);
  });

  it("gives catalogue objects the folder's spelling", () => {
    const object = {
      uuid: "u",
      file_path: realFile,
      path: "objects/rules/lsass-0.yaml",
    } as unknown as CatalogObject;
    const document = { objects: [object], edges: [] } as unknown as CatalogDocument;
    assert.equal(inFolderSpelling(document, link).objects[0]?.file_path, linkFile);
    assert.equal(inFolderSpelling(document, real), document, "unchanged without a link");
  });
});
