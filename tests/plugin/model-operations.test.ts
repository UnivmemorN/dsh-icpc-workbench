/**
 * Owned model operations over a real SQLite store, the real `AnalysisPipeline` and the real
 * `CoachingService` (Stage 4h2a).
 *
 * Only two things are faked, both at the outer boundary: the model gateway and the coaching
 * generator (scripted, local, never paid) — plus the injected model-metadata probe, which is a
 * host-composition concern. Everything under test is production code against a real temporary
 * database, so the assertions cover externally meaningful behaviour: snapshot/settings consistency,
 * the one synchronous start/save gate, owned background cancellation, bounded/redacted projections,
 * durable coaching idempotence across a settings change, unknown cost that is never estimated,
 * orphan reservations that must not block configuration forever, and a bounded disposal that reports
 * what is still outstanding.
 */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { AnalysisPipeline } from '../../src/application/analysis-pipeline.js';
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
import {
  CoachingService,
  type CoachingAnsweredView,
  type CoachingUnansweredView,
} from '../../src/application/coaching-service.js';
import type { CoachingAttempt } from '../../src/application/coaching-types.js';
import type {
  CoachingGenerationOutcome,
  CoachingGenerationRequest,
} from '../../src/application/coaching-generation.js';
import {
  ModelOperationError,
  type ModelBatchDetailResult,
  type ModelBatchJobView,
  type ModelBatchPrepareResult,
  type ModelCoachingAskRequest,
  type ModelOperationErrorCode,
  type ModelValidationDiagnostic,
} from '../../src/application/model-operation-types.js';
import {
  defaultWorkbenchSettings,
  type WorkbenchSettings,
} from '../../src/application/workbench-settings.js';
import {
  DomainError,
  createAiTagSuggestion,
  createCancellationSource,
  createEditorialSource,
  createModelUsage,
  createProblemSnapshot,
  createSuggestionVerification,
  createTaxonomy,
  type AiTagSuggestion,
  type CancellationToken,
  type ModelUsage,
  type NormalizedProblem,
  type ProblemSnapshot,
} from '../../src/domain/index.js';
import { ModelOperations, type ModelOperationFailureReport } from '../../src/plugin/model-operations.js';
import * as fx from '../storage/fixtures.js';

const AT = '2027-01-05T08:00:00.000Z';
const LATER = '2027-01-05T09:00:00.000Z';
const TAG = 'data-structure.segment-tree';
const HINT = '先想清楚一次区间修改会影响哪些节点，不要急着写代码。';
const EXCERPT = 'lazy propagation';
const PROVIDER_FAILURE_TEXT = 'provider socket closed before usage was reported';
const USAGE = createModelUsage({ calls: 1, promptTokens: 120, completionTokens: 40 });
/** A token nobody cancels: the "normal caller" of most cases. */
const TOKEN = createCancellationSource().token;

const TAXONOMY = createTaxonomy({
  version: 'ops-v1',
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
      id: TAG,
      parentId: 'data-structure',
      kind: 'technique',
      names: { en: 'Segment tree', zh: '线段树' },
      aliases: ['segment tree'],
      description: 'range queries',
    },
  ],
});

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

function absentSnapshot(problem: NormalizedProblem): ProblemSnapshot {
  const source = createEditorialSource({
    id: 'editorial-1',
    kind: 'editorial',
    url: `https://editorial.example.org/${problem.ref.externalKey}`,
    title: `Editorial for ${problem.title}`,
    availability: 'absent',
    retrievedAt: AT,
  });
  return createProblemSnapshot({ problem, sources: [source], solutions: [], capturedAt: AT });
}

function okAnalyze(
  snapshot: ProblemSnapshot,
  options: { readonly usage?: ModelUsage; readonly callId?: string } = {},
): ModelCallResult<AnalyzeOutcome> {
  const suggestion = createAiTagSuggestion({
    problemRef: snapshot.problem.ref,
    snapshotId: snapshot.snapshotId,
    taxonomyId: TAG,
    role: 'analysis',
    rationale: 'The editorial solution uses a lazy segment tree.',
    evidence: [{ sourceId: 'editorial-1', solutionId: 'solution-1', excerpt: EXCERPT }],
    createdAt: AT,
  });
  return {
    ok: true,
    value: { suggestions: [suggestion] },
    usage: options.usage ?? USAGE,
    callId: options.callId ?? 'call-analysis',
    sessionId: 'session-1',
  };
}

function okVerify(
  suggestions: readonly AiTagSuggestion[],
  snapshot: ProblemSnapshot,
  callId = 'call-verify',
): ModelCallResult<VerifyOutcome> {
  return {
    ok: true,
    value: {
      verifications: suggestions.map((suggestion) =>
        createSuggestionVerification({
          suggestionId: suggestion.suggestionId,
          problemRef: snapshot.problem.ref,
          snapshotId: snapshot.snapshotId,
          verdict: 'support',
          verifierRole: 'verification',
          evidenceOk: true,
          checkedAt: AT,
        }),
      ),
    },
    usage: USAGE,
    callId,
    sessionId: 'session-1',
  };
}

/** Scripted, local model gateway: it records the calls it received and returns canned domain output. */
class FakeGateway implements ModelGateway {
  readonly analyzeRequests: AnalyzeRequest[] = [];
  readonly verifyRequests: VerifyRequest[] = [];
  readonly reasonRequests: ReasonRequest[] = [];
  analyzeHandler: ((request: AnalyzeRequest) => Promise<ModelCallResult<AnalyzeOutcome>>) | null = null;
  verifyHandler: ((request: VerifyRequest) => Promise<ModelCallResult<VerifyOutcome>>) | null = null;

  capabilities(): ModelCapabilities {
    return {
      provider: 'fake-provider',
      implemented: true,
      roles: ['analysis', 'verification', 'reasoning'],
      maxConcurrency: 2,
      notes: [],
    };
  }

  async analyze(request: AnalyzeRequest): Promise<ModelCallResult<AnalyzeOutcome>> {
    this.analyzeRequests.push(request);
    const handler = this.analyzeHandler;
    if (handler === null) {
      throw new Error('unexpected analyze call');
    }
    return handler(request);
  }

  async verify(request: VerifyRequest): Promise<ModelCallResult<VerifyOutcome>> {
    this.verifyRequests.push(request);
    const handler = this.verifyHandler;
    if (handler === null) {
      throw new Error('unexpected verify call');
    }
    return handler(request);
  }

  async reason(request: ReasonRequest): Promise<ModelCallResult<ReasonOutcome>> {
    this.reasonRequests.push(request);
    throw new Error('unexpected reasoning call');
  }
}

