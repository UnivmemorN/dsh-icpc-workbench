/**
 * SQLite v8 ability-assessment persistence (Sprint 18d1).
 *
 * The cases drive a real database file through the {@link AssessmentStore} port: insert as a free
 * `prepared` row, revision-CAS saves, forward-only transitions, immutable identity and outcomes, the
 * shape every status must have, account-scoped pages bound to a filter fingerprint, the global
 * charged-count quota and the refusal of a corrupt stored body. The remaining fixture tables come
 * from the shared storage fixtures, so nothing here is hand-rolled.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import {
  ASSESSMENT_ATTEMPT_CHARGED_STATUSES,
  ASSESSMENT_QUOTA_WINDOW_MS,
  validateAssessmentAttempt,
  type AssessmentAttempt,
} from '../../src/application/assessment-types.js';
import { createModelUsage } from '../../src/domain/index.js';
import { ACCOUNT_ID, LATER, USAGE, ZERO_USAGE, makeAttempt, makeCapture, makeReport, makeReportRecord } from '../assessment-fixtures.js';
import * as fx from './fixtures.js';

const OTHER_ACCOUNT_ID = 'codeforces:codeforces.com|bob';

/** Match one typed domain/storage failure by its stable code, whatever error class carries it. */
function hasCode(code: string): (error: unknown) => boolean {
  return (error) => typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

/** One reserved attempt over the same preparation: the single charged in-flight state. */
function reserved(attempt: AssessmentAttempt, at = LATER): AssessmentAttempt {
  return { ...attempt, status: 'reserved', revision: attempt.revision + 1, requestedAt: at, expiresAt: '2026-11-01T10:00:00.000Z' };
}

async function withStore(run: (store: SqliteTrainingStore, path: string) => Promise<void>): Promise<void> {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => LATER });
  try {
    await run(store, paths.path);
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
}

test('a prepared attempt is stored free, read back with its body re-validated, and counts nothing charged', async () => {
  await withStore(async (store) => {
    const capture = makeCapture({ officialRating: null });
    const attempt = makeAttempt(capture);
    await store.saveAssessmentAttempt(attempt);

    assert.deepEqual(await store.getAssessmentAttempt('attempt-1'), attempt);
    assert.deepEqual(await store.getAssessmentAttempt('missing'), null);
    assert.equal(await store.countAssessmentAttempts({ s: undefined } as never), 1);
    assert.equal(await store.countAssessmentAttempts({}), 1);
    assert.equal(await store.countAssessmentAttempts({ statuses: ['prepared'] }), 1);
    assert.equal(
      await store.countAssessmentAttempts({ statuses: ASSESSMENT_ATTEMPT_CHARGED_STATUSES }),
      0,
      'a free preparation is never counted as a used call',
    );
    // An identical re-save is the caller's idempotent no-op.
    await store.saveAssessmentAttempt(attempt);
    assert.deepEqual(await store.getAssessmentAttempt('attempt-1'), attempt);

    // A new row may never be inserted as anything but a free preparation.
    await assert.rejects(
      store.saveAssessmentAttempt({ ...attempt, id: 'attempt-2', status: 'reserved', revision: 1 }),
      hasCode('invalid_transition'),
    );
    await assert.rejects(
      store.saveAssessmentAttempt({ ...attempt, id: 'attempt-3', revision: 2 }),
      hasCode('invalid_input'),
    );
  });
});

