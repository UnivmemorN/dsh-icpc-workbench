/**
 * Coaching attempts through the public store surface.
 *
 * These cases pin the audit and quota consequences the coaching service will rely on: a
 * reservation exists before dispatch with an explicit deadline, a charged attempt can never be
 * overwritten by a duplicate id, the lifecycle only moves forward and a settled row is final,
 * a known host correlation survives settlement unchanged, the quota count is global across
 * accounts and statuses (including uncertain/failed calls), pages are bounded, ordered and
 * bound to the filter set that produced their cursor, and the account scope keeps "every
 * account", "anonymous only" and one named account apart. Stored bodies are re-validated on
 * read (a tampered body is `corrupt_row`) and usage counters must be safe integers.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteTrainingStore, StorageError } from '../../src/adapters/sqlite/index.js';
import {
  COACHING_ATTEMPT_IDENTITY_FIELDS,
  MAX_COACHING_RESPONSE_CHARS,
  validateCoachingAttempt,
  validateCoachingAttemptTransition,
  type CoachingAttempt,
  type CoachingAttemptQuery,
} from '../../src/application/coaching-types.js';
import type { ModelGatewayError } from '../../src/application/ports.js';
import { DomainError, createModelUsage, type ModelUsage, type NormalizedProblem, type ProblemSnapshot } from '../../src/domain/index.js';
import * as fx from './fixtures.js';

/** Later than every fixture instant: a lease must still be in the future at its request time. */
const AFTER_LEASE = '2026-09-12T11:00:00.000Z';

/** A truthful failure without usage: the call finished, its cost is unknown. */
const TIMEOUT: ModelGatewayError = { code: 'timeout', message: 'no answer within 180s', retryable: true };
/** A terminal provider failure. */
const PROVIDER_FAILURE: ModelGatewayError = {
  code: 'provider_error',
  message: 'provider rejected the request',
  retryable: false,
};

/** One problem world plus a second problem/account to prove that filters and counts stay scoped. */
interface World {
  readonly problem: NormalizedProblem;
  readonly otherProblem: NormalizedProblem;
  readonly snapshot: ProblemSnapshot;
  readonly otherSnapshot: ProblemSnapshot;
  readonly accountId: string;
  readonly otherAccountId: string;
}

function makeWorld(): World {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const otherProblem = fx.makeProblem(fx.makeRef(scope.instance, '2B'));
  return {
    problem: scope.problem,
    otherProblem,
    snapshot: fx.makeSnapshot(scope.problem),
    otherSnapshot: fx.makeSnapshot(otherProblem),
    accountId: scope.account.id,
    otherAccountId: fx.makeAccount(scope.instance, 'bob').id,
  };
}

function usage(): ModelUsage {
  return createModelUsage({ calls: 1, promptTokens: 120, completionTokens: 40 });
}

/** A reservation with the approved shape; every case overrides only what it is about. */
function reserved(world: World, overrides: Partial<CoachingAttempt> = {}): CoachingAttempt {
  return {
    id: 'coaching-1',
    accountId: world.accountId,
    problemKey: world.problem.key,
    snapshotId: world.snapshot.snapshotId,
    level: 1,
    requestedAt: fx.AT,
    expiresAt: fx.LATER,
    finishedAt: null,
    status: 'reserved',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    promptVersion: 'coaching-v1',
    hostSessionId: null,
    hostCallId: null,
    usage: null,
    responseText: null,
    error: null,
    ...overrides,
  };
}

function uncertain(world: World, overrides: Partial<CoachingAttempt> = {}): CoachingAttempt {
  return reserved(world, {
    status: 'uncertain',
    finishedAt: fx.EXPIRED,
    error: TIMEOUT,
    ...overrides,
  });
}

function settled(world: World, overrides: Partial<CoachingAttempt> = {}): CoachingAttempt {
  return reserved(world, {
    status: 'settled',
    finishedAt: fx.EXPIRED,
    usage: usage(),
    responseText: 'Try a segment tree with lazy propagation.',
    ...overrides,
  });
}

function ids(page: { readonly items: readonly CoachingAttempt[] }): readonly string[] {
  return page.items.map((item) => item.id);
}

