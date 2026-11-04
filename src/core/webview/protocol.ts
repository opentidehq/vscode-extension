// The message shape between the extension host and a webview, shared by both sides (no vscode, no DOM).
//
// A protocol is two maps from message type to payload: what the host sends (`toWebview`) and what the
// webview sends (`toHost`). Both sides validate what they receive; a webview never receives a secret.

export interface Protocol {
  readonly toWebview: Readonly<Record<string, unknown>>;
  readonly toHost: Readonly<Record<string, unknown>>;
}

export interface Message<T extends string = string, P = unknown> {
  readonly type: T;
  readonly payload: P;
}

/** Payload validators, one per message type a side accepts. */
export type Validators<M extends Readonly<Record<string, unknown>>> = {
  readonly [K in keyof M]: (payload: unknown) => payload is M[K];
};

/** Is `value` a `{type, payload}` message whose type has a validator that accepts its payload? */
export function acceptMessage<M extends Readonly<Record<string, unknown>>>(
  value: unknown,
  validators: Validators<M>,
): Message<Extract<keyof M, string>, M[keyof M]> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { type, payload } = value as { type?: unknown; payload?: unknown };
  if (typeof type !== "string" || !Object.hasOwn(validators, type)) return undefined;
  const validate = validators[type as keyof M];
  return validate(payload)
    ? { type: type as Extract<keyof M, string>, payload: payload as M[keyof M] }
    : undefined;
}

/** Common validators. */
export const is = {
  string: (value: unknown): value is string => typeof value === "string",
  number: (value: unknown): value is number => typeof value === "number" && Number.isFinite(value),
  boolean: (value: unknown): value is boolean => typeof value === "boolean",
  nothing: (value: unknown): value is undefined => value === undefined || value === null,
  stringArray: (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string"),
  object: (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value),
};
