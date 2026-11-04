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
  /** A JSON-RPC protocol error from `opentide serve`. */
  | "protocol"
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

export function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { exit_code?: unknown }).exit_code === "number"
  );
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