/** Walk every page of one query and return the collected ids; fails if paging does not stop. */
async function drainAll(
  store: SqliteTrainingStore,
  query: Omit<CoachingAttemptQuery, 'limit' | 'cursor'>,
  limit: number,
): Promise<readonly string[]> {
  const collected: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await store.listCoachingAttempts({ ...query, limit, cursor });
    collected.push(...ids(page));
    cursor = page.nextCursor;
    pages += 1;
    assert.ok(pages <= 10, 'paging must terminate');
  } while (cursor !== null);
  return collected;
}

/** Persist a call the way the service will: a reservation first, then its terminal record. */
async function record(store: SqliteTrainingStore, body: CoachingAttempt): Promise<void> {
  await store.saveCoachingAttempt({
    ...body,
    status: 'reserved',
    finishedAt: null,
    usage: null,
    responseText: null,
    error: null,
  });
  await store.saveCoachingAttempt(body);
}

async function withStore(run: (store: SqliteTrainingStore) => Promise<void>): Promise<void> {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    await run(store);
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
}

function invalid(code: DomainError['code'], message: RegExp | null = null) {
  return (error: unknown): boolean =>
    error instanceof DomainError && error.code === code && (message === null || message.test(error.message));
}

void test('a reservation and its settlement survive close and reopen', async () => {
  const paths = fx.tempDatabase();
  const world = makeWorld();
  const done = settled(world, { hostSessionId: 'session-1', hostCallId: 'call-1' });

  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  await store.saveCoachingAttempt(reserved(world));
  await store.saveCoachingAttempt(done);
  await store.close();

  const reopened = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    assert.deepEqual(await reopened.getCoachingAttempt('coaching-1'), done);
    assert.equal(await reopened.getCoachingAttempt('missing'), null);
    assert.deepEqual(ids(await reopened.listCoachingAttempts({ limit: 10, cursor: null })), ['coaching-1']);

    // A settled row is terminal: no rewrite, while an identical re-save is a no-op.
    await assert.rejects(
      reopened.saveCoachingAttempt({ ...done, responseText: 'a rewritten answer' }),
      invalid('immutable_violation'),
    );
    await reopened.saveCoachingAttempt(done);
    assert.deepEqual(await reopened.getCoachingAttempt('coaching-1'), done);
  } finally {
    await reopened.close();
    fx.removeDirectory(paths.dir);
  }
});

void test('attempts only move forward: reserved -> uncertain | settled, nothing returns', async () => {
  await withStore(async (store) => {
    const world = makeWorld();
    const correlated = reserved(world, { hostSessionId: 'session-1', hostCallId: 'call-1' });
    await store.saveCoachingAttempt(correlated);
    const pending = uncertain(world, { hostSessionId: 'session-1', hostCallId: 'call-1' });
    await store.saveCoachingAttempt(pending);

    // An uncertain call waiting for late usage cannot be rewritten or returned to reserved.
    await assert.rejects(store.saveCoachingAttempt(correlated), invalid('invalid_transition'));
    await assert.rejects(
      store.saveCoachingAttempt({ ...pending, error: { ...TIMEOUT, message: 'a different story' } }),
      invalid('invalid_transition'),
    );
    assert.deepEqual(await store.getCoachingAttempt('coaching-1'), pending);

    // Late usage settles it exactly once and still lands.
    const final = settled(world, {
      hostSessionId: 'session-1',
      hostCallId: 'call-1',
      responseText: null,
      error: PROVIDER_FAILURE,
    });
    await store.saveCoachingAttempt(final);
    await assert.rejects(
      store.saveCoachingAttempt(reserved(world, { hostSessionId: 'session-1', hostCallId: 'call-1' })),
      invalid('immutable_violation'),
    );
    assert.deepEqual(await store.getCoachingAttempt('coaching-1'), final);

    // A new reservation is fixed once written: a second save cannot attach a call later.
    await store.saveCoachingAttempt(reserved(world, { id: 'coaching-2' }));
    await assert.rejects(
      store.saveCoachingAttempt(reserved(world, { id: 'coaching-2', hostCallId: 'call-late' })),
      invalid('invalid_transition'),
    );
    assert.equal((await store.getCoachingAttempt('coaching-2'))?.hostCallId, null);

    // A finished call can never be inserted first: the reservation is what puts it on the books.
    for (const terminal of [settled(world, { id: 'coaching-3' }), uncertain(world, { id: 'coaching-4' })]) {
      await assert.rejects(store.saveCoachingAttempt(terminal), invalid('invalid_transition'));
      assert.equal(await store.getCoachingAttempt(terminal.id), null);
    }
  });
});

