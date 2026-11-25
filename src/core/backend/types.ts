// Documents and errors of the backend. vscode-free.

/** `failure` of every `--json` envelope. */
export interface Failure {
  readonly code: string;
  readonly message: string;
  readonly argument?: string | null;
  readonly suggestion?: string | null;
  readonly crash_log?: string | null;
  readonly [key: string]: unknown;
}

/** The envelope every `opentide --json` document carries; each command adds its own keys. */
export interface Envelope {
  readonly ok: boolean;
  readonly status: string;
  readonly message: string;
  readonly schema_version: number;
  readonly command: string;
  readonly duration_ms: number;
  readonly exit_code: number;
  readonly summary: Readonly<Record<string, unknown>>;
  readonly next_actions: readonly unknown[];
  readonly failure: Failure | null;
  readonly [key: string]: unknown;
}

/** A progress event (opentide#756): NDJSON on stderr under `OPENTIDE_PROGRESS=json`, or `progress` from serve. */
export type ProgressEvent =
  | { readonly event: "progress"; readonly step: string; readonly done?: number; readonly total?: number }
  | {
      readonly event: "tenant";
      readonly platform: string;
      readonly tenant: string;
      readonly status: "ok" | "failed";
      readonly rows?: number;
      readonly elapsed_ms?: number;
    }
  | { readonly event: string; readonly [key: string]: unknown };

export type BackendErrorCode =
  /** No runtime resolved (universal package without opentide). */
  | "no-runtime"
  /** Restricted Mode: no commands run. */
  | "untrusted"
  /** The runtime is a bare `opentide-lsp`: editor features only. */
  | "editor-only"
  /** The process could not start. */
  | "spawn-failed"
  /** The command printed no JSON document. */
  | "bad-output"
  /** `opentide serve` exited while the request was pending. */
  | "crashed"
  /**
   * `opentide serve` was shutting down and refused the request without running it (JSON-RPC -32600,
   * "The server is shut down"): safe to run again on a fresh backend, a writer included.
   */
  | "shut-down"
  /** A JSON-RPC protocol error from `opentide serve`. */
  | "protocol"
  /** `opentide serve` did not answer an editor command within the interactive lane's deadline; it was cancelled. */
  | "timed-out"
  /** The backend was disposed. */
  | "disposed";

/** A run that produced no document. A command failure is not one: it resolves with its document. */
export class BackendError extends Error {
  constructor(
    readonly code: BackendErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Why `value` is not a usable `--json` envelope, or undefined when it is: the first field that has the wrong shape. */
export function envelopeProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return "is not a JSON object";
  if (typeof value.exit_code !== "number" || !Number.isFinite(value.exit_code))
    return "has no numeric exit_code";
  const typed: [string, (v: unknown) => boolean, string][] = [
    ["ok", (v) => typeof v === "boolean", "a boolean"],
    ["status", (v) => typeof v === "string", "a string"],
    ["message", (v) => typeof v === "string", "a string"],
    ["command", (v) => typeof v === "string", "a string"],
    ["schema_version", (v) => typeof v === "number", "a number"],
    ["duration_ms", (v) => typeof v === "number", "a number"],
    ["summary", isRecord, "an object"],
    ["next_actions", Array.isArray, "an array"],
  ];
  for (const [key, check, what] of typed)
    if (value[key] !== undefined && !check(value[key])) return `has a ${key} that is not ${what}`;
  const failure = value.failure;
  if (failure !== undefined && failure !== null) {
    if (!isRecord(failure)) return "has a failure that is neither null nor an object";
    if (typeof failure.code !== "string") return "has a failure with no string code";
    if (typeof failure.message !== "string") return "has a failure with no string message";
    for (const key of ["argument", "suggestion", "crash_log"])
      if (failure[key] !== undefined && failure[key] !== null && typeof failure[key] !== "string")
        return `has a failure whose ${key} is not a string`;
  }
  return undefined;
}

/**
 * An envelope with its shape checked in full: `exit_code` is a number and every field the callers read (`failure.code`,
 * `message`, `summary`, …) has the type it is declared with when it is present. A document that fails this is not
 * used: see `envelopeProblem` for why.
 */
export function isEnvelope(value: unknown): value is Envelope {
  return envelopeProblem(value) === undefined;
}

/** The document a cancelled run gets when the process printed none. */
export function cancelledEnvelope(command: string): Envelope {
  return {
    ok: false,
    status: "cancelled",
    message: "Cancelled",
    schema_version: 1,
    command,
    duration_ms: 0,
    exit_code: 130,
    summary: {},
    next_actions: [],
    failure: { code: "cancelled", message: "Cancelled" },
  };
}
