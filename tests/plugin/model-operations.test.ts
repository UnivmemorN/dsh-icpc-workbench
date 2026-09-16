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
  createNormalizedProblem,
  createProblemSnapshot,
  createSuggestionVerification,
  createTaxonomy,
  type AiTagSuggestion,
  type CancellationToken,
  type EditorialAvailability,
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
/** The editorial body a runnable snapshot carries; it must never travel through a projection. */
const SOLUTION_TEXT = 'The editorial uses lazy propagation: range updates stay O(log n) with a segment tree.';
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

/**
 * The same problem with an explicitly empty statement.
 *
 * The shared storage fixture treats an absent statement option as "use the default statement",
 * so a missing statement has to be built through the domain factory: `null` here is a real,
 * observed platform state ("the statement was never retrieved"), not a dropped option.
 */
function withoutStatement(world: fx.Scope, externalKey: string): NormalizedProblem {
  return createNormalizedProblem({
    ref: fx.makeRef(world.instance, externalKey),
    title: `Problem ${externalKey}`,
    url: `https://codeforces.com/problem/${externalKey}`,
    statement: null,
    fetchedAt: fx.AT,
    ratings: [{ dimension: 'rating', value: 1800, scale: { min: 800, max: 3500 }, raw: '1800' }],
    rawTags: ['data structures'],
  });
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
      reasoning: 'deepseek-flash',
    });
    assert.deepEqual(prepared.availability, { ready: 1, absent: 1, error: 0 });
    assert.equal(prepared.jobs.length, 2);
    assert.deepEqual(
      prepared.jobs.map((job) => job.problemKey).sort(),
      [ready.problem.key, bare.key].sort(),
    );
    // The bound is the batch's own quota: every dispatch, retries included, counts against it.
    assert.deepEqual(prepared.upperBoundCalls, { analysisCalls: 50, reasoningCalls: 5, blocked: 0 });
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
    // A problem without any material snapshot is an explicit blocked entry, not a rejection of
    // the whole selection: no job is created and no model call can reach it.
    const blockedOnly = await bench.controller.prepareBatch({ problemKeys: [neverFrozen.key] }, TOKEN);
    assert.equal(blockedOnly.batchId, null);
    assert.deepEqual(blockedOnly.jobs, []);
    assert.deepEqual(blockedOnly.blocked, [
      { problemKey: neverFrozen.key, reason: 'material_missing', action: 'refresh_materials' },
    ]);
    assert.deepEqual(blockedOnly.upperBoundCalls, { analysisCalls: 0, reasoningCalls: 0, blocked: 1 });
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
    bench.gateway.verifyHandler = async (request) => {
      // The completeness-aware answer: an explicit (empty) omissions list makes this run a
      // checked one, so the finished job is genuinely skipped by the next prepare.
      const answer = await okVerify(request.suggestions, snapshot);
      return answer.ok ? { ...answer, value: { ...answer.value, missingSuggestions: [] } } : answer;
    };

    const prepared = await bench.controller.prepareBatch({ problemKeys: [world.problem.key] }, TOKEN);
    const batchId = batchIdOf(prepared);
    assert.deepEqual(prepared.upperBoundCalls, { analysisCalls: 5, reasoningCalls: 1, blocked: 0 });
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
    assert.deepEqual(again.upperBoundCalls, { analysisCalls: 0, reasoningCalls: 0, blocked: 0 });
  } finally {
    await bench.close();
  }
});

// ---------------------------------------------------------------------------------------
// Material preflight (Sprint 33A)
// ---------------------------------------------------------------------------------------

/** Snapshot with one `found` source that carries no solution body: nothing may be analysed. */
function foundWithoutBody(problem: NormalizedProblem): ProblemSnapshot {
  const source = createEditorialSource({
    id: 'editorial-1',
    kind: 'editorial',
    url: `https://editorial.example.org/${problem.ref.externalKey}`,
    title: `Editorial for ${problem.title}`,
    availability: 'found',
    retrievedAt: AT,
    text: 'A retrieved page whose write-up was never extracted.',
  });
  return createProblemSnapshot({ problem, sources: [source], solutions: [], capturedAt: AT });
}

/** Snapshot with no source records at all: an unknown editorial state, never an absence. */
function withoutSources(problem: NormalizedProblem): ProblemSnapshot {
  return createProblemSnapshot({ problem, sources: [], solutions: [], capturedAt: AT });
}