void test('a duplicate id can neither overwrite a charged attempt nor fork its identity', async () => {
  await withStore(async (store) => {
    const world = makeWorld();
    await store.saveCoachingAttempt(reserved(world));
    const charged = settled(world, { responseText: null, error: PROVIDER_FAILURE });
    await store.saveCoachingAttempt(charged);

    // A second reservation and a same-shape replay both resolve against the charged row.
    for (const overwrite of [
      reserved(world, { level: 2, requestedAt: fx.LATER, expiresAt: fx.LEASE_UNTIL }),
      reserved(world),
      { ...charged, error: { ...PROVIDER_FAILURE, message: 'a different failure' } },
    ]) {
      await assert.rejects(store.saveCoachingAttempt(overwrite), invalid('immutable_violation'));
      assert.deepEqual(await store.getCoachingAttempt('coaching-1'), charged);
    }
    assert.equal(await store.countCoachingAttempts({}), 1);
  });
});

void test('a known host correlation is never reassigned or cleared and settles only once', async () => {
  await withStore(async (store) => {
    const world = makeWorld();
    const correlated = reserved(world, { hostSessionId: 'session-1', hostCallId: 'call-1' });
    await store.saveCoachingAttempt(correlated);
    await store.saveCoachingAttempt(correlated);
    assert.deepEqual(await store.getCoachingAttempt('coaching-1'), correlated, 'an identical re-save is a no-op');

    const pending = uncertain(world, { hostSessionId: 'session-1', hostCallId: 'call-1' });
    await store.saveCoachingAttempt(pending);
    const final = settled(world, {
      hostSessionId: 'session-1',
      hostCallId: 'call-1',
      responseText: null,
      error: PROVIDER_FAILURE,
    });
    for (const wrong of [
      { hostCallId: 'call-other' },
      { hostCallId: null },
      { hostSessionId: 'session-other' },
      { hostSessionId: null },
    ]) {
      await assert.rejects(
        store.saveCoachingAttempt({ ...final, ...wrong }),
        (error) =>
          error instanceof DomainError &&
          error.code === 'immutable_violation' &&
          error.details['reason'] === 'host_correlation',
      );
    }
    assert.deepEqual(await store.getCoachingAttempt('coaching-1'), pending, 'a wrong settlement wrote nothing');

    await store.saveCoachingAttempt(final);
    assert.deepEqual(await store.getCoachingAttempt('coaching-1'), final);
  });
});

