/**
 * Source-wide platform-operation gate (Sprint 17c2 r1; provider deadline Sprint 34A3).
 *
 * One gated operation may dispatch several HTTP requests (`listSubmissions` walks server pages),
 * so the contract floor is measured from the previous operation's **completion**, not its start.
 * These cases drive the gate with a manual clock and a wait port that advances that clock, so the
 * pacing is observed exactly instead of slept through, and they pin the queue behaviour: a rejected
 * or cancelled operation must never wedge the operations behind it.
 *
 * The 34A3 cases pin the second, provider-owned half of the pacing: a positive Retry-After — thrown
 * as a typed platform error or returned inside a typed result — raises one source-wide not-before
 * instant that every later operation of this source waits for, that is recorded while the answering
 * operation still owns the FIFO slot, that a shorter later delay can never shrink, and that a
 * cancellation during the cooldown leaves intact for the next live caller.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LUOGU_SOURCE_MIN_INTERVAL_MS,
  createLuoguSourceGate,
} from '../../src/application/luogu-source-gate.js';
import { PlatformError } from '../../src/application/platform-errors.js';
import { DomainError, createCancellationSource, type CancellationToken } from '../../src/domain/index.js';

interface Pacing {
  readonly now: () => number;
  readonly wait: (ms: number, token: CancellationToken) => Promise<void>;
  readonly waits: number[];
  readonly advance: (ms: number) => void;
}

/** Manual epoch-millisecond clock whose waits move it forward instead of sleeping. */
function createPacing(startMs = 0): Pacing {
  let ms = startMs;
  const waits: number[] = [];
  return {
    now: () => ms,
    waits,
    advance: (delta) => {
      ms += delta;
    },
    async wait(delay, token) {
      token.throwIfCancelled();
      waits.push(delay);
      ms += delay;
    },
  };
}

