/**
 * The material gate in front of a stored batch (Sprint 33A).
 *
 * The preparation gate stops a *new* batch from being created for unusable material. This file
 * covers the second, independent gate: a batch that already exists — because an earlier version
 * prepared it, or because a snapshot became unreadable afterwards — must not be able to spend money
 * either. Several cases here start from a batch written **directly** to the store, which is exactly
 * the historical shape the current `batch.prepare` can no longer produce, and then drive the real
 * controller over a real SQLite store with a recording gateway.
 *
 * What is asserted is the externally meaningful contract: `batch.run` and `batch.resume` refuse with
 * `materials_blocked`, and the refusal is *free and inert* — no owned operation, no dispatch, no
 * attempt row, no counter movement, no job-status change and no mutation of the batch itself,
 * whether the call comes from the UI or a direct API caller. `batch.detail` reports the same fact as
 * a read-only `materialBlocks` list without writing anything, and refreshing a problem's material
 * writes a new snapshot that never clears the old batch's block.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { AnalysisPipeline } from '../../src/application/analysis-pipeline.js';
import { createAnalysisBatch, type AnalysisBatch } from '../../src/application/batch-types.js';
import { CoachingService } from '../../src/application/coaching-service.js';
import { ModelOperationError } from '../../src/application/model-operation-types.js';
import type {
  AnalyzeOutcome,
  AnalyzeRequest,
  ModelCallResult,
  ModelCapabilities,
  ModelGateway,
  ReasonOutcome,
  ReasonRequest,
  VerifyOutcome,
  VerifyRequest,
} from '../../src/application/ports.js';
import { defaultWorkbenchSettings } from '../../src/application/workbench-settings.js';
import {
  analysisJobIdOf,
  createAnalysisJob,
  createCancellationSource,
  createEditorialSource,
  createProblemSnapshot,
  createTaxonomy,
  type CancellationToken,
  type EditorialAvailability,
  type NormalizedProblem,
  type ProblemSnapshot,
} from '../../src/domain/index.js';
import { ModelOperations } from '../../src/plugin/model-operations.js';
import * as fx from '../storage/fixtures.js';

/** A caller token nobody cancels: the material gate must be what refuses, not a dead request. */
const TOKEN: CancellationToken = createCancellationSource().token;

const TAXONOMY = createTaxonomy({ version: 'gate-v1', nodes: [] });

/** Gateway that records what it was asked to do and fails loudly if it is asked at all. */
class RecordingGateway implements ModelGateway {
  readonly analyzeRequests: AnalyzeRequest[] = [];
  readonly verifyRequests: VerifyRequest[] = [];
  readonly reasonRequests: ReasonRequest[] = [];

  capabilities(): ModelCapabilities {
    return {
      provider: 'recording-provider',
      implemented: true,
      roles: ['analysis', 'verification', 'reasoning'],
      maxConcurrency: 2,
      notes: [],
    };
  }

  async analyze(request: AnalyzeRequest): Promise<ModelCallResult<AnalyzeOutcome>> {
    this.analyzeRequests.push(request);
    throw new Error('the material gate must refuse before any analysis dispatch');
  }

  async verify(request: VerifyRequest): Promise<ModelCallResult<VerifyOutcome>> {
    this.verifyRequests.push(request);
    throw new Error('the material gate must refuse before any verification dispatch');
  }

  async reason(request: ReasonRequest): Promise<ModelCallResult<ReasonOutcome>> {
    this.reasonRequests.push(request);
    throw new Error('the material gate must refuse before any reasoning dispatch');
  }

  get calls(): number {
    return this.analyzeRequests.length + this.verifyRequests.length + this.reasonRequests.length;
  }
}

