import * as assert from "node:assert/strict";
import * as path from "node:path";
import type { CatalogObject } from "../../../src/core/catalog/types";
import {
  choiceItem,
  choicesFromCatalog,
  createdOf,
  failureAction,
  kindOfFolder,
  newArgv,
  objectFolderPaths,
  objectHeader,
  placeholdersLeft,
  placeholdersText,
  platformItems,
  platformsOf,
  slugOf,
  validateName,
} from "../../../src/features/new-object/flow";

const ROOT = path.resolve("/ws");
const FOLDERS = { threat: "objects/threats/", objective: "objects/objectives/", rule: "detections/rules/" };

describe("new-object: flow", () => {
  it("builds `opentide new` argv with the options the command has", () => {
    assert.deepEqual(
      newArgv({
        kind: "rule",
        name: "A",
        platforms: ["sentinel", "splunk"],
        objective: "u-1",
        path: "/ws/x",
      }),
      [
        "new",
        "rule",
        "--name",
        "A",
        "--platform",
        "sentinel",
        "--platform",
        "splunk",
        "--objective",
        "u-1",
        "--path",
        "/ws/x",
      ],
    );
    assert.deepEqual(newArgv({ kind: "objective", name: "O", threats: ["t1", "t2"] }), [
      "new",
      "objective",
      "--name",
      "O",
      "--threat",
      "t1",
      "--threat",
      "t2",
    ]);
    assert.deepEqual(
      newArgv({ kind: "threat", name: "T", path: "/x" }, (flag) => flag !== "--path"),
      ["new", "threat", "--name", "T"],
    );
  });

  it("previews the slug and checks the name", () => {
    assert.equal(slugOf("Suspicious LSASS Access"), "suspicious-lsass-access");
    assert.equal(slugOf("Test Rule 😀"), "test-rule");
    assert.equal(slugOf("Détection"), "detection");
    assert.ok(validateName("  "));
    assert.equal(validateName("x"), undefined);
  });

  it("knows the kind of an object folder from paths.toml, and lists them for the Explorer menu", () => {
    assert.equal(kindOfFolder(ROOT, path.join(ROOT, "detections/rules"), FOLDERS), "rule");
    assert.equal(kindOfFolder(ROOT, path.join(ROOT, "objects/threats/apt"), FOLDERS), "threat");
    assert.equal(kindOfFolder(ROOT, path.join(ROOT, "objects"), FOLDERS), undefined);
    assert.deepEqual(objectFolderPaths(ROOT, FOLDERS), [
      path.join(ROOT, "objects"),
      path.join(ROOT, "objects/threats"),
      path.join(ROOT, "objects/objectives"),
      path.join(ROOT, "detections/rules"),
    ]);
  });

  it("lists enabled platforms first and picked, with what opentide can do there", () => {
    const info = platformsOf({
      platforms: [
        { name: "elastic", enabled: false, can_deploy: true, can_validate: true, can_query: true },
        { name: "sentinel", enabled: true, can_deploy: true, can_validate: true, can_query: true },
        { name: "crowdstrike", enabled: true, can_deploy: true, can_validate: false, can_query: true },
      ],
    });
    const items = platformItems(["sentinel", "elastic", "crowdstrike", "sysdig"], info);
    assert.deepEqual(
      items.map((i) => [i.id, i.picked, i.description]),
      [
        ["sentinel", true, "enabled · deploy · validate · query"],
        ["crowdstrike", true, "enabled · deploy · query"],
        ["sysdig", false, ""],
        ["elastic", false, "not enabled here: validate will warn"],
      ],
    );
    assert.equal(items[0]?.label, "Microsoft Sentinel");
    assert.deepEqual(platformsOf({}), []);
  });

  it("picks objectives from the catalogue, searchable by name, UUID prefix and technique", () => {
    const object = (uuid: string, type: string, name: string, own: string[] = []): CatalogObject => ({
      uuid,
      type,
      schema: "",
      name,
      path: "",
      file_path: `/ws/${name}.yaml`,
      line: 1,
      platforms: [],
      deployment: [],
      techniques: { own, inherited: [] },
      tactics: [],
      actors: [],
      load_error: null,
    });
    const choices = choicesFromCatalog(
      [
        object("04149254-aaaa", "objective", "Detect LSASS", ["T1003.001"]),
        object("t", "threat", "T"),
        object("9f0c0000-b", "objective", "Detect DCSync"),
      ],
      "objective",
    );
    assert.deepEqual(
      choices.map((c) => c.name),
      ["Detect DCSync", "Detect LSASS"],
    );
    const lsass = choices[1];
    assert.ok(lsass);
    assert.deepEqual(choiceItem(lsass), {
      label: "Detect LSASS",
      description: "04149254",
      detail: "T1003.001",
      uuid: "04149254-aaaa",
    });
  });

  it("reads name and metadata.uuid from an object file without the catalogue", () => {
    const text =
      "name: Detect LSASS access\n\nmetadata:\n  uuid: 04149254-6a88-41b9-95a3-a030a4a00314\nobjective:\n  signals:\n    - uuid: 2ae24482-33aa-44e6-9514-97648be1c04a\n";
    assert.deepEqual(objectHeader(text), {
      name: "Detect LSASS access",
      uuid: "04149254-6a88-41b9-95a3-a030a4a00314",
    });
    assert.deepEqual(objectHeader("name: 'Quoted'\nmetadata:\n  uuid: aaaaaaaa-1\n"), {
      name: "Quoted",
      uuid: "aaaaaaaa-1",
    });
    assert.equal(objectHeader("name: x\nsignals:\n  uuid: aaaaaaaa-1\n"), undefined, "only metadata's uuid");
  });

  it("reads what `opentide new` created (0.21.0 shape)", () => {
    const created = createdOf(
      {
        ok: true,
        path: "objects/rules/test-rule.yaml",
        file_path: "/ws/objects/rules/test-rule.yaml",
        uuid: "623c",
        placeholders: ["description", "configurations.sentinel.query"],
        message: "Created objects/rules/test-rule.yaml · 2 placeholders to replace",
      },
      ROOT,
    );
    assert.deepEqual(created, {
      file: "/ws/objects/rules/test-rule.yaml",
      placeholders: 2,
      uuid: "623c",
      message: "Created objects/rules/test-rule.yaml · 2 placeholders to replace",
    });
    assert.equal(createdOf({ ok: false }, ROOT), undefined);
    assert.equal(placeholdersText(1), "1 placeholder to replace");
    assert.equal(placeholdersLeft(3), "3 placeholders left");
  });

  it("offers the next step for each failure code", () => {
    assert.deepEqual(failureAction("workspace_not_found", "", ROOT), { kind: "setup" });
    assert.deepEqual(failureAction("reference_not_found", "", ROOT), { kind: "pick-again" });
    assert.deepEqual(
      failureAction(
        "path_exists",
        "objects/rules/test-rule.yaml already exists; new never overwrites a file",
        ROOT,
      ),
      { kind: "exists", file: path.join(ROOT, "objects/rules/test-rule.yaml") },
    );
    assert.deepEqual(failureAction("template_missing", "", ROOT), { kind: "regenerate" });
    assert.deepEqual(failureAction("path_not_writable", "", ROOT), { kind: "regenerate" });
    assert.deepEqual(failureAction("internal", "", ROOT), { kind: "message" });
  });
});