function coachingOk(text = HINT): ModelCallResult<CoachingGenerationOutcome> {
  return { ok: true, value: { text }, usage: USAGE, callId: 'coach-call-1', sessionId: 'coach-session-1' };
}

interface BenchOptions {
  readonly validateModels?: (
    settings: WorkbenchSettings,
    token: CancellationToken,
  ) => Promise<readonly ModelValidationDiagnostic[]>;
  readonly generate?: (request: CoachingGenerationRequest) => Promise<ModelCallResult<CoachingGenerationOutcome>>;
  readonly closeWaitMs?: number;
  /** Store factory, for cases that must observe or block one real store call. */
  readonly store?: (path: string, now: () => string) => SqliteTrainingStore;
}

/** Controller + real store + real pipeline/coaching services, with only the model boundary faked. */
class Bench {
  readonly paths = fx.tempDatabase();
  clock = AT;
  readonly store: SqliteTrainingStore;
  readonly gateway = new FakeGateway();
  readonly coachingCalls: CoachingGenerationRequest[] = [];
  readonly internalErrors: ModelOperationFailureReport[] = [];
  readonly coaching: CoachingService;
  readonly controller: ModelOperations;
  private ids = 0;

  constructor(options: BenchOptions = {}) {
    const now = (): string => this.clock;
    this.store =
      options.store === undefined
        ? new SqliteTrainingStore({ path: this.paths.path, now })
        : options.store(this.paths.path, now);
    const generate = options.generate;
    this.coaching = new CoachingService({
      store: this.store,
      generator: {
        generate: async (request) => {
          this.coachingCalls.push(request);
          return generate === undefined ? coachingOk() : generate(request);
        },
      },
      now,
    });
    this.controller = new ModelOperations({
      store: this.store,
      coaching: this.coaching,
      createPipeline: (record) =>
        new AnalysisPipeline({
          store: this.store,
          gateway: this.gateway,
          taxonomy: TAXONOMY,
          roles: record.value.roles,
          limits: record.value.modelLimits,
          now,
          uniqueId: (prefix) => `${prefix}-${(this.ids += 1)}`,
        }),
      validateModels: (settings, token) =>
        options.validateModels === undefined ? Promise.resolve([]) : options.validateModels(settings, token),
      now,
      uniqueId: (prefix) => `${prefix}-${(this.ids += 1)}`,
      onInternalError: (report) => {
        this.internalErrors.push(report);
      },
      ...(options.closeWaitMs === undefined ? {} : { closeWaitMs: options.closeWaitMs }),
    });
  }

  /** Store default settings (revision 1) plus one problem with its current snapshot. */
  async seed(
    world: fx.Scope,
    snapshot: ProblemSnapshot,
  ): Promise<{ readonly settingsRevision: number }> {
    await this.store.upsertSourceInstances([world.instance]);
    await this.store.upsertAccounts([world.account]);
    await this.store.upsertProblems([world.problem]);
    await this.store.saveSnapshot(snapshot);
    const revision = await this.store.saveWorkbenchSettings(defaultWorkbenchSettings(), null);
    return { settingsRevision: revision };
  }

  /** Advance settings by one revision through the controller (the only accepted write path). */
  async saveSettings(expectedRevision: number): Promise<number> {
    const result = await this.controller.saveSettings(
      { expectedRevision, value: defaultWorkbenchSettings() },
      TOKEN,
    );
    return result.revision;
  }

  async close(): Promise<void> {
    await this.store.close();
    fx.removeDirectory(this.paths.dir);
  }
}

function scopeOf(key: string): fx.Scope {
  return fx.makeScope('codeforces', 'codeforces.com', 'alice', key);
}

function batchIdOf(prepared: ModelBatchPrepareResult): string {
  if (prepared.batchId === null) {
    assert.fail('expected a prepared batch');
  }
  return prepared.batchId;
}

function jobOf(detail: ModelBatchDetailResult, index = 0): ModelBatchJobView {
  const job = detail.batch.jobs[index];
  if (job === undefined) {
    assert.fail(`expected a job at index ${index}`);
  }
  return job;
}

const failure = (code: ModelOperationErrorCode) => (error: unknown): boolean =>
  error instanceof ModelOperationError && error.code === code;

function answered(result: { readonly status: string }): CoachingAnsweredView {
  if (result.status !== 'answered') {
    assert.fail(`expected an answered coaching result, got ${result.status}`);
  }
  return result as CoachingAnsweredView;
}