/** One editorial source in the requested state, with no solution attached. */
function snapshotWithSource(problem: NormalizedProblem, availability: EditorialAvailability): ProblemSnapshot {
  const source = createEditorialSource({
    id: 'editorial-1',
    kind: 'editorial',
    url: `https://editorial.example.org/${problem.ref.externalKey}`,
    title: `Editorial for ${problem.title}`,
    availability,
    retrievedAt: fx.AT,
    // A `found` source must have retrieved a body; the *write-up* is what is missing here.
    ...(availability === 'found' ? { text: 'A retrieved page whose write-up was never extracted.' } : {}),
  });
  return createProblemSnapshot({ problem, sources: [source], solutions: [], capturedAt: fx.AT });
}

/** Snapshot with no source records at all: an unknown editorial state, never an absence. */
function snapshotWithoutSources(problem: NormalizedProblem): ProblemSnapshot {
  return createProblemSnapshot({ problem, sources: [], solutions: [], capturedAt: fx.AT });
}

/**
 * Store whose snapshot *body* is unreadable for the ids it was told to hide.
 *
 * The current head is a real row; only the body behind it cannot be read, which is the historical
 * shape a damaged or partially reclaimed snapshot leaves behind. Nothing else is affected, so this
 * models a storage fact rather than a code path.
 */
class HiddenSnapshotStore extends SqliteTrainingStore {
  private readonly hidden = new Set<string>();
  private readonly hiddenJobs = new Set<string>();

  hide(snapshotId: string): void {
    this.hidden.add(snapshotId);
  }

  hideJob(jobId: string): void {
    this.hiddenJobs.add(jobId);
  }

  override async getSnapshot(snapshotId: string): Promise<ProblemSnapshot | null> {
    return this.hidden.has(snapshotId) ? null : super.getSnapshot(snapshotId);
  }

  override async getJob(jobId: string) {
    return this.hiddenJobs.has(jobId) ? null : super.getJob(jobId);
  }
}

interface GateWorld {
  readonly store: HiddenSnapshotStore;
  readonly gateway: RecordingGateway;
  readonly controller: ModelOperations;
  readonly runnable: fx.Scope;
  readonly unknownEditorial: fx.Scope;
  readonly authRequired: fx.Scope;
  readonly absentStatement: fx.Scope;
  /** A saved, still readable snapshot a case may hide to model a damaged body. */
  readonly extraSnapshotId: string;
  /** Problem key of that extra snapshot, for asserting the reported block. */
  readonly extraProblemKey: string;
  readonly snapshotIdOf: (scope: fx.Scope) => string;
}

