// `opentide --json info catalog` (CONTRACTS.md, opentide#749). vscode-free.
import type { Envelope } from "../backend/types";

export interface CatalogPlatform {
  readonly id: string;
  readonly enabled: boolean;
  readonly status: string;
  readonly strategy: string;
}

export interface CatalogDeployment {
  readonly platform: string;
  readonly tenant: string;
  readonly deployed: boolean;
  readonly rule_id: string | null;
}

export interface CatalogLoadError {
  readonly code: string;
  readonly message: string;
  readonly line?: number;
}

export type ObjectType = "threat" | "objective" | "rule" | (string & {});

export interface CatalogObject {
  readonly uuid: string;
  readonly type: ObjectType;
  readonly schema: string;
  readonly name: string;
  /** Workspace-relative, forward slashes. */
  readonly path: string;
  readonly file_path: string;
  /** 1-based line of the `name:` key, or 1. */
  readonly line: number;
  readonly tlp?: string | null;
  readonly author?: string | null;
  readonly created?: string | null;
  readonly modified?: string | null;
  readonly reviewed?: string | null;
  readonly platforms: readonly CatalogPlatform[];
  readonly deployment: readonly CatalogDeployment[];
  readonly techniques: { readonly own: readonly string[]; readonly inherited: readonly string[] };
  readonly tactics: readonly string[];
  readonly actors: readonly string[];
  readonly load_error: CatalogLoadError | null;
}

export type EdgeKind = "covers" | "implements" | "parent" | "chains" | "technique" | "logsource";

export interface CatalogEdge {
  readonly from: string;
  /** An object or signal UUID, an ATT&CK technique id, or a visibility.toml log source name. */
  readonly to: string;
  readonly kind: EdgeKind | (string & {});
  readonly field_path: string;
  readonly relation: string | null;
  /** `to` should be an object UUID and no object carries it. */
  readonly missing: boolean;
}

export interface CatalogSignal {
  readonly uuid: string;
  readonly name: string;
  readonly objective: string;
  readonly parent: string | null;
}

export interface AttackTactic {
  readonly id: string;
  readonly shortname: string;
  readonly name: string;
  readonly techniques: readonly string[];
}

export interface AttackTechnique {
  readonly name: string;
  readonly parent: string | null;
  readonly subtechniques: readonly string[];
}

export interface CatalogDocument extends Envelope {
  readonly objects: readonly CatalogObject[];
  readonly edges: readonly CatalogEdge[];
  readonly signals: readonly CatalogSignal[];
  readonly attack: {
    readonly tactics: readonly AttackTactic[];
    readonly techniques: Readonly<Record<string, AttackTechnique>>;
  };
  readonly summary: {
    readonly objects: number;
    readonly threats: number;
    readonly objectives: number;
    readonly rules: number;
    readonly signals: number;
    readonly edges: number;
    readonly load_errors: number;
  };
}

/** Names and locations from the language server's `workspace/symbol`, until (or instead of) the catalogue. */
export interface CatalogSymbol {
  readonly name: string;
  /** `rule`, `objective` or `threat` (the symbol's `containerName`). */
  readonly family: string;
  readonly uri: string;
  /** 0-based. */
  readonly line: number;
  readonly character: number;
}

export function isCatalogDocument(value: unknown): value is CatalogDocument {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { objects?: unknown }).objects) &&
    Array.isArray((value as { edges?: unknown }).edges)
  );
}
