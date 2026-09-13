/**
 * Source-wide platform-operation gate (Sprint 17c2 r1).
 *
 * One gated operation may dispatch several HTTP requests (`listSubmissions` walks server pages),
 * so the contract floor is measured from the previous operation's **completion**, not its start.
 * These cases drive the gate with a manual clock and a wait port that advances that clock, so the
 * pacing is observed exactly instead of slept through, and they pin the queue behaviour: a rejected
 * or cancelled operation must never wedge the operations behind it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LUOGU_SOURCE_MIN_INTERVAL_MS,
  createLuoguSourceGate,
} from '../../src/application/luogu-source-gate.js';
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