/** Real store + real controller + recording gateway; only the model boundary is faked. */
async function withGateWorld(run: (world: GateWorld) => Promise<void>): Promise<void> {
  const paths = fx.tempDatabase();
  const store = new HiddenSnapshotStore({ path: paths.path, now: () => fx.AT });
  const gateway = new RecordingGateway();
  const base = fx.makeScope('codeforces', 'codeforces.com', 'alice', '3000A');
  const runnable = base;
  const unknownEditorial = fx.makeScope('codeforces', 'codeforces.com', 'alice', '3001B');
  const authRequired = fx.makeScope('codeforces', 'codeforces.com', 'alice', '3002C');
  const absentStatement = fx.makeScope('codeforces', 'codeforces.com', 'alice', '3003D');
  const extra = fx.makeScope('codeforces', 'codeforces.com', 'alice', '3004E');
  const ids = new Map<string, string>();
  let counter = 0;
  const analysisPipeline = (): AnalysisPipeline =>
    new AnalysisPipeline({
      store,
      gateway,
      taxonomy: TAXONOMY,
      roles: defaultWorkbenchSettings().roles,
      limits: defaultWorkbenchSettings().modelLimits,
      now: () => fx.AT,
      uniqueId: (prefix) => `${prefix}-${(counter += 1)}`,
    });
  const controller = new ModelOperations({
    store,
    coaching: new CoachingService({
      store,
      generator: { generate: async () => assert.fail('no coaching call is expected in this file') },
      now: () => fx.AT,
    }),
    createPipeline: () => analysisPipeline(),
    validateModels: async () => [],
    now: () => fx.AT,
    uniqueId: (prefix) => `${prefix}-${(counter += 1)}`,
  });
  try {
    // One instance carries every problem of this fixture; each scope still has its own key.
    await store.upsertSourceInstances([base.instance]);
    await store.upsertProblems([
      runnable.problem,
      unknownEditorial.problem,
      authRequired.problem,
      absentStatement.problem,
      extra.problem,
    ]);
    const snapshots = [
      fx.makeSnapshot(runnable.problem),
      snapshotWithoutSources(unknownEditorial.problem),
      snapshotWithSource(authRequired.problem, 'auth_required'),
      snapshotWithSource(absentStatement.problem, 'absent'),
      snapshotWithoutSources(extra.problem),
    ];
    const scopes = [runnable, unknownEditorial, authRequired, absentStatement, extra];
    for (const [index, snapshot] of snapshots.entries()) {
      await store.saveSnapshot(snapshot);
      ids.set(scopes[index]!.problem.key, snapshot.snapshotId);
    }
    await store.saveWorkbenchSettings(defaultWorkbenchSettings(), null);
    const extraSnapshotId = ids.get(extra.problem.key);
    assert.ok(extraSnapshotId, 'the extra snapshot must be recorded');
    await run({
      store,
      gateway,
      controller,
      runnable,
      unknownEditorial,
      authRequired,
      absentStatement,
      extraSnapshotId,
      extraProblemKey: extra.problem.key,
      snapshotIdOf: (scope) => {
        const snapshotId = ids.get(scope.problem.key);
        if (snapshotId === undefined) {
          assert.fail(`no seeded snapshot for ${scope.problem.key}`);
        }
        return snapshotId;
      },
    });
  } finally {
    await controller.close();
    await controller.whenSettled();
    await store.close();
    fx.removeDirectory(paths.dir);
  }
}

/** A stored batch over exactly these snapshots, written straight to the store. */
async function storeBatch(
  store: SqliteTrainingStore,
  batchId: string,
  jobs: readonly { readonly snapshotId: string }[],
): Promise<AnalysisBatch> {
  await store.saveBatch(
    createAnalysisBatch({
      batchId,
      jobs: jobs.map((entry) => ({
        jobId: analysisJobIdOf(entry.snapshotId),
        snapshotId: entry.snapshotId,
      })),
      createdAt: fx.AT,
      maxJobs: Math.max(1, jobs.length),
    }),
    null,
  );
  // A real prepared batch always has its job rows created too; writing them keeps this fixture an
  // honest historical batch rather than a batch-shaped object with dangling references.
  for (const entry of jobs) {
    const jobId = analysisJobIdOf(entry.snapshotId);
    if ((await store.getJob(jobId)) !== null) {
      continue;
    }
    const snapshot = await store.getSnapshot(entry.snapshotId);
    assert.ok(snapshot, `snapshot ${entry.snapshotId} must exist before its job is written`);
    await store.saveJob(
      createAnalysisJob({ problemRef: snapshot.problem.ref, snapshotId: entry.snapshotId, at: fx.AT }),
    );
  }
  const stored = await store.getBatch(batchId);
  assert.ok(stored, `batch ${batchId} must be readable after it was stored`);
  return stored;
}

/** Everything the gate promises not to touch, as one comparable value. */
async function frozenStateOf(store: SqliteTrainingStore, batchId: string): Promise<string> {
  const batch = await store.getBatch(batchId);
  assert.ok(batch);
  const jobs = await Promise.all(batch.jobs.map(async (spec) => await store.getJob(spec.jobId)));
  const attempts = await store.listModelCallAttempts({ batchId });
  return JSON.stringify({ batch, jobs, attempts });
}

const blockedRefusal = (error: unknown): boolean =>
  error instanceof ModelOperationError && error.code === 'materials_blocked';

