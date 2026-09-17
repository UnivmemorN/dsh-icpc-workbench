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
 *
 * ## The source-wide provider deadline (Sprint 34A3)
 *
 * The transports of this one source are deliberately several — the anonymous business transport,
 * the anonymous metadata transport, and one authenticated transport per account — and some Luogu
 * adapters convert a provider refusal into a *successful typed result* (a `rate_limited` or
 * `unavailable` editorial answer, or a failed metadata report). A per-transport cooldown can
 * therefore not see a "slow down" that one of those transports answered as data, and the next
 * operation of the same source could be dispatched on another transport immediately.
 *
 * The gate closes that hole by owning one source-wide **not-before** instant: every operation waits
 * until the later of the previous operation's floor and that instant, and any positive, finite
 * Retry-After is folded into it *while the operation still owns the FIFO slot* — never after `run`
 * resolved, because a caller already queued behind it could otherwise start first. The instant only
 * ever moves forward, so a newer, shorter delay can never release a caller earlier than a deadline
 * an earlier answer declared, and it is a delay rather than a stop: once it passed, later work
 * proceeds normally.
 */
import { invariant, throwIfCancelled, type CancellationToken } from '../domain/index.js';
import { isPlatformError } from './platform-errors.js';

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
   * Run one whole platform operation under the source-wide floor and provider deadline.
   *
   * `work` receives the caller's token and owns the platform requests it makes; the returned
   * promise settles exactly as `work` settles. A queued call whose token is cancelled before it
   * starts rejects with `cancelled` without running `work`, and a failing or cancelled operation
   * still releases the queue and still starts the quiet-time window of the next one.
   *
   * `retryAfterOf` is the optional typed result extractor for adapters that answer a provider
   * refusal as **data** instead of throwing: it receives the resolved value and returns the declared
   * Retry-After in milliseconds, or `null`/`undefined` when the answer declared none. A positive,
   * finite delay raises the shared not-before instant to at least `now() + delay`; any other value is
   * ignored. A thrown {@link PlatformError} is inspected the same way and rethrown unchanged, so an
   * adapter that throws loses nothing either. Both recordings happen while this call still owns the
   * FIFO slot, so the next queued operation already observes them.
   */
  run<T>(
    token: CancellationToken,
    work: (token: CancellationToken) => Promise<T>,
    retryAfterOf?: (result: T) => number | null | undefined,
  ): Promise<T>;
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
  // The source-wide provider deadline: raised by every positive Retry-After this source observed,
  // however the transport answered it (thrown, or as a typed result of `work`). It never moves
  // backwards, and it is read **before** each operation, so a queued caller cannot slip past it.
  let notBeforeAt: number | null = null;
  // FIFO: every operation is chained onto the previous one, so a burst is serialized in the order
  // it arrived and no caller can jump the queue.
  let tail: Promise<void> = Promise.resolve();

  /**
   * Fold one declared delay into the shared deadline while the recording call still owns the slot.
   *
   * Only a positive, finite number is a declared delay; `null`, `undefined`, `NaN`, an infinity, a
   * negative value and a non-number are all "no declaration" and leave the deadline exactly as it
   * was. The deadline is raised with `Math.max`, never replaced, so a newer shorter delay cannot
   * release a caller earlier than an earlier answer demanded.
   */
  const recordRetryAfter = (retryAfterMs: number | null | undefined): void => {
    if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
      return;
    }
    const deadline = now() + Math.round(retryAfterMs);
    notBeforeAt = notBeforeAt === null ? deadline : Math.max(notBeforeAt, deadline);
  };

  return {
    minIntervalMs,
    run<T>(
      token: CancellationToken,
      work: (token: CancellationToken) => Promise<T>,
      retryAfterOf?: (result: T) => number | null | undefined,
    ): Promise<T> {
      invariant(typeof work === 'function', 'invalid_input', 'the source gate requires the operation to run');
      invariant(
        retryAfterOf === undefined || typeof retryAfterOf === 'function',
        'invalid_input',
        'retryAfterOf must be a function when supplied',
      );
      const operation = tail.then(async () => {
        throwIfCancelled(token);
        const floor = lastCompletedAt === null ? null : lastCompletedAt + minIntervalMs;
        const deadline = notBeforeAt;
        // The later of the source-wide floor and the retained provider deadline. A cancellation
        // observed while this wait runs rejects the queued call before `work`, and leaves both the
        // deadline and the queue itself exactly as they were.
        const target = floor === null ? deadline : deadline === null ? floor : Math.max(floor, deadline);
        if (target !== null) {
          const delay = target - now();
          if (delay > 0) {
            await wait(delay, token);
          }
        }
        throwIfCancelled(token);
        try {
          const result = await work(token);
          // An adapter may answer a provider refusal as data; its declared delay is recorded here,
          // while this call still owns the FIFO slot, so the next queued caller already sees it.
          if (retryAfterOf !== undefined) {
            recordRetryAfter(retryAfterOf(result));
          }
          return result;
        } catch (error) {
          // A thrown platform error is inspected the same way and rethrown unchanged.
          if (isPlatformError(error)) {
            recordRetryAfter(error.retryAfterMs);
          }
          throw error;
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
