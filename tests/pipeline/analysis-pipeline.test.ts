/**
 * Analysis pipeline behaviour, end to end against the real SQLite store.
 *
 * Every case drives the production pipeline with a deterministic fake gateway: the model is
 * the only thing faked, and the fake never mirrors pipeline internals — it records the
 * requests it received and returns scripted domain output. The store is a real temporary
 * database, so the accounting, lease, CAS and recovery behaviour under test is the behaviour
 * a restart would see.
 */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { AnalysisPipeline, type AnalysisPipelineOptions } from '../../src/application/analysis-pipeline.js';
import { createAnalysisBatch, type AnalysisBatch } from '../../src/application/batch-types.js';
import { DEFAULT_MODEL_LIMITS } from '../../src/application/ports.js';
import type {
  AnalyzeOutcome,
  AnalyzeRequest,
  ModelCallResult,
  ModelCapabilities,
  ModelErrorCode,
  ModelGateway,
  ReasonOutcome,
  ReasonRequest,
  VerifyOutcome,
  VerifyRequest,
} from '../../src/application/ports.js';
import {
  DomainError,
  analysisJobIdOf,
  createAiTagSuggestion,
  createAnalysisJob,
  createAnalysisResult,
  createCancellationSource,
  createEditorialSolution,
  createEditorialSource,
  createManualTagDecision,
  createModelUsage,
  createNormalizedProblem,
  createProblemSnapshot,
  createReasoningDraft,
  createSuggestionVerification,
  createTaxonomy,
  type AiTagSuggestion,
  type AnalysisJobState,
  type AnalysisResult,
  type EditorialAvailability,
  type ManualTagDecision,
  type NormalizedProblem,
  type ProblemSnapshot,
  type SuggestionVerification,
  type TagDecision,
  type Taxonomy,
} from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';

const SEGMENT_TREE_TAG = 'data-structure.segment-tree';
const EXCERPT = 'lazy propagation';
const SOLUTION_TEXT = 'The editorial uses lazy propagation: range updates stay O(log n) with a segment tree.';

/** The validated taxonomy fixture; `makeTaxonomy` lets a test vary the recorded version. */
function makeTaxonomy(version: string): Taxonomy {
  return createTaxonomy({
    version,
    nodes: [
      {
        id: 'data-structure',
        parentId: null,
        kind: 'category',
        names: { en: 'Data structures', zh: '数据结构' },
        aliases: [],
        description: 'container techniques',
      },
      {
        id: SEGMENT_TREE_TAG,
        parentId: 'data-structure',
        kind: 'technique',
        names: { en: 'Segment tree', zh: '线段树' },
        aliases: ['segment tree'],
        description: 'range queries',
      },
    ],
  });
}

const TAXONOMY: Taxonomy = makeTaxonomy('test-v1');

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

interface Clock {
  now(): string;
  at(iso: string): void;
}

function makeClock(): Clock {
  let current = fx.AT;
  return {
    now: () => current,
    at: (iso) => {
      current = iso;
    },
  };
}

/** Process-wide sequence: every pipeline/test gets globally unique ids from one counter. */
let globalIdSequence = 0;

function makeIdFactory(): (prefix: string) => string {
  return (prefix) => {
    globalIdSequence += 1;
    return `${prefix}-${globalIdSequence}`;
  };
}

interface Fixture {
  readonly store: SqliteTrainingStore;
  readonly clock: Clock;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const paths = fx.tempDatabase();
  const clock = makeClock();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => clock.now() });
  try {
    await run({ store, clock });
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
}

/**
 * Real SQLite store with two scripted hooks, used to drive races that would otherwise depend on
 * lucky interleaving: `getBatch` can hand the pipeline one stale view (after running a callback,
 * e.g. persisting a pause), and a hook can fire after `listManualDecisions`, which the pipeline
 * only calls inside its commit transaction.
 */
type HookedWrite = 'saveAnalysis' | 'saveTagDecisions' | 'saveJob' | 'saveBatch';

class ScriptedStore extends SqliteTrainingStore {
  private staleBatchView: {
    readonly batchId: string;
    readonly view: AnalysisBatch;
    readonly before: () => Promise<void>;
  } | null = null;
  private manualDecisionsHook: (() => void) | null = null;
  private writeHook: { readonly method: HookedWrite; readonly hook: () => void } | null = null;

  override async getBatch(batchId: string): Promise<AnalysisBatch | null> {
    const staged = this.staleBatchView;
    if (staged && staged.batchId === batchId) {
      // Consume the staging before running `before`, so the nested read made while the race is
      // persisted falls through to the live store instead of recursing.
      this.staleBatchView = null;
      await staged.before();
      return staged.view;
    }
    return super.getBatch(batchId);
  }

  override async listManualDecisions(problemKey: string): Promise<readonly ManualTagDecision[]> {
    const decisions = await super.listManualDecisions(problemKey);
    const hook = this.manualDecisionsHook;
    this.manualDecisionsHook = null;
    hook?.();
    return decisions;
  }

  /** Answer the next `getBatch` for `view.batchId` with this view, after running `before`. */
  stageStaleBatchView(view: AnalysisBatch, before: () => Promise<void>): void {
    this.staleBatchView = { batchId: view.batchId, view, before };
  }

  /** Run `hook` once, after the next manual-decision read returns. */
  onNextManualDecisionsRead(hook: () => void): void {
    this.manualDecisionsHook = hook;
  }

  /**
   * Run `hook` once, immediately after the next `method` write returns.
   *
   * Arming this from {@link onNextManualDecisionsRead} targets a write *inside* the adoption
   * transaction: the manual-decision read is the last read before the commit's writes, so the
   * hook cannot fire on the claim or on a reservation.
   */
  onNextWrite(method: HookedWrite, hook: () => void): void {
    this.writeHook = { method, hook };
  }

  private fireWriteHook(method: HookedWrite): void {
    const armed = this.writeHook;
    if (armed !== null && armed.method === method) {
      // Disarm before running: the hook itself must never re-enter this store write.
      this.writeHook = null;
      armed.hook();
    }
  }

  override async saveAnalysis(result: AnalysisResult): Promise<void> {
    await super.saveAnalysis(result);
    this.fireWriteHook('saveAnalysis');
  }

  override async saveTagDecisions(decisions: readonly TagDecision[]): Promise<void> {
    await super.saveTagDecisions(decisions);
    this.fireWriteHook('saveTagDecisions');
  }

  override async saveJob(state: AnalysisJobState): Promise<void> {
    await super.saveJob(state);
    this.fireWriteHook('saveJob');
  }

  override async saveBatch(batch: AnalysisBatch, expectedRevision: number | null): Promise<number> {
    const revision = await super.saveBatch(batch, expectedRevision);
    this.fireWriteHook('saveBatch');
    return revision;
  }
}

