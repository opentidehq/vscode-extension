// What the language server's `opentide/catalog` answers for a small root (language-server
// docs/EDITORS.md): two chained threats, an objective with two signals, three rules (one dangling).
import type { ServerObject } from "../../../src/core/catalog/serverCatalog";

const range = (line: number) => ({ start: { line, character: 6 }, end: { line, character: 20 } });

export function serverObjects(): ServerObject[] {
  const ref = (uuid: string, field_path: string, line = 5) => ({ uuid, field_path, range: range(line) });
  return [
    {
      uuid: "t1",
      object_type: "threat",
      schema: "threat::1.0",
      name: "Credential Dumping",
      uri: "file:///w/objects/threats/t1.yaml",
      range: range(0),
      refs: [ref("t2", "threat.chaining.0.vector")],
    },
    {
      uuid: "t2",
      object_type: "threat",
      schema: "threat::1.0",
      name: "Lateral Movement",
      uri: "file:///w/objects/threats/t2.yaml",
      range: range(0),
      refs: [],
    },
    {
      uuid: "o1",
      object_type: "objective",
      schema: "objective::1.0",
      name: "Detect LSASS access",
      uri: "file:///w/objects/objectives/o1.yaml",
      range: range(0),
      refs: [
        ref("s1", "objective.signals.0.uuid", 20),
        ref("s2", "objective.signals.1.uuid", 30),
        ref("s1", "objective.signals.1.parent", 40),
        ref("t1", "objective.threats.0"),
      ],
    },
    {
      uuid: "r1",
      object_type: "rule",
      schema: "rule::1.0",
      name: "Suspicious LSASS Access",
      uri: "file:///w/objects/rules/r1.yaml",
      range: range(0),
      refs: [ref("o1", "detection_model")],
    },
    {
      uuid: "r2",
      object_type: "rule",
      schema: "rule::1.0",
      name: "LSASS dump via comsvcs",
      uri: "file:///w/objects/rules/r2.yaml",
      range: range(0),
      refs: [ref("S1", "detection_model")],
    },
    {
      uuid: "r3",
      object_type: "rule",
      schema: "rule::1.0",
      name: "Dangling rule",
      uri: "file:///w/objects/rules/r3.yaml",
      range: range(0),
      refs: [ref("gone", "detection_model"), ref("org", "metadata.organisation.uuid")],
    },
  ];
}
