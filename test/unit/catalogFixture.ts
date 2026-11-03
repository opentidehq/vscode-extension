// `info catalog` documents for the graph and search tests, in the shape opentide prints (CONTRACTS.md,
// opentide docs/cli/info.md "The catalogue").
import type {
  CatalogDocument,
  CatalogEdge,
  CatalogObject,
  CatalogSignal,
} from "../../src/core/catalog/types";

export const UUID = {
  threat: "11111111-0000-4000-8000-000000000001",
  lateral: "11111111-0000-4000-8000-000000000002",
  objective: "22222222-0000-4000-8000-000000000001",
  orphan: "22222222-0000-4000-8000-000000000002",
  signal: "33333333-0000-4000-8000-000000000001",
  childSignal: "33333333-0000-4000-8000-000000000002",
  rule: "44444444-0000-4000-8000-000000000001",
  comsvcs: "44444444-0000-4000-8000-000000000002",
  broken: "44444444-0000-4000-8000-000000000003",
  missing: "99999999-0000-4000-8000-000000000009",
} as const;

export const ROOT = "/ws";

export function object(
  partial: Partial<CatalogObject> & Pick<CatalogObject, "uuid" | "type" | "name">,
): CatalogObject {
  const folder =
    partial.type === "threat" ? "threats" : partial.type === "objective" ? "objectives" : "rules";
  const path =
    partial.path ?? `objects/${folder}/${partial.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.yaml`;
  return {
    schema: `${partial.type}::1.0`,
    path,
    file_path: `${ROOT}/${path}`,
    line: 1,
    tlp: "amber",
    author: "Claude",
    created: "2026-01-10",
    modified: "2026-10-01",
    reviewed: null,
    platforms: [],
    deployment: [],
    techniques: { own: [], inherited: [] },
    tactics: [],
    actors: [],
    load_error: null,
    ...partial,
  };
}

const edge = (from: string, to: string, kind: string, extra: Partial<CatalogEdge> = {}): CatalogEdge => ({
  from,
  to,
  kind,
  field_path: kind === "implements" ? "detection_model" : kind,
  relation: null,
  missing: false,
  ...extra,
});

export function document(
  objects: CatalogObject[],
  edges: CatalogEdge[],
  signals: CatalogSignal[] = [],
): CatalogDocument {
  return {
    ok: true,
    status: "completed",
    message: "done",
    schema_version: 1,
    command: "info",
    duration_ms: 1,
    exit_code: 0,
    next_actions: [],
    failure: null,
    objects,
    edges,
    signals,
    attack: {
      tactics: [
        {
          id: "TA0006",
          shortname: "credential-access",
          name: "Credential Access",
          techniques: ["T1003"],
        },
        { id: "TA0008", shortname: "lateral-movement", name: "Lateral Movement", techniques: ["T1021"] },
      ],
      techniques: {
        T1003: { name: "OS Credential Dumping", parent: null, subtechniques: ["T1003.001"] },
        "T1003.001": { name: "LSASS Memory", parent: "T1003", subtechniques: [] },
        T1021: { name: "Remote Services", parent: null, subtechniques: [] },
      },
    },
    summary: {
      objects: objects.length,
      threats: objects.filter((o) => o.type === "threat").length,
      objectives: objects.filter((o) => o.type === "objective").length,
      rules: objects.filter((o) => o.type === "rule").length,
      signals: signals.length,
      edges: edges.length,
      load_errors: objects.filter((o) => o.load_error).length,
    },
  } as CatalogDocument;
}