test('the reservation rewrites the lease once, charges the row and refuses a stale revision or a changed identity', async () => {
  await withStore(async (store) => {
    const attempt = makeAttempt(makeCapture({ officialRating: null }));
    await store.saveAssessmentAttempt(attempt);
    const charged = reserved(attempt);
    await store.saveAssessmentAttempt(charged);

    const stored = await store.getAssessmentAttempt('attempt-1');
    assert.equal(stored?.status, 'reserved');
    assert.equal(stored?.requestedAt, LATER);
    assert.equal(await store.countAssessmentAttempts({ statuses: ASSESSMENT_ATTEMPT_CHARGED_STATUSES }), 1);
    assert.equal(
      await store.countAssessmentAttempts({ since: '2026-11-01T08:30:00.000Z', statuses: ASSESSMENT_ATTEMPT_CHARGED_STATUSES }),
      1,
    );
    assert.equal(
      await store.countAssessmentAttempts({ since: '2026-11-01T09:30:00.000Z', statuses: ASSESSMENT_ATTEMPT_CHARGED_STATUSES }),
      0,
    );

    // A stale writer that still holds an older revision cannot overwrite the reservation: an
    // identical body is the caller's documented no-op, while a different body at the stored revision
    // is a stale-revision conflict and a lease move inside a valid settlement is an immutable lease.
    await assert.rejects(
      store.saveAssessmentAttempt({ ...charged, expiresAt: '2026-11-01T10:30:00.000Z' }),
      hasCode('invalid_transition'),
    );
    await assert.rejects(
      store.saveAssessmentAttempt({ ...charged, revision: 4, status: 'uncertain', finishedAt: LATER, error: { code: 'timeout', message: 'deadline', retryable: true } }),
      hasCode('invalid_transition'),
    );
    await assert.rejects(
      store.saveAssessmentAttempt({
        ...charged,
        revision: 3,
        status: 'settled',
        finishedAt: LATER,
        usage: USAGE,
        error: { code: 'timeout', message: 'lease moved', retryable: true },
        requestedAt: attempt.requestedAt,
        expiresAt: attempt.expiresAt,
      }),
      hasCode('immutable_violation'),
    );
    await assert.rejects(
      store.saveAssessmentAttempt({ ...charged, model: 'another-model' }),
      hasCode('immutable_violation'),
    );
    // A structurally identical re-preparation is the documented no-op; a preparation that really
    // differs (another capture instant) is frozen identity and cannot replace the stored one.
    await assert.rejects(
      store.saveAssessmentAttempt({
        ...charged,
        revision: 3,
        preparation: { preparedAt: LATER, capture: makeCapture({ officialRating: null, at: LATER }) },
      }),
      hasCode('immutable_violation'),
    );
  });
});