function refused(result: { readonly status: string }): CoachingUnansweredView {
  if (result.status !== 'refused') {
    assert.fail(`expected a refused coaching result, got ${result.status}`);
  }
  return result as CoachingUnansweredView;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${label}`);
    }
    await delay(5);
  }
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------------------
// Batch prepare
// ---------------------------------------------------------------------------------------

void test('prepare resolves current snapshots into spoiler-free metadata and refuses bad material', async () => {
  const bench = new Bench();
  const ready = scopeOf('1000A');
  const bare = fx.makeProblem(fx.makeRef(ready.instance, '1001B'));
  const neverFrozen = fx.makeProblem(fx.makeRef(ready.instance, '1002C'));
  try {
    await bench.seed(ready, fx.makeSnapshot(ready.problem));
    await bench.store.upsertProblems([bare, neverFrozen]);
    await bench.store.saveSnapshot(absentSnapshot(bare));

    const prepared = await bench.controller.prepareBatch(
      { problemKeys: [ready.problem.key, bare.key] },
      TOKEN,
    );
    const batchId = batchIdOf(prepared);
    assert.equal(prepared.settingsRevision, 1);
    assert.equal(prepared.provider, 'deepseek-official');
    assert.deepEqual(prepared.models, {
      analysis: 'deepseek-flash',
      verification: 'deepseek-flash',
      reasoning: 'deepseek-v4-pro',
    });
    assert.deepEqual(prepared.availability, { ready: 1, absent: 1, error: 0 });
    assert.equal(prepared.jobs.length, 2);
    assert.deepEqual(
      prepared.jobs.map((job) => job.problemKey).sort(),
      [ready.problem.key, bare.key].sort(),
    );
    // The bound is the batch's own quota: every dispatch, retries included, counts against it.
    assert.deepEqual(prepared.upperBoundCalls, { analysisCalls: 50, reasoningCalls: 5 });
    assert.deepEqual(prepared.alreadyDone, []);
    // No title, statement, source or excerpt travels through a prepare answer.
    const json = JSON.stringify(prepared);
    assert.equal(json.includes(ready.problem.title), false);
    assert.equal(json.includes(EXCERPT), false);
    assert.equal((await bench.controller.batchDetail({ batchId }, TOKEN)).batch.status, 'pending');

    await assert.rejects(
      bench.controller.prepareBatch({ problemKeys: [ready.problem.key, ready.problem.key] }, TOKEN),
      failure('invalid_input'),
    );
    await assert.rejects(
      bench.controller.prepareBatch({ problemKeys: [fx.keyOf(fx.makeRef(ready.instance, '9999Z'))] }, TOKEN),
      failure('not_found'),
    );
    await assert.rejects(
      bench.controller.prepareBatch({ problemKeys: [neverFrozen.key] }, TOKEN),
      failure('conflict'),
    );
  } finally {
    await bench.close();
  }
});

void test('the call upper bound is the batch quota and covers retries, not one pass per job', async () => {
  const bench = new Bench();
  const world = scopeOf('1050A');
  try {
    const seeded = await bench.seed(world, fx.makeSnapshot(world.problem));
    const base = defaultWorkbenchSettings();
    const { revision } = await bench.controller.saveSettings(
      {
        expectedRevision: seeded.settingsRevision,
        value: {
          ...base,
          modelLimits: {
            ...base.modelLimits,
            maxAnalysisCalls: 5,
            maxReasoningCalls: 1,
            job: { ...base.modelLimits.job, maxAttempts: 4 },
          },
        },
      },
      TOKEN,
    );
    const snapshot = fx.makeSnapshot(world.problem);
    let attempts = 0;
    bench.gateway.analyzeHandler = async () => {
      attempts += 1;
      return attempts <= 2
        ? {
            ok: false,
            error: { code: 'rate_limited', message: 'slow down', retryable: true },
            usage: USAGE,
            callId: `call-retry-${attempts}`,
          }
        : okAnalyze(snapshot, { callId: 'call-analysis' });
    };
    bench.gateway.verifyHandler = async (request) => okVerify(request.suggestions, snapshot);

    const prepared = await bench.controller.prepareBatch({ problemKeys: [world.problem.key] }, TOKEN);
    const batchId = batchIdOf(prepared);
    assert.deepEqual(prepared.upperBoundCalls, { analysisCalls: 5, reasoningCalls: 1 });
    await bench.controller.runBatch({ batchId, expectedSettingsRevision: revision }, TOKEN);
    await bench.controller.whenSettled();

    const detail = await bench.controller.batchDetail({ batchId }, TOKEN);
    assert.equal(detail.batch.status, 'completed');
    // One analyze plus two retries plus one verification: retries push the paid analysis calls past
    // the old one-pass-per-job prediction, and the quota bound has to cover every attempt.
    assert.equal(detail.batch.counters.analysisCalls, 4);
    assert.ok(detail.batch.counters.analysisCalls > prepared.jobs.length * 2);
    assert.ok(prepared.upperBoundCalls.analysisCalls >= detail.batch.counters.analysisCalls);

    // A batch with no job never runs: its bound is zero, not the settings quota.
    const again = await bench.controller.prepareBatch({ problemKeys: [world.problem.key] }, TOKEN);
    assert.equal(again.batchId, null);
    assert.deepEqual(again.upperBoundCalls, { analysisCalls: 0, reasoningCalls: 0 });
  } finally {
    await bench.close();
  }
});

// ---------------------------------------------------------------------------------------
// Batch run, projection and settings consistency
// ---------------------------------------------------------------------------------------

void test('an owned run settles with known usage and a redacted projection', async () => {
  const bench = new Bench();
  const world = scopeOf('1100A');
  try {
    const seeded = await bench.seed(world, fx.makeSnapshot(world.problem));
    const snapshot = fx.makeSnapshot(world.problem);
    bench.gateway.analyzeHandler = async () => okAnalyze(snapshot);
    bench.gateway.verifyHandler = async (request) => okVerify(request.suggestions, snapshot);

    const prepared = await bench.controller.prepareBatch({ problemKeys: [world.problem.key] }, TOKEN);
    const batchId = batchIdOf(prepared);
    const started = await bench.controller.runBatch(
      { batchId, expectedSettingsRevision: seeded.settingsRevision },
      TOKEN,
    );
    assert.equal(started.batchId, batchId);
    assert.equal(started.settingsRevision, seeded.settingsRevision);
    assert.notEqual(started.operationId, '');
    await bench.controller.whenSettled();

    const detail = await bench.controller.batchDetail({ batchId }, TOKEN);
    assert.equal(detail.batch.status, 'completed');
    assert.deepEqual(detail.batch.counters, { analysisCalls: 2, reasoningCalls: 0, retries: 0 });
    assert.equal(detail.operation?.state, 'settled');
    assert.equal(detail.operation?.errorCode, null);
    const job = jobOf(detail);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.problemKey, world.problem.key);
    assert.equal(job.counters?.analysisCalls, 2);
    assert.equal(job.usage?.calls, 2);
    assert.equal(job.usage?.totalTokens, 320);
    assert.equal(job.uncertainAttempts, 0);
    assert.equal(job.errorCode, null);
    assert.deepEqual(
      job.calls.map((call) => call.role).sort(),
      ['analysis', 'verification'],
    );
    assert.ok(job.calls.every((call) => call.hostCallId !== null && call.hostSessionId === 'session-1'));
    assert.ok(job.calls.every((call) => call.status === 'settled' && call.usage !== null));

    // Redaction: no outcome, suggestion, evidence excerpt, rationale or plain title anywhere.
    const json = JSON.stringify(detail);
    for (const forbidden of ['outcome', 'suggestion', 'evidence', EXCERPT, 'rationale', world.problem.title]) {
      assert.equal(json.includes(forbidden), false, `the projection must not contain ${forbidden}`);
    }

    const list = await bench.controller.batchList({}, TOKEN);
    assert.equal(list.total, 1);
    assert.equal(list.items[0]?.batchId, batchId);
    assert.equal(list.items[0]?.jobCount, 1);
    assert.equal('jobs' in (list.items[0] ?? {}), false);

    // A second run of the completed batch is not a second paid run: the pipeline reports the state.
    await bench.controller.runBatch({ batchId, expectedSettingsRevision: seeded.settingsRevision }, TOKEN);
    await bench.controller.whenSettled();
    assert.equal(bench.gateway.analyzeRequests.length, 1);
    assert.equal(bench.gateway.verifyRequests.length, 1);
  } finally {
    await bench.close();
  }
});

void test('a stale settings revision refuses the start and dispatches nothing', async () => {
  const bench = new Bench();
  const world = scopeOf('1200A');
  try {
    const seeded = await bench.seed(world, fx.makeSnapshot(world.problem));
    const prepared = await bench.controller.prepareBatch({ problemKeys: [world.problem.key] }, TOKEN);
    const batchId = batchIdOf(prepared);
    assert.deepEqual(await bench.controller.currentSettings().then((current) => current.revision), seeded.settingsRevision);
    assert.equal(await bench.saveSettings(seeded.settingsRevision), seeded.settingsRevision + 1);

    await assert.rejects(
      bench.controller.runBatch({ batchId, expectedSettingsRevision: seeded.settingsRevision }, TOKEN),
      failure('settings_changed'),
    );
    assert.equal(bench.gateway.analyzeRequests.length, 0);
    assert.deepEqual(await bench.store.listModelCallAttempts({ batchId }), []);
    const detail = await bench.controller.batchDetail({ batchId }, TOKEN);
    assert.equal(detail.batch.status, 'pending');
    assert.equal(detail.operation, null);

    await assert.rejects(
      bench.controller.runBatch({ batchId, expectedSettingsRevision: 0 }, TOKEN),
      failure('invalid_input'),
    );
  } finally {
    await bench.close();
  }
});

void test('one start/save gate makes a concurrent save deterministic and an owned run blocks it', async () => {
  const validationStarted = deferred<void>();
  const validationGate = deferred<void>();
  const bench = new Bench({
    validateModels: async () => {
      validationStarted.resolve();
      await validationGate.promise;
      return [];
    },
  });
  const world = scopeOf('1300A');
  try {
    const seeded = await bench.seed(world, fx.makeSnapshot(world.problem));
    const snapshot = fx.makeSnapshot(world.problem);
    bench.gateway.analyzeHandler = async () => okAnalyze(snapshot, { callId: 'call-analysis-gate' });
    bench.gateway.verifyHandler = async (request) => okVerify(request.suggestions, snapshot, 'call-verify-gate');
    const prepared = await bench.controller.prepareBatch({ problemKeys: [world.problem.key] }, TOKEN);
    const batchId = batchIdOf(prepared);

    const running = bench.controller.runBatch(
      { batchId, expectedSettingsRevision: seeded.settingsRevision },
      TOKEN,
    );
    await validationStarted.promise;
    // The start holds the gate while it validates: a save cannot slip in, and neither can a second start.
    await assert.rejects(bench.saveSettings(seeded.settingsRevision), failure('model_busy'));
    await assert.rejects(
      bench.controller.runBatch({ batchId, expectedSettingsRevision: seeded.settingsRevision }, TOKEN),
      failure('model_busy'),
    );
    validationGate.resolve();
    await running;
    // The owned run is active: the save is refused even after the reservation/lease would be stale.
    await assert.rejects(bench.saveSettings(seeded.settingsRevision), failure('model_busy'));
    await bench.controller.whenSettled();
    assert.equal(await bench.saveSettings(seeded.settingsRevision), seeded.settingsRevision + 1);
  } finally {
    await bench.close();
  }
});

// ---------------------------------------------------------------------------------------
// Pause, cancel and client aborts
// ---------------------------------------------------------------------------------------

void test('pause and cancel operate on the owned pipeline instance and keep the paid audit', async () => {
  const bench = new Bench();
  const world = scopeOf('1400A');
  try {
    const seeded = await bench.seed(world, fx.makeSnapshot(world.problem));
    const snapshot = fx.makeSnapshot(world.problem);
    const analysis = deferred<ModelCallResult<AnalyzeOutcome>>();
    bench.gateway.analyzeHandler = () => analysis.promise;
    bench.gateway.verifyHandler = async (request) => okVerify(request.suggestions, snapshot);
    const prepared = await bench.controller.prepareBatch({ problemKeys: [world.problem.key] }, TOKEN);
    const batchId = batchIdOf(prepared);

    await bench.controller.runBatch({ batchId, expectedSettingsRevision: seeded.settingsRevision }, TOKEN);
    await waitFor(() => bench.gateway.analyzeRequests.length === 1, 'the analysis call to start');
    const paused = await bench.controller.pauseBatch({ batchId }, TOKEN);
    assert.equal(paused.status, 'paused');
    // The gateway ignores the abort and answers with a perfectly valid analysis.
    analysis.resolve(okAnalyze(snapshot, { callId: 'call-analysis-late' }));
    await bench.controller.whenSettled();

    const afterPause = await bench.controller.batchDetail({ batchId }, TOKEN);
    assert.equal(afterPause.batch.status, 'paused');
    assert.equal(afterPause.operation?.state, 'settled');
    assert.equal(afterPause.operation?.errorCode, null);
    assert.equal(jobOf(afterPause).status, 'pending');
    assert.equal(jobOf(afterPause).calls.length, 1);
    assert.deepEqual(await bench.store.listAnalyses(world.problem.key), []);

    const cancelled = await bench.controller.cancelBatch({ batchId }, TOKEN);
    assert.equal(cancelled.status, 'cancelled');
    const afterCancel = await bench.controller.batchDetail({ batchId }, TOKEN);
    assert.equal(afterCancel.batch.status, 'cancelled');
    assert.equal(jobOf(afterCancel).status, 'cancelled');
    assert.equal(bench.gateway.verifyRequests.length, 0);
  } finally {
    await bench.close();
  }
});

void test('an abort after the acknowledgement leaves the run alone while an explicit cancel stops it', async () => {
  const bench = new Bench();
  const first = scopeOf('1500A');
  const second = scopeOf('1501B');
  try {
    const firstSnapshot = fx.makeSnapshot(first.problem);
    const secondSnapshot = fx.makeSnapshot(second.problem);
    const seeded = await bench.seed(first, firstSnapshot);
    await bench.store.upsertProblems([second.problem]);
    await bench.store.saveSnapshot(secondSnapshot);
    const secondRun = deferred<ModelCallResult<AnalyzeOutcome>>();
    let secondDispatched = false;
    bench.gateway.analyzeHandler = async (request) => {
      if (request.snapshot.snapshotId === secondSnapshot.snapshotId) {
        secondDispatched = true;
        return secondRun.promise;
      }
      return okAnalyze(firstSnapshot);
    };
    bench.gateway.verifyHandler = async (request) => okVerify(request.suggestions, request.snapshot);

    const firstBatch = batchIdOf(await bench.controller.prepareBatch({ problemKeys: [first.problem.key] }, TOKEN));
    const secondBatch = batchIdOf(await bench.controller.prepareBatch({ problemKeys: [second.problem.key] }, TOKEN));

    // The client aborts after the start was acknowledged: the owned token is unaffected.
    const client = createCancellationSource();
    await bench.controller.runBatch(
      { batchId: firstBatch, expectedSettingsRevision: seeded.settingsRevision },
      client.token,
    );
    client.cancel('the browser navigated away');
    await bench.controller.whenSettled();
    assert.equal((await bench.controller.batchDetail({ batchId: firstBatch }, TOKEN)).batch.status, 'completed');

    // An explicit cancel does stop the owned run, and nothing of its paid work is adopted.
    await bench.controller.runBatch({ batchId: secondBatch, expectedSettingsRevision: seeded.settingsRevision }, TOKEN);
    await waitFor(() => secondDispatched, 'the second analysis call to start');
    assert.equal((await bench.controller.cancelBatch({ batchId: secondBatch }, TOKEN)).status, 'cancelled');
    secondRun.resolve(okAnalyze(secondSnapshot, { callId: 'call-analysis-cancelled' }));
    await bench.controller.whenSettled();
    const afterCancel = await bench.controller.batchDetail({ batchId: secondBatch }, TOKEN);
    assert.equal(afterCancel.batch.status, 'cancelled');
    assert.equal(jobOf(afterCancel).status, 'cancelled');
    assert.deepEqual(await bench.store.listAnalyses(second.problem.key), []);
    assert.equal(jobOf(afterCancel).calls.length, 1);
  } finally {
    await bench.close();
  }
});

// ---------------------------------------------------------------------------------------
// Coaching
// ---------------------------------------------------------------------------------------

void test('a coaching start is metadata-only while status/history reveal a body only on explicit flags', async () => {
  const bench = new Bench();
  const world = scopeOf('1600A');
  try {
    const seeded = await bench.seed(world, fx.makeSnapshot(world.problem));
    const request = {
      requestId: 'coach-1',
      accountId: world.account.id,
      problemKey: world.problem.key,
      level: 1 as const,
      expectedSettingsRevision: seeded.settingsRevision,
    };
    const started = await bench.controller.coachingAsk(request, TOKEN);
    assert.equal(started.state, 'running');
    assert.equal(started.status, 'pending');
    assert.equal(started.settingsRevision, seeded.settingsRevision);
    assert.equal(JSON.stringify(started).includes(HINT), false);
    await bench.controller.whenSettled();

    // A repeat of the same request id is a free replay: metadata only, no second paid call.
    const replay = await bench.controller.coachingAsk(request, TOKEN);
    assert.equal(replay.status, 'answered');
    assert.equal(replay.state, 'settled');
    assert.equal(replay.usage?.calls, 1);
    assert.equal(JSON.stringify(replay).includes(HINT), false);
    assert.equal(bench.coachingCalls.length, 1);

    const metadata = await bench.controller.coachingStatus(
      { requestId: 'coach-1', accountId: world.account.id, problemKey: world.problem.key },
      TOKEN,
    );
    assert.equal(metadata.status, 'found');
    if (metadata.status !== 'found') {
      assert.fail('expected a found attempt');
    }
    assert.equal('responseText' in metadata.attempt, false);
    assert.deepEqual(metadata.attempt.error, null);

    const body = await bench.controller.coachingStatus(
      {
        requestId: 'coach-1',
        accountId: world.account.id,
        problemKey: world.problem.key,
        includeResponseText: true,
      },
      TOKEN,
    );
    assert.equal(body.status === 'found' ? body.attempt.responseText : null, HINT);

    const history = await bench.controller.coachingHistory(
      { accountId: world.account.id, problemKey: world.problem.key },
      TOKEN,
    );
    assert.equal(history.items.length, 1);
    assert.equal('responseText' in (history.items[0] ?? {}), false);
    const historyBody = await bench.controller.coachingHistory(
      { accountId: world.account.id, problemKey: world.problem.key, level: 1, includeResponseText: true },
      TOKEN,
    );
    assert.equal(historyBody.items[0]?.responseText, HINT);
  } finally {
    await bench.close();
  }
});

void test('a duplicate coaching request is free and identity-checked, and a second one is busy', async () => {
  const started = deferred<void>();
  const release = deferred<void>();
  const bench = new Bench({
    generate: async () => {
      started.resolve();
      await release.promise;
      return coachingOk();
    },
  });
  const world = scopeOf('1700A');
  try {
    const seeded = await bench.seed(world, fx.makeSnapshot(world.problem));
    const request = {
      requestId: 'dup-1',
      accountId: world.account.id,
      problemKey: world.problem.key,
      level: 1 as const,
      expectedSettingsRevision: seeded.settingsRevision,
    };
    const first = await bench.controller.coachingAsk(request, TOKEN);
    await started.promise;
    const duplicate = await bench.controller.coachingAsk(request, TOKEN);
    assert.equal(duplicate.operationId, first.operationId);
    assert.equal(bench.coachingCalls.length, 1);
    await assert.rejects(bench.controller.coachingAsk({ ...request, level: 2 }, TOKEN), failure('conflict'));
    await assert.rejects(
      bench.controller.coachingAsk({ ...request, requestId: 'dup-2' }, TOKEN),
      failure('model_busy'),
    );
    // Cancelling the owned call signals its token; the durable record still settles as paid.
    assert.deepEqual(
      await bench.controller.coachingCancel(
        { requestId: 'dup-1', accountId: world.account.id, problemKey: world.problem.key, level: 1 },
        TOKEN,
      ),
      { requestId: 'dup-1', cancelled: true, status: 'reserved' },
    );
    release.resolve();
    await bench.controller.whenSettled();
    assert.equal(bench.coachingCalls.length, 1);

    // A settled request is never refunded, rewritten as cancelled or claimed by a later cancel.
    assert.deepEqual(
      await bench.controller.coachingCancel(
        { requestId: 'dup-1', accountId: world.account.id, problemKey: world.problem.key, level: 1 },
        TOKEN,
      ),
      { requestId: 'dup-1', cancelled: false, status: 'settled' },
    );
    await assert.rejects(
      bench.controller.coachingCancel(
        { requestId: 'dup-1', accountId: world.account.id, problemKey: world.problem.key, level: 2 },
        TOKEN,
      ),
      failure('conflict'),
    );
  } finally {
    await bench.close();
  }
});

void test('the settings guard refuses a stale new reservation but replays a durable request for free', async () => {
  const bench = new Bench();
  const world = scopeOf('1800A');
  try {
    const seeded = await bench.seed(world, fx.makeSnapshot(world.problem));
    const request = {
      requestId: 'guard-1',
      accountId: world.account.id,
      problemKey: world.problem.key,
      level: 1 as const,
      expectedSettingsRevision: seeded.settingsRevision,
    };
    const first = answered(await bench.coaching.ask(request, TOKEN));
    assert.equal(first.text, HINT);
    assert.equal(bench.coachingCalls.length, 1);

    assert.equal(await bench.saveSettings(seeded.settingsRevision), seeded.settingsRevision + 1);

    // A new reservation under the stale revision is refused before any dispatch and writes nothing.
    const stale = refused(
      await bench.coaching.ask({ ...request, requestId: 'guard-2' }, TOKEN),
    );
    assert.equal(stale.error.code, 'settings_changed');
    assert.equal(stale.attemptId, null);
    assert.equal(await bench.store.getCoachingAttempt('guard-2'), null);
    assert.equal(bench.coachingCalls.length, 1);

    // The durable request id stays readable for free, guard included, and its body stays visible.
    const replay = answered(await bench.coaching.ask(request, TOKEN));
    assert.equal(replay.text, HINT);
    assert.equal(bench.coachingCalls.length, 1);
    const status = await bench.coaching.getStatus(
      'guard-1',
      world.account.id,
      world.problem.key,
      TOKEN,
      { includeResponseText: true },
    );
    assert.equal(status.status === 'found' ? status.attempt.responseText : null, HINT);

    // A malformed guard is refused rather than silently becoming "no guard at all".
    await assert.rejects(
      bench.controller.coachingAsk({ ...request, requestId: 'guard-3', expectedSettingsRevision: 0 }, TOKEN),
      failure('invalid_input'),
    );
  } finally {
    await bench.close();
  }
});

void test('coaching status reports an owned terminal refusal without a durable row and isolates identities', async () => {
  const bench = new Bench();
  const world = scopeOf('1620A');
  const bare = fx.makeProblem(fx.makeRef(world.instance, '1001B'));
  const unknownKey = fx.keyOf(fx.makeRef(world.instance, '9999Z'));
  const otherKey = fx.keyOf(fx.makeRef(world.instance, '8888Y'));
  try {
    const seeded = await bench.seed(world, fx.makeSnapshot(world.problem));
    await bench.store.upsertProblems([bare]);
    const cases = [
      { requestId: 'ref-missing', problemKey: unknownKey, level: 1 as const, code: 'unknown_problem' },
      { requestId: 'ref-nosnap', problemKey: bare.key, level: 1 as const, code: 'snapshot_missing' },
      { requestId: 'ref-level', problemKey: world.problem.key, level: 2 as const, code: 'level_not_earned' },
    ];
    for (const entry of cases) {
      const started = await bench.controller.coachingAsk(
        {
          requestId: entry.requestId,
          accountId: world.account.id,
          problemKey: entry.problemKey,
          level: entry.level,
          expectedSettingsRevision: seeded.settingsRevision,
        },
        TOKEN,
      );
      assert.equal(started.state, 'running');
      await bench.controller.whenSettled();
      assert.equal(await bench.store.getCoachingAttempt(entry.requestId), null);

      const status = await bench.controller.coachingStatus(
        { requestId: entry.requestId, accountId: world.account.id, problemKey: entry.problemKey },
        TOKEN,
      );
      assert.equal(status.status, 'unknown');
      assert.equal(status.operation?.state, 'settled');
      assert.equal(status.operation?.status, 'refused');
      assert.equal(status.operation?.errorCode, entry.code);
      assert.equal(status.operation?.requestId, entry.requestId);
      assert.equal(status.operation?.problemKey, entry.problemKey);
      assert.equal(JSON.stringify(status).includes(HINT), false);

      // The same request id read for another account or problem never exposes this operation.
      const foreignAccount = await bench.controller.coachingStatus(
        { requestId: entry.requestId, accountId: null, problemKey: entry.problemKey },
        TOKEN,
      );
      assert.equal(foreignAccount.operation, null);
      const foreignProblem = await bench.controller.coachingStatus(
        { requestId: entry.requestId, accountId: world.account.id, problemKey: otherKey },
        TOKEN,
      );
      assert.equal(foreignProblem.operation, null);
    }
    assert.equal(bench.coachingCalls.length, 0);
  } finally {
    await bench.close();
  }
});

void test('a cancellation before the reservation reports the durable status and a cancelled duplicate is refused', async () => {
  const world = scopeOf('1640A');
  class GatedProblemStore extends SqliteTrainingStore {
    readonly entered = deferred<void>();
    readonly release = deferred<void>();
    private armed = true;
    override async getProblem(key: string): Promise<NormalizedProblem | null> {
      if (this.armed && key === world.problem.key) {
        this.armed = false;
        this.entered.resolve();
        await this.release.promise;
      }
      return super.getProblem(key);
    }
  }
  const created: { store: GatedProblemStore | null } = { store: null };
  const bench = new Bench({
    store: (path, now) => {
      const store = new GatedProblemStore({ path, now });
      created.store = store;
      return store;
    },
  });
  try {
    const seeded = await bench.seed(world, fx.makeSnapshot(world.problem));
    const request = {
      requestId: 'pre-res-1',
      accountId: world.account.id,
      problemKey: world.problem.key,
      level: 1 as const,
      expectedSettingsRevision: seeded.settingsRevision,
    };
    const started = await bench.controller.coachingAsk(request, TOKEN);
    const store = created.store;
    assert.ok(store);
    await store.entered.promise;

    // Active before the reservation: the durable status is unknown and no attempt id is invented.
    const active = await bench.controller.coachingStatus(
      { requestId: request.requestId, accountId: world.account.id, problemKey: world.problem.key },
      TOKEN,
    );
    assert.equal(active.status, 'unknown');
    assert.equal(active.operation?.state, 'running');
    assert.equal(active.operation?.status, 'pending');
    assert.equal(active.operation?.attemptId, null);
    assert.equal(active.operation?.operationId, started.operationId);

    // A duplicate of the owned request with a cancelled caller token is refused, never acknowledged.
    const abandoned = createCancellationSource();
    abandoned.cancel('the browser navigated away');
    await assert.rejects(
      bench.controller.coachingAsk(request, abandoned.token),
      (error: unknown) => error instanceof DomainError && error.code === 'cancelled',
    );

    // Cancelling before the reservation cancels this instance's token and reports the durable
    // `unknown`: an invented `reserved` would claim a paid reservation that does not exist.
    assert.deepEqual(
      await bench.controller.coachingCancel(
        { requestId: request.requestId, accountId: world.account.id, problemKey: world.problem.key, level: 1 },
        TOKEN,
      ),
      { requestId: request.requestId, cancelled: true, status: 'unknown' },
    );

    store.release.resolve();
    await bench.controller.whenSettled();
    assert.equal(await bench.store.getCoachingAttempt(request.requestId), null);
    assert.equal(bench.coachingCalls.length, 0);

    const settled = await bench.controller.coachingStatus(
      { requestId: request.requestId, accountId: world.account.id, problemKey: world.problem.key },
      TOKEN,
    );
    assert.equal(settled.status, 'unknown');
    assert.equal(settled.operation?.state, 'settled');
    assert.equal(settled.operation?.status, 'refused');
    assert.equal(settled.operation?.errorCode, 'cancelled');
    assert.equal(settled.operation?.attemptId, null);
    assert.equal(JSON.stringify(settled).includes(HINT), false);

    // An undeclared ask member is refused at this boundary too, never silently ignored.
    await assert.rejects(
      bench.controller.coachingAsk(
        { ...request, requestId: 'strict-1', typo: true } as unknown as ModelCoachingAskRequest,
        TOKEN,
      ),
      failure('invalid_input'),
    );
    assert.equal(await bench.store.getCoachingAttempt('strict-1'), null);
  } finally {
    await bench.close();
  }
});

void test('a thrown pre-reservation background failure is reported with a safe code only', async () => {
  const world = scopeOf('1660A');
  const marker = fx.makeProblem(fx.makeRef(world.instance, '1002C'));
  const SECRET = 'raw store failure at C:\\Users\\alice\\.dsh\\credentials.json';
  class ThrowingProblemStore extends SqliteTrainingStore {
    override async getProblem(key: string): Promise<NormalizedProblem | null> {
      if (key === marker.key) {
        throw new Error(SECRET);
      }
      return super.getProblem(key);
    }
  }
  const bench = new Bench({ store: (path, now) => new ThrowingProblemStore({ path, now }) });
  try {
    const seeded = await bench.seed(world, fx.makeSnapshot(world.problem));
    const started = await bench.controller.coachingAsk(
      {
        requestId: 'boom-1',
        accountId: world.account.id,
        problemKey: marker.key,
        level: 1,
        expectedSettingsRevision: seeded.settingsRevision,
      },
      TOKEN,
    );
    assert.equal(started.state, 'running');
    await bench.controller.whenSettled();

    const status = await bench.controller.coachingStatus(
      { requestId: 'boom-1', accountId: world.account.id, problemKey: marker.key },
      TOKEN,
    );
    assert.equal(status.status, 'unknown');
    assert.equal(status.operation?.state, 'settled');
    assert.equal(status.operation?.status, 'failed');
    assert.equal(status.operation?.errorCode, 'internal');
    assert.equal(JSON.stringify(status).includes(SECRET), false);
    assert.equal(await bench.store.getCoachingAttempt('boom-1'), null);
    assert.equal(bench.internalErrors.length, 1);
    assert.equal(bench.internalErrors[0]?.key, 'boom-1');
    assert.ok(bench.internalErrors[0]?.error instanceof Error);
  } finally {
    await bench.close();
  }
});

void test('coaching status reports a quota refusal, and a durable replay stays free after a settings change', async () => {
  const bench = new Bench();
  const world = scopeOf('1680A');
  try {
    const seeded = await bench.seed(world, fx.makeSnapshot(world.problem));
    const base = defaultWorkbenchSettings();
    const { revision } = await bench.controller.saveSettings(
      {
        expectedRevision: seeded.settingsRevision,
        value: { ...base, coaching: { ...base.coaching, maxCallsPer24Hours: 2 } },
      },
      TOKEN,
    );
    const ask = (requestId: string, level: 1 | 2 | 3) =>
      bench.controller.coachingAsk(
        {
          requestId,
          accountId: world.account.id,
          problemKey: world.problem.key,
          level,
          expectedSettingsRevision: revision,
        },
        TOKEN,
      );

    assert.equal((await ask('quota-1', 1)).state, 'running');
    await bench.controller.whenSettled();
    assert.equal((await ask('quota-2', 2)).state, 'running');
    await bench.controller.whenSettled();
    assert.equal(bench.coachingCalls.length, 2);

    assert.equal((await ask('quota-3', 3)).state, 'running');
    await bench.controller.whenSettled();
    const refusedStatus = await bench.controller.coachingStatus(
      { requestId: 'quota-3', accountId: world.account.id, problemKey: world.problem.key },
      TOKEN,
    );
    assert.equal(refusedStatus.operation?.status, 'refused');
    assert.equal(refusedStatus.operation?.errorCode, 'coaching_quota_exhausted');
    assert.equal(refusedStatus.operation?.retryable, true);
    assert.equal(await bench.store.getCoachingAttempt('quota-3'), null);

    // A durable request id replays for free even after the settings revision moved on.
    assert.equal(await bench.saveSettings(revision), revision + 1);
    const replay = await bench.controller.coachingAsk(
      {
        requestId: 'quota-1',
        accountId: world.account.id,
        problemKey: world.problem.key,
        level: 1,
        expectedSettingsRevision: revision,
      },
      TOKEN,
    );
    assert.equal(replay.status, 'answered');
    assert.equal(bench.coachingCalls.length, 2);
  } finally {
    await bench.close();
  }
});

void test('an expired orphan never blocks configuration and is recovered without a refund', async () => {
  const bench = new Bench();
  const world = scopeOf('1900A');
  try {
    const seeded = await bench.seed(world, fx.makeSnapshot(world.problem));
    const snapshot = fx.makeSnapshot(world.problem);
    const orphan: CoachingAttempt = {
      id: 'orphan-1',
      accountId: world.account.id,
      problemKey: world.problem.key,
      snapshotId: snapshot.snapshotId,
      level: 1,
      requestedAt: AT,
      expiresAt: new Date(Date.parse(AT) + 1000).toISOString(),
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
    };
    await bench.store.saveCoachingAttempt(orphan);
    bench.clock = new Date(Date.parse(AT) + 120_000).toISOString();

    // The expired orphan does not prevent configuration, and its cost record is untouched.
    assert.equal(await bench.saveSettings(seeded.settingsRevision), seeded.settingsRevision + 1);
    const stored = await bench.store.getCoachingAttempt('orphan-1');
    assert.equal(stored?.status, 'reserved');
    assert.equal(stored?.expiresAt, orphan.expiresAt);
    assert.equal(stored?.finishedAt, null);
    assert.equal(stored?.error, null);

    // A new coaching request still performs the accepted recovery and quota accounting.
    const started = await bench.controller.coachingAsk(
      {
        requestId: 'fresh-1',
        accountId: world.account.id,
        problemKey: world.problem.key,
        level: 1,
        expectedSettingsRevision: seeded.settingsRevision + 1,
      },
      TOKEN,
    );
    assert.equal(started.state, 'running');
    await bench.controller.whenSettled();
    assert.equal((await bench.store.getCoachingAttempt('orphan-1'))?.status, 'uncertain');
    assert.equal((await bench.store.getCoachingAttempt('orphan-1'))?.error?.code, 'timeout');
    assert.equal(await bench.store.countCoachingAttempts({}), 2);
  } finally {
    await bench.close();
  }
});

// ---------------------------------------------------------------------------------------
// Failure paths and disposal
// ---------------------------------------------------------------------------------------

void test('unknown paid cost is retained as an uncertain count, never estimated as zero', async () => {
  const bench = new Bench();
  const world = scopeOf('2000A');
  try {
    const seeded = await bench.seed(world, fx.makeSnapshot(world.problem));
    bench.gateway.analyzeHandler = async () => ({
      ok: false,
      error: { code: 'timeout', message: PROVIDER_FAILURE_TEXT, retryable: false },
      usage: null,
      callId: 'call-timeout',
    });
    const prepared = await bench.controller.prepareBatch({ problemKeys: [world.problem.key] }, TOKEN);
    const batchId = batchIdOf(prepared);
    await bench.controller.runBatch({ batchId, expectedSettingsRevision: seeded.settingsRevision }, TOKEN);
    await bench.controller.whenSettled();

    const detail = await bench.controller.batchDetail({ batchId }, TOKEN);
    assert.equal(detail.batch.status, 'failed');
    assert.equal(detail.batch.uncertainAttempts, 1);
    const job = jobOf(detail);
    assert.equal(job.status, 'failed');
    assert.equal(job.usage, null);
    assert.equal(job.uncertainAttempts, 1);
    assert.equal(job.calls.length, 1);
    assert.equal(job.calls[0]?.status, 'uncertain');
    assert.equal(job.calls[0]?.usage, null);
    assert.equal(job.calls[0]?.errorCode, 'timeout');
    assert.equal(JSON.stringify(detail).includes(PROVIDER_FAILURE_TEXT), false);
    // Nothing was adopted for a failed job.
    assert.deepEqual(await bench.store.listAnalyses(world.problem.key), []);
  } finally {
    await bench.close();
  }
});

void test('a background start failure is reported as a fixed code, and close reports outstanding work', async () => {
  const bench = new Bench();
  const world = scopeOf('2100A');
  try {
    const seeded = await bench.seed(world, fx.makeSnapshot(world.problem));
    const prepared = await bench.controller.prepareBatch({ problemKeys: [world.problem.key] }, TOKEN);
    const batchId = batchIdOf(prepared);
    // A paused batch refuses `run` inside the pipeline: the acknowledgement already happened, so the
    // failure is recorded as a safe code instead of surfacing a raw message.
    await bench.controller.pauseBatch({ batchId }, TOKEN);
    await bench.controller.runBatch({ batchId, expectedSettingsRevision: seeded.settingsRevision }, TOKEN);
    await bench.controller.whenSettled();
    const detail = await bench.controller.batchDetail({ batchId }, TOKEN);
    assert.equal(detail.batch.status, 'paused');
    assert.equal(detail.operation?.state, 'settled');
    assert.equal(detail.operation?.errorCode, 'conflict');
    assert.equal(bench.internalErrors.length, 1);
    assert.equal(bench.internalErrors[0]?.key, batchId);
    assert.equal(JSON.stringify(detail).includes('resume it before running'), false);
  } finally {
    await bench.close();
  }
});

void test('a bounded close reports an operation that ignores cancellation instead of claiming it settled', async () => {
  const never = new Promise<ModelCallResult<CoachingGenerationOutcome>>(() => {
    // Deliberately never settles: this worker ignores its token, which is exactly what the bounded
    // close must report as outstanding rather than silently declaring a settlement it never saw.
  });
  const bench = new Bench({ generate: () => never, closeWaitMs: 50 });
  const world = scopeOf('2200A');
  try {
    const seeded = await bench.seed(world, fx.makeSnapshot(world.problem));
    const started = await bench.controller.coachingAsk(
      {
        requestId: 'slow-1',
        accountId: world.account.id,
        problemKey: world.problem.key,
        level: 1,
        expectedSettingsRevision: seeded.settingsRevision,
      },
      TOKEN,
    );
    assert.equal(started.state, 'running');
    await waitFor(async () => (await bench.store.getCoachingAttempt('slow-1')) !== null, 'the reservation');

    // Even with an expired reservation, the owned operation still blocks a settings save.
    bench.clock = LATER;
    await assert.rejects(bench.saveSettings(seeded.settingsRevision), failure('model_busy'));

    // Concurrent callers share one close attempt and observe the very same bounded report.
    const [report, concurrent] = await Promise.all([bench.controller.close(), bench.controller.close()]);
    assert.equal(report, concurrent);
    assert.deepEqual(report.settled, []);
    assert.deepEqual(report.outstanding, [started.operationId]);
    assert.deepEqual(await bench.controller.close(), report);
    // A duplicate of the still-owned request is refused on the closed controller, not acknowledged.
    await assert.rejects(
      bench.controller.coachingAsk(
        {
          requestId: 'slow-1',
          accountId: world.account.id,
          problemKey: world.problem.key,
          level: 1,
          expectedSettingsRevision: seeded.settingsRevision,
        },
        TOKEN,
      ),
      failure('model_busy'),
    );
    await assert.rejects(bench.controller.batchList({}, TOKEN), failure('model_busy'));
  } finally {
    await bench.close();
  }
});

void test('a new active coaching request does not hide another request terminal refusal', async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const bench = new Bench({ generate: async () => { await waiting; return coachingOk(); } });
  const world = scopeOf('1A');
  try {
    await bench.seed(world, fx.makeSnapshot(world.problem));
    const missing = scopeOf('9999A');
    await bench.controller.coachingAsk({ requestId: 'previous-refusal', accountId: null,
      problemKey: missing.problem.key, level: 1, expectedSettingsRevision: 1 }, TOKEN);
    await bench.controller.whenSettled();
    await bench.controller.coachingAsk({ requestId: 'new-active', accountId: null,
      problemKey: world.problem.key, level: 1, expectedSettingsRevision: 1 }, TOKEN);
    const previous = await bench.controller.coachingStatus({ requestId: 'previous-refusal',
      accountId: null, problemKey: missing.problem.key }, TOKEN);
    assert.equal(previous.operation?.state, 'settled');
    assert.equal(previous.operation?.status, 'refused');
    assert.equal(previous.operation?.errorCode, 'unknown_problem');
  } finally {
    release();
    await bench.controller.whenSettled();
    await bench.controller.close();
    await bench.close();
  }
});