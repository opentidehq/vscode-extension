// Version parsing and comparison for opentide (PEP 440) and the engine (semver). vscode-free.

/** The oldest opentide that tiers 1–3 may run. One constant; raise it with the CLI contracts. */
export const MIN_OPENTIDE_VERSION = "0.20.1";

/** The oldest `opentide-lsp` engine `opentide.path` may name: the rebuilt host. */
export const MIN_ENGINE_VERSION = "0.9.0";

interface Parsed {
  release: number[];
  /** Pre-release rank: dev < a < b < rc < final < post. */
  phase: number;
  phaseNumber: number;
}

const PHASES: Record<string, number> = { dev: 0, a: 1, alpha: 1, b: 2, beta: 2, rc: 3, c: 3, "": 4, post: 5 };

/** Parse `0.21.0`, `0.21.0rc1`, `0.21.0.dev3`, `0.21.0-beta.1`, `v0.9.0`. Returns undefined when not a version. */
export function parseVersion(text: string): Parsed | undefined {
  const match = /^v?(\d+(?:\.\d+)*)(?:[-._]?(dev|alpha|beta|a|b|rc|c|post)[-._]?(\d*))?(?:[+].*)?$/i.exec(
    text.trim(),
  );
  if (!match?.[1]) return undefined;
  const phaseName = (match[2] ?? "").toLowerCase();
  return {
    release: match[1].split(".").map(Number),
    phase: PHASES[phaseName] ?? 4,
    phaseNumber: match[3] ? Number(match[3]) : 0,
  };
}

/** -1, 0 or 1. An unparseable version sorts before every parseable one. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  const length = Math.max(pa.release.length, pb.release.length);
  for (let i = 0; i < length; i++) {
    const diff = (pa.release[i] ?? 0) - (pb.release[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  if (pa.phase !== pb.phase) return Math.sign(pa.phase - pb.phase);
  return Math.sign(pa.phaseNumber - pb.phaseNumber);
}

export function atLeast(version: string, minimum: string): boolean {
  return compareVersions(version, minimum) >= 0;
}

/**
 * A dev build whose version says nothing about its age: hatch-vcs and setuptools-scm report
 * `0.1.devN+g<sha>` for a checkout with no release tag in its history (a fork, a shallow clone). It
 * cannot be ordered against a release, so the minimum does not apply. `0.21.1.dev3+g…`, from a tagged
 * history, orders normally.
 */
export function isUntaggedDevBuild(version: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed || parsed.phase !== PHASES.dev) return false;
  const release = [...parsed.release];
  while (release.length > 1 && release[release.length - 1] === 0) release.pop();
  return release.length <= 2 && release[0] === 0 && (release[1] ?? 0) <= 1;
}

/** Whether a version may run with `minimum`: `ok`, `untagged` (accepted, with a note), or `too-old`. */
export function checkMinimum(version: string, minimum: string): "ok" | "untagged" | "too-old" {
  if (atLeast(version, minimum)) return "ok";
  return isUntaggedDevBuild(version) ? "untagged" : "too-old";
}

/** The version from `opentide --version` output (`opentide 0.20.1`). */
export function parseOpentideVersionOutput(stdout: string): string | undefined {
  const match = /\bopentide\s+v?(\d+(?:\.\d+)+\S*)/i.exec(stdout);
  return match?.[1];
}

/** The engine version from `opentide-lsp --version --json` (the `experimental.opentide` object). */
export function parseEngineVersionOutput(stdout: string): string | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    if (value && typeof value === "object") {
      const engine = (value as { engine?: unknown }).engine;
      if (typeof engine === "string") return engine;
      if (
        engine &&
        typeof engine === "object" &&
        typeof (engine as { version?: unknown }).version === "string"
      ) {
        return (engine as { version: string }).version;
      }
      const version = (value as { version?: unknown }).version;
      if (typeof version === "string") return version;
    }
  } catch {
    const match = /(\d+\.\d+\.\d+\S*)/.exec(stdout);
    return match?.[1];
  }
  return undefined;
}
