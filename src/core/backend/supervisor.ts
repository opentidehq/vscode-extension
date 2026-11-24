// The supervision of `opentide serve`: its crash ceiling, cancel-then-kill and the writers' lock, written with Effect.
// It is its own bundle, dist/backend.js, which backend.ts loads with the first command (load.ts): Effect never loads
// in a window that runs none. vscode-free. backend.ts keeps the Promise API and BackendError; this file speaks in
// Effect inside and hands plain results across (`Settled`, `WaitCancelled`), which backend.ts maps to its codes.
import { Data, Duration, Effect, Exit, Fiber, Pull, Schedule, Scope, Semaphore } from "effect";

import { type CancellationToken, CancellationTokenSource } from "../util/cancellation";

/** How long a serve that was sent `$/cancelRequest` has to answer before its process is killed. */
export const CANCEL_GRACE_MS = 5000;
/** The crashes the ceiling counts fall within this window; an older one is forgotten. */
export const CRASH_WINDOW_MS = 120_000;
/** Restarts after a crash before serve is given up on: four starts in all. */
export const CRASH_RESTARTS = 3;
/** The first backoff before a restart; each next one doubles, with jitter. */
export const CRASH_BACKOFF_MS = 500;

/** The serve did not answer `$/cancelRequest` within the grace and was killed. */
class Killed extends Data.TaggedError("Killed")<{ readonly graceMs: number }> {}

/** What a request on the lane came to: its answer, its error, or a kill after an unanswered cancel. */
export type Settled<T> =
  | { readonly kind: "answered"; readonly value: T }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "killed"; readonly graceMs: number };

/** Rejection of `WriteLock.run` when the token was cancelled before the lock was free: the task did not run. */
export interface WaitCancelled {
  readonly _tag: "WaitCancelled";
}

export function isWaitCancelled(error: unknown): error is WaitCancelled {
  return (
    typeof error === "object" && error !== null && (error as { _tag?: unknown })._tag === "WaitCancelled"
  );
}

/** An Effect that completes when `token` is cancelled (at once when it already is). */
function cancelled(token: CancellationToken): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    const subscription = token.onCancellationRequested(() => resume(Effect.void));
    return Effect.sync(() => subscription.dispose());
  });
}

/**
 * Run one request with cancel-then-kill. `start` gets a token of its own, cancelled when `token` is: that sends
 * `$/cancelRequest`. A serve that answers within `graceMs` (exit 130, as opentide serve does) settles as `answered`;
 * one that does not is killed (`kill`), and the request settles as `killed`. Never rejects.
 */
export function runWithGrace<T>(
  start: (token: CancellationToken) => Promise<T>,
  options: { readonly token?: CancellationToken; readonly graceMs?: number; readonly kill: () => void },
): Promise<Settled<T>> {
  const graceMs = options.graceMs ?? CANCEL_GRACE_MS;
  const inner = new CancellationTokenSource();
  const request = Effect.tryPromise({ try: () => start(inner.token), catch: (error) => error });
  const program = Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(request);
    const token = options.token;
    if (token) {
      // The caller's cancel interrupts the wait (not the request): the serve is asked to stop, then given the grace.
      const first = yield* Effect.raceFirst(
        Fiber.join(fiber).pipe(Effect.map(() => "answered" as const)),
        cancelled(token).pipe(Effect.map(() => "cancel" as const)),
      ).pipe(Effect.catch(() => Effect.succeed("answered" as const)));
      if (first === "cancel") {
        inner.cancel();
        const answer = yield* Fiber.join(fiber).pipe(
          Effect.map(() => true),
          Effect.catch(() => Effect.succeed(true)),
          Effect.timeoutOption(Duration.millis(graceMs)),
        );
        if (answer._tag === "None") {
          options.kill();
          yield* Fiber.interrupt(fiber);
          return yield* Effect.fail(new Killed({ graceMs }));
        }
      }
    }
    return yield* Fiber.join(fiber);
  });
  return Effect.runPromiseExit(program).then((exit): Settled<T> => {
    inner.dispose();
    if (Exit.isSuccess(exit)) return { kind: "answered", value: exit.value };
    const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
    if (error?._tag === "Fail" && error.error instanceof Killed) return { kind: "killed", graceMs };
    return { kind: "failed", error: error?._tag === "Fail" ? error.error : new Error(String(exit.cause)) };
  });
}