/** Snapshot with one source that did not answer with an explicit absence. */
function withSourceAvailability(
  problem: NormalizedProblem,
  availability: EditorialAvailability,
): ProblemSnapshot {
  const source = createEditorialSource({
    id: 'editorial-1',
    kind: 'editorial',
    url: `https://editorial.example.org/${problem.ref.externalKey}`,
    title: `Editorial for ${problem.title}`,
    availability,
    retrievedAt: AT,
  });
  return createProblemSnapshot({ problem, sources: [source], solutions: [], capturedAt: AT });
}

/**
 * Store whose current head of one problem references a snapshot row an earlier version could have
 * left unreadable. Only `getSnapshot` is affected: the head itself is real.
 */
class HiddenSnapshotStore extends SqliteTrainingStore {
  private readonly hidden = new Set<string>();

  hide(snapshotId: string): void {
    this.hidden.add(snapshotId);
  }

  override async getSnapshot(snapshotId: string): Promise<ProblemSnapshot | null> {
    return this.hidden.has(snapshotId) ? null : super.getSnapshot(snapshotId);
  }
}

void test('only a usable editorial or a confirmed absence becomes a job, and every other state is an explicit free block', async () => {
  const created: { store: HiddenSnapshotStore | null } = { store: null };
  const bench = new Bench({
    store: (path, now) => {
      const store = new HiddenSnapshotStore({ path, now });
      created.store = store;
      return store;
    },
  });
  const ready = scopeOf('2000A');
  const bare = scopeOf('2001B');
  const unknown = scopeOf('2002C');
  const emptyBody = scopeOf('2003D');
  const auth = scopeOf('2004E');
  const noStatement = withoutStatement(ready, '2005F');
  // A stored problem whose material was never persisted: no head, so no snapshot either.
  const truncated = fx.makeProblem(fx.makeRef(ready.instance, '2006G'));
  const unreadable = scopeOf('2007H');
  const noEditorialUntouched = scopeOf('2008I');
  try {
    await bench.seed(ready, fx.makeSnapshot(ready.problem));
    await bench.store.upsertProblems([
      bare.problem,
      unknown.problem,
      emptyBody.problem,
      auth.problem,
      noStatement,
      truncated,
      unreadable.problem,
      noEditorialUntouched.problem,
    ]);
    await bench.store.saveSnapshot(absentSnapshot(bare.problem));
    await bench.store.saveSnapshot(withoutSources(unknown.problem));
    await bench.store.saveSnapshot(foundWithoutBody(emptyBody.problem));
    await bench.store.saveSnapshot(withSourceAvailability(auth.problem, 'auth_required'));
    await bench.store.saveSnapshot(withSourceAvailability(noStatement, 'absent'));
    const unreadableSnapshot = fx.makeSnapshot(unreadable.problem);
    await bench.store.saveSnapshot(unreadableSnapshot);
    assert.ok(created.store);
    created.store.hide(unreadableSnapshot.snapshotId);

    const request = [
      ready.problem.key,
      bare.problem.key,
      unknown.problem.key,
      emptyBody.problem.key,
      auth.problem.key,
      noStatement.key,
      truncated.key,
      unreadable.problem.key,
    ];
    const prepared = await bench.controller.prepareBatch({ problemKeys: request }, TOKEN);
    const batchId = batchIdOf(prepared);

    // Exactly the usable editorial and the confirmed absence became jobs.
    assert.deepEqual(
      prepared.jobs.map((job) => job.problemKey),
      [ready.problem.key, bare.problem.key],
    );
    assert.deepEqual(prepared.availability, { ready: 1, absent: 1, error: 6 });
    assert.deepEqual(
      prepared.blocked,
      [
        { problemKey: unknown.problem.key, reason: 'editorial_unknown', action: 'refresh_materials' },
        { problemKey: emptyBody.problem.key, reason: 'editorial_empty', action: 'supplement_editorial' },
        { problemKey: auth.problem.key, reason: 'source_unavailable', action: 'refresh_materials' },
        { problemKey: noStatement.key, reason: 'missing_statement', action: 'supplement_statement' },
        { problemKey: truncated.key, reason: 'material_missing', action: 'refresh_materials' },
        { problemKey: unreadable.problem.key, reason: 'snapshot_unreadable', action: 'refresh_materials' },
      ],
    );
    // A blocked problem is not a new task: the bound only covers the two real jobs, and the
    // blocked count is reported next to it instead of being folded into the workload.
    assert.deepEqual(prepared.upperBoundCalls, { analysisCalls: 50, reasoningCalls: 5, blocked: 6 });
    assert.equal(prepared.blocked.length, prepared.availability.error);

    // No model call can reach a blocked problem.
    assert.equal(bench.gateway.analyzeRequests.length, 0);
    assert.equal(bench.gateway.verifyRequests.length, 0);
    assert.equal(bench.gateway.reasonRequests.length, 0);

    // A problem outside the selection is untouched: its own material was never read.
    assert.equal(
      (await bench.controller.prepareBatch({ problemKeys: [noEditorialUntouched.problem.key] }, TOKEN)).batchId,
      null,
    );

    // The answer carries no statement, editorial body, source identity, title or classifier detail.
    const json = JSON.stringify(prepared);
    for (const leak of [
      truncated.title,
      'A retrieved page whose write-up was never extracted.',
      'editorial.example.org',
      'carry no referenced solution text',
      'did not answer with an explicit absence',
      'absence cannot be concluded',
      SOLUTION_TEXT,
      EXCERPT,
    ]) {
      assert.equal(json.includes(leak), false, `the prepare answer must not carry ${leak}`);
    }
    // The path to the only paid call is a job of the real batch, and it starts pending with nothing spent.
    const detail = await bench.controller.batchDetail({ batchId }, TOKEN);
    assert.equal(detail.batch.status, 'pending');
    assert.deepEqual(detail.batch.counters, { analysisCalls: 0, reasoningCalls: 0, retries: 0 });
    assert.deepEqual(detail.batch.materialBlocks, []);
    assert.equal(detail.batch.jobs.length, 2);
  } finally {
    await bench.close();
  }
});