async function withScriptedFixture(
  run: (fixture: { readonly store: ScriptedStore; readonly clock: Clock }) => Promise<void>,
): Promise<void> {
  const paths = fx.tempDatabase();
  const clock = makeClock();
  const store = new ScriptedStore({ path: paths.path, now: () => clock.now() });
  try {
    await run({ store, clock });
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
}

function makePipeline(
  store: SqliteTrainingStore,
  gateway: ModelGateway,
  clock: Clock,
  overrides: Partial<AnalysisPipelineOptions> = {},
): AnalysisPipeline {
  return new AnalysisPipeline({
    store,
    gateway,
    taxonomy: TAXONOMY,
    roles: {
      analysisModel: 'fake-analysis',
      verificationModel: 'fake-verification',
      reasoningModel: 'fake-reasoning',
      maxOutputTokens: 1024,
      temperature: 0,
    },
    limits: DEFAULT_MODEL_LIMITS,
    now: () => clock.now(),
    uniqueId: makeIdFactory(),
    ...overrides,
  });
}

function makeProblem(externalKey: string, options: { readonly statement?: string | null } = {}): NormalizedProblem {
  const instance = fx.makeInstance('codeforces', 'codeforces.com');
  return createNormalizedProblem({
    ref: { sourceInstanceId: instance.id, domain: null, externalKey },
    title: `Problem ${externalKey}`,
    url: `https://codeforces.com/problem/${externalKey}`,
    statement:
      options.statement === undefined ? 'Given an array, support range add and range sum queries.' : options.statement,
    fetchedAt: fx.AT,
    ratings: [{ dimension: 'rating', value: 1800, scale: { min: 800, max: 3500 }, raw: '1800' }],
    rawTags: ['data structures', 'segment tree'],
  });
}

function editorialSnapshot(problem: NormalizedProblem, previous: ProblemSnapshot | null = null): ProblemSnapshot {
  const source = createEditorialSource({
    id: 'editorial-1',
    kind: 'editorial',
    url: `https://editorial.example.org/${problem.ref.externalKey}`,
    title: `Editorial for ${problem.title}`,
    availability: 'found',
    retrievedAt: fx.AT,
    text: SOLUTION_TEXT,
  });
  const solution = createEditorialSolution({
    solutionId: 'solution-1',
    sourceId: source.id,
    ordinal: 0,
    title: 'Lazy segment tree',
    text: SOLUTION_TEXT,
  });
  return createProblemSnapshot({
    problem,
    sources: [source],
    solutions: [solution],
    capturedAt: previous === null ? fx.AT : fx.LATER,
    previous,
  });
}

function snapshotWithSource(problem: NormalizedProblem, availability: EditorialAvailability): ProblemSnapshot {
  const source = createEditorialSource({
    id: 'editorial-1',
    kind: 'editorial',
    url: `https://editorial.example.org/${problem.ref.externalKey}`,
    title: `Editorial for ${problem.title}`,
    availability,
    retrievedAt: fx.AT,
  });
  return createProblemSnapshot({ problem, sources: [source], solutions: [], capturedAt: fx.AT });
}

function snapshotWithoutSources(problem: NormalizedProblem): ProblemSnapshot {
  return createProblemSnapshot({ problem, sources: [], solutions: [], capturedAt: fx.AT });
}

/** Persist one problem with its snapshots (in version order). */
async function seed(
  store: SqliteTrainingStore,
  problem: NormalizedProblem,
  ...snapshots: readonly ProblemSnapshot[]
): Promise<void> {
  await store.upsertSourceInstances([fx.makeInstance('codeforces', 'codeforces.com')]);
  await store.upsertProblems([problem]);
  for (const snapshot of snapshots) {
    await store.saveSnapshot(snapshot);
  }
}

// ---------------------------------------------------------------------------------------
// Fake model gateway (tests only; production has no fake)
// ---------------------------------------------------------------------------------------

type HandlerResult<T> = ModelCallResult<T> | Promise<ModelCallResult<T>>;
type AnalyzeHandler = (request: AnalyzeRequest) => HandlerResult<AnalyzeOutcome>;
type VerifyHandler = (request: VerifyRequest) => HandlerResult<VerifyOutcome>;
type ReasonHandler = (request: ReasonRequest) => HandlerResult<ReasonOutcome>;

interface GatewayHandlers {
  readonly analyze?: AnalyzeHandler;
  readonly verify?: VerifyHandler;
  readonly reason?: ReasonHandler;
}

class FakeGateway implements ModelGateway {
  readonly analyzeRequests: AnalyzeRequest[] = [];
  readonly verifyRequests: VerifyRequest[] = [];
  readonly reasonRequests: ReasonRequest[] = [];
  private readonly handlers: GatewayHandlers;
  private readonly capabilityOverrides: Partial<ModelCapabilities>;

  constructor(handlers: GatewayHandlers, capabilityOverrides: Partial<ModelCapabilities> = {}) {
    this.handlers = handlers;
    this.capabilityOverrides = capabilityOverrides;
  }

  capabilities(): ModelCapabilities {
    return {
      provider: 'fake-provider',
      implemented: true,
      roles: ['analysis', 'verification', 'reasoning'],
      maxConcurrency: 4,
      notes: [],
      ...this.capabilityOverrides,
    };
  }

  async analyze(request: AnalyzeRequest): Promise<ModelCallResult<AnalyzeOutcome>> {
    this.analyzeRequests.push(request);
    if (!this.handlers.analyze) {
      throw new Error('unexpected analyze call');
    }
    return this.handlers.analyze(request);
  }

  async verify(request: VerifyRequest): Promise<ModelCallResult<VerifyOutcome>> {
    this.verifyRequests.push(request);
    if (!this.handlers.verify) {
      throw new Error('unexpected verify call');
    }
    return this.handlers.verify(request);
  }

  async reason(request: ReasonRequest): Promise<ModelCallResult<ReasonOutcome>> {
    this.reasonRequests.push(request);
    if (!this.handlers.reason) {
      throw new Error('unexpected reasoning call');
    }
    return this.handlers.reason(request);
  }
}

function okResult<T>(value: T, callId: string, usage = createModelUsage({ calls: 1, promptTokens: 100, completionTokens: 20 })): ModelCallResult<T> {
  return { ok: true, value, usage, callId, sessionId: `session-${callId}` };
}

function errorResult<T>(
  code: ModelErrorCode,
  message: string,
  retryable: boolean,
  callId = `call-${code}`,
): ModelCallResult<T> {
  return {
    ok: false,
    error: { code, message, retryable },
    usage: createModelUsage({ calls: 1, promptTokens: 5 }),
    callId,
  };
}

function suggestFor(snapshot: ProblemSnapshot, rationale = 'The solution uses a lazy segment tree.'): AiTagSuggestion {
  return createAiTagSuggestion({
    problemRef: snapshot.problem.ref,
    snapshotId: snapshot.snapshotId,
    taxonomyId: SEGMENT_TREE_TAG,
    role: 'analysis',
    rationale,
    evidence: [{ sourceId: 'editorial-1', solutionId: 'solution-1', excerpt: EXCERPT }],
    createdAt: fx.AT,
  });
}

function verifySupport(suggestion: AiTagSuggestion, snapshot: ProblemSnapshot): SuggestionVerification {
  return createSuggestionVerification({
    suggestionId: suggestion.suggestionId,
    problemRef: snapshot.problem.ref,
    snapshotId: snapshot.snapshotId,
    verdict: 'support',
    verifierRole: 'verification',
    evidenceOk: true,
    checkedAt: fx.AT,
  });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${label}`);
    }
    await delay(5);
  }
}

// ---------------------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------------------

void test('two-pass analysis adopts verified evidence and keeps raw platform tags', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('1A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const gateway = new FakeGateway({
      analyze: () => okResult<AnalyzeOutcome>({ suggestions: [suggestFor(snapshot)] }, 'call-analysis'),
      verify: (request) =>
        okResult<VerifyOutcome>(
          { verifications: request.suggestions.map((entry) => verifySupport(entry, snapshot)) },
          'call-verify',
        ),
    });
    const pipeline = makePipeline(store, gateway, clock);

    const prepared = await pipeline.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);
    assert.deepEqual(prepared.alreadyDone, []);
    assert.equal(batch.jobs[0]?.manualRevision, await store.getManualRevision(problem.key));

    const summary = await pipeline.run(batch.batchId);
    assert.equal(summary.status, 'completed');
    assert.equal(summary.counters.analysisCalls, 2);
    assert.equal(summary.counters.reasoningCalls, 0);
    assert.equal(summary.counters.retries, 0);

    const job = await store.getJob(analysisJobIdOf(snapshot.snapshotId));
    assert.equal(job?.status, 'succeeded');
    const analyses = await store.listAnalyses(problem.key);
    assert.equal(analyses.length, 1);
    assert.equal(analyses[0]?.suggestions.length, 1);
    assert.equal(analyses[0]?.verifications.length, 1);
    const decisions = await store.listTagDecisions(problem.key);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.status, 'auto_adopted');
    assert.equal(decisions[0]?.taxonomyId, SEGMENT_TREE_TAG);
    // Raw platform tags stay untouched and distinguishable from AI output.
    const storedProblem = await store.getProblem(problem.key);
    assert.deepEqual(storedProblem?.rawTags.map((tag) => tag.raw), ['data structures', 'segment tree']);

    const attempts = await store.listModelCallAttempts({ batchId: batch.batchId });
    assert.deepEqual(attempts.map((attempt) => attempt.role).sort(), ['analysis', 'verification']);
    assert.ok(attempts.every((attempt) => attempt.status === 'settled' && attempt.hostCallId !== null));
    assert.ok(attempts.every((attempt) => attempt.hostSessionId !== null));

    // A second prepare does not reset a finished job; it reports it as already done.
    const again = await pipeline.prepareBatch([snapshot.snapshotId], { batchId: 'second-batch' });
    assert.equal(again.batch, null);
    assert.deepEqual(again.alreadyDone.map((entry) => entry.status), ['succeeded']);
    assert.equal((await store.getJob(analysisJobIdOf(snapshot.snapshotId)))?.counters.analysisCalls, 2);
  });
});

void test('a constrained analysis budget pauses for quota and resume keeps the counters', async () => {
  await withFixture(async ({ store, clock }) => {
    const first = makeProblem('2A');
    const second = makeProblem('2B');
    const firstSnapshot = editorialSnapshot(first);
    const secondSnapshot = editorialSnapshot(second);
    await seed(store, first, firstSnapshot);
    await seed(store, second, secondSnapshot);
    const gateway = new FakeGateway({
      analyze: (request) => okResult<AnalyzeOutcome>({ suggestions: [suggestFor(request.snapshot)] }, 'call-analysis'),
      verify: (request) =>
        okResult<VerifyOutcome>(
          { verifications: request.suggestions.map((entry) => verifySupport(entry, request.snapshot)) },
          'call-verify',
        ),
    });
    const pipeline = makePipeline(store, gateway, clock, { limits: { ...DEFAULT_MODEL_LIMITS, concurrency: 1 } });
    const prepared = await pipeline.prepareBatch([firstSnapshot.snapshotId, secondSnapshot.snapshotId], {
      limits: { maxAnalysisCalls: 3, concurrency: 1 },
    });
    const batch = prepared.batch;
    assert.ok(batch);

    // 2 calls for the first job (analyze + verify), 1 for the second analyze, then the second
    // verification would exceed the budget of 3.
    const paused = await pipeline.run(batch.batchId);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.counters.analysisCalls, 3);
    assert.equal(paused.pausedForQuota, true);
    assert.equal((await store.getJob(analysisJobIdOf(firstSnapshot.snapshotId)))?.status, 'succeeded');
    assert.equal((await store.getJob(analysisJobIdOf(secondSnapshot.snapshotId)))?.status, 'paused_quota');
    assert.equal(gateway.verifyRequests.length, 1);

    await assert.rejects(
      pipeline.run(batch.batchId),
      (error: unknown) => error instanceof DomainError && error.code === 'invalid_transition',
    );

    await pipeline.resume(batch.batchId, { limits: { maxAnalysisCalls: 10 } });
    const summary = await pipeline.run(batch.batchId);
    assert.equal(summary.status, 'completed');
    assert.equal(summary.counters.analysisCalls, 4);
    // The settled analysis of the second job was reused: only its verification was paid again.
    assert.equal(gateway.analyzeRequests.length, 2);
    assert.equal(gateway.verifyRequests.length, 2);
  });
});

void test('a restart reuses a settled analysis pass instead of paying for it again', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('3A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const suggestion = suggestFor(snapshot);
    const firstGateway = new FakeGateway({
      analyze: () => okResult<AnalyzeOutcome>({ suggestions: [suggestion] }, 'call-analysis-1'),
      verify: () => errorResult<VerifyOutcome>('cancelled', 'process stopped before verification', false),
    });
    const first = makePipeline(store, firstGateway, clock, { owner: 'worker-1' });
    const prepared = await first.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);

    const interrupted = await first.run(batch.batchId);
    assert.equal(interrupted.status, 'pending');
    assert.equal(interrupted.counters.analysisCalls, 2);
    assert.equal((await store.getJob(analysisJobIdOf(snapshot.snapshotId)))?.status, 'pending');

    const resumedGateway = new FakeGateway({
      analyze: () => {
        throw new Error('the settled analysis pass must be reused, not paid for twice');
      },
      verify: (request) =>
        okResult<VerifyOutcome>(
          { verifications: request.suggestions.map((entry) => verifySupport(entry, snapshot)) },
          'call-verify-2',
        ),
    });
    const second = makePipeline(store, resumedGateway, clock, { owner: 'worker-2' });
    const summary = await second.run(batch.batchId);
    assert.equal(summary.status, 'completed', JSON.stringify({ jobs: summary.jobs, counters: summary.counters }));
    assert.equal(resumedGateway.analyzeRequests.length, 0);
    assert.equal(resumedGateway.verifyRequests.length, 1);
    assert.equal(summary.counters.analysisCalls, 3);
    assert.equal(summary.counters.retries, 0);
    // Usage is aggregated from every settled attempt of the job: the reused analysis pass and the
    // verification that was paid for but cancelled are both included.
    const analyses = await store.listAnalyses(problem.key);
    assert.equal(analyses.length, 1);
    assert.deepEqual(analyses[0]?.usage, createModelUsage({ calls: 3, promptTokens: 205, completionTokens: 40 }));
  });
});

void test('cancelling while a model result is deferred records the call but adopts nothing', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('4A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const suggestion = suggestFor(snapshot);
    let release!: (result: ModelCallResult<AnalyzeOutcome>) => void;
    const deferred = new Promise<ModelCallResult<AnalyzeOutcome>>((resolve) => {
      release = resolve;
    });
    const gateway = new FakeGateway({ analyze: () => deferred });
    const pipeline = makePipeline(store, gateway, clock);
    const prepared = await pipeline.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);

    const running = pipeline.run(batch.batchId);
    await waitFor(() => gateway.analyzeRequests.length === 1, 'the analysis call to start');
    const cancelled = await pipeline.cancel(batch.batchId);
    assert.equal(cancelled.status, 'cancelled');
    release(okResult<AnalyzeOutcome>({ suggestions: [suggestion] }, 'call-analysis-late'));

    const summary = await running;
    assert.equal(summary.status, 'cancelled');
    assert.equal((await store.getJob(analysisJobIdOf(snapshot.snapshotId)))?.status, 'cancelled');
    assert.deepEqual(await store.listAnalyses(problem.key), []);
    assert.deepEqual(await store.listTagDecisions(problem.key), []);
    // The late result stays as audit only.
    const attempts = await store.listModelCallAttempts({ batchId: batch.batchId });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.status, 'settled');
    assert.equal(attempts[0]?.hostCallId, 'call-analysis-late');
  });
});

void test('a manual decision made while the model runs prevents adoption', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('5A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const suggestion = suggestFor(snapshot);
    const gateway = new FakeGateway({
      analyze: async () => {
        await store.saveManualDecision(
          createManualTagDecision({
            problemRef: problem.ref,
            taxonomyId: SEGMENT_TREE_TAG,
            action: 'reject',
            decidedAt: fx.LATER,
          }),
        );
        return okResult<AnalyzeOutcome>({ suggestions: [suggestion] }, 'call-analysis');
      },
      verify: (request) =>
        okResult<VerifyOutcome>(
          { verifications: request.suggestions.map((entry) => verifySupport(entry, snapshot)) },
          'call-verify',
        ),
    });
    const pipeline = makePipeline(store, gateway, clock);
    const prepared = await pipeline.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);

    const summary = await pipeline.run(batch.batchId);
    assert.equal(summary.status, 'failed');
    const job = await store.getJob(analysisJobIdOf(snapshot.snapshotId));
    assert.equal(job?.status, 'failed');
    assert.equal(job?.lastError?.code, 'manual_revision_changed');
    assert.equal(summary.counters.analysisCalls, 1);
    // The changed revision is detected before the verification dispatch, which is never paid for.
    assert.equal(gateway.verifyRequests.length, 0);
    assert.deepEqual(await store.listAnalyses(problem.key), []);
    assert.deepEqual(await store.listTagDecisions(problem.key), []);
  });
});

void test('a newer snapshot published while the model runs prevents adoption', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('6A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const suggestion = suggestFor(snapshot);
    const gateway = new FakeGateway({
      analyze: async () => {
        const changed = makeProblem('6A', { statement: 'The statement was rewritten while the model ran.' });
        await store.saveSnapshot(editorialSnapshot(changed, snapshot));
        return okResult<AnalyzeOutcome>({ suggestions: [suggestion] }, 'call-analysis');
      },
      verify: (request) =>
        okResult<VerifyOutcome>(
          { verifications: request.suggestions.map((entry) => verifySupport(entry, snapshot)) },
          'call-verify',
        ),
    });
    const pipeline = makePipeline(store, gateway, clock);
    const prepared = await pipeline.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);

    const summary = await pipeline.run(batch.batchId);
    assert.equal(summary.status, 'failed');
    const job = await store.getJob(analysisJobIdOf(snapshot.snapshotId));
    assert.equal(job?.lastError?.code, 'stale_snapshot');
    assert.equal(summary.counters.analysisCalls, 1);
    // A superseded head refuses the verification dispatch instead of paying for it.
    assert.equal(gateway.verifyRequests.length, 0);
    assert.deepEqual(await store.listAnalyses(problem.key), []);
  });
});

void test('operational failures, unknown sources and a missing statement never trigger reasoning', async () => {
  await withFixture(async ({ store, clock }) => {
    const authProblem = makeProblem('7A');
    const emptyProblem = makeProblem('7B');
    const noStatementProblem = makeProblem('7C', { statement: null });
    const authSnapshot = snapshotWithSource(authProblem, 'auth_required');
    const emptySnapshot = snapshotWithoutSources(emptyProblem);
    const noStatementSnapshot = snapshotWithSource(noStatementProblem, 'absent');
    await seed(store, authProblem, authSnapshot);
    await seed(store, emptyProblem, emptySnapshot);
    await seed(store, noStatementProblem, noStatementSnapshot);
    const gateway = new FakeGateway({});
    const pipeline = makePipeline(store, gateway, clock);
    const prepared = await pipeline.prepareBatch([
      authSnapshot.snapshotId,
      emptySnapshot.snapshotId,
      noStatementSnapshot.snapshotId,
    ]);
    const batch = prepared.batch;
    assert.ok(batch);

    const summary = await pipeline.run(batch.batchId);
    assert.equal(summary.status, 'failed');
    assert.equal(gateway.analyzeRequests.length, 0);
    assert.equal(gateway.verifyRequests.length, 0);
    assert.equal(gateway.reasonRequests.length, 0);
    const codes = await Promise.all(
      batch.jobs.map(async (spec) => (await store.getJob(spec.jobId))?.lastError?.code),
    );
    assert.deepEqual([...codes].sort(), ['editorial_unknown', 'missing_statement', 'source_unavailable']);
  });
});

void test('a true editorial absence runs the reasoning role and its drafts always need review', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('8A');
    const snapshot = snapshotWithSource(problem, 'absent');
    await seed(store, problem, snapshot);
    const draft = createReasoningDraft({
      problemRef: problem.ref,
      snapshotId: snapshot.snapshotId,
      taxonomyIds: [SEGMENT_TREE_TAG],
      rationale: 'No editorial exists; the constraints suggest a segment tree.',
      createdAt: fx.AT,
    });
    const gateway = new FakeGateway({ reason: () => okResult<ReasonOutcome>({ drafts: [draft] }, 'call-reason') });
    const pipeline = makePipeline(store, gateway, clock);
    const prepared = await pipeline.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);

    const summary = await pipeline.run(batch.batchId);
    assert.equal(summary.status, 'completed');
    assert.equal(summary.counters.analysisCalls, 0);
    assert.equal(summary.counters.reasoningCalls, 1);
    const analyses = await store.listAnalyses(problem.key);
    assert.equal(analyses.length, 1);
    assert.equal(analyses[0]?.reasoningDrafts.length, 1);
    // Reasoning output is never adopted automatically.
    assert.deepEqual(await store.listTagDecisions(problem.key), []);
  });
});

void test('retryable model errors are retried with counters, non-retryable ones are not', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('9A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const suggestion = suggestFor(snapshot);
    let analyzeAttempts = 0;
    const gateway = new FakeGateway({
      analyze: () => {
        analyzeAttempts += 1;
        return analyzeAttempts === 1
          ? errorResult<AnalyzeOutcome>('rate_limited', 'slow down', true, 'call-rate-limited')
          : okResult<AnalyzeOutcome>({ suggestions: [suggestion] }, 'call-analysis');
      },
      verify: (request) =>
        okResult<VerifyOutcome>(
          { verifications: request.suggestions.map((entry) => verifySupport(entry, snapshot)) },
          'call-verify',
        ),
    });
    const pipeline = makePipeline(store, gateway, clock);
    const prepared = await pipeline.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);
    const summary = await pipeline.run(batch.batchId);
    assert.equal(summary.status, 'completed');
    assert.equal(summary.counters.analysisCalls, 3);
    assert.equal(summary.counters.retries, 1);
    const job = await store.getJob(analysisJobIdOf(snapshot.snapshotId));
    assert.equal(job?.attempts, 2);
    assert.equal(job?.counters.retries, 1);
    const attempts = await store.listModelCallAttempts({ batchId: batch.batchId });
    assert.equal(attempts.length, 3);
    assert.ok(attempts.every((attempt) => attempt.status === 'settled'));
    assert.ok(attempts.some((attempt) => attempt.error?.code === 'rate_limited'));
    // The failed retry was paid for, so it is part of the recorded usage of the adopted result.
    const analyses = await store.listAnalyses(problem.key);
    assert.equal(analyses.length, 1);
    assert.deepEqual(analyses[0]?.usage, createModelUsage({ calls: 3, promptTokens: 205, completionTokens: 40 }));

    const otherProblem = makeProblem('9B');
    const otherSnapshot = editorialSnapshot(otherProblem);
    await seed(store, otherProblem, otherSnapshot);
    const failingGateway = new FakeGateway({
      analyze: () => errorResult<AnalyzeOutcome>('invalid_output', 'not valid JSON', false),
    });
    const otherPipeline = makePipeline(store, failingGateway, clock, { owner: 'worker-other' });
    const otherPrepared = await otherPipeline.prepareBatch([otherSnapshot.snapshotId]);
    const otherBatch = otherPrepared.batch;
    assert.ok(otherBatch);
    const failed = await otherPipeline.run(otherBatch.batchId);
    assert.equal(failed.status, 'failed');
    assert.equal(failingGateway.analyzeRequests.length, 1);
    assert.equal(failed.counters.retries, 0);
    assert.equal(failed.counters.analysisCalls, 1);
  });
});

void test('two pipelines cannot execute the same batch; the live owner wins', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('10A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const suggestion = suggestFor(snapshot);
    let release!: (result: ModelCallResult<AnalyzeOutcome>) => void;
    const deferred = new Promise<ModelCallResult<AnalyzeOutcome>>((resolve) => {
      release = resolve;
    });
    const gateway = new FakeGateway({
      analyze: () => deferred,
      verify: (request) =>
        okResult<VerifyOutcome>(
          { verifications: request.suggestions.map((entry) => verifySupport(entry, snapshot)) },
          'call-verify',
        ),
    });
    const first = makePipeline(store, gateway, clock, { owner: 'owner-a' });
    const second = makePipeline(store, gateway, clock, { owner: 'owner-b' });
    const prepared = await first.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);

    const running = first.run(batch.batchId);
    await waitFor(() => gateway.analyzeRequests.length === 1, 'the first owner to dispatch');
    await assert.rejects(
      second.run(batch.batchId),
      (error: unknown) =>
        error instanceof DomainError && error.code === 'invalid_transition' && /owned by/.test(error.message),
    );
    release(okResult<AnalyzeOutcome>({ suggestions: [suggestion] }, 'call-analysis'));
    const summary = await running;
    assert.equal(summary.status, 'completed');
    assert.equal(gateway.analyzeRequests.length, 1);
    assert.equal((await store.getJob(analysisJobIdOf(snapshot.snapshotId)))?.status, 'succeeded');
  });
});

void test('recovery requeues expired work, marks reserved calls uncertain and refunds nothing', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('11A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const suggestion = suggestFor(snapshot);
    let release!: (result: ModelCallResult<AnalyzeOutcome>) => void;
    const deferred = new Promise<ModelCallResult<AnalyzeOutcome>>((resolve) => {
      release = resolve;
    });
    const gateway = new FakeGateway({ analyze: () => deferred });
    const crashed = makePipeline(store, gateway, clock, { owner: 'owner-crashed' });
    const prepared = await crashed.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);

    const abandoned = crashed.run(batch.batchId);
    await waitFor(() => gateway.analyzeRequests.length === 1, 'the crashed owner to dispatch');
    clock.at(fx.EXPIRED);
    const survivor = makePipeline(store, gateway, clock, { owner: 'owner-survivor' });
    const report = await survivor.recover(batch.batchId);
    assert.deepEqual(report.batches.map((entry) => entry.requeuedJobs), [1]);
    assert.deepEqual(report.batches.map((entry) => entry.uncertainAttempts), [1]);

    const recoveredBatch = await store.getBatch(batch.batchId);
    assert.equal(recoveredBatch?.status, 'pending');
    assert.equal(recoveredBatch?.counters.analysisCalls, 1);
    const recoveredJob = await store.getJob(analysisJobIdOf(snapshot.snapshotId));
    assert.equal(recoveredJob?.status, 'pending');
    assert.equal(recoveredJob?.counters.analysisCalls, 1);
    const attempts = await store.listModelCallAttempts({ batchId: batch.batchId });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.status, 'uncertain');
    assert.notEqual(attempts[0]?.finishedAt, null);

    // The abandoned owner finishes late but cannot adopt or spend anything more.
    release(okResult<AnalyzeOutcome>({ suggestions: [suggestion] }, 'call-late'));
    const summary = await abandoned;
    assert.notEqual(summary.status, 'completed');
    assert.equal(summary.counters.analysisCalls, 1);
    assert.deepEqual(await store.listAnalyses(problem.key), []);
  });
});

void test('a legacy batch without captured manual revisions refuses to execute', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('12A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const jobId = analysisJobIdOf(snapshot.snapshotId);
    await store.saveJob(createAnalysisJob({ problemRef: problem.ref, snapshotId: snapshot.snapshotId, at: fx.AT }));
    await store.saveBatch(
      createAnalysisBatch({ batchId: 'legacy-batch', jobs: [{ jobId, snapshotId: snapshot.snapshotId }], createdAt: fx.AT }),
      null,
    );
    const gateway = new FakeGateway({});
    const pipeline = makePipeline(store, gateway, clock);
    await assert.rejects(
      pipeline.run('legacy-batch'),
      (error: unknown) =>
        error instanceof DomainError && error.code === 'invalid_input' && /manual revision/i.test(error.message),
    );
    assert.equal(gateway.analyzeRequests.length, 0);
  });
});

void test('a job cannot be scheduled by a second active batch', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('13A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const gateway = new FakeGateway({});
    const pipeline = makePipeline(store, gateway, clock);
    const first = await pipeline.prepareBatch([snapshot.snapshotId], { batchId: 'batch-one' });
    assert.ok(first.batch);
    await assert.rejects(
      pipeline.prepareBatch([snapshot.snapshotId], { batchId: 'batch-two' }),
      (error: unknown) =>
        error instanceof DomainError && error.code === 'invalid_transition' && /active batch/.test(error.message),
    );
  });
});

void test('domain ids cover the semantic body, not only the timestamp', () => {
  const problem = makeProblem('id-1');
  const snapshot = editorialSnapshot(problem);
  const base = {
    problemRef: problem.ref,
    snapshotId: snapshot.snapshotId,
    taxonomyId: SEGMENT_TREE_TAG,
    role: 'analysis' as const,
    createdAt: fx.AT,
  };
  const evidence = [{ sourceId: 'editorial-1', solutionId: 'solution-1', excerpt: EXCERPT }];
  const first = createAiTagSuggestion({ ...base, rationale: 'rationale one', evidence });
  const second = createAiTagSuggestion({ ...base, rationale: 'rationale two', evidence });
  const replay = createAiTagSuggestion({ ...base, rationale: 'rationale one', evidence });
  assert.notEqual(first.suggestionId, second.suggestionId);
  assert.equal(first.suggestionId, replay.suggestionId);
  const otherEvidence = createAiTagSuggestion({
    ...base,
    rationale: 'rationale one',
    evidence: [{ sourceId: 'editorial-1', solutionId: 'solution-1', excerpt: 'lazy propagation keeps updates' }],
  });
  assert.notEqual(first.suggestionId, otherEvidence.suggestionId);

  const note = 'checked against the solution text';
  const verification = createSuggestionVerification({
    suggestionId: first.suggestionId,
    problemRef: problem.ref,
    snapshotId: snapshot.snapshotId,
    verdict: 'insufficient',
    verifierRole: 'verification',
    evidenceOk: false,
    checkedAt: fx.AT,
    note,
  });
  const otherNote = createSuggestionVerification({
    suggestionId: first.suggestionId,
    problemRef: problem.ref,
    snapshotId: snapshot.snapshotId,
    verdict: 'insufficient',
    verifierRole: 'verification',
    evidenceOk: false,
    checkedAt: fx.AT,
    note: 'another note',
  });
  const otherRole = createSuggestionVerification({
    suggestionId: first.suggestionId,
    problemRef: problem.ref,
    snapshotId: snapshot.snapshotId,
    verdict: 'insufficient',
    verifierRole: 'reasoning',
    evidenceOk: false,
    checkedAt: fx.AT,
    note,
  });
  const conflict = createSuggestionVerification({
    suggestionId: first.suggestionId,
    problemRef: problem.ref,
    snapshotId: snapshot.snapshotId,
    verdict: 'conflict',
    verifierRole: 'verification',
    evidenceOk: false,
    checkedAt: fx.AT,
    note,
    conflictingSolutionIds: ['solution-2'],
  });
  assert.notEqual(verification.verificationId, otherNote.verificationId);
  assert.notEqual(verification.verificationId, otherRole.verificationId);
  assert.notEqual(verification.verificationId, conflict.verificationId);

  const draftBase = {
    problemRef: problem.ref,
    snapshotId: snapshot.snapshotId,
    taxonomyIds: [SEGMENT_TREE_TAG],
    createdAt: fx.AT,
  };
  const draftOne = createReasoningDraft({ ...draftBase, rationale: 'draft one' });
  const draftTwo = createReasoningDraft({ ...draftBase, rationale: 'draft two' });
  assert.notEqual(draftOne.draftId, draftTwo.draftId);
  assert.equal(draftOne.draftId, createReasoningDraft({ ...draftBase, rationale: 'draft one' }).draftId);

  const resultInput = {
    problemRef: problem.ref,
    snapshotId: snapshot.snapshotId,
    snapshotVersion: snapshot.version,
    taxonomyVersion: TAXONOMY.version,
    createdAt: fx.AT,
    status: 'completed' as const,
    suggestions: [first],
    verifications: [verification],
  };
  const result = createAnalysisResult({ ...resultInput, usage: createModelUsage({ calls: 1, promptTokens: 10 }) });
  const otherUsage = createAnalysisResult({ ...resultInput, usage: createModelUsage({ calls: 2, promptTokens: 20 }) });
  assert.notEqual(result.analysisId, otherUsage.analysisId);
  assert.equal(
    result.analysisId,
    createAnalysisResult({ ...resultInput, usage: createModelUsage({ calls: 1, promptTokens: 10 }) }).analysisId,
  );
});

// ---------------------------------------------------------------------------------------
// Repair regressions: staleness, cancellation, pause, races and accounting
// ---------------------------------------------------------------------------------------

void test('a manual decision made after preparation fails the job before any paid call', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('14A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const gateway = new FakeGateway({
      analyze: () => {
        throw new Error('no call may be dispatched against a stale manual revision');
      },
    });
    const pipeline = makePipeline(store, gateway, clock);
    const prepared = await pipeline.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);
    await store.saveManualDecision(
      createManualTagDecision({
        problemRef: problem.ref,
        taxonomyId: SEGMENT_TREE_TAG,
        action: 'reject',
        decidedAt: fx.LATER,
      }),
    );

    const summary = await pipeline.run(batch.batchId);
    assert.equal(summary.status, 'failed');
    assert.equal(summary.counters.analysisCalls, 0);
    assert.equal(gateway.analyzeRequests.length, 0);
    const job = await store.getJob(analysisJobIdOf(snapshot.snapshotId));
    assert.equal(job?.status, 'failed');
    assert.equal(job?.lastError?.code, 'manual_revision_changed');
    assert.equal(job?.attempts, 0);
    assert.deepEqual(await store.listAnalyses(problem.key), []);
    assert.deepEqual(await store.listTagDecisions(problem.key), []);
  });
});

void test('a snapshot superseded by the analysis pass refuses the verification dispatch', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('15A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const suggestion = suggestFor(snapshot);
    const gateway = new FakeGateway({
      analyze: async () => {
        const changed = makeProblem('15A', { statement: 'Rewritten while the analysis call was in flight.' });
        await store.saveSnapshot(editorialSnapshot(changed, snapshot));
        return okResult<AnalyzeOutcome>({ suggestions: [suggestion] }, 'call-analysis');
      },
      verify: () => {
        throw new Error('verification must not be dispatched against a superseded snapshot');
      },
    });
    const pipeline = makePipeline(store, gateway, clock);
    const prepared = await pipeline.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);

    const summary = await pipeline.run(batch.batchId);
    assert.equal(summary.status, 'failed');
    assert.equal(gateway.analyzeRequests.length, 1);
    assert.equal(gateway.verifyRequests.length, 0);
    assert.equal(summary.counters.analysisCalls, 1);
    const job = await store.getJob(analysisJobIdOf(snapshot.snapshotId));
    assert.equal(job?.lastError?.code, 'stale_snapshot');
    const attempts = await store.listModelCallAttempts({ batchId: batch.batchId });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.status, 'settled');
    assert.deepEqual(await store.listAnalyses(problem.key), []);
  });
});

void test('an external cancellation during verification cancels terminally and keeps the paid audit', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('16A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const suggestion = suggestFor(snapshot);
    const external = createCancellationSource();
    let release!: (result: ModelCallResult<VerifyOutcome>) => void;
    const deferred = new Promise<ModelCallResult<VerifyOutcome>>((resolve) => {
      release = resolve;
    });
    const gateway = new FakeGateway({
      analyze: () => okResult<AnalyzeOutcome>({ suggestions: [suggestion] }, 'call-analysis'),
      verify: () => deferred,
    });
    const pipeline = makePipeline(store, gateway, clock);
    const prepared = await pipeline.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);

    const running = pipeline.run(batch.batchId, external.token);
    await waitFor(() => gateway.verifyRequests.length === 1, 'the verification call to start');
    external.cancel('the user stopped the run');
    // The gateway ignores the token and answers with a perfectly valid verification.
    release(okResult<VerifyOutcome>({ verifications: [verifySupport(suggestion, snapshot)] }, 'call-verify-late'));

    const summary = await running;
    assert.equal(summary.status, 'cancelled');
    assert.equal((await store.getBatch(batch.batchId))?.status, 'cancelled');
    assert.equal((await store.getJob(analysisJobIdOf(snapshot.snapshotId)))?.status, 'cancelled');
    assert.deepEqual(await store.listAnalyses(problem.key), []);
    assert.deepEqual(await store.listTagDecisions(problem.key), []);
    const attempts = await store.listModelCallAttempts({ batchId: batch.batchId });
    assert.equal(attempts.length, 2);
    assert.ok(attempts.every((attempt) => attempt.status === 'settled'));
    assert.ok(attempts.some((attempt) => attempt.hostCallId === 'call-verify-late'));
  });
});

void test('a pre-cancelled token cancels the batch terminally without dispatching', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('17A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const gateway = new FakeGateway({
      analyze: () => {
        throw new Error('a pre-cancelled run must not dispatch anything');
      },
    });
    const pipeline = makePipeline(store, gateway, clock);
    const prepared = await pipeline.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);
    const external = createCancellationSource();
    external.cancel('stopped before the run began');

    const summary = await pipeline.run(batch.batchId, external.token);
    assert.equal(summary.status, 'cancelled');
    assert.equal(summary.counters.analysisCalls, 0);
    assert.equal(gateway.analyzeRequests.length, 0);
    assert.equal((await store.getBatch(batch.batchId))?.status, 'cancelled');
    assert.equal((await store.getJob(analysisJobIdOf(snapshot.snapshotId)))?.status, 'cancelled');
    assert.deepEqual(await store.listAnalyses(problem.key), []);
  });
});

void test('a cancellation that lands inside the commit rolls back and cancels terminally', async () => {
  await withScriptedFixture(async ({ store, clock }) => {
    const problem = makeProblem('18A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const suggestion = suggestFor(snapshot);
    const external = createCancellationSource();
    const gateway = new FakeGateway({
      analyze: () => okResult<AnalyzeOutcome>({ suggestions: [suggestion] }, 'call-analysis'),
      verify: (request) =>
        okResult<VerifyOutcome>(
          { verifications: request.suggestions.map((entry) => verifySupport(entry, snapshot)) },
          'call-verify',
        ),
    });
    const pipeline = makePipeline(store, gateway, clock);
    const prepared = await pipeline.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);
    // `listManualDecisions` is only read inside the commit transaction: cancelling there proves
    // the token is re-checked after the callback's awaits, before any write.
    store.onNextManualDecisionsRead(() => external.cancel('cancelled during the commit'));

    const summary = await pipeline.run(batch.batchId, external.token);
    assert.equal(summary.status, 'cancelled');
    assert.deepEqual(await store.listAnalyses(problem.key), []);
    assert.deepEqual(await store.listTagDecisions(problem.key), []);
    assert.equal((await store.getJob(analysisJobIdOf(snapshot.snapshotId)))?.status, 'cancelled');
    const attempts = await store.listModelCallAttempts({ batchId: batch.batchId });
    assert.equal(attempts.length, 2);
    assert.ok(attempts.every((attempt) => attempt.status === 'settled'));
  });
});

void test('a pause aborts the local call, keeps the paid result and adopts nothing', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('19A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const suggestion = suggestFor(snapshot);
    let release!: (result: ModelCallResult<AnalyzeOutcome>) => void;
    const deferred = new Promise<ModelCallResult<AnalyzeOutcome>>((resolve) => {
      release = resolve;
    });
    const gateway = new FakeGateway({
      analyze: () => deferred,
      verify: (request) =>
        okResult<VerifyOutcome>(
          { verifications: request.suggestions.map((entry) => verifySupport(entry, snapshot)) },
          'call-verify',
        ),
    });
    const pipeline = makePipeline(store, gateway, clock);
    const prepared = await pipeline.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);

    const running = pipeline.run(batch.batchId);
    await waitFor(() => gateway.analyzeRequests.length === 1, 'the analysis call to start');
    const paused = await pipeline.pause(batch.batchId);
    assert.equal(paused.status, 'paused');
    // The gateway ignores the abort and answers with a valid analysis.
    release(okResult<AnalyzeOutcome>({ suggestions: [suggestion] }, 'call-analysis-late'));

    const stopped = await running;
    assert.equal(stopped.status, 'paused');
    assert.deepEqual(await store.listAnalyses(problem.key), []);
    assert.deepEqual(await store.listTagDecisions(problem.key), []);
    // Not terminal: the job is schedulable again and the paid call stays as audit.
    const job = await store.getJob(analysisJobIdOf(snapshot.snapshotId));
    assert.equal(job?.status, 'pending');
    const attempts = await store.listModelCallAttempts({ batchId: batch.batchId });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.status, 'settled');

    // Resume reuses the settled analysis: only the verification is paid again.
    await pipeline.resume(batch.batchId);
    const resumed = await pipeline.run(batch.batchId);
    assert.equal(resumed.status, 'completed');
    assert.equal(gateway.analyzeRequests.length, 1);
    assert.equal(gateway.verifyRequests.length, 1);
  });
});

void test('two simultaneous run calls on one pipeline claim and dispatch only once', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('20A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const suggestion = suggestFor(snapshot);
    let release!: (result: ModelCallResult<AnalyzeOutcome>) => void;
    const deferred = new Promise<ModelCallResult<AnalyzeOutcome>>((resolve) => {
      release = resolve;
    });
    const gateway = new FakeGateway({
      analyze: () => deferred,
      verify: (request) =>
        okResult<VerifyOutcome>(
          { verifications: request.suggestions.map((entry) => verifySupport(entry, snapshot)) },
          'call-verify',
        ),
    });
    const pipeline = makePipeline(store, gateway, clock);
    const prepared = await pipeline.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);

    const running = pipeline.run(batch.batchId);
    const raced = pipeline.run(batch.batchId);
    await assert.rejects(
      raced,
      (error: unknown) =>
        error instanceof DomainError && error.code === 'invalid_transition' && /already running/.test(error.message),
    );
    await waitFor(() => gateway.analyzeRequests.length === 1, 'exactly one dispatch');
    release(okResult<AnalyzeOutcome>({ suggestions: [suggestion] }, 'call-analysis'));
    const summary = await running;
    assert.equal(summary.status, 'completed');
    assert.equal(gateway.analyzeRequests.length, 1);
  });
});

void test('in-flight calls never exceed the smallest configured concurrency limit', async () => {
  await withFixture(async ({ store, clock }) => {
    const first = makeProblem('21A');
    const second = makeProblem('21B');
    const firstSnapshot = editorialSnapshot(first);
    const secondSnapshot = editorialSnapshot(second);
    await seed(store, first, firstSnapshot);
    await seed(store, second, secondSnapshot);
    let inFlight = 0;
    let maxInFlight = 0;
    const track = async <T>(value: T): Promise<T> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(10);
      inFlight -= 1;
      return value;
    };
    const gateway = new FakeGateway(
      {
        analyze: (request) =>
          track(okResult<AnalyzeOutcome>({ suggestions: [suggestFor(request.snapshot)] }, 'call-analysis')),
        verify: (request) =>
          track(
            okResult<VerifyOutcome>(
              { verifications: request.suggestions.map((entry) => verifySupport(entry, request.snapshot)) },
              'call-verify',
            ),
          ),
      },
      { maxConcurrency: 1 },
    );
    const pipeline = makePipeline(store, gateway, clock, {
      limits: { ...DEFAULT_MODEL_LIMITS, concurrency: 2 },
    });
    const prepared = await pipeline.prepareBatch([firstSnapshot.snapshotId, secondSnapshot.snapshotId], {
      limits: { concurrency: 4, maxAnalysisCalls: 20 },
    });
    const batch = prepared.batch;
    assert.ok(batch);

    const summary = await pipeline.run(batch.batchId);
    assert.equal(summary.status, 'completed');
    assert.equal(maxInFlight, 1);
    assert.equal(gateway.analyzeRequests.length, 2);
  });
});

void test('two instances sharing one owner string cannot duplicate a live claim', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('22A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const suggestion = suggestFor(snapshot);
    let release!: (result: ModelCallResult<AnalyzeOutcome>) => void;
    const deferred = new Promise<ModelCallResult<AnalyzeOutcome>>((resolve) => {
      release = resolve;
    });
    const gateway = new FakeGateway({
      analyze: () => deferred,
      verify: (request) =>
        okResult<VerifyOutcome>(
          { verifications: request.suggestions.map((entry) => verifySupport(entry, snapshot)) },
          'call-verify',
        ),
    });
    const first = makePipeline(store, gateway, clock, { owner: 'shared-owner' });
    const second = makePipeline(store, gateway, clock, { owner: 'shared-owner' });
    const prepared = await first.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);

    const running = first.run(batch.batchId);
    await waitFor(() => gateway.analyzeRequests.length === 1, 'the first owner to dispatch');
    await assert.rejects(
      second.run(batch.batchId),
      (error: unknown) =>
        error instanceof DomainError && error.code === 'invalid_transition' && /owned by shared-owner/.test(error.message),
    );
    release(okResult<AnalyzeOutcome>({ suggestions: [suggestion] }, 'call-analysis'));
    const summary = await running;
    assert.equal(summary.status, 'completed');
    assert.equal(gateway.analyzeRequests.length, 1);
  });
});

void test('a pause that lands between the initial read and the claim refuses the run', async () => {
  await withScriptedFixture(async ({ store, clock }) => {
    const problem = makeProblem('23A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const gateway = new FakeGateway({
      analyze: () => {
        throw new Error('a paused batch must not dispatch');
      },
    });
    const pipeline = makePipeline(store, gateway, clock);
    const prepared = await pipeline.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);
    // The next `getBatch` is answered with the pre-pause (pending) view while the store already
    // holds `paused`: the claim's own re-read must refuse instead of stealing it.
    store.stageStaleBatchView(batch, async () => {
      await pipeline.pause(batch.batchId);
    });

    await assert.rejects(
      pipeline.run(batch.batchId),
      (error: unknown) =>
        error instanceof DomainError && error.code === 'invalid_transition' && /paused/.test(error.message),
    );
    assert.equal(gateway.analyzeRequests.length, 0);
    const stored = await store.getBatch(batch.batchId);
    assert.equal(stored?.status, 'paused');
    assert.equal(stored?.owner, null);
    assert.equal((await store.getJob(analysisJobIdOf(snapshot.snapshotId)))?.status, 'pending');
  });
});

void test('recover reclaims an expired lease of its own owner while resume refuses a running batch', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('24A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const suggestion = suggestFor(snapshot);
    let release!: (result: ModelCallResult<AnalyzeOutcome>) => void;
    const deferred = new Promise<ModelCallResult<AnalyzeOutcome>>((resolve) => {
      release = resolve;
    });
    const gateway = new FakeGateway({ analyze: () => deferred });
    const pipeline = makePipeline(store, gateway, clock, { owner: 'owner-self' });
    const prepared = await pipeline.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);
    const abandoned = pipeline.run(batch.batchId);
    await waitFor(() => gateway.analyzeRequests.length === 1, 'the owner to dispatch');

    // A live lease is never stolen by resume, not even by the pipeline that owns it.
    await assert.rejects(
      pipeline.resume(batch.batchId),
      (error: unknown) =>
        error instanceof DomainError && error.code === 'invalid_transition' && /running/.test(error.message),
    );

    clock.at(fx.EXPIRED);
    const report = await pipeline.recover(batch.batchId);
    assert.deepEqual(report.batches.map((entry) => entry.skipped), [null]);
    const recovered = await store.getBatch(batch.batchId);
    assert.equal(recovered?.status, 'pending');
    assert.equal(recovered?.counters.analysisCalls, 1);
    assert.equal((await store.getJob(analysisJobIdOf(snapshot.snapshotId)))?.status, 'pending');

    // The abandoned call settles late but can no longer adopt or spend.
    release(okResult<AnalyzeOutcome>({ suggestions: [suggestion] }, 'call-late'));
    const summary = await abandoned;
    assert.notEqual(summary.status, 'completed');
    assert.equal(summary.counters.analysisCalls, 1);
    assert.deepEqual(await store.listAnalyses(problem.key), []);
  });
});

void test('a gateway quota_exhausted result pauses the batch instead of burning retries', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('25A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const suggestion = suggestFor(snapshot);
    let exhausted = true;
    const gateway = new FakeGateway({
      analyze: () =>
        exhausted
          ? errorResult<AnalyzeOutcome>('quota_exhausted', 'provider quota reached', true, 'call-quota')
          : okResult<AnalyzeOutcome>({ suggestions: [suggestion] }, 'call-analysis'),
      verify: (request) =>
        okResult<VerifyOutcome>(
          { verifications: request.suggestions.map((entry) => verifySupport(entry, snapshot)) },
          'call-verify',
        ),
    });
    const pipeline = makePipeline(store, gateway, clock);
    const prepared = await pipeline.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);

    const paused = await pipeline.run(batch.batchId);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pausedForQuota, true);
    assert.equal(gateway.analyzeRequests.length, 1);
    assert.equal(paused.counters.analysisCalls, 1);
    assert.equal(paused.counters.retries, 0);
    const job = await store.getJob(analysisJobIdOf(snapshot.snapshotId));
    assert.equal(job?.status, 'paused_quota');
    assert.equal(job?.lastError?.code, 'quota_exhausted');

    exhausted = false;
    await pipeline.resume(batch.batchId);
    const summary = await pipeline.run(batch.batchId);
    assert.equal(summary.status, 'completed');
    assert.equal(gateway.analyzeRequests.length, 2);
  });
});

void test('a throwing gateway call is settled as uncertain and never retried blindly', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('26A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const gateway = new FakeGateway({
      analyze: () => {
        throw new Error('socket closed');
      },
    });
    const pipeline = makePipeline(store, gateway, clock);
    const prepared = await pipeline.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);

    const summary = await pipeline.run(batch.batchId);
    assert.equal(summary.status, 'failed');
    assert.equal(gateway.analyzeRequests.length, 1);
    assert.equal(summary.counters.analysisCalls, 1);
    assert.equal(summary.counters.retries, 0);
    assert.equal(summary.uncertainAttempts, 1);
    const attempts = await store.listModelCallAttempts({ batchId: batch.batchId });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.status, 'uncertain');
    assert.equal(attempts[0]?.usage, null);
    assert.equal(attempts[0]?.error?.code, 'provider_error');
    const job = await store.getJob(analysisJobIdOf(snapshot.snapshotId));
    assert.equal(job?.status, 'failed');
    assert.equal(job?.lastError?.code, 'provider_error');
    assert.deepEqual(await store.listAnalyses(problem.key), []);
  });
});

void test('an exhausted retry budget stays bounded across an explicit resume', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('27A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    let calls = 0;
    const gateway = new FakeGateway({
      analyze: () => {
        calls += 1;
        return errorResult<AnalyzeOutcome>('rate_limited', 'slow down', true, `call-rate-limited-${calls}`);
      },
    });
    const pipeline = makePipeline(store, gateway, clock);
    const prepared = await pipeline.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);

    // maxRetries is 2 but the job attempt budget is 2 as well: the loop stops as soon as the job
    // can no longer be restarted, so the paid calls stay bounded.
    const failed = await pipeline.run(batch.batchId);
    assert.equal(failed.status, 'failed');
    assert.equal(gateway.analyzeRequests.length, 2);
    assert.equal(failed.counters.analysisCalls, 2);
    assert.equal(failed.counters.retries, 1);

    // A terminal failed batch is never retried implicitly.
    await assert.rejects(
      pipeline.run(batch.batchId),
      (error: unknown) => error instanceof DomainError && error.code === 'invalid_transition',
    );
    assert.equal(gateway.analyzeRequests.length, 2);

    // An explicit resume runs the job once more with every counter preserved.
    await pipeline.resume(batch.batchId);
    const again = await pipeline.run(batch.batchId);
    assert.equal(again.status, 'failed');
    assert.equal(gateway.analyzeRequests.length, 3);
    assert.equal(again.counters.analysisCalls, 3);
    const job = await store.getJob(analysisJobIdOf(snapshot.snapshotId));
    assert.equal(job?.attempts, 3);
    assert.equal(job?.counters.analysisCalls, 3);
  });
});

void test('a settled analysis pass is only reused under the same provider and prompt identity', async () => {
  await withFixture(async ({ store, clock }) => {
    const firstProblem = makeProblem('28A');
    const firstSnapshot = editorialSnapshot(firstProblem);
    await seed(store, firstProblem, firstSnapshot);
    const suggestion = suggestFor(firstSnapshot);
    const interrupted = new FakeGateway({
      analyze: () => okResult<AnalyzeOutcome>({ suggestions: [suggestion] }, 'call-analysis'),
      verify: () => errorResult<VerifyOutcome>('cancelled', 'process stopped before verification', false),
    });
    const owner = makePipeline(store, interrupted, clock, { owner: 'cache-owner' });
    const firstPrepared = await owner.prepareBatch([firstSnapshot.snapshotId]);
    const firstBatch = firstPrepared.batch;
    assert.ok(firstBatch);
    await owner.run(firstBatch.batchId);
    const analysisAttempt = (await store.listModelCallAttempts({ batchId: firstBatch.batchId })).find(
      (attempt) => attempt.role === 'analysis',
    );
    assert.equal(analysisAttempt?.provider, 'fake-provider');
    assert.equal(analysisAttempt?.promptVersion, 'analysis-v1|taxonomy:test-v1');

    // A different provider must not reuse a pass that was paid for under another provider.
    const otherProvider = new FakeGateway(
      {
        analyze: () => okResult<AnalyzeOutcome>({ suggestions: [suggestion] }, 'call-analysis-2'),
        verify: (request) =>
          okResult<VerifyOutcome>(
            { verifications: request.suggestions.map((entry) => verifySupport(entry, firstSnapshot)) },
            'call-verify-2',
          ),
      },
      { provider: 'other-provider' },
    );
    const foreign = makePipeline(store, otherProvider, clock, { owner: 'cache-owner' });
    const foreignSummary = await foreign.run(firstBatch.batchId);
    assert.equal(foreignSummary.status, 'completed');
    assert.equal(otherProvider.analyzeRequests.length, 1);

    // Same provider, different taxonomy version: the model input changed, so no reuse either.
    const secondProblem = makeProblem('28B');
    const secondSnapshot = editorialSnapshot(secondProblem);
    await seed(store, secondProblem, secondSnapshot);
    const secondSuggestion = suggestFor(secondSnapshot);
    const secondOwner = makePipeline(
      store,
      new FakeGateway({
        analyze: () => okResult<AnalyzeOutcome>({ suggestions: [secondSuggestion] }, 'call-analysis'),
        verify: () => errorResult<VerifyOutcome>('cancelled', 'process stopped before verification', false),
      }),
      clock,
      { owner: 'cache-owner' },
    );
    const secondPrepared = await secondOwner.prepareBatch([secondSnapshot.snapshotId]);
    const secondBatch = secondPrepared.batch;
    assert.ok(secondBatch);
    await secondOwner.run(secondBatch.batchId);

    const retagged = new FakeGateway({
      analyze: () => okResult<AnalyzeOutcome>({ suggestions: [secondSuggestion] }, 'call-analysis-2'),
      verify: (request) =>
        okResult<VerifyOutcome>(
          { verifications: request.suggestions.map((entry) => verifySupport(entry, secondSnapshot)) },
          'call-verify-2',
        ),
    });
    const retaggedPipeline = makePipeline(store, retagged, clock, {
      owner: 'cache-owner',
      taxonomy: makeTaxonomy('test-v2'),
    });
    const retaggedSummary = await retaggedPipeline.run(secondBatch.batchId);
    assert.equal(retaggedSummary.status, 'completed');
    assert.equal(retagged.analyzeRequests.length, 1);
  });
});

// ---------------------------------------------------------------------------------------
// Repair 2: capability validation before the claim, and rollback of a cancelled adoption
// ---------------------------------------------------------------------------------------

void test('an unimplemented provider refuses before claiming and leaves the batch unspent', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('29A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const gateway = new FakeGateway(
      {
        analyze: () => {
          throw new Error('an unimplemented provider must never be dispatched to');
        },
      },
      { implemented: false },
    );
    const pipeline = makePipeline(store, gateway, clock);
    const prepared = await pipeline.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);

    await assert.rejects(
      pipeline.run(batch.batchId),
      (error: unknown) =>
        error instanceof DomainError && error.code === 'invalid_input' && /no implementation/.test(error.message),
    );

    // The claim never happened: the batch is exactly as `prepareBatch` left it.
    const stored = await store.getBatch(batch.batchId);
    assert.equal(stored?.status, 'pending');
    assert.equal(stored?.owner, null);
    assert.equal(stored?.leaseExpiresAt, null);
    assert.equal(stored?.revision, batch.revision);
    assert.equal(stored?.counters.analysisCalls, 0);
    assert.equal(stored?.counters.reasoningCalls, 0);
    assert.equal(stored?.counters.retries, 0);
    const job = await store.getJob(analysisJobIdOf(snapshot.snapshotId));
    assert.equal(job?.status, 'pending');
    assert.equal(job?.attempts, 0);
    assert.equal(job?.counters.analysisCalls, 0);
    assert.deepEqual(await store.listModelCallAttempts({ batchId: batch.batchId }), []);
    assert.equal(gateway.analyzeRequests.length, 0);
  });
});

void test('a concurrency advert that is not a finite positive integer refuses before claiming', async () => {
  await withFixture(async ({ store, clock }) => {
    const problem = makeProblem('30A');
    const snapshot = editorialSnapshot(problem);
    await seed(store, problem, snapshot);
    const prepared = await makePipeline(store, new FakeGateway({}), clock).prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);

    for (const maxConcurrency of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const gateway = new FakeGateway(
        {
          analyze: () => {
            throw new Error('an invalid concurrency advert must never be dispatched to');
          },
        },
        { maxConcurrency },
      );
      await assert.rejects(
        makePipeline(store, gateway, clock).run(batch.batchId),
        (error: unknown) =>
          error instanceof DomainError &&
          error.code === 'invalid_input' &&
          /maxConcurrency/.test(error.message),
        `maxConcurrency=${String(maxConcurrency)} must be refused`,
      );
      const stored = await store.getBatch(batch.batchId);
      assert.equal(stored?.status, 'pending', `maxConcurrency=${String(maxConcurrency)}`);
      assert.equal(stored?.owner, null, `maxConcurrency=${String(maxConcurrency)}`);
      assert.equal(stored?.leaseExpiresAt, null, `maxConcurrency=${String(maxConcurrency)}`);
      assert.equal(stored?.counters.analysisCalls, 0, `maxConcurrency=${String(maxConcurrency)}`);
      assert.equal(gateway.analyzeRequests.length, 0, `maxConcurrency=${String(maxConcurrency)}`);
      assert.equal(
        (await store.getJob(analysisJobIdOf(snapshot.snapshotId)))?.attempts,
        0,
        `maxConcurrency=${String(maxConcurrency)}`,
      );
    }

    // Nothing was consumed: the very same batch still completes under a healthy advert.
    const healthy = new FakeGateway({
      analyze: (request) => okResult<AnalyzeOutcome>({ suggestions: [suggestFor(request.snapshot)] }, 'call-analysis'),
      verify: (request) =>
        okResult<VerifyOutcome>(
          { verifications: request.suggestions.map((entry) => verifySupport(entry, request.snapshot)) },
          'call-verify',
        ),
    });
    const summary = await makePipeline(store, healthy, clock).run(batch.batchId);
    assert.equal(summary.status, 'completed');
    assert.equal(summary.counters.analysisCalls, 2);
  });
});

void test('a cancellation injected inside an adoption write rolls the whole commit back', async () => {
  const writes = ['saveAnalysis', 'saveTagDecisions', 'saveJob', 'saveBatch'] as const;
  for (const method of writes) {
    await withScriptedFixture(async ({ store, clock }) => {
      const problem = makeProblem(`31-${method}`);
      const snapshot = editorialSnapshot(problem);
      await seed(store, problem, snapshot);
      const suggestion = suggestFor(snapshot);
      const external = createCancellationSource();
      const gateway = new FakeGateway({
        analyze: () => okResult<AnalyzeOutcome>({ suggestions: [suggestion] }, 'call-analysis'),
        verify: (request) =>
          okResult<VerifyOutcome>(
            { verifications: request.suggestions.map((entry) => verifySupport(entry, snapshot)) },
            'call-verify',
          ),
      });
      const pipeline = makePipeline(store, gateway, clock);
      const prepared = await pipeline.prepareBatch([snapshot.snapshotId]);
      const batch = prepared.batch;
      assert.ok(batch);
      // Arm the write hook on the last read of the commit transaction, so it can only fire on the
      // adoption writes (never on the claim or on an attempt reservation).
      store.onNextManualDecisionsRead(() => {
        store.onNextWrite(method, () => external.cancel(`cancelled right after ${method}`));
      });

      const rejections: unknown[] = [];
      const onRejection = (reason: unknown): void => {
        rejections.push(reason);
      };
      process.on('unhandledRejection', onRejection);
      try {
        const summary = await pipeline.run(batch.batchId, external.token);
        // Give a rejection that escaped the run a tick to surface before detaching the listener.
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(summary.status, 'cancelled', method);
        assert.equal(summary.counters.analysisCalls, 2, method);
      } finally {
        process.off('unhandledRejection', onRejection);
      }

      assert.deepEqual(rejections, [], `unhandled rejection after ${method}`);
      // The commit threw to force a real rollback: no analysis and no decision survived it.
      assert.deepEqual(await store.listAnalyses(problem.key), [], method);
      assert.deepEqual(await store.listTagDecisions(problem.key), [], method);
      // The cancellation is still made durable, and it is terminal for both batch and job.
      assert.equal((await store.getBatch(batch.batchId))?.status, 'cancelled', method);
      assert.equal((await store.getJob(analysisJobIdOf(snapshot.snapshotId)))?.status, 'cancelled', method);
      // The paid audit rows live outside the rollback and are preserved as settled calls.
      const attempts = await store.listModelCallAttempts({ batchId: batch.batchId });
      assert.equal(attempts.length, 2, method);
      assert.ok(attempts.every((attempt) => attempt.status === 'settled'), method);
      assert.ok(attempts.every((attempt) => attempt.usage !== null), method);
      assert.ok(attempts.some((attempt) => attempt.hostCallId === 'call-analysis'), method);
      assert.ok(attempts.some((attempt) => attempt.hostCallId === 'call-verify'), method);
    });
  }
});
