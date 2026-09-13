/**
 * Durable AI training-plan service over a real SQLite store (Sprint 11c).
 *
 * Every case drives the real {@link PlanningService} with the real {@link WorkbenchService} as its
 * candidate/ability collaborator and a scripted generator; nothing reaches a platform, a model or
 * the network. The assertions cover the externally meaningful behaviour of the backend foundation:
 * a free durable preparation that dispatches nothing, the strict domain validation of a model
 * answer, paid usage retained when the answer is refused, stale preparations refused before and
 * after dispatch, settings/lease guards, cancellation, the borrowed rolling quota, restart
 * recovery without a duplicate call and the account-scoped status/cancel reads.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { defaultWorkbenchSettings, type WorkbenchSettings } from '../../src/application/workbench-settings.js';
import {
  PlanningService,
  PlanningServiceError,
  type PlanningDataPort,
  type PlanningInternalErrorReport,
  type PlanningServiceStore,
} from '../../src/application/planning-service.js';
import type { PlanAttempt } from '../../src/application/planning-types.js';
import type {
  PlanGenerationDraft,
  PlanGenerationOutcome,
  PlanGenerationRequest,
  PlanningGenerator,
} from '../../src/application/planning-generation.js';
import type { ModelCallResult } from '../../src/application/ports.js';
import { WorkbenchService, type WorkbenchServiceOptions } from '../../src/application/workbench-service.js';
import {
  CURRENT_TAXONOMY,
  createCancellationSource,
  createModelUsage,
  createTaxonomyIndex,
} from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';

const AT = '2026-11-01T08:00:00.000Z';
const LATER = '2026-11-01T09:00:00.000Z';
const EXPIRED_LEASE = '2026-11-01T08:30:00.000Z';
const LIVE_LEASE = '2026-11-01T09:30:00.000Z';
const TOKEN = createCancellationSource().token;
const TAXONOMY = createTaxonomyIndex(CURRENT_TAXONOMY);
const REQUEST = 'plan-request-1';

interface Scripted {
  readonly calls: PlanGenerationRequest[];
  readonly generator: PlanningGenerator;
}

/** A generator that records every dispatch and answers with a scripted result. */
function scriptedGenerator(
  answer: (request: PlanGenerationRequest) => Promise<ModelCallResult<PlanGenerationOutcome>>,
): Scripted {
  const calls: PlanGenerationRequest[] = [];
  return {
    calls,
    generator: {
      async generate(request: PlanGenerationRequest): Promise<ModelCallResult<PlanGenerationOutcome>> {
        calls.push(request);
        return answer(request);
      },
    },
  };
}

function planned(draft: PlanGenerationDraft): ModelCallResult<PlanGenerationOutcome> {
  return {
    ok: true,
    value: { draft },
    usage: createModelUsage({ calls: 1, promptTokens: 120, completionTokens: 40 }),
    callId: 'host-call-1',
    sessionId: 'host-session-1',
  };
}

function failed(usage: ReturnType<typeof createModelUsage> | null): ModelCallResult<PlanGenerationOutcome> {
  return {
    ok: false,
    error: { code: 'provider_error', message: 'the model provider reported a failure', retryable: true },
    usage,
    callId: 'host-call-2',
    sessionId: null,
  };
}

function planningData(workbench: WorkbenchService) {
  return { prepare: workbench.preparePlanInput.bind(workbench), revalidate: workbench.revalidatePlanInput.bind(workbench), savePlan: workbench.saveModelPlan.bind(workbench) };
}

/**
 * Wrap the real SQLite store so a test can observe one public write right after it landed.
 *
 * Every property is delegated to the real store — the service and the workbench keep sharing one
 * connection and one transaction — and only `savePlanAttempt` gains the observation point, so a
 * race is injected at a real await of the service instead of against a storage stub.
 */