void test('coaching pages are ordered, bounded and bound to their filter set', async () => {
  await withStore(async (store) => {
    const world = makeWorld();
    // Two attempts share `AT`, so ordering must fall back to the id; two share `LATER`.
    await store.saveCoachingAttempt(reserved(world, { id: 'attempt-b', requestedAt: fx.AT }));
    await store.saveCoachingAttempt(reserved(world, { id: 'attempt-a', requestedAt: fx.AT }));
    await store.saveCoachingAttempt(
      reserved(world, { id: 'attempt-c', requestedAt: fx.LATER, expiresAt: fx.LEASE_UNTIL, accountId: world.otherAccountId }),
    );
    await record(
      store,
      settled(world, {
        id: 'attempt-d',
        requestedAt: fx.LATER,
        expiresAt: fx.LEASE_UNTIL,
        finishedAt: fx.LATER,
        accountId: null,
        problemKey: world.otherProblem.key,
        snapshotId: world.otherSnapshot.snapshotId,
      }),
    );
    await record(
      store,
      uncertain(world, { id: 'attempt-e', requestedAt: fx.LEASE_UNTIL, expiresAt: AFTER_LEASE, finishedAt: fx.LEASE_UNTIL }),
    );

    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await store.listCoachingAttempts({ limit: 2, cursor });
      collected.push(...ids(page));
      cursor = page.nextCursor;
      pages += 1;
      assert.ok(pages <= 5, 'paging must terminate');
    } while (cursor !== null);
    assert.deepEqual(collected, ['attempt-a', 'attempt-b', 'attempt-c', 'attempt-d', 'attempt-e']);
    assert.equal(pages, 3);

    assert.deepEqual(ids(await store.listCoachingAttempts({ accountId: world.accountId, limit: 50, cursor: null })), [
      'attempt-a',
      'attempt-b',
      'attempt-e',
    ]);
    assert.deepEqual(
      ids(await store.listCoachingAttempts({ problemKey: world.otherProblem.key, limit: 50, cursor: null })),
      ['attempt-d'],
    );
    assert.deepEqual(ids(await store.listCoachingAttempts({ since: fx.LATER, limit: 50, cursor: null })), [
      'attempt-c',
      'attempt-d',
      'attempt-e',
    ]);
    assert.deepEqual(ids(await store.listCoachingAttempts({ status: 'reserved', limit: 50, cursor: null })), [
      'attempt-a',
      'attempt-b',
      'attempt-c',
    ]);
    assert.deepEqual(ids(await store.listCoachingAttempts({ status: 'uncertain', limit: 50, cursor: null })), [
      'attempt-e',
    ]);
    assert.deepEqual(
      ids(await store.listCoachingAttempts({ accountId: null, limit: 50, cursor: null })),
      ['attempt-d'],
      'an explicit null means "anonymous attempts only", not "no restriction"',
    );

    // A cursor keeps working under the filter set that produced it.
    const accountFirst = await store.listCoachingAttempts({ accountId: world.accountId, limit: 1, cursor: null });
    assert.deepEqual(ids(accountFirst), ['attempt-a']);
    const accountSecond = await store.listCoachingAttempts({
      accountId: world.accountId,
      limit: 1,
      cursor: accountFirst.nextCursor,
    });
    assert.deepEqual(ids(accountSecond), ['attempt-b']);

    // The same cursor under different filters is refused instead of paging another history.
    const unfilteredFirst = await store.listCoachingAttempts({ limit: 2, cursor: null });
    assert.notEqual(unfilteredFirst.nextCursor, null);
    await assert.rejects(
      store.listCoachingAttempts({ status: 'reserved', limit: 2, cursor: unfilteredFirst.nextCursor }),
      invalid('invalid_input', /different filter set/),
    );
    for (const badCursor of ['problem:AAAA', 'coaching:zzzz', 'coaching:']) {
      await assert.rejects(
        store.listCoachingAttempts({ limit: 2, cursor: badCursor }),
        invalid('invalid_input'),
      );
    }

    for (const limit of [0, 501, 1.5]) {
      await assert.rejects(store.listCoachingAttempts({ limit, cursor: null }), invalid('invalid_input'));
    }
    assert.equal((await store.listCoachingAttempts({ limit: 500, cursor: null })).items.length, 5);
    await assert.rejects(
      store.listCoachingAttempts({ since: 'yesterday', limit: 5, cursor: null }),
      invalid('invalid_timestamp'),
    );
    await assert.rejects(
      store.listCoachingAttempts({ problemKey: 'not-a-key', limit: 5, cursor: null }),
      invalid('invalid_id_part'),
    );
  });
});