test('settled and cancelled rows keep known usage, preserve outcomes and are immutable afterwards', async () => {
  await withStore(async (store) => {
    const capture = makeCapture({ officialRating: null });
    const attempt = makeAttempt(capture);
    await store.saveAssessmentAttempt(attempt);
    const charged = reserved(attempt);
    await store.saveAssessmentAttempt(charged);

    const settled: AssessmentAttempt = {
      ...charged,
      revision: 3,
      status: 'settled',
      finishedAt: LATER,
      usage: USAGE,
      hostSessionId: 'icpc-audit-1',
      hostCallId: 'call-1',
      report: makeReportRecord(capture, makeReport({ estimatedRange: null, priority: 'diagnostic' })),
    };
    await store.saveAssessmentAttempt(settled);
    const stored = await store.getAssessmentAttempt('attempt-1');
    assert.deepEqual(stored?.usage, USAGE);
    assert.equal(stored?.report?.source, 'ai_inferred');
    assert.equal(stored?.hostCallId, 'call-1');

    // Terminal rows are immutable, known usage/correlation may not be cleared, and the report keeps
    // the capture it was validated against.
    await assert.rejects(
      store.saveAssessmentAttempt({ ...settled, revision: 4, status: 'uncertain', usage: null, report: null, error: { code: 'cancelled', message: 'x', retryable: false } }),
      hasCode('immutable_violation'),
    );
    // Clearing a known usage cannot even be expressed as a valid settled row, so the refusal is the
    // shape error; the case above is what refuses a *valid* replacement of a known outcome.
    await assert.rejects(
      store.saveAssessmentAttempt({ ...settled, revision: 4, usage: null }),
      hasCode('invalid_input'),
    );
    await assert.rejects(
      store.saveAssessmentAttempt({ ...settled, revision: 4, hostSessionId: null }),
      hasCode('immutable_violation'),
    );
    await assert.rejects(
      store.saveAssessmentAttempt({
        ...settled,
        revision: 4,
        report: { ...settled.report!, evidenceHash: 'b'.repeat(64) },
      }),
      hasCode('invalid_input'),
    );

    // A cancellation observed after the reservation settles through the dispatch path and keeps the
    // usage the provider already reported; a `cancelled` row is reachable only from `prepared`.
    const second = makeAttempt(capture, { id: 'attempt-cancel', preparation: { preparedAt: LATER, capture } });
    await store.saveAssessmentAttempt(second);
    const chargedSecond = { ...second, status: 'reserved' as const, revision: 2, requestedAt: LATER, expiresAt: '2026-11-01T10:00:00.000Z' };
    await store.saveAssessmentAttempt(chargedSecond);
    await store.saveAssessmentAttempt({
      ...chargedSecond,
      revision: 3,
      status: 'settled',
      finishedAt: LATER,
      usage: USAGE,
      error: { code: 'cancelled', message: 'the call was cancelled while streaming', retryable: false },
    });
    assert.equal((await store.getAssessmentAttempt('attempt-cancel'))?.status, 'settled');

    // A preparation cancelled before dispatch is known to be zero — a charged claim is refused.
    const third = makeAttempt(capture, { id: 'attempt-free-cancel', preparation: { preparedAt: LATER, capture } });
    await store.saveAssessmentAttempt(third);
    await assert.rejects(
      store.saveAssessmentAttempt({
        ...third,
        revision: 2,
        status: 'cancelled',
        finishedAt: LATER,
        usage: USAGE,
        error: { code: 'cancelled', message: 'cancelled', retryable: false },
      }),
      hasCode('invalid_input'),
    );
    await store.saveAssessmentAttempt({
      ...third,
      revision: 2,
      status: 'cancelled',
      finishedAt: LATER,
      usage: createModelUsage({ calls: 0 }),
      error: { code: 'cancelled', message: 'cancelled before dispatch', retryable: false },
    });
    assert.equal(await store.countAssessmentAttempts({ statuses: ASSESSMENT_ATTEMPT_CHARGED_STATUSES }), 2);
  });
});

test('every status shape is enforced before a row can be written', async () => {
  await withStore(async (store) => {
    const capture = makeCapture({ officialRating: null });
    const attempt = makeAttempt(capture);
    await store.saveAssessmentAttempt(attempt);
    const charged = reserved(attempt);

    // reserved/carried results, uncertain with usage, settled without usage or with both outcomes.
    assert.throws(() => validateAssessmentAttempt({ ...charged, usage: ZERO_USAGE }), hasCode('invalid_input'));
    assert.throws(
      () => validateAssessmentAttempt({ ...charged, revision: 3, status: 'uncertain', finishedAt: LATER, usage: ZERO_USAGE, error: { code: 'timeout', message: 'x', retryable: true } }),
      hasCode('invalid_input'),
    );
    assert.throws(
      () => validateAssessmentAttempt({ ...charged, revision: 3, status: 'settled', finishedAt: LATER, usage: null, error: { code: 'timeout', message: 'x', retryable: true } }),
      hasCode('invalid_input'),
    );
    assert.throws(
      () => validateAssessmentAttempt({ ...charged, revision: 3, status: 'settled', finishedAt: LATER, usage: ZERO_USAGE }),
      hasCode('invalid_input'),
    );
    assert.throws(
      () => validateAssessmentAttempt({ ...charged, revision: 3, status: 'settled', finishedAt: '2026-10-01T00:00:00.000Z', usage: ZERO_USAGE }),
      hasCode('invalid_input'),
    );
    assert.throws(
      () => validateAssessmentAttempt({ ...attempt, expiresAt: attempt.requestedAt }),
      hasCode('invalid_input'),
    );
  });
});

