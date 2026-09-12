/**
 * Durable batches and model-call attempts through the public store surface.
 *
 * These cases state the accounting consequences the pipeline will depend on: a stale writer
 * cannot overwrite newer batch state, counters never move backwards, a reservation made in a
 * caller transaction is rolled back with the counters it bumped, an uncertain call stays on
 * the books until late usage settles it, and a settled audit row can never be rewritten. The
 * records are the contract's plain data; only declared top-level fields are persisted.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import {
  budgetKindOfRole,
  createAnalysisBatch,
  validateAnalysisBatch,
  validateAnalysisBatchTransition,
  validateModelCallAttempt,
  type AnalysisBatch,
  type ModelCallAttempt,
} from '../../src/application/batch-types.js';
import {
  DomainError,
  createAiTagSuggestion,
  createModelUsage,
  transitionJob,
  type AnalysisJobLimits,
  type AnalysisJobState,
  type NormalizedProblem,
  type ProblemSnapshot,
} from '../../src/domain/index.js';
import * as fx from './fixtures.js';

const LIMITS: AnalysisJobLimits = {
  maxAnalysisCalls: 50,
  maxReasoningCalls: 5,
  maxAttempts: 2,
  leaseMs: 120_000,
};

/** One problem/snapshot/job world plus the batch that schedules the job. */
interface World {
  readonly problem: NormalizedProblem;
  readonly snapshot: ProblemSnapshot;
  readonly job: AnalysisJobState;
  readonly batch: AnalysisBatch;
}

function makeWorld(): World {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const snapshot = fx.makeSnapshot(scope.problem);
  const job = fx.makeJob(scope.problem, snapshot);
  const batch = createAnalysisBatch({
    batchId: 'batch-1',
    jobs: [{ jobId: job.jobId, snapshotId: snapshot.snapshotId }],
    createdAt: fx.AT,
  });
  return { problem: scope.problem, snapshot, job, batch };
}

/** A reserved attempt of `world`'s batch/job, overridable per case. */
function attempt(world: World, overrides: Partial<ModelCallAttempt> = {}): ModelCallAttempt {
  return {
    attemptId: 'attempt-1',
    batchId: world.batch.batchId,
    jobId: world.job.jobId,
    snapshotId: world.snapshot.snapshotId,
    role: 'analysis',
    provider: 'test-provider',
    model: 'test-model',
    promptVersion: 'analysis-v1',
    requestedAt: fx.AT,
    finishedAt: null,
    status: 'reserved',
    hostSessionId: null,
    hostCallId: null,
    usage: null,
    error: null,
    outcome: null,
    ...overrides,
  };
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

void test('a batch and its settled call attempt survive close and reopen', async () => {
  const paths = fx.tempDatabase();
  const world = makeWorld();
  const suggestion = createAiTagSuggestion({
    problemRef: world.problem.ref,
    snapshotId: world.snapshot.snapshotId,
    taxonomyId: fx.SEGMENT_TREE_TAG,
    role: 'analysis',
    rationale: 'the editorial solution cites a lazy segment tree',
    evidence: [{ sourceId: 'editorial-1', solutionId: 'solution-1', excerpt: 'lazy propagation' }],
    createdAt: fx.AT,
  });
  const settled = attempt(world, {
    status: 'settled',
    finishedAt: fx.LATER,
    hostSessionId: 'session-1',
    hostCallId: 'call-1',
    usage: createModelUsage({ calls: 1, promptTokens: 120, completionTokens: 30 }),
    outcome: { kind: 'analysis', value: { suggestions: [suggestion] } },
  });

  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  assert.equal(await store.saveBatch(world.batch, null), 1);
  // Reserved first: the audit row exists before the model is dispatched.
  await store.saveModelCallAttempt(attempt(world));
  await store.saveModelCallAttempt(settled);
  await store.close();

  const reopened = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    const storedBatch = await reopened.getBatch(world.batch.batchId);
    assert.deepEqual(storedBatch, { ...world.batch, revision: 1 });
    assert.deepEqual(await reopened.getModelCallAttempt('attempt-1'), settled);
    assert.deepEqual(await reopened.listModelCallAttempts({ batchId: world.batch.batchId }), [settled]);
    assert.deepEqual(await reopened.listBatches('pending'), [storedBatch]);
    assert.deepEqual(await reopened.listBatches('running'), []);
    assert.equal(await reopened.getBatch('missing'), null);
    assert.equal(await reopened.getModelCallAttempt('missing'), null);
  } finally {
    await reopened.close();
    fx.removeDirectory(paths.dir);
  }
});

