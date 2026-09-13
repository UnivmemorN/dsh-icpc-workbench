/**
 * Source-wide platform-operation gate (Sprint 17c2, revised 17c2-r1).
 *
 * The authenticated reader and the anonymous metadata transport each pace their **own** HTTP
 * requests, but they are separate transports: a pass that switches between them (or a second
 * account whose reader was created later) would reset the observable pacing and could issue two
 * requests to the official origin back to back. This gate is the shared floor across every Luogu
 * operation of one source instance, whatever transport makes it: it serializes **whole
 * operations** (FIFO) and keeps at least {@link LUOGU_SOURCE_MIN_INTERVAL_MS} of quiet time
 * between the end of one operation and the start of the next.
 *
 * The floor is measured from the previous operation's *completion*, not its start, because one
 * operation may dispatch several HTTP requests: a `listSubmissions` call walks server pages and
 * can span more than four seconds, so pacing its start would let the next operation begin
 * immediately after a burst of requests. The transports keep their own internal pacing inside
 * `work`; this gate only guarantees the source-wide quiet time between whole operations.
 *
 * It is deliberately pure application code: time and waiting arrive through injected ports, so
 * no runtime timer, `AbortSignal` or `setTimeout` appears here and a test can drive the pacing
 * deterministically. The gate never persists anything; a restart starts a fresh window, which at
 * worst delays one operation — it can never release a caller earlier than the floor.
 */
import { invariant, throwIfCancelled, type CancellationToken } from '../domain/index.js';

/** Luogu's platform floor between the completion of one operation and the start of the next. */
export const LUOGU_SOURCE_MIN_INTERVAL_MS = 2_000;

/**
 * Serialized, paced access to one source instance's platform operations.
 *
 * Implementations must not resolve `run` before the configured interval elapsed since the previous
 * operation **finished**, must observe the caller's token, and must not let a rejected or cancelled
 * operation block later ones.
 */
export interface LuoguSourceGate {
  /** Effective floor in milliseconds; never below {@link LUOGU_SOURCE_MIN_INTERVAL_MS}. */
  readonly minIntervalMs: number;
  /**
   * Run one whole platform operation under the source-wide floor.
   *
   * `work` receives the caller's token and owns the platform requests it makes; the returned
   * promise settles exactly as `work` settles. A queued call whose token is cancelled before it
   * starts rejects with `cancelled` without running `work`, and a failing or cancelled operation
   * still releases the queue and still starts the quiet-time window of the next one.
   */
  run<T>(token: CancellationToken, work: (token: CancellationToken) => Promise<T>): Promise<T>;
}

export interface LuoguSourceGateOptions {
  /** Epoch-millisecond clock used only for pacing arithmetic. */
  readonly now: () => number;
  /** Cancellation-aware wait; the single timer this module uses. */
  readonly wait: (ms: number, token: CancellationToken) => Promise<void>;
  /** Configured platform interval; a lower value is raised to the platform floor. */
  readonly minRequestIntervalMs?: number;
  /** Completion instant of a previous operation (diagnostics/tests); `null` means "none yet". */
  readonly lastCompletedAt?: number | null;
}

/**
 * Build one gate per source instance.
 *
 * The returned gate is safe to share between the sync service and the connection adapter of the
 * same instance; sharing one instance is the point, because two gates would pace independently.
 */
export function createLuoguSourceGate(options: LuoguSourceGateOptions): LuoguSourceGate {
  invariant(
    options !== null && typeof options === 'object' && typeof options.now === 'function' && typeof options.wait === 'function',
    'unfilled_settings',
    'createLuoguSourceGate requires explicit now() and wait() ports',
  );
  const configured = options.minRequestIntervalMs ?? 0;
  invariant(
    typeof configured === 'number' && Number.isSafeInteger(configured) && configured >= 0,
    'invalid_input',
    'minRequestIntervalMs must be a safe integer >= 0',
    { minRequestIntervalMs: configured },
  );
  const minIntervalMs = Math.max(LUOGU_SOURCE_MIN_INTERVAL_MS, configured);
  const now = options.now;
  const wait = options.wait;
  let lastCompletedAt: number | null = options.lastCompletedAt ?? null;
  // FIFO: every operation is chained onto the previous one, so a burst is serialized in the order
  // it arrived and no caller can jump the queue.
  let tail: Promise<void> = Promise.resolve();

  return {
    minIntervalMs,
    run<T>(token: CancellationToken, work: (token: CancellationToken) => Promise<T>): Promise<T> {
      invariant(typeof work === 'function', 'invalid_input', 'the source gate requires the operation to run');
      const operation = tail.then(async () => {
        throwIfCancelled(token);
        const previous = lastCompletedAt;
        if (previous !== null) {
          const delay = previous + minIntervalMs - now();
          if (delay > 0) {
            await wait(delay, token);
          }
        }
        throwIfCancelled(token);
        try {
          return await work(token);
        } finally {
          // Completion, not start: the next operation waits the floor after this whole operation
          // ended, however many requests it dispatched and whether it succeeded or threw.
          lastCompletedAt = now();
        }
      });
      tail = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
  };
}