function storeRacingAfterAttemptWrite(
  store: SqliteTrainingStore,
  after: (attempt: PlanAttempt) => void,
): PlanningServiceStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'savePlanAttempt') {
        return async (attempt: PlanAttempt): Promise<void> => {
          await target.savePlanAttempt(attempt);
          after(attempt);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

interface Bench {
  readonly store: SqliteTrainingStore;
  readonly workbench: WorkbenchService;
  readonly planning: PlanningService;
  readonly clock: { value: string };
  readonly scope: fx.Scope;
  readonly solved: fx.Scope;
}

/**
 * Optional race hooks.
 *
 * They wrap the **public** methods of the real store and of the real workbench port, so a test can
 * cancel a token or throw at a real await point of the service while every storage and candidate
 * rule stays the production one.
 */
interface BenchHooks {
  /** Wrap the store the service is given; the workbench keeps the unwrapped store. */
  readonly store?: (store: SqliteTrainingStore) => PlanningServiceStore;
  /** Wrap the real candidate/ability port built by {@link planningData}. */
  readonly preparation?: (port: PlanningDataPort, workbench: WorkbenchService) => PlanningDataPort;
  /** Local diagnostic sink of the service under test. */
  readonly onInternalError?: (report: PlanningInternalErrorReport) => void;
}

async function withBench(
  run: (bench: Bench, scripted: Scripted) => Promise<void>,
  scripted: Scripted,
  hooks: BenchHooks = {},
): Promise<void> {
  const paths = fx.tempDatabase();
  const clock = { value: AT };
  const store = new SqliteTrainingStore({ path: paths.path, now: () => clock.value });
  let minted = 0;
  const options: WorkbenchServiceOptions = {
    store,
    taxonomy: TAXONOMY,
    now: () => clock.value,
    uniqueId: () => `plan-${(minted += 1)}`,
  };
  const workbench = new WorkbenchService(options);
  const port = planningData(workbench);
  const planning = new PlanningService({
    store: hooks.store === undefined ? store : hooks.store(store),
    generator: scripted.generator,
    preparation: hooks.preparation === undefined ? port : hooks.preparation(port, workbench),
    now: () => clock.value,
    ...(hooks.onInternalError === undefined ? {} : { onInternalError: hooks.onInternalError }),
  });
  try {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const solved = fx.makeScope('codeforces', 'codeforces.com', 'alice', '9Z');
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertAccounts([scope.account]);
    await store.upsertProblems([
      scope.problem,
      fx.makeProblem(fx.makeRef(scope.instance, '2B')),
      fx.makeProblem(fx.makeRef(scope.instance, '3C')),
      solved.problem,
    ]);
    await store.upsertSubmissions([
      fx.makeSubmission(scope.account, solved.problem.ref, 'sub-solved', 'accepted', AT),
    ]);
    await run({ store, workbench, planning, clock, scope, solved }, scripted);
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
}

/** Save a settings record and return its revision, so the run guard has something to compare. */
async function saveSettings(store: SqliteTrainingStore, settings: WorkbenchSettings): Promise<number> {
  return store.saveWorkbenchSettings(settings, null);
}

function withQuota(limit: number): WorkbenchSettings {
  const base = defaultWorkbenchSettings();
  return { ...base, coaching: { ...base.coaching, maxCallsPer24Hours: limit } };
}

// ---------------------------------------------------------------------------------------

test('prepare is free, durable and idempotent, and never dispatches a model call', async () => {
  const scripted = scriptedGenerator(async () => planned({ title: null, tasks: [] }));
  await withBench(async ({ store, planning, scope, solved }) => {
    const first = await planning.prepare({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(first.outcome, 'prepared');
    if (first.outcome !== 'prepared') return;
    assert.equal(first.view.status, 'prepared');
    assert.equal(first.view.disclosure, '能力统计摘要及所选候选题信息；不含账号标识、提交明细或复盘笔记');
    assert.ok(first.view.candidates.length >= 3, 'the three unsolved problems are candidates');
    assert.ok(first.view.generator.maxCallsPer24Hours > 0);

    // The account's own accepted problem is excluded by default; the solved problem of another
    // key never appears, and no candidate exposes a withheld tag list.
    const keys = first.view.candidates.map((candidate) => candidate.problemKey);
    assert.ok(!keys.includes(solved.problem.key));
    for (const candidate of first.view.candidates) {
      assert.equal(Object.hasOwn(candidate, 'taxonomyIds'), false);
      assert.equal(Object.hasOwn(candidate, 'provisionalRawTags'), false);
    }

    const second = await planning.prepare({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(second.outcome, 'prepared');
    if (second.outcome !== 'prepared') return;
    assert.equal(second.view.contentHash, first.view.contentHash, 'the same request is idempotent');

    // Free: one durable prepared row, nothing charged, and no provider call.
    assert.equal(scripted.calls.length, 0);
    assert.equal(await store.countPlanAttempts({}), 1);
    assert.equal(
      await store.countPlanAttempts({ statuses: ['reserved', 'settled', 'uncertain'] }),
      0,
      'a prepared row is not a charged call',
    );
  }, scripted);
});

test('prepare refuses a conflicting payload under the same request id and discloses no account', async () => {
  const scripted = scriptedGenerator(async () => planned({ title: null, tasks: [] }));
  await withBench(async ({ planning, scope }) => {
    const first = await planning.prepare({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(first.outcome, 'prepared');
    await assert.rejects(
      () =>
        planning.prepare(
          { requestId: REQUEST, accountId: scope.account.id, settings: { horizonDays: 3 } },
          TOKEN,
        ),
      (error: unknown) => error instanceof PlanningServiceError && error.code === 'request_conflict',
    );
  }, scripted);
});

test('a paid run validates the model answer and stores a source=model plan', async () => {
  const scripted = scriptedGenerator(async (request) =>
    planned({
      title: 'AI weekly plan',
      tasks: [
        { candidateId: request.candidates[0]!.candidateId, day: 1, minutes: 30, kind: 'solve' },
        { candidateId: request.candidates[1]!.candidateId, day: 2, minutes: null, kind: null },
      ],
    }),
  );
  await withBench(async ({ store, planning, scope, solved }) => {
    await saveSettings(store, withQuota(3));
    const prepared = await planning.prepare({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(prepared.outcome, 'prepared');

    const run = await planning.run(
      { requestId: REQUEST, accountId: scope.account.id, expectedSettingsRevision: 1 },
      TOKEN,
    );
    assert.equal(run.outcome, 'planned');
    assert.equal(scripted.calls.length, 1);
    assert.ok(run.attempt !== null && run.attempt.planId !== null && run.attempt.planHash !== null);
    assert.equal(run.attempt?.status, 'settled');
    assert.equal(run.attempt?.error, null);
    assert.equal(run.attempt?.usage?.calls, 1);

    const plan = await store.getPlan(run.attempt!.planId!);
    assert.ok(plan !== null);
    assert.equal(plan.source, 'model');
    assert.equal(plan.evidence.attemptedDistinctTotal, 1, 'stored provenance retains the real submission count');
    assert.equal(plan.evidence.attemptedDistinctTotal, scripted.calls[0]?.attemptedDistinctTotal);
    assert.deepEqual(plan.evidence.sufficientTagIds, prepared.outcome === 'prepared' ? prepared.view.weakness.sufficientTagIds : []);
    assert.equal(plan.status, 'draft');
    assert.equal(plan.accountId, scope.account.id);
    assert.equal(plan.tasks.length, 2);
    // Titles and links come from the stored problem, never from the model draft.
    assert.equal(plan.tasks[0]!.title, scope.problem.title);
    assert.equal(plan.tasks[1]!.minutes, plan.tasks[1]!.minutes);

    // The generation request carries no account identifier, no handle, no statement and no note.
    const prompt = JSON.stringify(scripted.calls[0]);
    assert.equal(prompt.includes(scope.account.id), false);
    assert.equal(prompt.includes('alice'), false);
    assert.equal(prompt.includes(solved.problem.title), false);
    assert.equal(prompt.includes('Given an array, support range add and range sum queries.'), false);
  }, scripted);
});

test('a repeat run and a status read return the same durable audit without a second dispatch', async () => {
  const scripted = scriptedGenerator(async (request) =>
    planned({ title: null, tasks: [{ candidateId: request.candidates[0]!.candidateId, day: 1, minutes: 20, kind: 'solve' }] }),
  );
  await withBench(async ({ planning, scope }) => {
    const prepared = await planning.prepare({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(prepared.outcome, 'prepared');
    const first = await planning.run({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(first.outcome, 'planned');

    const second = await planning.run({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(second.outcome, 'planned');
    assert.equal(second.attempt?.planId, first.attempt?.planId);
    assert.equal(scripted.calls.length, 1, 'a paid attempt is never redispatched');

    const status = await planning.status({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(status.status, 'found');
    if (status.status === 'found') {
      assert.equal(status.attempt.status, 'settled');
      assert.equal(status.attempt.planId, first.attempt?.planId);
      assert.equal(JSON.stringify(status.attempt).includes('tasks'), false, 'no audit body is exposed');
    }

    // Another account cannot read or reuse the attempt.
    const foreign = await planning.status({ requestId: REQUEST, accountId: 'someone-else' }, TOKEN);
    assert.equal(foreign.status, 'unknown');
    await assert.rejects(
      () => planning.run({ requestId: REQUEST, accountId: 'someone-else' }, TOKEN),
      (error: unknown) => error instanceof PlanningServiceError && error.code === 'unknown_request',
    );
  }, scripted);
});

test('unknown, duplicate and out-of-range model answers are refused with their cost retained', async () => {
  const drafts: readonly PlanGenerationDraft[] = [
    { title: null, tasks: [{ candidateId: 'candidate-hallucinated', day: 1, minutes: 30, kind: 'solve' }] },
    {
      title: null,
      tasks: [
        { candidateId: '__FIRST__', day: 1, minutes: 30, kind: 'solve' },
        { candidateId: '__FIRST__', day: 2, minutes: 30, kind: 'solve' },
      ],
    },
    { title: null, tasks: [{ candidateId: '__FIRST__', day: 99, minutes: 30, kind: 'solve' }] },
  ];
  for (const [index, draft] of drafts.entries()) {
    const scripted = scriptedGenerator(async (request) =>
      planned({
        title: draft.title,
        tasks: draft.tasks.map((task) => ({
          ...task,
          candidateId: task.candidateId === '__FIRST__' ? request.candidates[0]!.candidateId : task.candidateId,
        })),
      }),
    );
    await withBench(async ({ store, planning, scope }) => {
      await saveSettings(store, withQuota(5));
      const requestId = `bad-answer-${index}`;
      const prepared = await planning.prepare({ requestId, accountId: scope.account.id }, TOKEN);
      assert.equal(prepared.outcome, 'prepared');
      const run = await planning.run({ requestId, accountId: scope.account.id }, TOKEN);
      assert.equal(run.outcome, 'failed', `draft ${index} must be refused`);
      assert.equal(run.attempt?.status, 'settled');
      assert.equal(run.attempt?.error?.code, 'invalid_output');
      assert.equal(run.attempt?.planId, null);
      assert.equal(run.attempt?.usage?.calls, 1, 'the paid call is retained');
      assert.equal(scripted.calls.length, 1);
      assert.deepEqual(await store.listPlans(scope.account.id), [], 'no refused answer is stored');
      assert.equal(
        await store.countPlanAttempts({ statuses: ['settled'] }),
        1,
        'a refused answer still counts against the quota',
      );
    }, scripted);
  }
});

test('a settings change after prepare refuses the run, and a candidate accepted after prepare goes stale', async () => {
  const scripted = scriptedGenerator(async (request) =>
    planned({ title: null, tasks: [{ candidateId: request.candidates[0]!.candidateId, day: 1, minutes: 30, kind: 'solve' }] }),
  );
  // Case A: the stored settings revision moved after the preparation.
  await withBench(async ({ store, planning, scope }) => {
    await saveSettings(store, withQuota(5));
    const prepared = await planning.prepare({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(prepared.outcome, 'prepared');
    await store.saveWorkbenchSettings({ ...withQuota(5), provider: 'deepseek-official' }, 1);
    const run = await planning.run({ requestId: REQUEST, accountId: scope.account.id, expectedSettingsRevision: 2 }, TOKEN);
    assert.equal(run.outcome, 'refused');
    assert.equal(run.error?.code, 'settings_changed');
    assert.equal(scripted.calls.length, 0, 'a stale settings revision pays nothing');
  }, scripted);

  // Case B: the account accepted a candidate between prepare and run. The ability evidence and the
  // candidate itself both changed, so the run is a typed stale refusal before any dispatch; the
  // concrete reason depends on which re-read observes the change first, so the code and the absence
  // of a paid call are what the caller may rely on.
  await withBench(async ({ store, planning, scope, clock }) => {
    const prepared = await planning.prepare({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(prepared.outcome, 'prepared');
    if (prepared.outcome !== 'prepared') return;
    const target = prepared.view.candidates[0]!;
    await store.upsertSubmissions([
      fx.makeSubmission(scope.account, fx.makeRef(scope.instance, target.externalKey), 'sub-late', 'accepted', LATER),
    ]);
    clock.value = LATER;
    const run = await planning.run({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(run.outcome, 'refused');
    assert.equal(run.error?.code, 'stale_preparation');
    assert.equal(scripted.calls.length, 0, 'a stale preparation is refused before dispatch');
    assert.equal((await store.getPlanAttempt(REQUEST))?.status, 'prepared', 'a refusal never charges the attempt');
  }, scripted);
});

test('a new AC on a previously attempted non-candidate problem makes the preparation stale before dispatch', async () => {
  const scripted = scriptedGenerator(async (request) =>
    planned({ title: null, tasks: [{ candidateId: request.candidates[0]!.candidateId, day: 1, minutes: 30, kind: 'solve' }] }),
  );
  await withBench(async ({ store, planning, scope, clock }) => {
    // 2B was already attempted (a wrong answer) before the preparation and is NOT in the explicit
    // selection, so it can neither enter the pool nor replace the selected candidate.
    const attempted = fx.makeProblem(fx.makeRef(scope.instance, '2B'));
    await store.upsertSubmissions([
      fx.makeSubmission(scope.account, attempted.ref, 'sub-wa', 'wrong_answer', AT),
    ]);
    const prepared = await planning.prepare(
      { requestId: REQUEST, accountId: scope.account.id, candidateProblemKeys: [scope.problem.key] },
      TOKEN,
    );
    assert.equal(prepared.outcome, 'prepared');
    if (prepared.outcome !== 'prepared') return;
    assert.deepEqual(prepared.view.candidates.map((candidate) => candidate.problemKey), [scope.problem.key]);
    const weaknessBefore = prepared.view.weakness;

    // The first AC on 2B arrives after the preparation. The attempted total and the weak-tag
    // ranking are unchanged (2B was already attempted and carries no sufficient tag evidence), but
    // the ability evidence moved: the new solve changes the rolling window and completion modes.
    await store.upsertSubmissions([
      fx.makeSubmission(scope.account, attempted.ref, 'sub-late-ac', 'accepted', LATER),
    ]);
    clock.value = LATER;

    const run = await planning.run({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(run.outcome, 'refused');
    assert.equal(run.error?.code, 'stale_preparation');
    assert.match(String(run.error?.message), /ability_changed/);
    assert.equal(scripted.calls.length, 0, 'the paid call is refused before dispatch');
    const stored = await store.getPlanAttempt(REQUEST);
    assert.equal(stored?.status, 'prepared', 'a refusal leaves the free preparation untouched');
    assert.equal(await store.countPlanAttempts({ statuses: ['reserved', 'settled', 'uncertain'] }), 0);
    assert.equal(stored?.preparation.weakness.attemptedDistinctTotal, weaknessBefore.attemptedDistinctTotal);
    assert.deepEqual(stored?.preparation.weakness.ranking, weaknessBefore.ranking);
  }, scripted);
});

test('a retrospective recorded after prepare on a solved problem is a real change', async () => {
  const scripted = scriptedGenerator(async (request) =>
    planned({ title: null, tasks: [{ candidateId: request.candidates[0]!.candidateId, day: 1, minutes: 30, kind: 'solve' }] }),
  );
  await withBench(async ({ store, planning, scope, solved, clock }) => {
    const prepared = await planning.prepare(
      { requestId: REQUEST, accountId: scope.account.id, candidateProblemKeys: [scope.problem.key] },
      TOKEN,
    );
    assert.equal(prepared.outcome, 'prepared');

    // The solver records how they finished the already solved, non-candidate problem after the
    // preparation: the completion-mode evidence moves even though no submission changed.
    await store.saveRetrospective(
      fx.makeRetrospective(solved.problem, scope.account.id, {
        recordedAt: LATER,
        note: 'used the editorial for the invariant',
      }),
    );
    clock.value = LATER;

    const run = await planning.run({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(run.outcome, 'refused');
    assert.equal(run.error?.code, 'stale_preparation');
    assert.match(String(run.error?.message), /ability_changed/);
    assert.equal(scripted.calls.length, 0);
  }, scripted);
});

test('evidence that aged out of the rolling 90-day window is a real change, not a clock artefact', async () => {
  const scripted = scriptedGenerator(async (request) =>
    planned({ title: null, tasks: [{ candidateId: request.candidates[0]!.candidateId, day: 1, minutes: 30, kind: 'solve' }] }),
  );
  await withBench(async ({ planning, scope, clock }) => {
    const prepared = await planning.prepare({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(prepared.outcome, 'prepared');
    // 91 days later the same stored history is genuinely outside the recent window, so the
    // reassessment must not silently reuse the old aggregate.
    clock.value = '2027-01-31T08:00:00.000Z';

    const run = await planning.run({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(run.outcome, 'refused');
    assert.equal(run.error?.code, 'stale_preparation');
    assert.match(String(run.error?.message), /ability_changed/);
    assert.equal(scripted.calls.length, 0, 'aged evidence is refused before dispatch');
  }, scripted);
});

test('the same late AC during generation keeps the paid usage and stores no plan', async () => {
  const scripted = scriptedGenerator(async (request) =>
    planned({ title: null, tasks: [{ candidateId: request.candidates[0]!.candidateId, day: 1, minutes: 30, kind: 'solve' }] }),
  );
  await withBench(async ({ store, planning, scope, clock }) => {
    const attempted = fx.makeProblem(fx.makeRef(scope.instance, '2B'));
    await store.upsertSubmissions([
      fx.makeSubmission(scope.account, attempted.ref, 'sub-wa', 'wrong_answer', AT),
    ]);
    const prepared = await planning.prepare(
      { requestId: REQUEST, accountId: scope.account.id, candidateProblemKeys: [scope.problem.key] },
      TOKEN,
    );
    assert.equal(prepared.outcome, 'prepared');
    // Only the clock moved: a later instant alone must not make the identifier-free aggregate
    // differ, so the pre-dispatch re-validation still passes.
    clock.value = LATER;
    const original = scripted.generator.generate;
    const mutating: PlanningGenerator = {
      async generate(request) {
        await store.upsertSubmissions([
          fx.makeSubmission(scope.account, attempted.ref, 'sub-race-ac', 'accepted', LATER),
        ]);
        return original(request);
      },
    };
    const racing = new PlanningService({
      store,
      generator: mutating,
      preparation: planningData(new WorkbenchService({
        store,
        taxonomy: TAXONOMY,
        now: () => clock.value,
        uniqueId: () => 'plan-race',
      })),
      now: () => clock.value,
    });
    const run = await racing.run({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(run.outcome, 'failed');
    assert.equal(run.attempt?.status, 'settled');
    assert.equal(run.attempt?.planId, null);
    assert.equal(run.attempt?.usage?.calls, 1, 'the paid call is retained');
    assert.match(String(run.attempt?.error?.message), /went stale/);
    assert.deepEqual(await store.listPlans(scope.account.id), []);
  }, scripted);
});

test('an explicit candidate selection uses exactly the selected own-source problems', async () => {
  const scripted = scriptedGenerator(async (request) =>
    planned({ title: null, tasks: [{ candidateId: request.candidates[0]!.candidateId, day: 1, minutes: 30, kind: 'solve' }] }),
  );
  await withBench(async ({ planning, scope, solved }) => {
    const unselected = fx.makeProblem(fx.makeRef(scope.instance, '2B'));
    const third = fx.makeProblem(fx.makeRef(scope.instance, '3C'));
    const selection = [scope.problem.key, third.key, solved.problem.key];

    const prepared = await planning.prepare(
      { requestId: REQUEST, accountId: scope.account.id, candidateProblemKeys: selection },
      TOKEN,
    );
    assert.equal(prepared.outcome, 'prepared');
    if (prepared.outcome !== 'prepared') return;
    // Only the selected stored problems, minus the one this account already accepted. The
    // unselected problem is never used as a fallback, and nothing is truncated.
    assert.deepEqual(
      prepared.view.candidates.map((candidate) => candidate.problemKey),
      [scope.problem.key, third.key],
    );
    assert.ok(!prepared.view.candidates.some((candidate) => candidate.problemKey === unselected.key));
    assert.equal(prepared.view.exclusions.candidateLimit, 3);
    assert.equal(prepared.view.exclusions.nativeSolvedExcluded, 1);
    assert.equal(prepared.view.exclusions.considered, 3);

    // The selection is immutable request identity: the same id cannot name a different scope...
    await assert.rejects(
      () =>
        planning.prepare(
          { requestId: REQUEST, accountId: scope.account.id, candidateProblemKeys: [unselected.key] },
          TOKEN,
        ),
      (error: unknown) => error instanceof PlanningServiceError && error.code === 'request_conflict',
    );
    // ...while the identical selection replays idempotently.
    const replay = await planning.prepare(
      { requestId: REQUEST, accountId: scope.account.id, candidateProblemKeys: selection },
      TOKEN,
    );
    assert.equal(replay.outcome, 'prepared');
    if (replay.outcome === 'prepared') {
      assert.equal(replay.view.contentHash, prepared.view.contentHash);
      assert.equal(replay.view.candidates.length, 2);
    }
  }, scripted);
});

test('explicit selections are validated and an empty or fully solved selection is a free refusal', async () => {
  const scripted = scriptedGenerator(async () => planned({ title: null, tasks: [] }));
  await withBench(async ({ store, planning, scope, solved }) => {
    const foreign = fx.makeScope('luogu', 'luogu.com', 'alice', 'P1001');
    await store.upsertSourceInstances([foreign.instance]);
    await store.upsertProblems([foreign.problem]);

    // An explicit empty selection is a caller statement, not a request for the automatic pool.
    const empty = await planning.prepare(
      { requestId: 'empty-selection', accountId: scope.account.id, candidateProblemKeys: [] },
      TOKEN,
    );
    assert.equal(empty.outcome, 'refused');
    assert.equal(empty.error?.code, 'preparation_empty');
    assert.equal(await store.countPlanAttempts({}), 0, 'a refused preparation stores nothing');

    // Every selected problem already solved is the same honest refusal, never a substitute row.
    const allSolved = await planning.prepare(
      { requestId: 'solved-selection', accountId: scope.account.id, candidateProblemKeys: [solved.problem.key] },
      TOKEN,
    );
    assert.equal(allSolved.outcome, 'refused');
    assert.equal(allSolved.error?.code, 'preparation_empty');
    assert.equal(await store.countPlanAttempts({}), 0);

    // A key of another source instance is refused, never borrowed into this account's plan.
    await assert.rejects(
      () =>
        planning.prepare(
          { requestId: 'foreign-selection', accountId: scope.account.id, candidateProblemKeys: [foreign.problem.key] },
          TOKEN,
        ),
      (error: unknown) => (error as { code?: string; details?: { reason?: string } }).details?.reason === 'candidate_source_mismatch',
    );
    // An unknown key is a missing reference, not a smaller pool.
    await assert.rejects(
      () =>
        planning.prepare(
          {
            requestId: 'missing-selection',
            accountId: scope.account.id,
            candidateProblemKeys: [fx.keyOf(fx.makeRef(scope.instance, '99Z'))],
          },
          TOKEN,
        ),
      (error: unknown) => (error as { code?: string }).code === 'missing_reference',
    );
    // Non-canonical, duplicated and over-long selections are bad input.
    for (const keys of [
      ['not-a-problem-key'],
      [scope.problem.key, scope.problem.key],
      Array.from({ length: 101 }, (_, index) => fx.keyOf(fx.makeRef(scope.instance, `${index + 1}A`))),
    ]) {
      await assert.rejects(
        () => planning.prepare({ requestId: `invalid-${keys.length}-${keys[0]}`, accountId: scope.account.id, candidateProblemKeys: keys }, TOKEN),
        (error: unknown) => error instanceof PlanningServiceError && error.code === 'invalid_request',
      );
    }
    // A candidateLimit below the selection is a typed conflict instead of a silent truncation.
    await assert.rejects(
      () =>
        planning.prepare(
          {
            requestId: 'narrow-limit',
            accountId: scope.account.id,
            candidateProblemKeys: [scope.problem.key, fx.makeProblem(fx.makeRef(scope.instance, '3C')).key],
            candidateLimit: 1,
          },
          TOKEN,
        ),
      (error: unknown) =>
        error instanceof PlanningServiceError &&
        error.code === 'invalid_request' &&
        error.details['reason'] === 'candidate_limit_below_selection',
    );
    assert.equal(scripted.calls.length, 0, 'no selection refusal ever dispatches');
  }, scripted);
});

test('the preparation view exposes the captured settings revision for the paid run', async () => {
  const scripted = scriptedGenerator(async () => planned({ title: null, tasks: [] }));
  await withBench(async ({ store, planning, scope }) => {
    const revision = await saveSettings(store, withQuota(5));
    const prepared = await planning.prepare({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(prepared.outcome, 'prepared');
    if (prepared.outcome !== 'prepared') return;
    assert.equal(prepared.view.settingsRevision, revision, 'the view reports the revision it captured');

    await store.saveWorkbenchSettings({ ...withQuota(5), provider: 'deepseek-official' }, revision);
    const run = await planning.run(
      { requestId: REQUEST, accountId: scope.account.id, expectedSettingsRevision: prepared.view.settingsRevision },
      TOKEN,
    );
    assert.equal(run.outcome, 'refused');
    assert.equal(run.error?.code, 'settings_changed');
    assert.equal(scripted.calls.length, 0);
  }, scripted);
});

test('history is account scoped, newest first and never carries preparation material', async () => {
  const scripted = scriptedGenerator(async () => planned({ title: null, tasks: [] }));
  await withBench(async ({ store, planning, scope, solved, clock }) => {
    const other = fx.makeScope('codeforces', 'codeforces.com', 'bob', '4D');
    await store.upsertAccounts([other.account]);

    const first = await planning.prepare(
      { requestId: 'history-1', accountId: scope.account.id, candidateProblemKeys: [scope.problem.key] },
      TOKEN,
    );
    assert.equal(first.outcome, 'prepared');
    clock.value = LATER;
    const second = await planning.prepare({ requestId: 'history-2', accountId: scope.account.id }, TOKEN);
    assert.equal(second.outcome, 'prepared');
    clock.value = '2026-11-01T10:00:00.000Z';
    const third = await planning.prepare(
      { requestId: 'history-3', accountId: scope.account.id, candidateProblemKeys: [scope.problem.key, solved.problem.key] },
      TOKEN,
    );
    assert.equal(third.outcome, 'prepared');
    clock.value = '2026-11-01T11:00:00.000Z';
    const foreign = await planning.prepare({ requestId: 'history-other', accountId: other.account.id }, TOKEN);
    assert.equal(foreign.outcome, 'prepared');

    const rows = await planning.history({ accountId: scope.account.id }, TOKEN);
    assert.deepEqual(
      rows.map((row) => row.requestId),
      ['history-3', 'history-2', 'history-1'],
      'the newest attempt comes first and another account is never mixed in',
    );
    assert.ok(rows.every((row) => row.accountId === scope.account.id));
    const otherRows = await planning.history({ accountId: other.account.id }, TOKEN);
    assert.deepEqual(otherRows.map((row) => row.requestId), ['history-other']);

    // Metadata only: no preparation, candidate ids, tags, aggregate evidence or hashes.
    const text = JSON.stringify(rows);
    for (const forbidden of [
      'preparation',
      'candidateId',
      'taxonomyIds',
      'provisionalRawTags',
      'weakness',
      'ability',
      'inputHash',
      'contentHash',
      scope.problem.title,
    ]) {
      assert.equal(text.includes(forbidden), false, `history must not carry ${forbidden}`);
    }
    assert.equal(rows[0]?.candidateCount, 1, 'the count is metadata, not the candidate list');

    // The page bound is validated, never clamped.
    assert.equal((await planning.history({ accountId: scope.account.id, limit: 1 }, TOKEN)).length, 1);
    assert.equal((await planning.history({ accountId: scope.account.id, limit: 50 }, TOKEN)).length, 3);
    await assert.rejects(
      () => planning.history({ accountId: scope.account.id, limit: 51 }, TOKEN),
      (error: unknown) => error instanceof PlanningServiceError && error.code === 'invalid_request',
    );
  }, scripted);
});

test('expired reservations recover while a live reservation is preserved and never blocks', async () => {
  const scripted = scriptedGenerator(async (request) =>
    planned({ title: null, tasks: [{ candidateId: request.candidates[0]!.candidateId, day: 1, minutes: 30, kind: 'solve' }] }),
  );
  await withBench(async ({ store, planning, scope, clock }) => {
    await saveSettings(store, withQuota(5));
    const expired = await planning.prepare({ requestId: 'recover-expired', accountId: scope.account.id }, TOKEN);
    const after = await planning.prepare({ requestId: 'recover-after', accountId: scope.account.id }, TOKEN);
    assert.equal(expired.outcome, 'prepared');
    assert.equal(after.outcome, 'prepared');
    clock.value = LATER;
    const live = await planning.prepare({ requestId: 'recover-live', accountId: scope.account.id }, TOKEN);
    assert.equal(live.outcome, 'prepared');

    // Only the expired reservation exists right now.
    const expiredRow = await store.getPlanAttempt('recover-expired');
    assert.ok(expiredRow !== null);
    await store.savePlanAttempt({ ...expiredRow, status: 'reserved', requestedAt: AT, expiresAt: EXPIRED_LEASE });

    assert.equal(await planning.recoverExpiredReservations(TOKEN), 1, 'only the expired reservation is converted');
    assert.equal((await store.getPlanAttempt('recover-expired'))?.status, 'uncertain');

    // A converted row is no longer live, so it must not block the single in-flight call.
    const run = await planning.run({ requestId: 'recover-after', accountId: scope.account.id }, TOKEN);
    assert.equal(run.outcome, 'planned', 'a recovered reservation does not block a new dispatch');
    assert.equal(scripted.calls.length, 1);

    // A genuinely live reservation is kept exactly as it was and reported as blocking.
    const liveRow = await store.getPlanAttempt('recover-live');
    assert.ok(liveRow !== null);
    await store.savePlanAttempt({ ...liveRow, status: 'reserved', requestedAt: LATER, expiresAt: LIVE_LEASE });
    assert.equal(await planning.recoverExpiredReservations(TOKEN), 0, 'a second recovery converts nothing');
    assert.equal((await store.getPlanAttempt('recover-live'))?.status, 'reserved', 'the live reservation is preserved');
    assert.equal(await planning.hasLiveReservation(TOKEN), true, 'the live reservation is still reported');

    assert.equal(await store.countPlanAttempts({ statuses: ['uncertain'] }), 1, 'the recovered slot stays charged');
    assert.equal(await store.countPlanAttempts({ statuses: ['reserved'] }), 1, 'the live slot stays charged');
    assert.equal(await store.countPlanAttempts({ statuses: ['settled'] }), 1);
  }, scripted);
});

test('a preparation that goes stale while the model answers keeps its cost and stores no plan', async () => {
  const scripted = scriptedGenerator(async (request) => {
    const target = request.candidates[0]!;
    return planned({ title: null, tasks: [{ candidateId: target.candidateId, day: 1, minutes: 30, kind: 'solve' }] });
  });
  await withBench(async ({ store, planning, scope }) => {
    const prepared = await planning.prepare({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(prepared.outcome, 'prepared');
    if (prepared.outcome !== 'prepared') return;
    const target = prepared.view.candidates[0]!;
    // The store changes while the provider call is in flight.
    const original = scripted.generator.generate;
    const mutating: PlanningGenerator = {
      async generate(request) {
        await store.upsertSubmissions([
          fx.makeSubmission(scope.account, fx.makeRef(scope.instance, target.externalKey), 'sub-race', 'accepted', LATER),
        ]);
        return original(request);
      },
    };
    const racing = new PlanningService({
      store,
      generator: mutating,
      preparation: planningData(new WorkbenchService({
        store,
        taxonomy: TAXONOMY,
        now: () => AT,
        uniqueId: () => 'plan-race',
      })),
      now: () => LATER,
    });
    const run = await racing.run({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(run.outcome, 'failed');
    assert.equal(run.attempt?.status, 'settled');
    assert.equal(run.attempt?.planId, null);
    assert.equal(run.attempt?.usage?.calls, 1, 'the paid call is retained');
    assert.match(String(run.attempt?.error?.message), /went stale/);
    assert.deepEqual(await store.listPlans(scope.account.id), []);
  }, scripted);
});

test('cancel of a prepared attempt is free and terminal; unknown usage is charged as uncertain', async () => {
  const scripted = scriptedGenerator(async () => planned({ title: null, tasks: [] }));
  await withBench(async ({ store, planning, scope }) => {
    const prepared = await planning.prepare({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(prepared.outcome, 'prepared');
    const cancelled = await planning.cancel({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(cancelled.status, 'found');
    if (cancelled.status === 'found') {
      assert.equal(cancelled.attempt.status, 'cancelled');
      assert.equal(cancelled.attempt.usage, null);
    }
    assert.equal(await store.countPlanAttempts({ statuses: ['reserved', 'settled', 'uncertain'] }), 0);
    const history = await planning.history({ accountId: scope.account.id }, TOKEN);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.status, 'cancelled', 'an abandoned preparation stays visible as free history');
    const run = await planning.run({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(run.outcome, 'cancelled');
    assert.equal(scripted.calls.length, 0, 'a cancelled preparation never dispatches');
  }, scripted);

  // A dispatched call the provider answered without usage stays on the books as uncertain.
  const unknownUsage = scriptedGenerator(async () => failed(null));
  await withBench(async ({ store, planning, scope }) => {
    await saveSettings(store, withQuota(5));
    const prepared = await planning.prepare({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(prepared.outcome, 'prepared');
    const run = await planning.run({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(run.outcome, 'uncertain');
    assert.equal(run.attempt?.status, 'uncertain');
    assert.equal(run.attempt?.usage, null);
    assert.equal(await store.countPlanAttempts({ statuses: ['uncertain'] }), 1, 'unknown usage is charged');
    const again = await planning.run({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(again.outcome, 'uncertain');
    assert.equal(unknownUsage.calls.length, 1, 'an uncertain attempt is never retried automatically');
  }, unknownUsage);
});

test('the borrowed rolling quota bounds paid runs and a live reservation blocks a second one', async () => {
  const scripted = scriptedGenerator(async (request) =>
    planned({ title: null, tasks: [{ candidateId: request.candidates[0]!.candidateId, day: 1, minutes: 30, kind: 'solve' }] }),
  );
  await withBench(async ({ store, planning, scope }) => {
    await saveSettings(store, withQuota(1));
    const first = await planning.prepare({ requestId: 'quota-1', accountId: scope.account.id }, TOKEN);
    assert.equal(first.outcome, 'prepared');
    const run = await planning.run({ requestId: 'quota-1', accountId: scope.account.id }, TOKEN);
    assert.equal(run.outcome, 'planned');

    const second = await planning.prepare({ requestId: 'quota-2', accountId: scope.account.id }, TOKEN);
    assert.equal(second.outcome, 'prepared');
    const blocked = await planning.run({ requestId: 'quota-2', accountId: scope.account.id }, TOKEN);
    assert.equal(blocked.outcome, 'refused');
    assert.equal(blocked.error?.code, 'planning_quota_exhausted');
    assert.equal(scripted.calls.length, 1);

    // A live reservation from another attempt blocks a second dispatch even with quota left.
    await store.saveWorkbenchSettings({ ...withQuota(5), provider: 'deepseek-official' }, 1);
    const third = await planning.prepare({ requestId: 'quota-3', accountId: scope.account.id }, TOKEN);
    assert.equal(third.outcome, 'prepared');
    const attempt = await store.getPlanAttempt('quota-3');
    assert.ok(attempt !== null);
    await store.savePlanAttempt({ ...attempt, status: 'reserved', requestedAt: AT, expiresAt: LIVE_LEASE });
    assert.equal(await planning.hasLiveReservation(TOKEN), true);
    const live = await planning.liveReservations(TOKEN);
    assert.equal(live.length, 1);
    assert.equal(live[0]?.requestId, 'quota-3');
    const concurrent = await planning.run({ requestId: 'quota-3', accountId: scope.account.id }, TOKEN);
    assert.equal(concurrent.outcome, 'pending', 'a reserved attempt is never redispatched');
    assert.equal(scripted.calls.length, 1);
  }, scripted);
});

test('an expired reservation recovers to uncertain once and keeps its quota slot', async () => {
  const scripted = scriptedGenerator(async () => planned({ title: null, tasks: [] }));
  await withBench(async ({ store, planning, scope, clock }) => {
    await saveSettings(store, withQuota(5));
    const prepared = await planning.prepare({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(prepared.outcome, 'prepared');
    const attempt = await store.getPlanAttempt(REQUEST);
    assert.ok(attempt !== null);
    // Simulate a process that reserved a call and died before settling it.
    await store.savePlanAttempt({ ...attempt, status: 'reserved', requestedAt: AT, expiresAt: EXPIRED_LEASE });
    clock.value = LATER;

    assert.equal(await planning.hasLiveReservation(TOKEN), false);
    assert.equal(await planning.recoverExpiredReservations(TOKEN), 1);
    const recovered = await store.getPlanAttempt(REQUEST);
    assert.equal(recovered?.status, 'uncertain');
    assert.equal(recovered?.usage, null);
    assert.match(String(recovered?.error?.message), /expired/);
    assert.equal(await planning.recoverExpiredReservations(TOKEN), 0, 'recovery is idempotent');
    assert.equal(await store.countPlanAttempts({ statuses: ['uncertain'] }), 1, 'the slot is never refunded');

    const run = await planning.run({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(run.outcome, 'uncertain');
    assert.equal(scripted.calls.length, 0, 'a recovered attempt is never redispatched');
  }, scripted);
});

// ---------------------------------------------------------------------------------------
// Cancellation-safe settlement and the post-dispatch settings guard (repair 2)
// ---------------------------------------------------------------------------------------

test('a cancellation observed when the provider returns keeps the paid usage and stores no plan', async () => {
  const source = createCancellationSource();
  const scripted = scriptedGenerator(async (request) => {
    // The user cancels while the provider answer is on its way back: the answer is already paid.
    source.cancel();
    return planned({
      title: null,
      tasks: [{ candidateId: request.candidates[0]!.candidateId, day: 1, minutes: 30, kind: 'solve' }],
    });
  });
  await withBench(async ({ store, planning, scope }) => {
    const prepared = await planning.prepare({ requestId: REQUEST, accountId: scope.account.id }, source.token);
    assert.equal(prepared.outcome, 'prepared');

    const run = await planning.run({ requestId: REQUEST, accountId: scope.account.id }, source.token);
    assert.equal(run.outcome, 'failed');
    assert.equal(run.attempt?.status, 'settled', 'the reservation is terminal, never stranded');
    assert.equal(run.attempt?.error?.code, 'cancelled');
    assert.equal(run.attempt?.planId, null);
    assert.equal(run.attempt?.planHash, null);
    assert.deepEqual(
      run.attempt?.usage,
      createModelUsage({ calls: 1, promptTokens: 120, completionTokens: 40 }),
      'the known paid usage is kept exactly',
    );
    assert.equal(scripted.calls.length, 1);
    assert.deepEqual(await store.listPlans(scope.account.id), [], 'a cancelled dispatch stores no plan');

    const stored = await store.getPlanAttempt(REQUEST);
    assert.equal(stored?.status, 'settled');
    assert.equal(stored?.hostCallId, 'host-call-1', 'the host correlation is durable');
    assert.equal(stored?.hostSessionId, 'host-session-1');
    assert.equal(await store.countPlanAttempts({ statuses: ['reserved'] }), 0, 'no reservation is left behind');
    assert.equal(await store.countPlanAttempts({ statuses: ['settled'] }), 1);

    // A still-cancelled token is refused at the entry of `run` and pays nothing...
    const stillCancelled = await planning.run({ requestId: REQUEST, accountId: scope.account.id }, source.token);
    assert.equal(stillCancelled.outcome, 'refused');
    assert.equal(stillCancelled.error?.code, 'cancelled');
    assert.equal(stillCancelled.attempt, null);

    // ...while the durable record stays readable with a live token and is never dispatched again.
    const again = await planning.run({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(again.outcome, 'failed');
    assert.equal(again.attempt?.error?.code, 'cancelled');
    assert.deepEqual(again.attempt?.usage, run.attempt?.usage);
    assert.equal(scripted.calls.length, 1, 'a repeated run returns the durable record without a new generation');
    const status = await planning.status({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(status.status, 'found');
    if (status.status === 'found') {
      assert.equal(status.attempt.error?.code, 'cancelled');
      assert.equal(status.attempt.usage?.calls, 1);
    }
  }, scripted);
});

test('a cancellation inside the second re-validation aborts the plan and settles the known usage', async () => {
  const source = createCancellationSource();
  let revalidations = 0;
  let settlementTokenWasLive = false;
  const scripted = scriptedGenerator(async (request) =>
    planned({ title: null, tasks: [{ candidateId: request.candidates[0]!.candidateId, day: 1, minutes: 30, kind: 'solve' }] }),
  );
  await withBench(async ({ store, planning, scope }) => {
    const prepared = await planning.prepare({ requestId: REQUEST, accountId: scope.account.id }, source.token);
    assert.equal(prepared.outcome, 'prepared');

    const run = await planning.run({ requestId: REQUEST, accountId: scope.account.id }, source.token);
    assert.equal(revalidations, 2, 'the reservation and the charged settlement each re-validated once');
    assert.equal(
      settlementTokenWasLive,
      true,
      'the charged settlement re-validated with a token that was still live after the user cancelled',
    );
    assert.equal(run.outcome, 'failed');
    assert.equal(run.attempt?.status, 'settled');
    assert.equal(run.attempt?.error?.code, 'cancelled');
    assert.equal(run.attempt?.planId, null);
    assert.deepEqual(run.attempt?.usage, createModelUsage({ calls: 1, promptTokens: 120, completionTokens: 40 }));
    assert.equal(scripted.calls.length, 1);
    assert.deepEqual(await store.listPlans(scope.account.id), [], 'the cancelled plan is never written');
    assert.equal((await store.getPlanAttempt(REQUEST))?.status, 'settled');
  }, scripted, {
    preparation: (port) => ({
      prepare: port.prepare,
      savePlan: port.savePlan,
      revalidate: async (preparation, token) => {
        revalidations += 1;
        if (revalidations === 2) {
          source.cancel();
          settlementTokenWasLive = token.cancelled === false;
        }
        return port.revalidate(preparation, token);
      },
    }),
  });
});

test('a cancellation after the plan write rolls the plan back and settles the known usage', async () => {
  const source = createCancellationSource();
  let planWrites = 0;
  const scripted = scriptedGenerator(async (request) =>
    planned({ title: null, tasks: [{ candidateId: request.candidates[0]!.candidateId, day: 1, minutes: 30, kind: 'solve' }] }),
  );
  await withBench(async ({ store, planning, scope }) => {
    const prepared = await planning.prepare({ requestId: REQUEST, accountId: scope.account.id }, source.token);
    assert.equal(prepared.outcome, 'prepared');

    const run = await planning.run({ requestId: REQUEST, accountId: scope.account.id }, source.token);
    assert.equal(planWrites, 1, 'the plan write really happened before the cancellation');
    assert.equal(run.outcome, 'failed');
    assert.equal(run.attempt?.status, 'settled');
    assert.equal(run.attempt?.error?.code, 'cancelled');
    assert.equal(run.attempt?.planId, null);
    assert.equal(run.attempt?.planHash, null);
    assert.deepEqual(run.attempt?.usage, createModelUsage({ calls: 1, promptTokens: 120, completionTokens: 40 }));
    assert.equal(scripted.calls.length, 1);
    assert.deepEqual(await store.listPlans(scope.account.id), [], 'the rollback removed the written plan');
    assert.equal(await store.countPlanAttempts({ statuses: ['reserved'] }), 0);
    assert.equal((await store.getPlanAttempt(REQUEST))?.planId, null);
  }, scripted, {
    preparation: (port) => ({
      prepare: port.prepare,
      revalidate: port.revalidate,
      savePlan: async (plan, attemptId, token) => {
        const saved = await port.savePlan(plan, attemptId, token);
        planWrites += 1;
        source.cancel();
        return saved;
      },
    }),
  });
});

test('a cancellation after the settled row write rolls it back and re-settles the paid usage', async () => {
  const source = createCancellationSource();
  let plannedSettlements = 0;
  const scripted = scriptedGenerator(async (request) =>
    planned({ title: null, tasks: [{ candidateId: request.candidates[0]!.candidateId, day: 1, minutes: 30, kind: 'solve' }] }),
  );
  await withBench(async ({ store, planning, scope }) => {
    const prepared = await planning.prepare({ requestId: REQUEST, accountId: scope.account.id }, source.token);
    assert.equal(prepared.outcome, 'prepared');

    const run = await planning.run({ requestId: REQUEST, accountId: scope.account.id }, source.token);
    assert.equal(plannedSettlements, 1, 'the planned settlement really was written before the abort');
    assert.equal(run.outcome, 'failed');
    assert.equal(run.attempt?.status, 'settled');
    assert.equal(run.attempt?.error?.code, 'cancelled');
    assert.equal(run.attempt?.planId, null, 'the pre-commit planned row is not the durable audit');
    assert.equal(run.attempt?.usage?.calls, 1);
    assert.equal(scripted.calls.length, 1);

    const stored = await store.getPlanAttempt(REQUEST);
    assert.equal(stored?.status, 'settled');
    assert.equal(stored?.planId, null);
    assert.equal(stored?.hostCallId, 'host-call-1');
    assert.equal(stored?.hostSessionId, 'host-session-1');
    assert.deepEqual(await store.listPlans(scope.account.id), [], 'the plan written before the abort is gone');
    assert.equal(await store.countPlanAttempts({ statuses: ['reserved'] }), 0);
  }, scripted, {
    store: (target) =>
      storeRacingAfterAttemptWrite(target, (attempt) => {
        if (attempt.status === 'settled' && attempt.planId !== null) {
          plannedSettlements += 1;
          source.cancel();
        }
      }),
  });
});

test('a throwing post-provider re-validation settles a sanitized failure with the known usage', async () => {
  const secret = 'sk-live-DEADBEEF leaked from C:\\Users\\alice\\.dsh\\token.txt';
  const reports: PlanningInternalErrorReport[] = [];
  let revalidations = 0;
  const scripted = scriptedGenerator(async (request) =>
    planned({ title: null, tasks: [{ candidateId: request.candidates[0]!.candidateId, day: 1, minutes: 30, kind: 'solve' }] }),
  );
  await withBench(async ({ store, planning, scope }) => {
    const prepared = await planning.prepare({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(prepared.outcome, 'prepared');

    const run = await planning.run({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(revalidations, 2);
    assert.equal(run.outcome, 'failed');
    assert.equal(run.attempt?.status, 'settled');
    assert.equal(run.attempt?.error?.code, 'provider_error');
    assert.equal(run.attempt?.planId, null);
    assert.equal(run.attempt?.planHash, null);
    assert.deepEqual(run.attempt?.usage, createModelUsage({ calls: 1, promptTokens: 120, completionTokens: 40 }));
    assert.match(String(run.attempt?.error?.message), /prepare the plan again/);
    const text = JSON.stringify(run);
    assert.equal(text.includes('sk-live'), false, 'the raw error never reaches a public result');
    assert.equal(text.includes('token.txt'), false);
    assert.equal(scripted.calls.length, 1, 'the model is never called twice');
    assert.deepEqual(await store.listPlans(scope.account.id), []);
    assert.equal((await store.getPlanAttempt(REQUEST))?.status, 'settled');

    const again = await planning.run({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(again.outcome, 'failed');
    assert.equal(again.attempt?.error?.code, 'provider_error');
    assert.equal(scripted.calls.length, 1, 'a settled failure is never redispatched');
  }, scripted, {
    preparation: (port) => ({
      prepare: port.prepare,
      savePlan: port.savePlan,
      revalidate: async (preparation, token) => {
        revalidations += 1;
        if (revalidations === 2) {
          throw new Error(secret);
        }
        return port.revalidate(preparation, token);
      },
    }),
    onInternalError: (report) => reports.push(report),
  });
  assert.equal(reports.length, 1, 'the raw value only reaches the local diagnostic hook');
  assert.equal(reports[0]?.phase, 'settlement');
  assert.equal((reports[0]?.error as Error).message, secret);
});

test('a workbench settings change after dispatch withholds the plan and keeps the paid usage', async () => {
  let revision = 0;
  let changingStore: SqliteTrainingStore | null = null;
  const scripted = scriptedGenerator(async (request) => {
    assert.ok(changingStore !== null);
    // The configuration moves while the model is answering: the revision and the analysis model
    // both change, so the answer may not be stored as if it belonged to the new configuration.
    await changingStore.saveWorkbenchSettings(
      {
        ...withQuota(5),
        roles: { ...defaultWorkbenchSettings().roles, analysisModel: 'deepseek-v4-pro' },
      },
      revision,
    );
    return planned({
      title: null,
      tasks: [{ candidateId: request.candidates[0]!.candidateId, day: 1, minutes: 30, kind: 'solve' }],
    });
  });
  await withBench(async ({ store, planning, scope }) => {
    changingStore = store;
    revision = await saveSettings(store, withQuota(5));
    const prepared = await planning.prepare({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(prepared.outcome, 'prepared');

    const run = await planning.run({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(run.outcome, 'failed');
    assert.equal(run.attempt?.status, 'settled');
    assert.equal(run.attempt?.error?.code, 'provider_error');
    assert.match(String(run.attempt?.error?.message), /prepare the plan again/);
    assert.match(String(run.attempt?.error?.message), /settings revision/);
    assert.equal(run.attempt?.planId, null);
    assert.deepEqual(
      run.attempt?.usage,
      createModelUsage({ calls: 1, promptTokens: 120, completionTokens: 40 }),
      'the paid call is retained',
    );
    assert.equal(scripted.calls.length, 1);
    assert.deepEqual(await store.listPlans(scope.account.id), [], 'a plan under moved settings is never stored');
    const stored = await store.getPlanAttempt(REQUEST);
    assert.equal(stored?.status, 'settled');
    assert.equal(stored?.settingsRevision, revision, 'the immutable prepared revision is untouched');
  }, scripted);
});

test('an ordinary success still stores its plan and a provider failure keeps its reported usage', async () => {
  const success = scriptedGenerator(async (request) =>
    planned({ title: null, tasks: [{ candidateId: request.candidates[0]!.candidateId, day: 1, minutes: 30, kind: 'solve' }] }),
  );
  await withBench(async ({ store, planning, scope }) => {
    const prepared = await planning.prepare({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(prepared.outcome, 'prepared');
    const run = await planning.run({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(run.outcome, 'planned');
    assert.equal(run.attempt?.status, 'settled');
    assert.equal(run.attempt?.error, null);
    assert.ok(run.attempt !== null && run.attempt.planId !== null && run.attempt.planHash !== null);
    assert.deepEqual(run.attempt?.usage, createModelUsage({ calls: 1, promptTokens: 120, completionTokens: 40 }));
    assert.equal((await store.listPlans(scope.account.id)).length, 1, 'the validated plan is stored');
  }, success);

  const failure = scriptedGenerator(async () =>
    failed(createModelUsage({ calls: 1, promptTokens: 11, completionTokens: 2 })),
  );
  await withBench(async ({ store, planning, scope }) => {
    const prepared = await planning.prepare({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(prepared.outcome, 'prepared');
    const run = await planning.run({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(run.outcome, 'failed');
    assert.equal(run.attempt?.status, 'settled');
    assert.equal(run.attempt?.error?.code, 'provider_error');
    assert.equal(run.attempt?.planId, null);
    assert.deepEqual(
      run.attempt?.usage,
      createModelUsage({ calls: 1, promptTokens: 11, completionTokens: 2 }),
      'the reported failure usage is retained',
    );
    assert.equal(failure.calls.length, 1);
    assert.deepEqual(await store.listPlans(scope.account.id), []);
  }, failure);
});

test('prepared plans include earlier evidence and detect its change while the recent baseline stays unchanged', async () => {
  const scripted = scriptedGenerator(async () => { throw Error('No model dispatch expected'); });
  await withBench(async ({ store, workbench, planning, clock, scope }) => {
    const old = Array.from({ length: 6 }, (_, i) => {
      const base = fx.makeProblem(fx.makeRef(scope.instance, 'old-' + i));
      return { ...base, ratings: [{ dimension: 'rating', value: 2200 + i * 100, scale: null, raw: String(2200 + i * 100) }] };
    });
    const recent = Array.from({ length: 5 }, (_, i) => {
      const base = fx.makeProblem(fx.makeRef(scope.instance, 'new-' + i));
      return { ...base, ratings: [{ dimension: 'rating', value: 800 + i * 100, scale: null, raw: String(800 + i * 100) }] };
    });
    await store.upsertProblems([...old, ...recent]);
    await store.upsertSubmissions([
      ...old.map((p, i) => fx.makeSubmission(scope.account, p.ref, 'history-' + i, 'accepted', '2025-01-01T00:00:00.000Z')),
      ...recent.map((p, i) => fx.makeSubmission(scope.account, p.ref, 'recent-' + i, 'accepted', AT)),
    ]);
    const prepared = await planning.prepare({ requestId: REQUEST, accountId: scope.account.id }, TOKEN);
    assert.equal(prepared.outcome, 'prepared');
    const stored = await store.getPlanAttempt(REQUEST);
    assert.ok(stored);
    const history = stored.preparation.ability.history!;
    assert.equal(history.periods[2]!.eligibleDistinct, 6);
    assert.equal(history.periods[2]!.baselineTrainingLevel, 2500);
    const recentBaseline = stored.preparation.ability.baselineTrainingLevel;
    clock.value = LATER;
    assert.equal((await workbench.revalidatePlanInput(stored.preparation, TOKEN)).ok, true, 'elapsed time alone preserves the preparation');
    await store.upsertProblems(old.map(p => ({ ...p, ratings: [{ dimension: 'rating', value: 3000, scale: null, raw: '3000' }] })));
    const current = await workbench.weakness({ accountId: scope.account.id }, TOKEN);
    assert.equal(current.ability.estimate.baselineTrainingLevel, recentBaseline);
    const changed = await workbench.revalidatePlanInput(stored.preparation, TOKEN);
    assert.equal(changed.ok, false);
    if (!changed.ok) assert.equal(changed.staleness.reason, 'ability_changed');
    assert.equal(scripted.calls.length, 0);
  }, scripted);
});