function batchIdOf(prepared: { readonly batchId: string | null }): string {
  if (prepared.batchId === null) {
    assert.fail('expected a prepared batch');
  }
  return prepared.batchId;
}

// ---------------------------------------------------------------------------------------
// A historical pending batch
// ---------------------------------------------------------------------------------------

void test('an old pending batch whose material is unusable refuses to run and changes nothing', async () => {
  await withGateWorld(async (world) => {
    const batch = await storeBatch(world.store, 'legacy-pending', [
      { snapshotId: world.snapshotIdOf(world.unknownEditorial) },
    ]);
    const before = await frozenStateOf(world.store, batch.batchId);

    await assert.rejects(
      world.controller.runBatch({ batchId: batch.batchId, expectedSettingsRevision: 1 }, TOKEN),
      blockedRefusal,
    );

    // The refusal is inert: no dispatch, no audit row, no counter, no status and no operation.
    assert.equal(world.gateway.calls, 0);
    assert.equal(await frozenStateOf(world.store, batch.batchId), before);
    const detail = await world.controller.batchDetail({ batchId: batch.batchId }, TOKEN);
    assert.equal(detail.batch.status, 'pending');
    assert.equal(detail.operation, null);
    assert.deepEqual(detail.batch.counters, { analysisCalls: 0, reasoningCalls: 0, retries: 0 });
    assert.deepEqual(detail.batch.materialBlocks, [
      { problemKey: world.unknownEditorial.problem.key, reason: 'editorial_unknown', action: 'refresh_materials' },
    ]);
    assert.deepEqual(await world.store.listModelCallAttempts({ batchId: batch.batchId }), []);
  });
});

void test('an old failed batch reports its material blocker and refuses to resume or run', async () => {
  await withGateWorld(async (world) => {
    const snapshotId = world.snapshotIdOf(world.authRequired);
    const batch = await storeBatch(world.store, 'legacy-failed', [{ snapshotId }]);
    // The historical failure the user saw: the job failed at the pipeline's own defence, and the
    // batch was left `failed` for a later resume.
    const job = await world.store.getJob(analysisJobIdOf(snapshotId));
    assert.ok(job);
    await world.store.saveJob({
      ...job,
      status: 'failed',
      lastError: { code: 'source_unavailable', message: 'the source required authentication', retryable: false },
    });
    const failed = await world.store.getBatch(batch.batchId);
    assert.ok(failed);
    await world.store.saveBatch({ ...failed, status: 'failed', updatedAt: fx.LATER }, failed.revision);
    const before = await frozenStateOf(world.store, batch.batchId);

    await assert.rejects(
      world.controller.resumeBatch({ batchId: batch.batchId, expectedSettingsRevision: 1 }, TOKEN),
      blockedRefusal,
    );
    await assert.rejects(
      world.controller.runBatch({ batchId: batch.batchId, expectedSettingsRevision: 1 }, TOKEN),
      blockedRefusal,
    );

    assert.equal(world.gateway.calls, 0);
    assert.equal(await frozenStateOf(world.store, batch.batchId), before);
    // A resume would have requeued this job and returned the batch to pending; neither happened.
    const detail = await world.controller.batchDetail({ batchId: batch.batchId }, TOKEN);
    assert.equal(detail.batch.status, 'failed');
    assert.equal(detail.batch.jobs[0]?.status, 'failed');
    assert.equal(detail.batch.jobs[0]?.errorCode, 'source_unavailable');
    assert.equal(detail.operation, null);
  });
});

// ---------------------------------------------------------------------------------------
// Mixed batches
// ---------------------------------------------------------------------------------------

