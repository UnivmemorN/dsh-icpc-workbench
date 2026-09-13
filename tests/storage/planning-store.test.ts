/**
 * SQLite v4 planning persistence (Sprint 11c).
 *
 * The cases drive a real database file: a genuine schema-v3 fixture built with the frozen v3 DDL is
 * copied and migrated to v4, its rows are proved unchanged, and the new `plan_attempts` table is
 * exercised through the application port — insert as `prepared`, forward-only transitions, an
 * immutable lease and terminal rows, the quota count that ignores a free preparation, cursor paging
 * bound to its filter set, and the refusal of a corrupt stored body.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import {
  SCHEMA_VERSION_V3,
  STORE_SCHEMA_VERSION,
  detectSchemaState,
  initializeSchemaV2,
  initializeSchemaV3,
  readUserVersion,
} from '../../src/adapters/sqlite/schema.js';
import {
  planPreparationEvidenceHash,
  validatePlanAttempt,
  type PlanAttempt,
  type PlanAttemptCandidate,
  type PlanAttemptPreparation,
} from '../../src/application/planning-types.js';
import {
  aggregateAbilityForPlanning,
  computeAbilityAssessment,
  createModelUsage,
} from '../../src/domain/index.js';
import * as fx from './fixtures.js';

const AT = '2026-11-01T08:00:00.000Z';
const LATER = '2026-11-01T09:00:00.000Z';
const ACCOUNT_ID = 'codeforces:codeforces.com|alice';
const SOURCE_ID = 'codeforces:codeforces.com';

/** Match one typed domain/storage failure by its stable code, whatever error class carries it. */
function hasCode(code: string): (error: unknown) => boolean {
  return (error) => typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

/** One valid preparation, built from the real 11a aggregate over empty evidence. */
function makePreparation(
  accountId: string = ACCOUNT_ID,
  requestedCandidateKeys: readonly string[] | null = null,
): PlanAttemptPreparation {
  const ability = aggregateAbilityForPlanning(
    computeAbilityAssessment({
      accountId,
      sourceInstanceId: SOURCE_ID,
      platform: 'codeforces',
      problems: [],
      submissions: [],
      retrospectives: [],
      now: AT,
    }),
  );
  const candidate: PlanAttemptCandidate = {
    candidateId: 'candidate-1',
    problemKey: `${SOURCE_ID}|1A`,
    externalKey: '1A',
    title: 'Theatre Square',
    url: 'https://codeforces.com/problemset/problem/1/A',
    estimatedMinutes: 30,
    effectiveTaxonomyIds: ['data-structure.stack'],
    provisionalRawTags: ['math'],
    ratings: [{ dimension: 'rating', value: 1000, scale: { min: 800, max: 3500 }, raw: '1000' }],
    origin: 'unsolved_pool',
  };
  const base = {
    preparedAt: AT,
    accountId,
    sourceInstanceId: SOURCE_ID,
    requestedCandidateKeys,
    settings: { horizonDays: 7, minutesPerDay: 60, maxTasksPerDay: 3, estimatedMinutes: 30 },
    candidates: [candidate],
    exclusions: { nativeSolvedExcluded: 1, duplicateExcluded: 0, foreignExcluded: 0, candidateLimit: 100, considered: 1 },
    weakness: { attemptedDistinctTotal: 1, sufficientTagIds: [], ranking: [] },
    ability,
  };
  return { ...base, evidenceHash: planPreparationEvidenceHash(base) };
}

function makeAttempt(preparation: PlanAttemptPreparation = makePreparation()): PlanAttempt {
  return {
    id: 'attempt-1',
    accountId: ACCOUNT_ID,
    sourceInstanceId: SOURCE_ID,
    status: 'prepared',
    requestedAt: AT,
    expiresAt: LATER,
    finishedAt: null,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    promptVersion: 'planning-v1',
    settingsRevision: null,
    inputHash: 'a'.repeat(64),
    preparation,
    hostSessionId: null,
    hostCallId: null,
    usage: null,
    planId: null,
    planHash: null,
    error: null,
  };
}

/** One genuine schema-v3 file with one stored row, built through the frozen v3 helpers. */
function makeV3Fixture(path: string): void {
  const db = new DatabaseSync(path);
  initializeSchemaV3(db);
  db.prepare(
    `INSERT INTO plans (plan_id, account_id, status, created_at, adopted_at, body) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('plan-legacy', ACCOUNT_ID, 'draft', AT, null, JSON.stringify({ planId: 'plan-legacy', marker: 'kept' }));
  db.close();
}

test('a schema-v3 database is backed up and migrated to v4 with its rows unchanged', async () => {
  const paths = fx.tempDatabase();
  try {
    makeV3Fixture(paths.path);
    const before = new DatabaseSync(paths.path);
    assert.equal(readUserVersion(before), SCHEMA_VERSION_V3);
    assert.equal(detectSchemaState(before), 'v3');
    before.close();

    const store = new SqliteTrainingStore({ path: paths.path, now: () => AT });
    try {
      // The store refuses to open a database of its own version without the new table, and this one
      // was just migrated.
      const legacy = await store.getPlan('plan-legacy');
      assert.ok(legacy !== null);
      assert.equal((legacy as unknown as { marker: string }).marker, 'kept');
      await store.savePlanAttempt(makeAttempt());
      assert.equal((await store.getPlanAttempt('attempt-1'))?.status, 'prepared');
    } finally {
      await store.close();
    }

    const after = new DatabaseSync(paths.path);
    try {
      assert.equal(readUserVersion(after), STORE_SCHEMA_VERSION);
      assert.equal(detectSchemaState(after), 'current');
      const tables = after
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
        .all() as readonly Record<string, unknown>[];
      assert.ok(tables.some((row) => row['name'] === 'plan_attempts'));
      const row = after.prepare('SELECT body FROM plans WHERE plan_id = ?').get('plan-legacy') as
        | Record<string, unknown>
        | undefined;
      assert.equal((JSON.parse(String(row?.['body'])) as { marker: string }).marker, 'kept');
    } finally {
      after.close();
    }

    const backups = readdirSync(paths.dir).filter((name) => name.includes('.backup-v3-'));
    assert.equal(backups.length, 1, 'exactly one pre-migration backup of the v3 file is taken');
    assert.ok(existsSync(`${paths.dir}/${backups[0]}`));
    const backup = new DatabaseSync(`${paths.dir}/${backups[0]}`);
    try {
      assert.equal(readUserVersion(backup), SCHEMA_VERSION_V3, 'the backup is the database as found');
    } finally {
      backup.close();
    }
  } finally {
    fx.removeDirectory(paths.dir);
  }
});

test('a schema-v2 database migrates straight to v4 through the frozen v2 and v3 helpers', async () => {
  const paths = fx.tempDatabase();
  try {
    const db = new DatabaseSync(paths.path);
    initializeSchemaV2(db);
    assert.equal(readUserVersion(db), 2);
    db.close();
    const store = new SqliteTrainingStore({ path: paths.path, now: () => AT });
    try {
      await store.savePlanAttempt(makeAttempt());
      assert.equal(await store.countPlanAttempts({}), 1);
    } finally {
      await store.close();
    }
    assert.equal(readdirSync(paths.dir).filter((name) => name.includes('.backup-v2-')).length, 1);
  } finally {
    fx.removeDirectory(paths.dir);
  }
});

test('planning attempts move forward only, keep their lease and never rewrite a terminal row', async () => {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => AT });
  try {
    await store.savePlanAttempt(makeAttempt());
    // A row cannot be inserted already reserved: the free preparation must exist first.
    await assert.rejects(
      () => store.savePlanAttempt({ ...makeAttempt(), id: 'attempt-2', status: 'reserved' }),
      hasCode('invalid_transition'),
    );
    // The preparation identity is immutable: a different input hash is refused.
    await assert.rejects(
      () => store.savePlanAttempt({ ...makeAttempt(), preparation: makePreparation(), inputHash: 'b'.repeat(64) }),
      hasCode('immutable_violation'),
    );

    await store.savePlanAttempt({ ...makeAttempt(), status: 'reserved', expiresAt: '2026-11-01T10:00:00.000Z' });
    // Once reserved the lease is fixed.
    await assert.rejects(
      () => store.savePlanAttempt({ ...makeAttempt(), status: 'settled', finishedAt: LATER, usage: createModelUsage(), error: null, planId: 'p', planHash: 'c'.repeat(64), expiresAt: '2026-11-01T11:00:00.000Z' }),
      hasCode('immutable_violation'),
    );
    await store.savePlanAttempt({
      ...makeAttempt(),
      status: 'settled',
      expiresAt: '2026-11-01T10:00:00.000Z',
      finishedAt: LATER,
      usage: createModelUsage({ calls: 1, promptTokens: 10, completionTokens: 5 }),
      planId: 'plan-1',
      planHash: 'c'.repeat(64),
      error: null,
    });
    const settled = await store.getPlanAttempt('attempt-1');
    assert.equal(settled?.status, 'settled');
    assert.equal(settled?.planId, 'plan-1');
    // An identical re-save is a no-op; a shape-valid but different terminal body is refused.
    await store.savePlanAttempt(settled as PlanAttempt);
    await assert.rejects(
      () =>
        store.savePlanAttempt({
          ...(settled as PlanAttempt),
          status: 'uncertain',
          usage: null,
          planId: null,
          planHash: null,
          error: { code: 'timeout', message: 'the reservation expired', retryable: false },
        }),
      hasCode('immutable_violation'),
    );
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
});

test('the quota count ignores a free preparation, and pages are bound to their filter set', async () => {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => AT });
  try {
    await store.savePlanAttempt(makeAttempt());
    assert.equal(await store.countPlanAttempts({}), 1);
    assert.equal(await store.countPlanAttempts({ statuses: ['reserved', 'settled', 'uncertain'] }), 0);
    assert.equal(await store.countPlanAttempts({ since: LATER }), 0, 'since is an inclusive lower bound');
    await store.savePlanAttempt({ ...makeAttempt(), status: 'reserved', expiresAt: '2026-11-01T10:00:00.000Z' });
    assert.equal(await store.countPlanAttempts({ statuses: ['reserved'] }), 1);

    await store.savePlanAttempt({ ...makeAttempt(), id: 'attempt-2' });
    await store.savePlanAttempt({
      ...makeAttempt(makePreparation('other|bob')),
      id: 'attempt-3',
      accountId: 'other|bob',
    });
    const first = await store.listPlanAttempts({ limit: 1, cursor: null });
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0]?.id, 'attempt-1');
    assert.ok(first.nextCursor !== null);
    const second = await store.listPlanAttempts({ limit: 1, cursor: first.nextCursor });
    assert.equal(second.items[0]?.id, 'attempt-2');
    await assert.rejects(
      () =>
        store.listPlanAttempts({
          accountId: ACCOUNT_ID,
          limit: 1,
          cursor: first.nextCursor,
        }),
      hasCode('invalid_input'),
    );
    const scoped = await store.listPlanAttempts({ accountId: 'other|bob', limit: 10, cursor: null });
    assert.deepEqual(
      scoped.items.map((item) => item.id),
      ['attempt-3'],
    );
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
});

test('a descending page is newest-first and its cursor is bound to the ordering', async () => {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => AT });
  const lease = '2026-11-01T10:00:00.000Z';
  try {
    await store.savePlanAttempt(makeAttempt());
    await store.savePlanAttempt({ ...makeAttempt(), id: 'attempt-2', requestedAt: LATER, expiresAt: lease });
    await store.savePlanAttempt({
      ...makeAttempt(makePreparation('other|bob')),
      id: 'attempt-3',
      accountId: 'other|bob',
      requestedAt: LATER,
      expiresAt: lease,
    });

    const newest = await store.listPlanAttempts({ order: 'desc', limit: 1, cursor: null });
    assert.deepEqual(newest.items.map((item) => item.id), ['attempt-3'], 'the newest attempt is first');
    assert.ok(newest.nextCursor !== null);
    const next = await store.listPlanAttempts({ order: 'desc', limit: 1, cursor: newest.nextCursor });
    assert.deepEqual(next.items.map((item) => item.id), ['attempt-2']);
    const last = await store.listPlanAttempts({ order: 'desc', limit: 1, cursor: next.nextCursor });
    assert.deepEqual(last.items.map((item) => item.id), ['attempt-1']);
    assert.equal(last.nextCursor, null);

    // The historical ascending default is untouched, and the two orders cannot share a cursor.
    const ascending = await store.listPlanAttempts({ limit: 1, cursor: null });
    assert.deepEqual(ascending.items.map((item) => item.id), ['attempt-1']);
    await assert.rejects(() => store.listPlanAttempts({ limit: 1, cursor: newest.nextCursor }), hasCode('invalid_input'));
    await assert.rejects(
      () => store.listPlanAttempts({ order: 'desc', limit: 1, cursor: ascending.nextCursor }),
      hasCode('invalid_input'),
    );
    await assert.rejects(
      () => store.listPlanAttempts({ limit: 1, cursor: null, order: 'newest' as 'desc' }),
      hasCode('invalid_input'),
    );
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
});

test('the settlement truth table admits exactly one of a stored plan or an error, with known usage', () => {
  const reserved = { ...makeAttempt(), status: 'reserved' as const, expiresAt: '2026-11-01T10:00:00.000Z' };
  const usage = createModelUsage({ calls: 1, promptTokens: 10, completionTokens: 5 });
  const failure = { code: 'provider_error' as const, message: 'the provider failed after the call', retryable: true };
  const settled = (patch: Partial<PlanAttempt>): PlanAttempt => ({
    ...reserved,
    status: 'settled',
    finishedAt: LATER,
    usage,
    planId: null,
    planHash: null,
    error: null,
    ...patch,
  });

  // Legitimate successes: a stored plan with its pair, or an error-only settlement. Both keep usage.
  const planned = validatePlanAttempt(settled({ planId: 'plan-1', planHash: 'c'.repeat(64) }));
  assert.equal(planned.planId, 'plan-1');
  assert.equal(planned.error, null);
  const failed = validatePlanAttempt(settled({ error: failure }));
  assert.equal(failed.planId, null);
  assert.equal(failed.error?.code, 'provider_error');
  assert.deepEqual(failed.usage, usage);

  const refused: readonly (readonly [string, unknown])[] = [
    ['plan and error together', settled({ planId: 'plan-1', planHash: 'c'.repeat(64), error: failure })],
    ['neither plan nor error', settled({})],
    ['planId without planHash', settled({ planId: 'plan-1' })],
    ['planHash without planId', settled({ planHash: 'c'.repeat(64) })],
    ['settled without usage', settled({ planId: 'plan-1', planHash: 'c'.repeat(64), usage: null })],
    ['uncertain with usage', { ...reserved, status: 'uncertain', finishedAt: LATER, usage, error: failure }],
    ['uncertain without an error', { ...reserved, status: 'uncertain', finishedAt: LATER }],
    ['cancelled with usage', { ...reserved, status: 'cancelled', finishedAt: LATER, usage, error: failure }],
    [
      'prepared carrying a result',
      { ...makeAttempt(), finishedAt: LATER, usage, planId: 'plan-1', planHash: 'c'.repeat(64) },
    ],
  ];
  for (const [label, value] of refused) {
    assert.throws(() => validatePlanAttempt(value), hasCode('invalid_input'), label);
  }
});

test('paid usage survives a reopen and a duplicate save cannot mutate a terminal row', async () => {
  const paths = fx.tempDatabase();
  const lease = '2026-11-01T10:00:00.000Z';
  const usage = createModelUsage({ calls: 1, promptTokens: 11, completionTokens: 7, totalTokens: 18 });
  const settle = (id: string, plan: boolean): PlanAttempt => ({
    ...makeAttempt(),
    id,
    status: 'settled',
    expiresAt: lease,
    finishedAt: LATER,
    usage,
    planId: plan ? 'plan-1' : null,
    planHash: plan ? 'c'.repeat(64) : null,
    error: plan ? null : { code: 'provider_error', message: 'the provider failed after the call', retryable: true },
  });
  try {
    const created = new SqliteTrainingStore({ path: paths.path, now: () => AT });
    await created.savePlanAttempt(makeAttempt());
    await created.savePlanAttempt({ ...makeAttempt(), status: 'reserved', expiresAt: lease });
    await created.savePlanAttempt(settle('attempt-1', true));
    await created.savePlanAttempt({ ...makeAttempt(), id: 'attempt-2' });
    await created.savePlanAttempt({ ...makeAttempt(), id: 'attempt-2', status: 'reserved', expiresAt: lease });
    await created.savePlanAttempt(settle('attempt-2', false));
    await created.close();

    const reopened = new SqliteTrainingStore({ path: paths.path, now: () => LATER });
    try {
      const success = await reopened.getPlanAttempt('attempt-1');
      assert.equal(success?.status, 'settled');
      assert.equal(success?.planId, 'plan-1');
      assert.deepEqual(success?.usage, usage, 'the successful paid usage survives the restart');
      const failure = await reopened.getPlanAttempt('attempt-2');
      assert.equal(failure?.error?.code, 'provider_error');
      assert.deepEqual(failure?.usage, usage, 'the failed paid usage survives the restart');
      assert.equal(failure?.planId, null);

      // An identical duplicate is the caller's idempotent no-op; any different terminal body is refused.
      await reopened.savePlanAttempt(success as PlanAttempt);
      await assert.rejects(
        () => reopened.savePlanAttempt({ ...(success as PlanAttempt), usage: createModelUsage({ calls: 2 }) }),
        hasCode('immutable_violation'),
      );
      await reopened.savePlanAttempt(failure as PlanAttempt);
      await assert.rejects(
        () =>
          reopened.savePlanAttempt({
            ...(failure as PlanAttempt),
            error: null,
            planId: 'plan-other',
            planHash: 'd'.repeat(64),
          }),
        hasCode('immutable_violation'),
      );
    } finally {
      await reopened.close();
    }
  } finally {
    fx.removeDirectory(paths.dir);
  }
});

test('a hand-edited stored body is refused as corrupt instead of being cast to an attempt', async () => {
  const paths = fx.tempDatabase();
  try {
    const created = new SqliteTrainingStore({ path: paths.path, now: () => AT });
    await created.close();
    const db = new DatabaseSync(paths.path);
    db.prepare(
      `INSERT INTO plan_attempts (id, account_id, source_instance_id, status, requested_at, expires_at, finished_at, plan_id, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('broken', ACCOUNT_ID, SOURCE_ID, 'prepared', AT, LATER, null, null, '{"not":"an attempt"}');
    db.close();
    const store = new SqliteTrainingStore({ path: paths.path, now: () => AT });
    try {
      await assert.rejects(() => store.getPlanAttempt('broken'), hasCode('corrupt_row'));
    } finally {
      await store.close();
    }
  } finally {
    fx.removeDirectory(paths.dir);
  }
});

void test('new history survives persisted plan validation while legacy preparations remain unchanged', () => {
  const current = makeAttempt();
  assert.deepEqual(validatePlanAttempt(current), current);
  const legacy = structuredClone(current);
  delete (legacy.preparation.ability as { history?: unknown }).history;
  delete (legacy.preparation.ability as { trainingReference?: unknown }).trainingReference;
  (legacy.preparation.ability as { version: string }).version = 'ability.1';
  Object.assign(legacy.preparation, { evidenceHash: planPreparationEvidenceHash(legacy.preparation) });
  const restored = validatePlanAttempt(legacy);
  assert.deepEqual(restored, legacy);
  assert.equal(Object.hasOwn(restored.preparation.ability, 'history'), false, 'never rewrite an old immutable preparation');
  const leaked = structuredClone(current);
  Object.assign(leaked.preparation.ability.history!.periods[0]!, { accountId: 'private-account' });
  assert.throws(() => validatePlanAttempt(leaked), hasCode('invalid_input'), 'nested identifiers cannot reach the model');
  const corrupt = structuredClone(current);
  Object.assign(corrupt.preparation.ability.history!.periods[0]!, { eligibleDistinct: 100 });
  assert.throws(() => validatePlanAttempt(corrupt), hasCode('invalid_input'), 'inconsistent history counters are refused');
});