void test('the quota count is global across accounts and includes reserved, uncertain and failed calls', async () => {
  await withStore(async (store) => {
    const world = makeWorld();
    await store.saveCoachingAttempt(reserved(world, { id: 'attempt-a1' }));
    await record(
      store,
      uncertain(world, { id: 'attempt-a2', requestedAt: fx.LATER, expiresAt: fx.LEASE_UNTIL, finishedAt: fx.LATER }),
    );
    await record(
      store,
      settled(world, {
        id: 'attempt-a3',
        requestedAt: fx.LATER,
        expiresAt: fx.LEASE_UNTIL,
        finishedAt: fx.LATER,
        responseText: null,
        error: PROVIDER_FAILURE,
      }),
    );
    await store.saveCoachingAttempt(
      reserved(world, {
        id: 'attempt-b1',
        accountId: world.otherAccountId,
        requestedAt: fx.LEASE_UNTIL,
        expiresAt: AFTER_LEASE,
      }),
    );
    await record(
      store,
      uncertain(world, {
        id: 'attempt-b2',
        accountId: null,
        requestedAt: fx.LEASE_UNTIL,
        expiresAt: AFTER_LEASE,
        finishedAt: fx.LEASE_UNTIL,
        error: PROVIDER_FAILURE,
      }),
    );

    assert.equal(await store.countCoachingAttempts({}), 5);
    assert.equal(await store.countCoachingAttempts({ status: 'reserved' }), 2);
    assert.equal(await store.countCoachingAttempts({ status: 'uncertain' }), 2, 'an uncertain call is never free');
    assert.equal(await store.countCoachingAttempts({ status: 'settled' }), 1);
    assert.equal(await store.countCoachingAttempts({ since: fx.LATER }), 4);
    assert.equal(await store.countCoachingAttempts({ since: fx.LATER, status: 'uncertain' }), 2);

    // Listing one account must not shrink the global total: switching accounts refunds nothing.
    assert.equal(
      ids(await store.listCoachingAttempts({ accountId: world.otherAccountId, limit: 50, cursor: null })).length,
      1,
    );
    assert.equal(await store.countCoachingAttempts({}), 5);

    await assert.rejects(store.countCoachingAttempts({ status: 'unknown' as never }), invalid('invalid_input'));
    await assert.rejects(store.countCoachingAttempts({ since: 'not-a-timestamp' }), invalid('invalid_timestamp'));
  });
});

void test('a reservation joins the caller transaction and disappears when it rolls back', async () => {
  await withStore(async (store) => {
    const world = makeWorld();
    await assert.rejects(
      store.transaction(async () => {
        await store.saveCoachingAttempt(reserved(world));
        assert.equal((await store.getCoachingAttempt('coaching-1'))?.status, 'reserved', 'the read sees its own write');
        throw new Error('dispatch failed before the model was called');
      }),
      /dispatch failed/,
    );
    assert.equal(await store.getCoachingAttempt('coaching-1'), null);
    assert.equal(await store.countCoachingAttempts({}), 0);

    // The CRUD methods join the outer transaction; they never open a nested one.
    await store.transaction(async () => {
      await assert.rejects(
        store.transaction(async () => undefined),
        (error) => error instanceof StorageError && error.code === 'nested_transaction',
      );
      await store.saveCoachingAttempt(reserved(world));
    });
    assert.equal((await store.getCoachingAttempt('coaching-1'))?.status, 'reserved');
    assert.equal(await store.countCoachingAttempts({}), 1);
  });
});