void test('a stale batch revision is rejected before any write and counters never decrease', async () => {
  await withStore(async (store) => {
    const world = makeWorld();
    assert.equal(await store.saveBatch(world.batch, null), 1);
    const running: AnalysisBatch = {
      ...world.batch,
      revision: 1,
      status: 'running',
      owner: 'worker-1',
      leaseExpiresAt: fx.LEASE_UNTIL,
      limits: { ...world.batch.limits, maxAnalysisCalls: 60 },
      counters: { analysisCalls: 1, reasoningCalls: 0, retries: 0 },
      updatedAt: fx.LATER,
    };
    assert.equal(await store.saveBatch(running, 1), 2);
    const stored = await store.getBatch(world.batch.batchId);
    assert.equal(stored?.status, 'running');
    assert.equal(stored?.revision, 2);
    assert.equal(stored?.limits.maxAnalysisCalls, 60, 'raising a limit is allowed');
    assert.equal(stored?.counters.analysisCalls, 1, 'counters are preserved, not reset');

    // A writer that still believes revision 1 must not overwrite the newer state.
    await assert.rejects(
      store.saveBatch(
        { ...running, revision: 1, status: 'paused', owner: null, leaseExpiresAt: null, updatedAt: fx.EXPIRED },
        1,
      ),
      (error) => {
        return (
          error instanceof DomainError &&
          error.code === 'invalid_transition' &&
          error.details['reason'] === 'stale_revision'
        );
      },
    );
    assert.deepEqual(await store.getBatch(world.batch.batchId), stored, 'a stale save wrote nothing');

    // Counter regression is refused even with the current revision.
    await assert.rejects(
      store.saveBatch(
        { ...running, revision: 2, counters: { analysisCalls: 0, reasoningCalls: 0, retries: 0 } },
        2,
      ),
      (error) => error instanceof DomainError && error.code === 'invalid_transition',
    );
    assert.deepEqual(await store.getBatch(world.batch.batchId), stored);

    // Identity is fixed: a different job mapping cannot be smuggled in with a valid revision.
    await assert.rejects(
      store.saveBatch({ ...running, revision: 2, jobs: [{ jobId: 'other-job', snapshotId: 'other-snapshot' }] }, 2),
      (error) => error instanceof DomainError && error.code === 'immutable_violation',
    );
    assert.deepEqual(await store.getBatch(world.batch.batchId), stored);

    // Create-only and update-only misuse are separate failures.
    await assert.rejects(
      store.saveBatch(world.batch, null),
      (error) => error instanceof DomainError && error.code === 'duplicate_id',
    );
    await assert.rejects(
      store.saveBatch(createAnalysisBatch({ batchId: 'batch-missing', jobs: world.batch.jobs, createdAt: fx.AT }), 3),
      (error) => error instanceof DomainError && error.code === 'invalid_transition',
    );
  });
});