void test('a mixed historical batch is refused as a whole and reports only the unusable jobs', async () => {
  await withGateWorld(async (world) => {
    const batch = await storeBatch(world.store, 'legacy-mixed', [
      { snapshotId: world.snapshotIdOf(world.runnable) },
      { snapshotId: world.snapshotIdOf(world.unknownEditorial) },
      { snapshotId: world.snapshotIdOf(world.absentStatement) },
    ]);
    const before = await frozenStateOf(world.store, batch.batchId);

    await assert.rejects(
      world.controller.runBatch({ batchId: batch.batchId, expectedSettingsRevision: 1 }, TOKEN),
      blockedRefusal,
    );

    // One unusable job refuses the whole start: a partial run would spend money on a batch the user
    // cannot complete, so the runnable jobs are not selectively paid for either.
    assert.equal(world.gateway.calls, 0);
    assert.equal(await frozenStateOf(world.store, batch.batchId), before);
    const detail = await world.controller.batchDetail({ batchId: batch.batchId }, TOKEN);
    assert.deepEqual(detail.batch.materialBlocks, [
      { problemKey: world.unknownEditorial.problem.key, reason: 'editorial_unknown', action: 'refresh_materials' },
    ]);
    assert.equal(detail.batch.materialBlocks.length < detail.batch.jobs.length, true);
  });
});

void test('refreshing a problem writes a new snapshot and never clears the old batch block', async () => {
  await withGateWorld(async (world) => {
    const oldSnapshotId = world.snapshotIdOf(world.unknownEditorial);
    const batch = await storeBatch(world.store, 'legacy-stale-head', [{ snapshotId: oldSnapshotId }]);
    await assert.rejects(
      world.controller.runBatch({ batchId: batch.batchId, expectedSettingsRevision: 1 }, TOKEN),
      blockedRefusal,
    );

    // The user refreshes the material, which produces a *new* current snapshot: this one records a
    // source that answered, so its semantic content (and therefore its snapshot id) really differs.
    const oldSnapshot = await world.store.getSnapshot(oldSnapshotId);
    assert.ok(oldSnapshot);
    const refreshed = createProblemSnapshot({
      problem: world.unknownEditorial.problem,
      sources: [
        createEditorialSource({
          id: 'editorial-1',
          kind: 'editorial',
          url: `https://editorial.example.org/${world.unknownEditorial.problem.ref.externalKey}`,
          title: 'Editorial',
          availability: 'absent',
          retrievedAt: fx.LATER,
        }),
      ],
      solutions: [],
      capturedAt: fx.LATER,
      previous: oldSnapshot,
    });
    assert.notEqual(refreshed.snapshotId, oldSnapshotId);
    await world.store.saveSnapshot(refreshed);
    const head = await world.store.getCurrentSnapshotHead(world.unknownEditorial.problem.ref);
    assert.equal(head?.snapshotId, refreshed.snapshotId);

    // The stored batch keeps the immutable snapshot it captured, so its block stays and the very
    // same refusal applies: refreshing material cannot repair an old batch, only a new free
    // preparation can.
    const detail = await world.controller.batchDetail({ batchId: batch.batchId }, TOKEN);
    assert.equal(detail.batch.jobs[0]?.snapshotId, oldSnapshotId);
    assert.deepEqual(detail.batch.materialBlocks, [
      { problemKey: world.unknownEditorial.problem.key, reason: 'editorial_unknown', action: 'refresh_materials' },
    ]);
    await assert.rejects(
      world.controller.runBatch({ batchId: batch.batchId, expectedSettingsRevision: 1 }, TOKEN),
      blockedRefusal,
    );
    assert.equal(world.gateway.calls, 0);

    // A fresh free preparation of the refreshed problem is runnable, and that is the only path.
    const prepared = await world.controller.prepareBatch(
      { problemKeys: [world.unknownEditorial.problem.key] },
      TOKEN,
    );
    assert.deepEqual(prepared.blocked, []);
    assert.equal(prepared.jobs.length, 1);
    assert.notEqual(prepared.batchId, batch.batchId);
  });
});

// ---------------------------------------------------------------------------------------
// Reads stay free, unreadable snapshots are caught, and runnable material still runs
// ---------------------------------------------------------------------------------------