/** Two threats (chained), two objectives, two signals, four rules (one dangling, one that did not load). */
export function sampleCatalog(): CatalogDocument {
  const objects = [
    object({
      uuid: UUID.threat,
      type: "threat",
      name: "Credential Dumping",
      techniques: { own: ["T1003"], inherited: [] },
      tactics: ["credential-access"],
      actors: ["att&ck::G0016"],
    }),
    object({
      uuid: UUID.lateral,
      type: "threat",
      name: "Lateral Movement",
      techniques: { own: ["T1021"], inherited: [] },
      tactics: ["lateral-movement"],
    }),
    object({
      uuid: UUID.objective,
      type: "objective",
      name: "Detect LSASS access",
      line: 3,
      techniques: { own: ["T1003.001"], inherited: ["T1003"] },
      tactics: ["credential-access"],
      actors: ["att&ck::G0016"],
    }),
    object({ uuid: UUID.orphan, type: "objective", name: "Orphan objective" }),
    object({
      uuid: UUID.rule,
      type: "rule",
      name: "Suspicious LSASS Access",
      schema: "rule::1.1",
      author: "Jane Doe",
      platforms: [
        { id: "sentinel", enabled: true, status: "DESIGN", strategy: "INERT" },
        { id: "defender", enabled: true, status: "PRODUCTION", strategy: "RELEASE" },
      ],
      deployment: [{ platform: "defender", tenant: "prod", deployed: true, rule_id: "1" }],
      techniques: { own: ["T1003.001"], inherited: ["T1003"] },
      tactics: ["credential-access"],
      actors: ["att&ck::G0016"],
    }),
    object({
      uuid: UUID.comsvcs,
      type: "rule",
      name: "LSASS dump via comsvcs",
      tlp: "green",
      author: "Bob",
      created: "2025-03-01",
      modified: "2025-03-01",
      reviewed: "2025-06-01",
      platforms: [{ id: "splunk", enabled: true, status: "PRODUCTION", strategy: "RELEASE" }],
      techniques: { own: [], inherited: ["T1003.001", "T1003"] },
      tactics: ["credential-access"],
    }),
    object({
      uuid: UUID.broken,
      type: "rule",
      name: "Broken reference",
      platforms: [{ id: "sentinel", enabled: true, status: "PRODUCTION", strategy: "RELEASE" }],
    }),
    object({
      uuid: "",
      type: "rule",
      name: "",
      path: "objects/rules/bad.yaml",
      load_error: { code: "yaml_parse", message: "mapping values are not allowed here", line: 4 },
    }),
  ];
  const edges = [
    edge(UUID.threat, "T1003", "technique", { field_path: "threat.mitre_attack" }),
    edge(UUID.lateral, "T1021", "technique", { field_path: "threat.mitre_attack" }),
    edge(UUID.threat, UUID.lateral, "chains", {
      field_path: "threat.chaining",
      relation: "sequence::preceeds",
    }),
    edge(UUID.objective, UUID.threat, "covers", { field_path: "objective.threats" }),
    edge(UUID.objective, "T1003.001", "technique", { field_path: "objective.mitre_attack" }),
    edge(UUID.childSignal, UUID.signal, "parent", { field_path: "objective.signals.1.parent" }),
    edge(UUID.signal, "DeviceProcessEvents", "logsource", {
      field_path: "objective.signals.0.data.logsources",
    }),
    edge(UUID.rule, UUID.objective, "implements"),
    edge(UUID.rule, "T1003.001", "technique", { field_path: "techniques" }),
    edge(UUID.comsvcs, UUID.signal, "implements"),
    edge(UUID.broken, UUID.missing, "implements", { missing: true }),
  ];
  const signals = [
    { uuid: UUID.signal, name: "LSASS handle opened", objective: UUID.objective, parent: null },
    {
      uuid: UUID.childSignal,
      name: "LSASS handle with VM_READ",
      objective: UUID.objective,
      parent: UUID.signal,
    },
  ];
  return document(objects, edges, signals);
}

/**
 * A catalogue at scale: `threats` threats, each covered by objectives, each implemented by rules;
 * `total` objects in all.
 */
export function syntheticCatalog(total: number): CatalogDocument {
  const objects: CatalogObject[] = [];
  const edges: CatalogEdge[] = [];
  const threats = Math.max(1, Math.round(total / 100));
  const objectives = Math.max(1, Math.round(total / 10));
  const rules = Math.max(1, total - threats - objectives);
  const platforms = ["sentinel", "defender", "splunk", "elastic"];
  const statuses = ["DESIGN", "TESTING", "STAGING", "PRODUCTION"];
  for (let t = 0; t < threats; t += 1) {
    objects.push(
      object({
        uuid: `t-${t}`,
        type: "threat",
        name: `Threat ${t}`,
        techniques: { own: [`T1${String(t % 600).padStart(3, "0")}`], inherited: [] },
      }),
    );
    if (t > 0) edges.push(edge(`t-${t - 1}`, `t-${t}`, "chains", { relation: "sequence::preceeds" }));
  }
  for (let o = 0; o < objectives; o += 1) {
    objects.push(object({ uuid: `o-${o}`, type: "objective", name: `Objective ${o}` }));
    edges.push(edge(`o-${o}`, `t-${o % threats}`, "covers"));
  }
  for (let r = 0; r < rules; r += 1) {
    const technique = `T1${String(r % 600).padStart(3, "0")}.${String((r % 9) + 1).padStart(3, "0")}`;
    objects.push(
      object({
        uuid: `r-${r}`,
        type: "rule",
        name: `Rule ${r} ${r % 7 === 0 ? "lsass" : "process"} detection`,
        author: r % 3 === 0 ? "Jane Doe" : "Bob",
        tlp: r % 4 === 0 ? "green" : "amber",
        platforms: [
          {
            id: platforms[r % platforms.length] as string,
            enabled: true,
            status: statuses[r % statuses.length] as string,
            strategy: "RELEASE",
          },
        ],
        techniques: { own: [technique], inherited: [] },
        tactics: ["credential-access"],
      }),
    );
    edges.push(edge(`r-${r}`, `o-${r % objectives}`, "implements"));
    edges.push(edge(`r-${r}`, technique, "technique"));
  }
  return document(objects, edges);
}