void test('an uncertain call is never free and only moves forward to settled', async () => {
  await withStore(async (store) => {
    const world = makeWorld();
    await store.saveBatch(world.batch, null);
    const reserved = attempt(world);
    await store.saveModelCallAttempt(reserved);

    // Host identifiers may become known while the call is still reserved.
    const withHost: ModelCallAttempt = { ...reserved, hostSessionId: 'session-9', hostCallId: 'call-9' };
    await store.saveModelCallAttempt(withHost);
    await store.saveModelCallAttempt(withHost);
    assert.deepEqual(await store.getModelCallAttempt('attempt-1'), withHost);

    const uncertain: ModelCallAttempt = {
      ...withHost,
      status: 'uncertain',
      finishedAt: fx.LATER,
      error: { code: 'timeout', message: 'no answer within 60s', retryable: true },
    };
    await store.saveModelCallAttempt(uncertain);
    assert.deepEqual(await store.getModelCallAttempt('attempt-1'), uncertain);

    // Late usage settles the call; the failure and its cost stay recorded.
    const settled: ModelCallAttempt = {
      ...uncertain,
      status: 'settled',
      finishedAt: fx.EXPIRED,
      usage: createModelUsage({ calls: 1, promptTokens: 10, completionTokens: 0 }),
      error: { code: 'provider_error', message: 'late failure', retryable: false },
    };
    await store.saveModelCallAttempt(settled);
    assert.deepEqual(await store.getModelCallAttempt('attempt-1'), settled);

    // A settled row is final: no rewrites and no way back to reserved/uncertain.
    await assert.rejects(
      store.saveModelCallAttempt({ ...settled, status: 'reserved', finishedAt: null, usage: null, error: null }),
      (error) => error instanceof DomainError && error.code === 'immutable_violation',
    );
    await assert.rejects(
      store.saveModelCallAttempt({ ...settled, usage: createModelUsage({ calls: 2 }) }),
      (error) => error instanceof DomainError && error.code === 'immutable_violation',
    );
    assert.deepEqual(await store.getModelCallAttempt('attempt-1'), settled);

    // A finished call cannot be written without first being reserved.
    await assert.rejects(
      store.saveModelCallAttempt(
        attempt(world, {
          attemptId: 'attempt-2',
          status: 'settled',
          finishedAt: fx.LATER,
          error: { code: 'cancelled', message: 'cancelled by user', retryable: false },
        }),
      ),
      (error) => error instanceof DomainError && error.code === 'invalid_transition',
    );
    assert.equal(await store.getModelCallAttempt('attempt-2'), null);
  });
});

void test('a known host correlation is never reassigned or cleared when a call settles', async () => {
  await withStore(async (store) => {
    const world = makeWorld();
    await store.saveBatch(world.batch, null);
    const correlated = attempt(world, { hostSessionId: 'session-9', hostCallId: 'call-9' });
    await store.saveModelCallAttempt(correlated);

    const uncertain: ModelCallAttempt = {
      ...correlated,
      status: 'uncertain',
      finishedAt: fx.LATER,
      error: { code: 'timeout', message: 'no answer within 60s', retryable: true },
    };
    await store.saveModelCallAttempt(uncertain);

    const settled = (overrides: Partial<ModelCallAttempt>): ModelCallAttempt => ({
      ...uncertain,
      status: 'settled',
      finishedAt: fx.LEASE_UNTIL,
      usage: createModelUsage({ calls: 1, promptTokens: 10, completionTokens: 0 }),
      error: { code: 'provider_error', message: 'late failure', retryable: false },
      ...overrides,
    });

    // Filing the result against a different host call is a wrong correlation.
    await assert.rejects(
      store.saveModelCallAttempt(settled({ hostCallId: 'call-other' })),
      (error) =>
        error instanceof DomainError &&
        error.code === 'immutable_violation' &&
        error.details['reason'] === 'host_correlation',
    );
    // Clearing an already recorded correlation is not a settlement either.
    await assert.rejects(
      store.saveModelCallAttempt(settled({ hostCallId: null })),
      (error) => error instanceof DomainError && error.code === 'immutable_violation',
    );
    await assert.rejects(
      store.saveModelCallAttempt(settled({ hostSessionId: null })),
      (error) => error instanceof DomainError && error.code === 'immutable_violation',
    );
    assert.deepEqual(await store.getModelCallAttempt('attempt-1'), uncertain, 'the rejected settlement wrote nothing');

    // Settling the call with its real correlation still works.
    const correct = settled({});
    await store.saveModelCallAttempt(correct);
    assert.deepEqual(await store.getModelCallAttempt('attempt-1'), correct);
  });
});

