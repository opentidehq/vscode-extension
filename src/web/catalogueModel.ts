// The web extension's Catalogue, Relations and Find Detection, from the engine's `opentide/catalog`
// index: threats → objectives → rules by their references, an object's relations both ways, and the
// objects to search. vscode-free, no Node built-ins. The desktop builds its views from `info catalog`
// (src/features/sidebar/); this is the part the browser can have.
import { type ServerObject, serverRelations } from "../engine/catalog";

export type Family = "threat" | "objective" | "rule" | "signal" | "missing" | "other";

export interface WebNode {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly family: Family;
  /** The object's file and the line of its name, to open. */
  readonly uri?: string;
  readonly line?: number;
  readonly uuid?: string;
  readonly children: readonly WebNode[];
}

/** An object's relation, as Relations lists it. */
export interface WebRelation {
  readonly direction: "out" | "in";
  /** `implements`, `covers`, `chains`, `parent`. */
  readonly kind: string;
  readonly uuid: string;
  readonly name: string;
  readonly family: Family;
  readonly uri?: string;
  readonly line?: number;
  readonly missing: boolean;
}

const FAMILIES: Record<string, Family> = { threat: "threat", objective: "objective", rule: "rule" };

const familyOf = (object: ServerObject): Family => FAMILIES[object.object_type] ?? "other";

const byName = (a: ServerObject, b: ServerObject) =>
  a.name.localeCompare(b.name) || a.uuid.localeCompare(b.uuid);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The objects and what connects them, indexed both ways. */
export class WebIndex {
  readonly objects: readonly ServerObject[];
  private readonly byUuid = new Map<string, ServerObject>();
  /** Signal UUID → its objective's UUID. */
  private readonly signalOwner = new Map<string, string>();
  private readonly out = new Map<string, { to: string; kind: string; missing: boolean }[]>();
  private readonly incoming = new Map<string, { from: string; kind: string }[]>();

  constructor(objects: readonly ServerObject[]) {
    this.objects = [...objects].sort(byName);
    for (const object of this.objects) this.byUuid.set(object.uuid.toLowerCase(), object);
    const { edges, signals } = serverRelations(objects);
    for (const signal of signals)
      if (signal.objective) this.signalOwner.set(signal.uuid.toLowerCase(), signal.objective);
    for (const edge of edges) {
      const from = edge.from.toLowerCase();
      const to = edge.to.toLowerCase();
      const list = this.out.get(from) ?? [];
      list.push({ to, kind: edge.kind, missing: edge.missing });
      this.out.set(from, list);
      const back = this.incoming.get(to) ?? [];
      back.push({ from, kind: edge.kind });
      this.incoming.set(to, back);
    }
  }

  object(uuid: string): ServerObject | undefined {
    return this.byUuid.get(uuid.toLowerCase());
  }

  /** The object a reference names: an object, or the objective that owns a signal. */
  private target(uuid: string): ServerObject | undefined {
    const key = uuid.toLowerCase();
    return this.byUuid.get(key) ?? this.byUuid.get(this.signalOwner.get(key)?.toLowerCase() ?? "");
  }

  /** The object in a file. */
  objectAt(uri: string): ServerObject | undefined {
    return this.objects.find((object) => sameUri(object.uri, uri));
  }

  /** What `uuid` points to (→) and what points to it (←). */
  relations(uuid: string): WebRelation[] {
    const key = uuid.toLowerCase();
    const relation = (
      direction: "out" | "in",
      kind: string,
      other: string,
      missing: boolean,
    ): WebRelation => {
      const object = missing ? undefined : this.target(other);
      return {
        direction,
        kind,
        uuid: other,
        name: object?.name ?? other,
        family: object ? familyOf(object) : missing ? "missing" : "signal",
        ...(object ? { uri: object.uri, line: object.range.start.line } : {}),
        missing: missing || !object,
      };
    };
    const outgoing = (this.out.get(key) ?? []).map((edge) =>
      relation("out", edge.kind, edge.to, edge.missing),
    );
    // A rule that implements one of this objective's signals points to the objective too.
    const owned = [...this.signalOwner]
      .filter(([, owner]) => owner.toLowerCase() === key)
      .map(([signal]) => signal);
    const incoming = [key, ...owned].flatMap((target) =>
      (this.incoming.get(target) ?? []).map((edge) => relation("in", edge.kind, edge.from, false)),
    );
    // A signal's parent inside the same objective is not a relation of the objective with itself.
    const self = this.object(uuid)?.uuid;
    return [...outgoing, ...incoming].filter(
      (relation) => relation.missing || (relation.uuid !== self && this.target(relation.uuid)?.uuid !== self),
    );
  }

