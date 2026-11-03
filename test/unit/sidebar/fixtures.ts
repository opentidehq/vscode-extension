// A small `info catalog` document (CONTRACTS.md shape) for the sidebar tests.
import type { CatalogState } from "../../../src/core/catalog/store";
import type { CatalogDocument, CatalogObject } from "../../../src/core/catalog/types";

export const ROOT = "/repo";

export function object(
  partial: Partial<CatalogObject> & Pick<CatalogObject, "uuid" | "type" | "name">,
): CatalogObject {
  const file = `objects/${partial.type}s/${partial.name.toLowerCase().replaceAll(" ", "-")}.yaml`;
  return {
    schema: `${partial.type}::1.0`,
    path: file,
    file_path: `${ROOT}/${file}`,
    line: 3,
    platforms: [],
    deployment: [],
    techniques: { own: [], inherited: [] },
    tactics: [],
    actors: [],
    load_error: null,
    ...partial,
  };
}

export function catalog(): CatalogDocument {
  const objects: CatalogObject[] = [
    object({
      uuid: "t1",
      type: "threat",
      name: "Credential Dumping",
      techniques: { own: ["T1003"], inherited: [] },
    }),
    object({
      uuid: "o1",
      type: "objective",
      name: "Detect LSASS access",
      techniques: { own: ["T1003.001"], inherited: ["T1003"] },
    }),
    object({
      uuid: "o2",
      type: "objective",
      name: "Detect DCSync",
      techniques: { own: ["T1003.006"], inherited: [] },
    }),
    object({
      uuid: "r1",
      type: "rule",
      name: "Suspicious LSASS Access",
      platforms: [
        { id: "sentinel", enabled: true, status: "PRODUCTION", strategy: "RELEASE" },
        { id: "splunk", enabled: true, status: "DESIGN", strategy: "INERT" },
      ],
      techniques: { own: [], inherited: ["T1003.001", "T1003"] },
    }),
    object({
      uuid: "r2",
      type: "rule",
      name: "LSASS dump via comsvcs",
      platforms: [{ id: "sentinel", enabled: true, status: "DESIGN", strategy: "PREVIEW" }],
      techniques: { own: [], inherited: ["T1003.001"] },
    }),
    object({ uuid: "r3", type: "rule", name: "Orphan rule" }),
    object({ uuid: "r4", type: "rule", name: "Dangling rule" }),
    object({
      uuid: "bad",
      type: "rule",
      name: "",
      path: "objects/rules/broken.yaml",
      file_path: `${ROOT}/objects/rules/broken.yaml`,
      load_error: { code: "yaml_parse", message: "mapping values are not allowed here", line: 12 },
    }),
  ];
  return {
    ok: true,
    status: "completed",
    message: "",
    schema_version: 1,
    command: "info",
    duration_ms: 1,
    exit_code: 0,
    summary: { objects: 8, threats: 1, objectives: 2, rules: 5, signals: 1, edges: 5, load_errors: 1 },
    next_actions: [],
    failure: null,
    objects,
    signals: [{ uuid: "s1", name: "LSASS handle opened", objective: "o1", parent: null }],
    edges: [
      {
        from: "o1",
        to: "t1",
        kind: "covers",
        field_path: "objective.threats",
        relation: null,
        missing: false,
      },
      {
        from: "r1",
        to: "o1",
        kind: "implements",
        field_path: "detection_model",
        relation: null,
        missing: false,
      },
      {
        from: "r2",
        to: "s1",
        kind: "implements",
        field_path: "detection_model",
        relation: null,
        missing: false,
      },
      {
        from: "r4",
        to: "gone",
        kind: "implements",
        field_path: "detection_model",
        relation: null,
        missing: true,
      },
      {
        from: "o1",
        to: "T1003.001",
        kind: "technique",
        field_path: "objective.mitre_attack",
        relation: null,
        missing: false,
      },
    ],
    attack: {
      tactics: [
        {
          id: "TA0006",
          shortname: "credential-access",
          name: "Credential Access",
          techniques: ["T1003", "T1110"],
        },
      ],
      techniques: {
        T1003: { name: "OS Credential Dumping", parent: null, subtechniques: ["T1003.001", "T1003.006"] },
        "T1003.001": { name: "LSASS Memory", parent: "T1003", subtechniques: [] },
        "T1003.006": { name: "DCSync", parent: "T1003", subtechniques: [] },
        T1110: { name: "Brute Force", parent: null, subtechniques: [] },
      },
    },
  };
}

export function ready(doc: CatalogDocument = catalog(), folder = ROOT): CatalogState {
  return { folder, status: "ready", catalog: doc, refreshing: false };
}