void test('a caller transaction reserves the call, the job counter and the batch counter atomically', async () => {
  await withStore(async (store) => {
    const world = makeWorld();
    await store.saveBatch(world.batch, null);
    await store.saveJob(world.job);
    const running = transitionJob(world.job, {
      type: 'start',
      owner: 'worker-1',
      at: fx.AT,
      leaseMs: LIMITS.leaseMs,
    });
    const consumed = transitionJob(running, { type: 'consume_call', kind: 'analysis', at: fx.AT, limits: LIMITS });
    const bumped: AnalysisBatch = {
      ...world.batch,
      revision: 1,
      status: 'running',
      owner: 'worker-1',
      leaseExpiresAt: fx.LATER,
      counters: { analysisCalls: 1, reasoningCalls: 0, retries: 0 },
      updatedAt: fx.AT,
    };

    await assert.rejects(
      store.transaction(async () => {
        await store.saveJob(consumed);
        await store.saveBatch(bumped, 1);
        await store.saveModelCallAttempt(attempt(world));
        throw new Error('dispatch failed before the model was called');
      }),
      /dispatch failed/,
    );

    // All three writes rolled back together: no paid call is recorded and no budget is lost.
    assert.deepEqual(await store.getJob(world.job.jobId), world.job);
    assert.deepEqual(await store.getBatch(world.batch.batchId), { ...world.batch, revision: 1 });
    assert.equal(await store.getModelCallAttempt('attempt-1'), null);

    await store.transaction(async () => {
      await store.saveJob(consumed);
      await store.saveBatch(bumped, 1);
      await store.saveModelCallAttempt(attempt(world));
    });
    assert.equal((await store.getJob(world.job.jobId))?.counters.analysisCalls, 1);
    assert.equal((await store.getBatch(world.batch.batchId))?.counters.analysisCalls, 1);
    assert.equal((await store.getBatch(world.batch.batchId))?.revision, 2);
    assert.equal((await store.getModelCallAttempt('attempt-1'))?.status, 'reserved');
  });
});

void test('attempt queries are scoped, deterministically ordered and validated', async () => {
  await withStore(async (store) => {
    const world = makeWorld();
    await store.saveBatch(world.batch, null);
    await store.saveModelCallAttempt(attempt(world, { attemptId: 'attempt-1', requestedAt: fx.AT }));
    await store.saveModelCallAttempt(attempt(world, { attemptId: 'attempt-3', requestedAt: fx.AT }));
    await store.saveModelCallAttempt(
      attempt(world, { attemptId: 'attempt-2', jobId: 'job-2', requestedAt: fx.LATER }),
    );

    assert.deepEqual(
      (await store.listModelCallAttempts({ batchId: world.batch.batchId })).map((entry) => entry.attemptId),
      ['attempt-1', 'attempt-3', 'attempt-2'],
    );
    assert.deepEqual(
      (await store.listModelCallAttempts({ jobId: 'job-2' })).map((entry) => entry.attemptId),
      ['attempt-2'],
    );
    assert.equal((await store.listModelCallAttempts({})).length, 3);
    assert.deepEqual(await store.listModelCallAttempts({ status: 'settled' }), []);
    await assert.rejects(
      store.listModelCallAttempts({ status: 'unknown' as never }),
      (error) => error instanceof DomainError && error.code === 'invalid_input',
    );

    // Analyze and verify share the analysis budget; reasoning is accounted separately.
    assert.equal(budgetKindOfRole('analysis'), 'analysis');
    assert.equal(budgetKindOfRole('verification'), 'analysis');
    assert.equal(budgetKindOfRole('reasoning'), 'reasoning');
  });
});