void test('attempt validation is strict about fields, nested values and dates', () => {
  const world = makeWorld();
  const base = reserved(world);
  assert.deepEqual(validateCoachingAttempt(base), base);

  const rejects = (value: unknown, message: RegExp | null = null): void => {
    assert.throws(
      () => validateCoachingAttempt(value),
      invalid('invalid_input', message),
      `expected invalid_input${message === null ? '' : ` matching ${String(message)}`}`,
    );
  };

  rejects({ ...base, rawPayload: { token: 'secret' } }, /unknown keys: rawPayload/);
  const missing: Record<string, unknown> = { ...base };
  delete missing['expiresAt'];
  rejects(missing, /missing keys: expiresAt/);
  rejects({ ...base, accountId: '   ' }, /accountId must be a non-empty string/);
  rejects({ ...base, provider: '' }, /provider must be a non-empty string/);
  rejects({ ...base, promptVersion: ' ' }, /promptVersion must be a non-empty string/);
  rejects({ ...base, problemKey: 'not-a-key' }, /not a canonical problem key/);
  rejects({ ...base, snapshotId: 'snapshot-1' }, /canonical snapshot id/);
  rejects(
    { ...base, snapshotId: world.otherSnapshot.snapshotId },
    /snapshotId does not belong to problemKey/,
  );
  rejects({ ...base, level: 4 }, /unknown coaching level 4/);
  rejects({ ...base, status: 'pending' }, /unknown coaching status pending/);
  assert.throws(
    () => validateCoachingAttempt({ ...base, requestedAt: 'yesterday' }),
    invalid('invalid_timestamp'),
  );
  rejects({ ...base, expiresAt: fx.AT }, /expiresAt must be after requestedAt/);
  rejects({ ...base, usage: usage() }, /reserved coaching attempt coaching-1 must not carry a result/);
  rejects({ ...base, finishedAt: fx.EXPIRED }, /must not carry a result/);

  rejects(uncertain(world, { finishedAt: null }), /uncertain coaching attempt coaching-1 requires finishedAt/);
  rejects(uncertain(world, { error: null }), /requires an error/);
  rejects(uncertain(world, { usage: usage() }), /must not carry usage or a response/);
  rejects(uncertain(world, { responseText: 'a hint' }), /must not carry usage or a response/);

  rejects(settled(world, { finishedAt: null }), /requires finishedAt/);
  rejects(settled(world, { finishedAt: '2026-09-11T00:00:00.000Z' }), /finishedAt must not precede requestedAt/);
  rejects(settled(world, { usage: null }), /requires known usage/);
  rejects(settled(world, { error: PROVIDER_FAILURE }), /exactly one of responseText or error/);
  rejects(settled(world, { responseText: null }), /exactly one of responseText or error/);
  rejects(settled(world, { responseText: '   ' }), /responseText must be a non-empty string/);
  rejects(
    settled(world, { responseText: 'x'.repeat(MAX_COACHING_RESPONSE_CHARS + 1) }),
    /responseText must be a non-empty string/,
  );
  assert.equal(
    validateCoachingAttempt(settled(world, { responseText: 'x'.repeat(MAX_COACHING_RESPONSE_CHARS) })).responseText
      ?.length,
    MAX_COACHING_RESPONSE_CHARS,
    'the response bound is inclusive',
  );

  rejects(settled(world, { usage: { ...usage(), calls: -1 } }), /usage.calls must be a safe integer >= 0/);
  rejects(settled(world, { usage: { ...usage(), totalTokens: 1.5 } }), /usage.totalTokens must be a safe integer/);
  rejects(
    settled(world, { usage: { ...usage(), calls: Number.POSITIVE_INFINITY } }),
    /usage.calls must be a safe integer/,
  );
  rejects(
    settled(world, { usage: { ...usage(), totalTokens: Number.MAX_SAFE_INTEGER + 1 } }),
    /usage.totalTokens must be a safe integer/,
  );
  rejects(
    settled(world, { usage: { ...usage(), promptTokens: Number.NaN } }),
    /usage.promptTokens must be a safe integer/,
  );
  rejects(settled(world, { usage: { ...usage(), cachedTokens: 5 } as never }), /usage has unknown keys/);
  rejects(settled(world, { error: { code: 'panic', message: 'x', retryable: true } as never }), /unknown coaching attempt error code/);
  rejects(settled(world, { responseText: null, error: { code: 'timeout', message: 'x' } as never }), /error is missing keys/);
  rejects(
    settled(world, { responseText: null, error: { ...TIMEOUT, detail: 'x' } as never }),
    /error has unknown keys/,
  );
  rejects(settled(world, { responseText: null, error: { ...TIMEOUT, message: ' ' } }), /error message must be a non-empty string/);
  rejects(null, /must be a JSON object/);

  // The validator returns a detached, normalized value: mutating it cannot leak anywhere.
  const original = settled(world);
  const copy = validateCoachingAttempt(original);
  assert.notEqual(copy, original);
  assert.notEqual(copy.usage, original.usage);
  (copy as unknown as { id: string }).id = 'mutated';
  (copy.usage as unknown as { calls: number }).calls = 99;
  assert.equal(original.id, 'coaching-1');
  assert.equal(original.usage?.calls, 1);
});