void test('batch.detail reports the blocks read-only and writes nothing', async () => {
  await withGateWorld(async (world) => {
    const batch = await storeBatch(world.store, 'legacy-detail', [
      { snapshotId: world.snapshotIdOf(world.unknownEditorial) },
      { snapshotId: world.snapshotIdOf(world.runnable) },
    ]);
    const before = await frozenStateOf(world.store, batch.batchId);
    for (let round = 0; round < 3; round += 1) {
      const detail = await world.controller.batchDetail({ batchId: batch.batchId }, TOKEN);
      assert.deepEqual(detail.batch.materialBlocks, [
        { problemKey: world.unknownEditorial.problem.key, reason: 'editorial_unknown', action: 'refresh_materials' },
      ]);
    }
    assert.equal(await frozenStateOf(world.store, batch.batchId), before);
    assert.equal(world.gateway.calls, 0);
  });
});

void test('a batch whose snapshot body is unreadable is blocked as snapshot_unreadable', async () => {
  await withGateWorld(async (world) => {
    // A real head whose snapshot body this store cannot read: the historical shape left behind by a
    // damaged or partially reclaimed snapshot. The current preparation gate refuses this too, so
    // the batch is written directly — it is exactly what a stored batch must still survive.
    const snapshotId = world.extraSnapshotId;
    const batch = await storeBatch(world.store, 'legacy-unreadable', [{ snapshotId }]);
    const jobId = analysisJobIdOf(snapshotId);
    assert.notEqual(await world.store.getSnapshot(snapshotId), null);
    assert.notEqual(await world.store.getJob(jobId), null);
    world.store.hide(snapshotId);
    world.store.hideJob(jobId);
    assert.equal(await world.store.getSnapshot(snapshotId), null);
    assert.equal(await world.store.getJob(jobId), null);
    const before = await frozenStateOf(world.store, batch.batchId);

    await assert.rejects(
      world.controller.runBatch({ batchId: batch.batchId, expectedSettingsRevision: 1 }, TOKEN),
      blockedRefusal,
    );
    assert.equal(world.gateway.calls, 0);
    assert.equal(await frozenStateOf(world.store, batch.batchId), before);
    const detail = await world.controller.batchDetail({ batchId: batch.batchId }, TOKEN);
    assert.deepEqual(detail.batch.materialBlocks, [
      { problemKey: world.extraProblemKey, reason: 'snapshot_unreadable', action: 'refresh_materials' },
    ]);
    assert.equal(JSON.stringify(detail.batch.materialBlocks).includes(snapshotId), false);
  });
});

void test('a stored batch whose material is runnable still starts, so only real blockers refuse', async () => {
  await withGateWorld(async (world) => {
    // `absent` material with a statement is genuinely analysable through the reasoning role, so the
    // gate must let it through; refusing it would silently disable a supported path.
    const batch = await storeBatch(world.store, 'legacy-absent', [
      { snapshotId: world.snapshotIdOf(world.absentStatement) },
    ]);
    const detail = await world.controller.batchDetail({ batchId: batch.batchId }, TOKEN);
    assert.deepEqual(detail.batch.materialBlocks, []);

    const started = await world.controller.runBatch(
      { batchId: batch.batchId, expectedSettingsRevision: 1 },
      TOKEN,
    );
    assert.equal(started.batchId, batch.batchId);
    await world.controller.cancelBatch({ batchId: batch.batchId }, TOKEN);
    assert.equal((await world.store.getBatch(batch.batchId))?.status, 'cancelled');

    // A batch the preparation gate produced has no blocks either, and it keeps its own identity.
    const prepared = await world.controller.prepareBatch({ problemKeys: [world.runnable.problem.key] }, TOKEN);
    const preparedBatchId = batchIdOf(prepared);
    assert.deepEqual(
      (await world.controller.batchDetail({ batchId: preparedBatchId }, TOKEN)).batch.materialBlocks,
      [],
    );
  });
});