/** A promise with a resolver, used to park one synthetic cooldown wait. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Let pending microtasks and timers run until `predicate` holds. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

void test('the floor is measured after the whole operation finished, not after it started', async () => {
  const pacing = createPacing();
  const gate = createLuoguSourceGate({ now: pacing.now, wait: pacing.wait, minRequestIntervalMs: 0 });
  assert.equal(
    gate.minIntervalMs,
    LUOGU_SOURCE_MIN_INTERVAL_MS,
    'a lower configured interval is raised to the platform floor',
  );
  const token = createCancellationSource().token;
  const starts: number[] = [];
  const finishes: number[] = [];

  const first = gate.run(token, async () => {
    starts.push(pacing.now());
    // One operation that dispatches several requests over four seconds.
    pacing.advance(4_000);
    finishes.push(pacing.now());
    return 'first';
  });
  const second = gate.run(token, async () => {
    starts.push(pacing.now());
    finishes.push(pacing.now());
    return 'second';
  });

  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.deepEqual(starts, [0, 6_000], 'the second operation starts only after the quiet time');
  assert.equal(
    starts[1]! - finishes[0]!,
    LUOGU_SOURCE_MIN_INTERVAL_MS,
    'the next operation starts one floor after the previous finished, not after it started',
  );
  assert.deepEqual(pacing.waits, [LUOGU_SOURCE_MIN_INTERVAL_MS]);
});

void test('a rejected or cancelled operation releases the queue instead of wedging later work', async () => {
  const pacing = createPacing();
  const gate = createLuoguSourceGate({ now: pacing.now, wait: pacing.wait, minRequestIntervalMs: 5_000 });
  assert.equal(gate.minIntervalMs, 5_000, 'a higher configured interval is kept');
  const token = createCancellationSource().token;
  const cancelled = createCancellationSource();
  const events: string[] = [];

  const failing = gate.run(token, async () => {
    events.push('failed');
    pacing.advance(1_000);
    throw new Error('the transport failed');
  });
  const skipped = gate.run(cancelled.token, async () => {
    events.push('cancelled-work');
    return 'never';
  });
  cancelled.cancel('cancelled by the test');
  const after = gate.run(token, async () => {
    events.push('after');
    return 'ok';
  });

  await assert.rejects(failing, /the transport failed/);
  await assert.rejects(skipped, (error: unknown) => error instanceof DomainError && error.code === 'cancelled');
  assert.equal(await after, 'ok');
  assert.deepEqual(events, ['failed', 'after'], 'the cancelled operation never ran and the later one still did');
  assert.deepEqual(pacing.waits, [5_000], 'the failing operation still opened the quiet-time window');
});

void test('the gate refuses a missing operation, passes its token through and honors a prior completion instant', async () => {
  const pacing = createPacing(10_000);
  const gate = createLuoguSourceGate({ now: pacing.now, wait: pacing.wait, lastCompletedAt: 9_000 });
  const token = createCancellationSource().token;

  assert.throws(
    () => gate.run(token, undefined as never),
    (error: unknown) => error instanceof DomainError && error.code === 'invalid_input',
    'running no operation at all is a typed refusal, not a silent no-op',
  );

  const starts: number[] = [];
  const passedThrough = await gate.run(token, async (inner) => {
    starts.push(pacing.now());
    return inner === token;
  });
  assert.equal(passedThrough, true, 'the work receives the caller token');
  assert.deepEqual(starts, [11_000], 'a prior completion instant delays the first operation to the floor');
  assert.deepEqual(pacing.waits, [1_000]);
});

void test('a thrown platform Retry-After becomes the source-wide deadline the next operation waits for', async () => {
  const pacing = createPacing();
  const gate = createLuoguSourceGate({ now: pacing.now, wait: pacing.wait });
  const token = createCancellationSource().token;
  const starts: number[] = [];

  const throttled = gate.run(token, async () => {
    starts.push(pacing.now());
    throw new PlatformError({
      code: 'rate_limited',
      operation: 'editorial',
      retryable: true,
      retryAfterMs: 5_000,
      detail: 'the provider asked for a pause',
    });
  });
  const after = gate.run(token, async () => {
    starts.push(pacing.now());
    return 'after';
  });

  await assert.rejects(
    throttled,
    (error: unknown) => error instanceof PlatformError && error.code === 'rate_limited',
    'the typed failure is rethrown unchanged',
  );
  assert.equal(await after, 'after', 'the delay never becomes a permanent stop: later work still progresses');
  assert.deepEqual(starts, [0, 5_000], 'the next operation dispatches at the provider deadline, not at the floor');
  assert.deepEqual(pacing.waits, [5_000], 'the 5s provider deadline replaced the shorter 2s floor');
});

void test('a returned result Retry-After is recorded while the slot is owned, and a shorter later delay never shrinks it', async () => {
  const pacing = createPacing();
  const gate = createLuoguSourceGate({ now: pacing.now, wait: pacing.wait });
  const token = createCancellationSource().token;
  const starts: number[] = [];
  const answer = (retryAfterMs: number | null): { readonly retryAfterMs: number | null } => ({ retryAfterMs });
  const extract = (result: { readonly retryAfterMs: number | null }): number | null => result.retryAfterMs;

  // The second operation is queued *before* the first one answers, so it can only be delayed by a
  // deadline the first one recorded while it still owned the FIFO slot.
  const first = gate.run(token, async () => {
    starts.push(pacing.now());
    return answer(9_000);
  }, extract);
  const second = gate.run(token, async () => {
    starts.push(pacing.now());
    return answer(1_000);
  }, extract);
  const third = gate.run(token, async () => {
    starts.push(pacing.now());
    return answer(null);
  }, extract);

  assert.deepEqual(await Promise.all([first, second, third]), [answer(9_000), answer(1_000), answer(null)]);
  assert.deepEqual(starts, [0, 9_000, 11_000], 'each queued caller already observed the retained deadline');
  assert.deepEqual(
    pacing.waits,
    [9_000, 2_000],
    'the shorter 1s delay observed at 9s raised the deadline to 10s instead of shrinking it, and the floor carried the third call to 11s',
  );
});

void test('a cancellation during the retained cooldown dispatches nothing and does not poison the queue', async () => {
  let ms = 0;
  const waits: number[] = [];
  const park = deferred();
  let parkNextWait = false;
  let parkedWaits = 0;
  const gate = createLuoguSourceGate({
    now: () => ms,
    wait: async (delay, token) => {
      waits.push(delay);
      token.throwIfCancelled();
      if (parkNextWait) {
        // Park this cooldown, so the test can cancel the queued caller while it is waiting it out.
        parkNextWait = false;
        parkedWaits += 1;
        await park.promise;
        token.throwIfCancelled();
      }
      ms += delay;
    },
  });
  const token = createCancellationSource().token;
  const queued = createCancellationSource();
  const events: string[] = [];

  const throttled = gate.run(token, async () => {
    events.push('throttled');
    throw new PlatformError({ code: 'rate_limited', operation: 'editorial', retryAfterMs: 5_000, detail: 'slow down' });
  }).then(
    () => null,
    (error: unknown) => error,
  );
  await until(() => events.length === 1, 'the throttled operation to answer');

  parkNextWait = true;
  const waiting = gate.run(queued.token, async () => {
    events.push('cancelled-work');
    return 'never';
  });
  await until(() => parkedWaits === 1, 'the queued operation to park inside the cooldown');
  queued.cancel('cancelled during the cooldown');
  park.resolve();

  await assert.rejects(waiting, (error: unknown) => error instanceof DomainError && error.code === 'cancelled');
  assert.equal(events.includes('cancelled-work'), false, 'the cancelled caller dispatched nothing');
  assert.ok((await throttled) instanceof PlatformError, 'the throttled operation kept its own typed failure');

  // The queue and the retained deadline both survive: the next live caller proceeds, but only after
  // the cooldown the cancelled one never waited out.
  const after = gate.run(token, async () => {
    events.push('after');
    return 'ok';
  });
  assert.equal(await after, 'ok');
  assert.deepEqual(events, ['throttled', 'after']);
  assert.deepEqual(waits, [5_000, 5_000], 'the retained deadline still holds the next live caller');
});