void test('an outcome must match its role and undeclared top-level fields are dropped', async () => {
  await withStore(async (store) => {
    const world = makeWorld();
    await store.saveBatch(world.batch, null);
    await assert.rejects(
      store.saveModelCallAttempt(
        attempt(world, {
          attemptId: 'attempt-mismatch',
          role: 'verification',
          status: 'settled',
          finishedAt: fx.LATER,
          outcome: { kind: 'analysis', value: { suggestions: [] } },
        }),
      ),
      (error) => error instanceof DomainError && error.code === 'invalid_input',
    );
    assert.equal(await store.getModelCallAttempt('attempt-mismatch'), null);

    // An undeclared top-level field is outside the projection, so it cannot be persisted.
    const withSecret = {
      ...attempt(world, { attemptId: 'attempt-raw' }),
      rawPayload: { token: 'secret-token' },
    } as ModelCallAttempt;
    await store.saveModelCallAttempt(withSecret);
    const stored = await store.getModelCallAttempt('attempt-raw');
    assert.deepEqual(stored, attempt(world, { attemptId: 'attempt-raw' }));
    assert.equal(JSON.stringify(stored).includes('secret-token'), false);
  });
});

void test('batch boundaries and lease shape are validated as plain data', () => {
  const world = makeWorld();
  assert.equal(world.batch.limits.maxAnalysisCalls, 50);
  assert.equal(world.batch.limits.maxReasoningCalls, 5);
  assert.equal(world.batch.limits.concurrency, 2);
  assert.equal(world.batch.maxJobs, 20);
  assert.equal(world.batch.revision, 0);
  assert.equal(world.batch.counters.analysisCalls, 0);

  const jobs21 = Array.from({ length: 21 }, (_, index) => ({
    jobId: `job-${index}`,
    snapshotId: `snapshot-${index}`,
  }));
  assert.throws(
    () => createAnalysisBatch({ batchId: 'too-many', jobs: jobs21, createdAt: fx.AT }),
    (error) => error instanceof DomainError && error.code === 'invalid_input',
  );
  assert.equal(
    createAnalysisBatch({ batchId: 'explicit', jobs: jobs21, createdAt: fx.AT, maxJobs: 21 }).jobs.length,
    21,
    'an explicit bound up to 100 is allowed',
  );
  assert.throws(
    () => createAnalysisBatch({ batchId: 'over-max', jobs: jobs21, createdAt: fx.AT, maxJobs: 101 }),
    (error) => error instanceof DomainError && error.code === 'invalid_input',
  );
  assert.throws(
    () => createAnalysisBatch({ batchId: 'empty', jobs: [], createdAt: fx.AT }),
    (error) => error instanceof DomainError && error.code === 'invalid_input',
  );
  assert.throws(
    () =>
      createAnalysisBatch({
        batchId: 'duplicates',
        jobs: [
          { jobId: 'job-1', snapshotId: 'a' },
          { jobId: 'job-1', snapshotId: 'b' },
        ],
        createdAt: fx.AT,
      }),
    (error) => error instanceof DomainError && error.code === 'duplicate_id',
  );
  assert.throws(
    () =>
      createAnalysisBatch({
        batchId: 'bad-limit',
        jobs: [{ jobId: 'job-1', snapshotId: 'a' }],
        createdAt: fx.AT,
        limits: { concurrency: 0 },
      }),
    (error) => error instanceof DomainError && error.code === 'invalid_input',
  );

  // Lease shape: running holds exactly one lease, every other status holds none.
  assert.throws(
    () => validateAnalysisBatch({ ...world.batch, status: 'running' }),
    (error) => error instanceof DomainError && error.code === 'invalid_input',
  );
  assert.throws(
    () => validateAnalysisBatch({ ...world.batch, owner: 'worker-1' }),
    (error) => error instanceof DomainError && error.code === 'invalid_input',
  );

  const completed: AnalysisBatch = { ...world.batch, revision: 1, status: 'completed' };
  assert.throws(
    () =>
      validateAnalysisBatchTransition(completed, {
        ...completed,
        status: 'running',
        owner: 'worker-1',
        leaseExpiresAt: fx.LATER,
      }),
    (error) => error instanceof DomainError && error.code === 'invalid_transition',
  );

  // Resuming a paused batch and raising its limits keeps the counters that were spent.
  const paused: AnalysisBatch = {
    ...world.batch,
    revision: 1,
    status: 'paused',
    counters: { analysisCalls: 3, reasoningCalls: 1, retries: 0 },
    updatedAt: fx.LATER,
  };
  validateAnalysisBatchTransition(paused, {
    ...paused,
    status: 'running',
    owner: 'worker-1',
    leaseExpiresAt: fx.LEASE_UNTIL,
    limits: { ...paused.limits, maxAnalysisCalls: 80 },
  });
});