/** Writers one at a time, first come first served. A writer cancelled while it waits leaves the line. */
export interface WriteLock {
  /** Run `task` alone; rejects with `WaitCancelled` (and does not run it) when `token` is cancelled first. */
  run<T>(task: () => Promise<T>, token?: CancellationToken): Promise<T>;
}

export function makeWriteLock(): WriteLock {
  const semaphore = Semaphore.makeUnsafe(1);
  return {
    run<T>(task: () => Promise<T>, token?: CancellationToken): Promise<T> {
      let started = false;
      const program = Semaphore.withPermit(
        semaphore,
        Effect.suspend(() => {
          started = true;
          return Effect.tryPromise({ try: task, catch: (error) => error });
        }),
      );
      const fiber = Effect.runFork(program);
      // Interruptible while it waits for the permit only: once the task runs it owns the permit until it settles.
      const subscription = token?.onCancellationRequested(() => {
        if (!started) fiber.interruptUnsafe();
      });
      return new Promise<T>((resolve, reject) => {
        fiber.addObserver((exit) => {
          subscription?.dispose();
          if (Exit.isSuccess(exit)) return resolve(exit.value);
          const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
          if (failure?._tag === "Fail") return reject(failure.error);
          const waitCancelled: WaitCancelled = { _tag: "WaitCancelled" };
          reject(waitCancelled);
        });
      });
    },
  };
}

/**
 * The crash ceiling of one runtime's serve: the Schedule that paces its restarts, `max` of a jittered exponential
 * backoff and three recurrences, counted within a window. `crashed` is told each crash: it answers the backoff before
 * the next start, or undefined when the ceiling is reached and serve is given up on.
 */
export interface CrashBudget {
  crashed(now: number): { readonly delayMs: number } | undefined;
}

export interface CrashBudgetOptions {
  readonly baseMs?: number;
  readonly restarts?: number;
  readonly windowMs?: number;
}

export function makeCrashBudget(options: CrashBudgetOptions = {}): CrashBudget {
  const schedule = Schedule.max([
    Schedule.jittered(Schedule.exponential(Duration.millis(options.baseMs ?? CRASH_BACKOFF_MS))),
    Schedule.recurs(options.restarts ?? CRASH_RESTARTS),
  ]);
  const windowMs = options.windowMs ?? CRASH_WINDOW_MS;
  let step:
    | ((
        now: number,
        input: unknown,
      ) => Pull.Pull<[Duration.Duration, Duration.Duration], never, Duration.Duration>)
    | undefined;
  let windowStart = 0;
  let exhausted = false;
  return {
    crashed(now) {
      if (exhausted) return undefined;
      if (step === undefined || now - windowStart > windowMs) {
        step = Effect.runSync(Schedule.toStep(schedule));
        windowStart = now;
      }
      const next = Effect.runSync(
        step(now, undefined).pipe(
          Effect.map(([, delay]) => Duration.toMillis(delay)),
          Pull.catchDone(() => Effect.succeed(undefined)),
        ),
      );
      if (next === undefined) {
        exhausted = true;
        return undefined;
      }
      return { delayMs: Math.max(0, Math.round(next)) };
    },
  };
}

/** A resource whose life is a Scope: closing it runs `release` once (a serve lane: stop, then kill). */
export interface Lane<T> {
  readonly value: T;
  close(): Promise<void>;
}

export function openLane<T>(acquire: () => T, release: (value: T) => Promise<void>): Lane<T> {
  const scope = Effect.runSync(Scope.make());
  const value = Effect.runSync(
    Scope.provide(
      Effect.acquireRelease(Effect.sync(acquire), (resource) => Effect.promise(() => release(resource))),
      scope,
    ),
  );
  let closed: Promise<void> | undefined;
  return {
    value,
    close() {
      closed ??= Effect.runPromise(Scope.close(scope, Exit.void));
      return closed;
    },
  };
}