void test('a selection whose material is entirely unusable creates no batch, no job and no bound', async () => {
  const bench = new Bench();
  const unknown = scopeOf('2100A');
  const auth = scopeOf('2101B');
  const noStatement = withoutStatement(unknown, '2102C');
  const absentKeys = scopeOf('2103D');
  const emptyBody = scopeOf('2104E');
  try {
    await bench.seed(unknown, withoutSources(unknown.problem));
    await bench.store.upsertProblems([auth.problem, noStatement, emptyBody.problem]);
    await bench.store.saveSnapshot(withSourceAvailability(auth.problem, 'rate_limited'));
    await bench.store.saveSnapshot(withSourceAvailability(noStatement, 'absent'));
    await bench.store.saveSnapshot(foundWithoutBody(emptyBody.problem));

    const prepared = await bench.controller.prepareBatch(
      { problemKeys: [unknown.problem.key, auth.problem.key, noStatement.key, emptyBody.problem.key] },
      TOKEN,
    );
    assert.equal(prepared.batchId, null);
    assert.deepEqual(prepared.jobs, []);
    assert.deepEqual(prepared.upperBoundCalls, { analysisCalls: 0, reasoningCalls: 0, blocked: 4 });
    assert.deepEqual(prepared.availability, { ready: 0, absent: 0, error: 4 });
    assert.deepEqual(prepared.blocked.map((entry) => entry.reason), [
      'editorial_unknown',
      'source_unavailable',
      'missing_statement',
      'editorial_empty',
    ]);
    assert.equal(prepared.alreadyDone.length, 0);
    assert.equal(prepared.reruns.length, 0);

    // Nothing was written: no batch exists at all, and no paid call was reachable.
    assert.deepEqual(await bench.store.listBatches(null), []);
    assert.deepEqual(await bench.store.listJobs(null), []);
    assert.deepEqual(await bench.store.listModelCallAttempts({}), []);
    assert.equal(bench.gateway.analyzeRequests.length, 0);
    assert.equal(bench.gateway.reasonRequests.length, 0);

    // A problem whose own material was never frozen is reported exactly like the others.
    await bench.store.upsertProblems([absentKeys.problem]);
    const missing = await bench.controller.prepareBatch({ problemKeys: [absentKeys.problem.key] }, TOKEN);
    assert.equal(missing.batchId, null);
    assert.deepEqual(missing.blocked, [
      { problemKey: absentKeys.problem.key, reason: 'material_missing', action: 'refresh_materials' },
    ]);
  } finally {
    await bench.close();
  }
});