test('pages are account-scoped and bound to the filter set that produced the cursor', async () => {
  await withStore(async (store) => {
    const mine = makeCapture({ officialRating: null });
    const theirs = makeCapture({ accountId: OTHER_ACCOUNT_ID });
    await store.saveAssessmentAttempt(makeAttempt(mine, { id: 'a1', requestedAt: '2026-11-01T08:00:00.000Z', expiresAt: LATER }));
    await store.saveAssessmentAttempt(
      makeAttempt(mine, { id: 'a2', preparation: { preparedAt: LATER, capture: mine }, requestedAt: '2026-11-01T08:30:00.000Z', expiresAt: '2026-11-01T10:00:00.000Z' }),
    );
    await store.saveAssessmentAttempt(
      makeAttempt(theirs, {
        id: 'b1',
        preparation: { preparedAt: LATER, capture: theirs },
        requestedAt: '2026-11-01T09:00:00.000Z',
        expiresAt: '2026-11-01T10:00:00.000Z',
      }),
    );

    const first = await store.listAssessmentAttempts({ accountId: ACCOUNT_ID, limit: 1, cursor: null });
    assert.deepEqual(first.items.map((item) => item.id), ['a1']);
    assert.notEqual(first.nextCursor, null);

    const second = await store.listAssessmentAttempts({ accountId: ACCOUNT_ID, limit: 1, cursor: first.nextCursor });
    assert.deepEqual(second.items.map((item) => item.id), ['a2']);
    assert.equal(second.nextCursor, null, 'the other account is never on this page');

    // The cursor is opaque and bound to its filter set: another account or order is a typed refusal.
    await assert.rejects(
      store.listAssessmentAttempts({ accountId: OTHER_ACCOUNT_ID, limit: 1, cursor: first.nextCursor }),
      hasCode('invalid_input'),
    );
    await assert.rejects(
      store.listAssessmentAttempts({ accountId: ACCOUNT_ID, status: 'prepared', limit: 1, cursor: first.nextCursor }),
      hasCode('invalid_input'),
    );
    await assert.rejects(store.listAssessmentAttempts({ limit: 1, cursor: 'not-a-cursor' }), hasCode('invalid_input'));

    const descending = await store.listAssessmentAttempts({ accountId: ACCOUNT_ID, order: 'desc', limit: 10, cursor: null });
    assert.deepEqual(descending.items.map((item) => item.id), ['a2', 'a1']);
    const all = await store.listAssessmentAttempts({ limit: 10, cursor: null });
    assert.deepEqual(all.items.map((item) => item.id), ['a1', 'a2', 'b1']);
    assert.equal(await store.countAssessmentAttempts({ since: new Date(Date.parse(LATER) - ASSESSMENT_QUOTA_WINDOW_MS).toISOString() }), 3);
    await assert.rejects(
      store.countAssessmentAttempts({ statuses: [] }),
      hasCode('invalid_input'),
      'an empty status list is refused rather than counted as a filter',
    );
  });
});

test('a corrupt or identity-swapped stored body is reported as corrupt_row', async () => {
  await withStore(async (store, path) => {
    const attempt = makeAttempt(makeCapture({ officialRating: null }));
    await store.saveAssessmentAttempt(attempt);

    const external = new DatabaseSync(path);
    external.prepare(`UPDATE ability_evaluation_attempts SET body = ? WHERE id = ?`).run('{"broken":true}', 'attempt-1');
    external.close();
    await assert.rejects(store.getAssessmentAttempt('attempt-1'), hasCode('corrupt_row'));

    const swapped = new DatabaseSync(path);
    swapped
      .prepare(`UPDATE ability_evaluation_attempts SET body = ?, account_id = ? WHERE id = ?`)
      .run(JSON.stringify(attempt), OTHER_ACCOUNT_ID, 'attempt-1');
    swapped.close();
    await assert.rejects(store.getAssessmentAttempt('attempt-1'), hasCode('invalid_input'));
    await assert.rejects(store.listAssessmentAttempts({ limit: 10, cursor: null }), hasCode('invalid_input'));
  });
});
