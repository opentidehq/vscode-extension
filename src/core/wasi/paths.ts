// Paths between the host and the WASI module (SPEC §4). The module sees only what is mounted: the window's
// workspace folders, at `/workspace` (one folder) or `/workspaces/<name>`. Every path it reads or prints is a
// guest path, so what goes in (a run's `cwd`, its argv and environment, the paths `invalidate` names, the
// URIs of the language server) is mapped to guest paths, and what comes out (the documents, progress events,
// the language server's answers) back to the host's. vscode-free: the glue (src/core/services/wasi.ts)
// asks @vscode/wasm-wasi for each folder's guest path and gives the pairs here.
import * as path from "node:path";

/** A mounted folder: where it is on the host and where the module sees it. */
export interface Mount {
  /** The folder's file-system path (`uri.fsPath`). */
  readonly host: string;
  /** `file:///…`: the folder's URI as VS Code writes it (`uri.toString()`). */
  readonly hostUri: string;
  /** The folder's guest path: `/workspace`. */
  readonly guest: string;
  /** `file:///workspace`. */
  readonly guestUri: string;
}

/** Replace a leading `from` (followed by a path separator or the end of a token) with `to`. */
interface Rule {
  readonly from: string;
  readonly to: string;
  /** The separator of what follows `from` after the replacement, when it differs (`\` on Windows). */
  readonly rest?: (text: string) => string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Apply `rules` to every string in a JSON value (keys are left alone). A rule matches a path that starts
 * with `from` at the start of the string or after a space, quote, `=` or `(`, and ends at `from` itself or at
 * a separator: `/workspace/a` matches `/workspace`, `/workspaces/a` and `/other/workspace/a` do not.
 */
export function rewriteStrings<T>(value: T, rules: readonly Rule[]): T {
  if (rules.length === 0) return value;
  const ordered = [...rules].sort((a, b) => b.from.length - a.from.length);
  const alternatives = ordered.map((rule) => `(${escapeRegExp(rule.from)})`).join("|");
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_.~-])(?:${alternatives})((?:[/\\\\][^\\s"'<>,;()\\[\\]{}]*)?)(?![A-Za-z0-9_-])`,
    "g",
  );
  const rewrite = (text: string): string =>
    text.replace(pattern, (...match: unknown[]) => {
      const groups = match.slice(1, 1 + ordered.length) as (string | undefined)[];
      const index = groups.findIndex((group) => group !== undefined);
      const rule = ordered[index];
      const rest = match[1 + ordered.length] as string;
      return rule ? rule.to + (rule.rest ? rule.rest(rest) : rest) : (match[0] as string);
    });
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return rewrite(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) out[key] = walk(child);
      return out;
    }
    return node;
  };
  return walk(value) as T;
}

/** The guest path of a workspace folder: `/workspace` for the only one, else `/workspaces/<name>`. */
export function guestPathOf(name: string, only: boolean): string {
  return only ? "/workspace" : `/workspaces/${name}`;
}

const toSlashes = (text: string): string => text.replaceAll("\\", "/");
const toBackslashes = (text: string): string => text.replaceAll("/", "\\");

/** The host <-> guest mapping of the folders mounted for one WASI process. */
export class GuestPaths {
  constructor(
    readonly mounts: readonly Mount[],
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  private get windows(): boolean {
    return this.platform === "win32";
  }

  /** What the module is given: host paths in a run's argv, `cwd`, environment and `invalidate`. */
  private toGuestRules(): Rule[] {
    return this.mounts.map((mount) => ({
      from: mount.host,
      to: mount.guest,
      ...(this.windows ? { rest: toSlashes } : {}),
    }));
  }

  /** What the module prints: guest paths in documents, progress events and log lines. */
  private toHostRules(): Rule[] {
    return this.mounts.map((mount) => ({
      from: mount.guest,
      to: mount.host,
      ...(this.windows ? { rest: toBackslashes } : {}),
    }));
  }

  /** `file://` URIs, host to guest (to the language server) or back. */
  private uriRules(toGuest: boolean): Rule[] {
    return this.mounts.map((mount) =>
      toGuest ? { from: mount.hostUri, to: mount.guestUri } : { from: mount.guestUri, to: mount.hostUri },
    );
  }

  /** A host path as the module sees it (unchanged when it is under no mounted folder). */
  toGuest(hostPath: string): string {
    return rewriteStrings(hostPath, this.toGuestRules());
  }

  /** A guest path as the host has it. */
  toHost(guestPath: string): string {
    return rewriteStrings(guestPath, this.toHostRules());
  }

  /** Every host path in `value` (a run's params) as the module sees it. */
  paramsToGuest<T>(value: T): T {
    return rewriteStrings(value, this.toGuestRules());
  }

  /** Every guest path in `value` (a document) as the host has it. */
  documentToHost<T>(value: T): T {
    return rewriteStrings(value, this.toHostRules());
  }

  /** A language-server message to the module: the mounted folders' file URIs (and `rootPath`) become guest ones. */
  lspToGuest<T>(message: T): T {
    return rewriteStrings(message, [...this.uriRules(true), ...this.toGuestRules()]);
  }

  /** A language-server message from the module: guest URIs and paths become the host's. */
  lspToHost<T>(message: T): T {
    return rewriteStrings(message, [...this.uriRules(false), ...this.toHostRules()]);
  }

  /** Whether a host path lies in a mounted folder. */
  mounted(hostPath: string): boolean {
    const paths = this.windows ? path.win32 : path.posix;
    return this.mounts.some((mount) => {
      const relative = paths.relative(mount.host, hostPath);
      return relative === "" || (!relative.startsWith("..") && !paths.isAbsolute(relative));
    });
  }
}
