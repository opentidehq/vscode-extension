// The validate and lint findings the extension shows, by file, with the rules that keep them honest
// (SPEC §6): a run's result only lands on a file nothing changed since the run started (an edit, or a
// newer run's result), and an edit drops a file's findings until the next run. vscode-free.
import * as path from "node:path";
import type { Finding, FindingSource } from "./findings";

/** What a run covered: a folder (every file in it is replaced) or some files of one. */
export type RunScope =
  | { readonly kind: "workspace"; readonly folder: string }
  | { readonly kind: "files"; readonly folder: string; readonly files: readonly string[] };

interface Entry {
  readonly findings: readonly Finding[];
  /** The sequence number of the run these came from. */
  readonly seq: number;
}

/** A key for a file path: resolved, and case-folded where the file system usually is (Windows, macOS). */
export function fileKey(file: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(file);
  return platform === "win32" || platform === "darwin" ? resolved.toLowerCase() : resolved;
}

export function isInside(
  folder: string,
  file: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const relative = path.relative(fileKey(folder, platform), fileKey(file, platform));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class FindingsModel {
  private seq = 0;
  private readonly entries: Record<FindingSource, Map<string, Entry>> = {
    validate: new Map(),
    lint: new Map(),
  };
  /** The file path (as the CLI gave it) per key, for callers that need a path back. */
  private readonly paths = new Map<string, string>();
  /** The last sequence number at which a file was edited. */
  private readonly edits = new Map<string, number>();

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  private key(file: string): string {
    return fileKey(file, this.platform);
  }

  /** A sequence number for a run that starts now. */
  begin(): number {
    return ++this.seq;
  }

  /** The file was edited: drop its findings (SPEC §6 rule 2). Returns whether anything was dropped. */
  edited(file: string): boolean {
    const key = this.key(file);
    this.edits.set(key, ++this.seq);
    return this.drop(key);
  }

  /** The file is gone (deleted, renamed away). */
  removed(file: string): boolean {
    return this.drop(this.key(file));
  }

  /** The folder left the workspace: every file under it. */
  removeFolder(folder: string): string[] {
    const files = this.files().filter((file) => isInside(folder, file, this.platform));
    for (const file of files) this.drop(this.key(file));
    return files;
  }

  /** Forget everything (the runtime changed). */
  clear(): string[] {
    const files = this.files();
    for (const map of Object.values(this.entries)) map.clear();
    this.paths.clear();
    return files;
  }

  private drop(key: string): boolean {
    let dropped = false;
    for (const map of Object.values(this.entries)) dropped = map.delete(key) || dropped;
    if (!this.entries.validate.has(key) && !this.entries.lint.has(key)) this.paths.delete(key);
    return dropped;
  }

  /** May a result of the run started at `seq` land on this file? */
  private fresh(source: FindingSource, key: string, seq: number): boolean {
    if ((this.edits.get(key) ?? 0) > seq) return false;
    return (this.entries[source].get(key)?.seq ?? 0) <= seq;
  }

  /**
   * Store a run's findings. A workspace run replaces every file of its folder; a files run replaces the
   * files it named (other files' findings in its result are ignored). Files edited, or given a newer
   * run's result, since the run started keep what they have. Returns the files whose findings changed.
   */
  apply(
    source: FindingSource,
    seq: number,
    scope: RunScope,
    findings: readonly Finding[],
    skip: (file: string) => boolean = () => false,
  ): string[] {
    const map = this.entries[source];
    const byFile = new Map<string, Finding[]>();
    const covered = (file: string): boolean =>
      scope.kind === "workspace"
        ? isInside(scope.folder, file, this.platform)
        : scope.files.some((target) => this.key(target) === this.key(file));
    for (const finding of findings) {
      if (!covered(finding.file)) continue;
      const key = this.key(finding.file);
      this.paths.set(key, this.paths.get(key) ?? finding.file);
      byFile.get(key)?.push(finding) ?? byFile.set(key, [finding]);
    }
    const targets = new Set<string>(byFile.keys());
    if (scope.kind === "workspace") {
      for (const key of map.keys()) if (covered(this.paths.get(key) ?? key)) targets.add(key);
    } else {
      for (const file of scope.files) {
        const key = this.key(file);
        this.paths.set(key, this.paths.get(key) ?? file);
        targets.add(key);
      }
    }
    const changed: string[] = [];
    for (const key of targets) {
      const file = this.paths.get(key) ?? key;
      if (!this.fresh(source, key, seq)) continue;
      const next = skip(file) ? [] : (byFile.get(key) ?? []);
      const had = map.get(key)?.findings.length ?? 0;
      // An empty entry still records the run, so an older run's result cannot land afterwards.
      map.set(key, { findings: next, seq });
      if (had > 0 || next.length > 0) changed.push(file);
    }
    return changed;
  }

  get(source: FindingSource, file: string): readonly Finding[] {
    return this.entries[source].get(this.key(file))?.findings ?? [];
  }

  /** Every file with findings of either source. */
  files(): string[] {
    const keys = new Set<string>([...this.entries.validate.keys(), ...this.entries.lint.keys()]);
    return [...keys]
      .filter((key) => this.get("validate", key).length + this.get("lint", key).length > 0)
      .map((key) => this.paths.get(key) ?? key);
  }

  has(file: string): boolean {
    const key = this.key(file);
    return (
      (this.entries.validate.get(key)?.findings.length ?? 0) +
        (this.entries.lint.get(key)?.findings.length ?? 0) >
      0
    );
  }
}