  /** The UUIDs `uuid` points to by `kind` (signals as their objective). */
  private targets(uuid: string, kind: string): string[] {
    return (this.out.get(uuid.toLowerCase()) ?? [])
      .filter((edge) => edge.kind === kind)
      .map((edge) => this.target(edge.to)?.uuid)
      .filter((value): value is string => value !== undefined);
  }

  /** Threats → objectives that cover them → rules that implement those; the unattached in their groups. */
  catalogue(): WebNode[] {
    const of = (family: Family) => this.objects.filter((object) => familyOf(object) === family);
    const rulesOf = (objective: string) =>
      of("rule").filter((rule) => this.targets(rule.uuid, "implements").includes(objective));
    const node = (object: ServerObject, id: string, children: WebNode[], description?: string): WebNode => ({
      id,
      label: object.name || object.uuid,
      ...(description ? { description } : {}),
      tooltip: `${object.object_type} · ${object.schema} · ${object.uuid}`,
      family: familyOf(object),
      uri: object.uri,
      line: object.range.start.line,
      uuid: object.uuid,
      children,
    });
    const objectiveNode = (objective: ServerObject, prefix: string): WebNode => {
      const rules = rulesOf(objective.uuid);
      return node(
        objective,
        `${prefix}/${objective.uuid}`,
        rules.map((rule) => node(rule, `${prefix}/${objective.uuid}/${rule.uuid}`, [])),
        rules.length > 0 ? plural(rules.length, "rule") : "no rule",
      );
    };
    const threats = of("threat").map((threat) => {
      const objectives = of("objective").filter((objective) =>
        this.targets(objective.uuid, "covers").includes(threat.uuid),
      );
      return node(
        threat,
        `threat/${threat.uuid}`,
        objectives.map((objective) => objectiveNode(objective, `threat/${threat.uuid}`)),
        objectives.length > 0 ? plural(objectives.length, "objective") : "no objective",
      );
    });
    const loose = of("objective").filter((objective) => this.targets(objective.uuid, "covers").length === 0);
    const orphans = of("rule").filter((rule) => this.targets(rule.uuid, "implements").length === 0);
    const others = of("other");
    const group = (id: string, label: string, children: WebNode[], family: Family): WebNode[] =>
      children.length > 0 ? [{ id, label, description: String(children.length), family, children }] : [];
    return [
      ...threats,
      ...group(
        "loose-objectives",
        "Objectives without a threat",
        loose.map((o) => objectiveNode(o, "loose")),
        "objective",
      ),
      ...group(
        "orphan-rules",
        "Rules without an objective",
        orphans.map((r) => node(r, `orphan/${r.uuid}`, [])),
        "rule",
      ),
      ...group(
        "other",
        "Other objects",
        others.map((o) => node(o, `other/${o.uuid}`, [])),
        "other",
      ),
    ];
  }

  /** Find Detection: objects whose name, UUID or file contains every word of `query`, ignoring case. */
  search(query: string): ServerObject[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.objects.filter((object) => {
      const text =
        `${object.name}\n${object.uuid}\n${object.object_type}\n${decodeURIComponent(object.uri)}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }
}

/** Two URIs of the same file: the server and VS Code may percent-encode differently. */
export function sameUri(a: string, b: string): boolean {
  const norm = (uri: string) => {
    try {
      return decodeURIComponent(uri).replace(/\/+$/, "").toLowerCase();
    } catch {
      return uri.toLowerCase();
    }
  };
  return norm(a) === norm(b);
}