void test('a mixed selection prepares only the runnable problems, and a rerun of them stays runnable', async () => {
  const bench = new Bench();
  const ready = scopeOf('2200A');
  const broken = scopeOf('2201B');
  try {
    const seeded = await bench.seed(ready, fx.makeSnapshot(ready.problem));
    await bench.store.upsertProblems([broken.problem]);
    await bench.store.saveSnapshot(withoutSources(broken.problem));
    const snapshot = fx.makeSnapshot(ready.problem);
    bench.gateway.analyzeHandler = async () => okAnalyze(snapshot);
    bench.gateway.verifyHandler = async (request) => {
      const answer = await okVerify(request.suggestions, snapshot);
      return answer.ok ? { ...answer, value: { ...answer.value, missingSuggestions: [] } } : answer;
    };

    const selection = [ready.problem.key, broken.problem.key];
    const first = await bench.controller.prepareBatch({ problemKeys: selection }, TOKEN);
    const firstBatchId = batchIdOf(first);
    assert.equal(first.jobs.length, 1);
    assert.equal(first.blocked.length, 1);
    assert.deepEqual(first.upperBoundCalls, { analysisCalls: 50, reasoningCalls: 5, blocked: 1 });
    await bench.controller.runBatch({ batchId: firstBatchId, expectedSettingsRevision: seeded.settingsRevision }, TOKEN);
    await bench.controller.whenSettled();

    // Finished and checked: the runnable problem is skipped, the blocked one is reported again.
    const second = await bench.controller.prepareBatch({ problemKeys: selection }, TOKEN);
    assert.equal(second.batchId, null);
    assert.equal(second.alreadyDone.length, 1);
    assert.deepEqual(second.upperBoundCalls, { analysisCalls: 0, reasoningCalls: 0, blocked: 1 });
    assert.deepEqual(second.blocked.map((entry) => entry.reason), ['editorial_unknown']);

    // An explicit rerun only reruns what is runnable; the blocked problem never becomes a job.
    const rerun = await bench.controller.prepareBatch({ problemKeys: selection, reanalyze: true }, TOKEN);
    const rerunBatchId = batchIdOf(rerun);
    assert.equal(rerun.jobs.length, 1);
    assert.equal(rerun.reruns.length, 1);
    assert.equal(rerun.reruns[0]?.reason, 'reanalyze_requested');
    assert.deepEqual(rerun.blocked.map((entry) => entry.reason), ['editorial_unknown']);
    const detail = await bench.controller.batchDetail({ batchId: rerunBatchId }, TOKEN);
    assert.equal(detail.batch.status, 'pending');
    assert.deepEqual(detail.batch.counters, { analysisCalls: 0, reasoningCalls: 0, retries: 0 });
    assert.deepEqual(detail.batch.materialBlocks, []);
  } finally {
    await bench.close();
  }
});

void test('every operational source failure is blocked as unavailable and never becomes an absence', async () => {
  const bench = new Bench();
  const worlds = (['auth_required', 'forbidden', 'rate_limited', 'unavailable', 'changed_response'] as const).map(
    (availability, index) => ({ availability, world: scopeOf(`230${index}A`) }),
  );
  try {
    await bench.seed(worlds[0]!.world, withSourceAvailability(worlds[0]!.world.problem, worlds[0]!.availability));
    for (const entry of worlds.slice(1)) {
      await bench.store.upsertProblems([entry.world.problem]);
      await bench.store.saveSnapshot(withSourceAvailability(entry.world.problem, entry.availability));
    }
    const prepared = await bench.controller.prepareBatch(
      { problemKeys: worlds.map((entry) => entry.world.problem.key) },
      TOKEN,
    );
    assert.equal(prepared.batchId, null);
    assert.deepEqual(prepared.availability, { ready: 0, absent: 0, error: 5 });
    assert.deepEqual(prepared.blocked.map((entry) => entry.reason), Array(5).fill('source_unavailable'));
    assert.deepEqual(prepared.blocked.map((entry) => entry.action), Array(5).fill('refresh_materials'));
    // Nothing could be mistaken for "the platform has no editorial", so no reasoning call was reachable.
    assert.equal(bench.gateway.reasonRequests.length, 0);
    assert.equal(prepared.upperBoundCalls.reasoningCalls, 0);
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