void test('transition validation fixes identity and host correlations as plain rules', () => {
  const world = makeWorld();
  const reservedBody = reserved(world, { hostSessionId: 'session-1', hostCallId: 'call-1' });
  const pending = uncertain(world, { hostSessionId: 'session-1', hostCallId: 'call-1' });
  const final = settled(world, { hostSessionId: 'session-1', hostCallId: 'call-1' });

  assert.equal(COACHING_ATTEMPT_IDENTITY_FIELDS.includes('expiresAt'), true);
  validateCoachingAttemptTransition(reservedBody, pending);
  validateCoachingAttemptTransition(pending, final);

  const immutable = (previous: CoachingAttempt, next: CoachingAttempt): void => {
    assert.throws(
      () => validateCoachingAttemptTransition(previous, next),
      invalid('immutable_violation'),
    );
  };
  immutable(reservedBody, { ...reservedBody, expiresAt: fx.LEASE_UNTIL });
  immutable(reservedBody, { ...reservedBody, level: 2 });
  immutable(reservedBody, { ...reservedBody, provider: 'another-provider' });
  immutable(reservedBody, {
    ...reservedBody,
    problemKey: world.otherProblem.key,
    snapshotId: world.otherSnapshot.snapshotId,
  });
  immutable(final, { ...final, responseText: 'a rewritten answer' });
  assert.throws(
    () => validateCoachingAttemptTransition(pending, { ...final, hostCallId: 'call-other' }),
    (error) =>
      error instanceof DomainError &&
      error.code === 'immutable_violation' &&
      error.details['reason'] === 'host_correlation',
  );

  const illegal = (previous: CoachingAttempt, next: CoachingAttempt): void => {
    assert.throws(() => validateCoachingAttemptTransition(previous, next), invalid('invalid_transition'));
  };
  const plain = reserved(world, { id: 'coaching-plain' });
  illegal(plain, { ...plain, hostCallId: 'call-late' });
  illegal(pending, { ...pending, error: { ...TIMEOUT, message: 'a different story' } });
  illegal(pending, reservedBody);
});

void test('account scope keeps all accounts, anonymous only and one account apart', async () => {
  await withStore(async (store) => {
    const world = makeWorld();
    // Two anonymous and two named attempts, interleaved in `requestedAt, id` order.
    await store.saveCoachingAttempt(reserved(world, { id: 'anon-a', accountId: null }));
    await store.saveCoachingAttempt(reserved(world, { id: 'named-a', accountId: world.accountId }));
    await record(
      store,
      settled(world, {
        id: 'anon-b',
        accountId: null,
        requestedAt: fx.LATER,
        expiresAt: fx.LEASE_UNTIL,
        finishedAt: fx.LATER,
      }),
    );
    await record(
      store,
      settled(world, {
        id: 'named-a2',
        accountId: world.accountId,
        requestedAt: fx.LATER,
        expiresAt: fx.LEASE_UNTIL,
        finishedAt: fx.LATER,
      }),
    );
    await store.saveCoachingAttempt(
      reserved(world, {
        id: 'named-b',
        accountId: world.otherAccountId,
        requestedAt: fx.LEASE_UNTIL,
        expiresAt: AFTER_LEASE,
      }),
    );

    // Omitted accountId = every account; explicit null = anonymous only; a string = that account.
    assert.deepEqual(await drainAll(store, {}, 2), ['anon-a', 'named-a', 'anon-b', 'named-a2', 'named-b']);
    assert.deepEqual(await drainAll(store, { accountId: null }, 1), ['anon-a', 'anon-b']);
    assert.deepEqual(await drainAll(store, { accountId: world.accountId }, 1), ['named-a', 'named-a2']);
    assert.deepEqual(
      ids(await store.listCoachingAttempts({ accountId: world.otherAccountId, limit: 50, cursor: null })),
      ['named-b'],
    );

    // The quota count stays global; a scoped read never shrinks it.
    assert.equal(await store.countCoachingAttempts({}), 5);

    const anonymousFirst = await store.listCoachingAttempts({ accountId: null, limit: 1, cursor: null });
    assert.deepEqual(ids(anonymousFirst), ['anon-a']);
    assert.notEqual(anonymousFirst.nextCursor, null);
    const namedFirst = await store.listCoachingAttempts({ accountId: world.accountId, limit: 1, cursor: null });
    assert.deepEqual(ids(namedFirst), ['named-a']);
    assert.notEqual(namedFirst.nextCursor, null);
    const unfilteredFirst = await store.listCoachingAttempts({ limit: 1, cursor: null });
    assert.deepEqual(ids(unfilteredFirst), ['anon-a']);
    assert.notEqual(unfilteredFirst.nextCursor, null);

    // A cursor is bound to its scope: every cross-scope continuation is refused.
    const refused: readonly CoachingAttemptQuery[] = [
      { limit: 1, cursor: anonymousFirst.nextCursor },
      { accountId: world.accountId, limit: 1, cursor: anonymousFirst.nextCursor },
      { limit: 1, cursor: namedFirst.nextCursor },
      { accountId: null, limit: 1, cursor: namedFirst.nextCursor },
      { accountId: world.otherAccountId, limit: 1, cursor: namedFirst.nextCursor },
      { accountId: null, limit: 1, cursor: unfilteredFirst.nextCursor },
      { accountId: world.accountId, limit: 1, cursor: unfilteredFirst.nextCursor },
    ];
    for (const query of refused) {
      await assert.rejects(store.listCoachingAttempts(query), invalid('invalid_input', /different filter set/));
    }

    // Continuation inside one scope still works and reaches the end.
    const anonymousSecond = await store.listCoachingAttempts({
      accountId: null,
      limit: 1,
      cursor: anonymousFirst.nextCursor,
    });
    assert.deepEqual(ids(anonymousSecond), ['anon-b']);
    assert.equal(anonymousSecond.nextCursor, null);
    assert.equal(await store.countCoachingAttempts({}), 5);
  });
});