void test('temporal metadata is ordered and a legal resume still lands', async () => {
  await withStore(async (store) => {
    const world = makeWorld();
    await store.saveBatch(world.batch, null);
    const running: AnalysisBatch = {
      ...world.batch,
      revision: 1,
      status: 'running',
      owner: 'worker-1',
      leaseExpiresAt: fx.LEASE_UNTIL,
      counters: { analysisCalls: 2, reasoningCalls: 1, retries: 0 },
      updatedAt: fx.LATER,
    };
    assert.equal(await store.saveBatch(running, 1), 2, 'a legal resume with an ordered lease lands');
    assert.deepEqual(await store.getBatch(world.batch.batchId), { ...running, revision: 2 });

    // updatedAt before createdAt and a lease that does not outlive updatedAt are both refused.
    await assert.rejects(
      store.saveBatch({ ...world.batch, createdAt: fx.LATER, updatedAt: fx.AT }, null),
      (error) => error instanceof DomainError && error.code === 'invalid_input',
    );
    for (const leaseExpiresAt of [fx.AT, fx.LATER]) {
      await assert.rejects(
        store.saveBatch({ ...running, revision: 2, leaseExpiresAt }, 2),
        (error) => error instanceof DomainError && error.code === 'invalid_input',
      );
    }
    assert.deepEqual(
      await store.getBatch(world.batch.batchId),
      { ...running, revision: 2 },
      'invalid temporal metadata wrote nothing',
    );

    // A settled attempt cannot finish before it was requested; an equal instant is a
    // zero-duration call and stays legal.
    const settledAt = (finishedAt: string): ModelCallAttempt => ({
      ...attempt(world, { requestedAt: fx.LATER }),
      status: 'settled',
      finishedAt,
      error: { code: 'cancelled', message: 'cancelled before dispatch', retryable: false },
    });
    assert.throws(
      () => validateModelCallAttempt(settledAt(fx.AT)),
      (error) => error instanceof DomainError && error.code === 'invalid_input',
    );
    await store.saveModelCallAttempt(attempt(world, { requestedAt: fx.LATER }));
    await assert.rejects(
      store.saveModelCallAttempt(settledAt(fx.AT)),
      (error) => error instanceof DomainError && error.code === 'invalid_input',
    );
    assert.equal((await store.getModelCallAttempt('attempt-1'))?.status, 'reserved', 'the invalid settlement wrote nothing');
    await store.saveModelCallAttempt(settledAt(fx.LATER));
    assert.equal((await store.getModelCallAttempt('attempt-1'))?.status, 'settled');
  });
});
void test('zero analysis or reasoning quota is a valid persisted disabled role; concurrency still cannot be zero',()=>{
 const world=makeWorld();const disabled=createAnalysisBatch({batchId:'disabled',jobs:world.batch.jobs,createdAt:fx.AT,limits:{maxAnalysisCalls:0,maxReasoningCalls:0,concurrency:1}});
 assert.equal(disabled.limits.maxAnalysisCalls,0);assert.equal(disabled.limits.maxReasoningCalls,0);assert.throws(()=>validateAnalysisBatch({...disabled,limits:{...disabled.limits,concurrency:0}}));
});