void test('a stored coaching body that is valid JSON but not a valid attempt is corrupt_row', async () => {
  const paths = fx.tempDatabase();
  const world = makeWorld();
  const valid = reserved(world, { id: 'attempt-valid' });
  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  await store.saveCoachingAttempt(reserved(world, { id: 'attempt-tampered' }));
  await store.saveCoachingAttempt(valid);
  await store.close();

  // Raw SQLite edit: the body stays parseable JSON but stops being a coaching attempt.
  const db = new DatabaseSync(paths.path);
  try {
    const row = db.prepare('SELECT body FROM coaching_attempts WHERE id = ?').get('attempt-tampered') as
      | Record<string, unknown>
      | undefined;
    assert.ok(row !== undefined, 'the tampered row must exist');
    const tampered = JSON.parse(String(row['body'])) as Record<string, unknown>;
    tampered['level'] = 4;
    db.prepare('UPDATE coaching_attempts SET body = ? WHERE id = ?').run(JSON.stringify(tampered), 'attempt-tampered');
  } finally {
    db.close();
  }

  const reopened = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    const corrupt = (error: unknown): boolean => error instanceof StorageError && error.code === 'corrupt_row';
    await assert.rejects(reopened.getCoachingAttempt('attempt-tampered'), corrupt);
    await assert.rejects(reopened.listCoachingAttempts({ limit: 10, cursor: null }), corrupt);
    // Validation is per row: the untouched attempt is still readable.
    assert.deepEqual(await reopened.getCoachingAttempt('attempt-valid'), valid);
  } finally {
    await reopened.close();
    fx.removeDirectory(paths.dir);
  }
});

void test('the status-filtered quota count resolves through the coaching status index', async () => {
  const paths = fx.tempDatabase();
  const world = makeWorld();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    await store.saveCoachingAttempt(reserved(world, { id: 'attempt-1' }));
    await store.saveCoachingAttempt(reserved(world, { id: 'attempt-2', accountId: world.otherAccountId }));
    assert.equal(await store.countCoachingAttempts({ status: 'reserved' }), 2);
  } finally {
    await store.close();
  }
  const db = new DatabaseSync(paths.path);
  try {
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM coaching_attempts WHERE status = ?')
      .all('reserved') as readonly Record<string, unknown>[];
    const detail = plan.map((row) => String(row['detail'])).join(' | ');
    assert.match(detail, /coaching_attempts_by_status/, `count plan must use the status index, got: ${detail}`);
  } finally {
    db.close();
    fx.removeDirectory(paths.dir);
  }
});
