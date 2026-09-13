/**
 * Owned AI planning operations over a real SQLite store, the real `WorkbenchService` as the
 * preparation port and the real `PlanningService` (Sprint 11d).
 *
 * Only the model boundary is faked — one scripted local generator that is never paid and one
 * unexpected-gateway stub for the batch pipeline, which these cases never start — plus the injected
 * model-metadata probe, which is a host-composition concern. Everything under test is production
 * code against a real temporary database, so the assertions cover externally meaningful behaviour:
 * a free durable preparation that dispatches nothing, one paid run that stores a projected model
 * plan, account isolation and spoiler reveal, latest-first history recoverability, strict request
 * refusal, the start/save gate, the settings-revision and model-probe guards, idempotent repeats,
 * owned cancellation that keeps known usage, reciprocal batch/coaching/settings exclusion across a
 * restart and past an expired lease, and a bounded disposal that keeps the store open until the
 * durable settlement finished.
 */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { AnalysisPipeline } from '../../src/application/analysis-pipeline.js';
import { CoachingService } from '../../src/application/coaching-service.js';
import type {
  ModelCallResult,
  ModelGateway,
} from '../../src/application/ports.js';
import type {
  PlanGenerationDraft,
  PlanGenerationOutcome,
  PlanGenerationRequest,
} from '../../src/application/planning-generation.js';
import {
  PlanningService,
  type PlanningInternalErrorReport,
} from '../../src/application/planning-service.js';
import type { PlanAttempt } from '../../src/application/planning-types.js';
import {
  ModelOperationError,
  type ModelOperationErrorCode,
  type ModelValidationDiagnostic,
} from '../../src/application/model-operation-types.js';
import { WorkbenchService } from '../../src/application/workbench-service.js';
import {
  defaultWorkbenchSettings,
  type WorkbenchSettings,
} from '../../src/application/workbench-settings.js';
import {
  CURRENT_TAXONOMY,
  createCancellationSource,
  createModelUsage,
  createTaxonomyIndex,
  type CancellationToken,
} from '../../src/domain/index.js';
import { ModelOperations, type ModelOperationFailureReport } from '../../src/plugin/model-operations.js';
import * as fx from '../storage/fixtures.js';

const AT = fx.AT;
const LATER = fx.LATER;
const LATER_STILL = '2026-09-12T10:00:00.000Z';
/** A token nobody cancels: the "normal caller" of most cases. */
const TOKEN = createCancellationSource().token;
const USAGE = createModelUsage({ calls: 1, promptTokens: 120, completionTokens: 40 });
const WORLD = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
const EXTRA_PROBLEMS = [
  fx.makeProblem(fx.makeRef(WORLD.instance, '2B')),
  fx.makeProblem(fx.makeRef(WORLD.instance, '3C')),
];

/** A valid paid answer for the prepared candidate pool; every candidate id is real. */
function plannedFrom(request: PlanGenerationRequest): ModelCallResult<PlanGenerationOutcome> {
  const first = request.candidates[0];
  if (first === undefined) {
    throw new Error('the preparation carried no candidate');
  }
  const draft: PlanGenerationDraft = {
    title: 'AI weekly plan',
    tasks: [{ candidateId: first.candidateId, day: 1, minutes: 30, kind: 'solve' }],
  };
  return { ok: true, value: { draft }, usage: USAGE, callId: 'plan-call-1', sessionId: 'plan-session-1' };
}

/** Batch pipeline boundary that no planning case may reach; reaching it is a test failure. */
const unexpectedGateway: ModelGateway = {
  capabilities: () => ({
    provider: 'fake',
    implemented: true,
    roles: ['analysis', 'verification', 'reasoning'],
    maxConcurrency: 1,
    notes: [],
  }),
  analyze: async () => {
    throw new Error('unexpected analysis call');
  },
  verify: async () => {
    throw new Error('unexpected verification call');
  },
  reason: async () => {
    throw new Error('unexpected reasoning call');
  },
};

interface BenchOptions {
  /** Scripted generator answer; omitted answers with a plan built from the first candidate. */
  readonly generate?: (request: PlanGenerationRequest) => Promise<ModelCallResult<PlanGenerationOutcome>>;
  /** Store factory, for cases that must observe or block one real store call. */
  readonly store?: (path: string, now: () => string) => SqliteTrainingStore;
  /** `false` builds the controller without the planning host (the typed `unavailable` case). */
  readonly withPlanning?: boolean;
  readonly closeWaitMs?: number;
}

/** Controller + real store + real planning service and workbench, with only the model boundary faked. */
class Bench {
  readonly paths = fx.tempDatabase();
  clock = AT;
  readonly store: SqliteTrainingStore;
  readonly workbench: WorkbenchService;
  readonly planning: PlanningService;
  readonly controller: ModelOperations;
  readonly planCalls: PlanGenerationRequest[] = [];
  readonly getPlanCalls: { readonly planId: string; readonly accountId: string; readonly reveal: boolean }[] = [];
  readonly planningErrors: PlanningInternalErrorReport[] = [];
  readonly controllerErrors: ModelOperationFailureReport[] = [];
  readonly probeDiagnostics: ModelValidationDiagnostic[] = [];
  private ids = 0;

  private readonly options: BenchOptions;
  constructor(options: BenchOptions = {}) {
    this.options = options;
    const now = (): string => this.clock;
    this.store =
      options.store === undefined
        ? new SqliteTrainingStore({ path: this.paths.path, now })
        : options.store(this.paths.path, now);
    this.workbench = new WorkbenchService({
      store: this.store,
      taxonomy: createTaxonomyIndex(CURRENT_TAXONOMY),
      now,
      uniqueId: () => `wb-${(this.ids += 1)}`,
    });
    this.planning = new PlanningService({
      store: this.store,
      generator: {
        generate: (request) => {
          this.planCalls.push(request);
          return options.generate === undefined ? Promise.resolve(plannedFrom(request)) : options.generate(request);
        },
      },
      preparation: {
        prepare: this.workbench.preparePlanInput.bind(this.workbench),
        revalidate: this.workbench.revalidatePlanInput.bind(this.workbench),
        savePlan: this.workbench.saveModelPlan.bind(this.workbench),
      },
      now,
      onInternalError: (report) => {
        this.planningErrors.push(report);
      },
    });
    this.controller = this.buildController(options.withPlanning !== false);
  }

  /** A fresh controller over the same store and services: the "restarted process" of a case. */
  restart(): ModelOperations {
    return this.buildController(true);
  }

  private buildController(withPlanning: boolean): ModelOperations {
    const now = (): string => this.clock;
    return new ModelOperations({
      store: this.store,
      coaching: new CoachingService({
        store: this.store,
        now,
        generator: {
          generate: async () => {
            throw new Error('unexpected coaching call');
          },
        },
      }),
      createPipeline: (record) =>
        new AnalysisPipeline({
          store: this.store,
          gateway: unexpectedGateway,
          taxonomy: CURRENT_TAXONOMY,
          roles: record.value.roles,
          limits: record.value.modelLimits,
          now,
          uniqueId: (prefix) => `${prefix}-${(this.ids += 1)}`,
        }),
      validateModels: (_settings: WorkbenchSettings, _token: CancellationToken) =>
        Promise.resolve(this.probeDiagnostics),
      now,
      uniqueId: (prefix) => `${prefix}-${(this.ids += 1)}`,
      onInternalError: (report) => {
        this.controllerErrors.push(report);
      },
      ...(this.options.closeWaitMs === undefined ? {} : { closeWaitMs: this.options.closeWaitMs }),
      ...(withPlanning
        ? {
            planning: this.planning,
            getPlan: (planId: string, accountId: string, reveal: boolean, token: CancellationToken) => {
              this.getPlanCalls.push({ planId, accountId, reveal });
              return this.workbench.getPlan(reveal ? { planId, accountId, reveal: true } : { planId, accountId }, token);
            },
          }
        : {}),
    });
  }

  /** Store default settings (revision 1) plus one account and its unsolved problems. */
  async seed(): Promise<number> {
    await this.store.upsertSourceInstances([WORLD.instance]);
    await this.store.upsertAccounts([WORLD.account]);
    await this.store.upsertProblems([WORLD.problem, ...EXTRA_PROBLEMS]);
    return this.store.saveWorkbenchSettings(defaultWorkbenchSettings(), null);
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

const failure = (code: ModelOperationErrorCode) => (error: unknown): boolean =>
  error instanceof ModelOperationError && error.code === code;

function preparedView(result: { readonly outcome: string }): Extract<
  Awaited<ReturnType<ModelOperations['planPrepare']>>,
  { readonly outcome: 'prepared' }
> {
  if (result.outcome !== 'prepared') {
    assert.fail(`expected a prepared AI plan, got ${result.outcome}`);
  }
  return result as Extract<Awaited<ReturnType<ModelOperations['planPrepare']>>, { readonly outcome: 'prepared' }>;
}

function foundStatus(result: Awaited<ReturnType<ModelOperations['planStatus']>>): Extract<
  Awaited<ReturnType<ModelOperations['planStatus']>>,
  { readonly status: 'found' }
> {
  if (result.status !== 'found') {
    assert.fail('expected a found AI plan attempt');
  }
  return result as Extract<Awaited<ReturnType<ModelOperations['planStatus']>>, { readonly status: 'found' }>;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 3000,
): Promise<void> {  const deadline = Date.now() + timeoutMs;
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

/** A deferred generator whose resolved answer is built from the request it actually received. */
function gatedGenerator(): {
  readonly generate: (request: PlanGenerationRequest) => Promise<ModelCallResult<PlanGenerationOutcome>>;
  readonly resolve: () => void;
  readonly requests: PlanGenerationRequest[];
} {
  const gate = deferred<ModelCallResult<PlanGenerationOutcome>>();
  const requests: PlanGenerationRequest[] = [];
  return {
    requests,
    generate: (request) => {
      requests.push(request);
      return gate.promise;
    },
    resolve: () => {
      const request = requests[0];
      if (request === undefined) {
        assert.fail('the paid call was never dispatched');
      }
      gate.resolve(plannedFrom(request));
    },
  };
}

// ---------------------------------------------------------------------------------------
// Free preparation and one paid run
// ---------------------------------------------------------------------------------------

void test('an AI plan preparation is free and durable, and one paid run stores a projected model plan', async () => {
  const bench = new Bench();
  try {
    const revision = await bench.seed();
    const prepared = preparedView(
      await bench.controller.planPrepare({ requestId: 'plan-1', accountId: WORLD.account.id }, TOKEN),
    );
    assert.equal(prepared.view.status, 'prepared');
    assert.equal(prepared.view.settingsRevision, revision);
    assert.ok(prepared.view.candidates.length >= 3, 'the three unsolved problems are candidates');
    assert.equal(bench.planCalls.length, 0);
    assert.equal(await bench.store.countPlanAttempts({ statuses: ['reserved', 'settled', 'uncertain'] }), 0);

    // The same request id replays idempotently for free and never dispatches.
    const replay = preparedView(
      await bench.controller.planPrepare({ requestId: 'plan-1', accountId: WORLD.account.id }, TOKEN),
    );
    assert.equal(replay.view.contentHash, prepared.view.contentHash);
    assert.equal(bench.planCalls.length, 0);

    const started = await bench.controller.planRun(
      { requestId: 'plan-1', accountId: WORLD.account.id, expectedSettingsRevision: revision },
      TOKEN,
    );
    assert.equal(started.operation?.state, 'running');
    assert.equal(started.operation?.settingsRevision, revision);
    assert.ok((started.operation?.operationId ?? '').startsWith('model-op'));
    assert.equal(started.attempt?.status, 'prepared');
    await bench.controller.whenSettled();
    assert.equal(bench.planCalls.length, 1);

    const status = foundStatus(
      await bench.controller.planStatus({ requestId: 'plan-1', accountId: WORLD.account.id }, TOKEN),
    );
    assert.equal(status.attempt.status, 'settled');
    assert.equal(status.attempt.error, null);
    assert.equal(status.attempt.usage?.calls, 1);
    assert.equal(status.operation?.state, 'settled');
    assert.equal(status.operation?.errorCode, null);
    assert.equal(status.plan?.source, 'model');
    assert.equal(status.plan?.status, 'draft');
    assert.equal(status.plan?.tasks.length, 1);
    // The plan task names the candidate the model actually saw, with the stored problem's title.
    assert.equal(status.plan?.tasks[0]?.title, bench.planCalls[0]?.candidates[0]?.title);
    // The stored plan is the workbench's own projection, requested with this account and no spoilers.
    assert.deepEqual(bench.getPlanCalls, [
      { planId: status.attempt.planId, accountId: WORLD.account.id, reveal: false },
    ]);
    // No preparation, candidate pool or model body is retained in a public operation view.
    const operationJson = JSON.stringify(status.operation);
    for (const forbidden of ['preparation', 'candidateId', 'ability', 'title']) {
      assert.equal(operationJson.includes(forbidden), false, `the operation view must not carry ${forbidden}`);
    }
    // The paid prompt carries no account identifier, handle or stored statement.
    const prompt = JSON.stringify(bench.planCalls[0]);
    assert.equal(prompt.includes(WORLD.account.id), false);
    assert.equal(prompt.includes('alice'), false);
    assert.equal(prompt.includes('Given an array, support range add and range sum queries.'), false);
  } finally {
    await bench.close();
  }
});

void test('a status read is account-scoped, attaches the owned run only to its account and follows reveal', async () => {
  const gated = gatedGenerator();
  const bench = new Bench({ generate: gated.generate });
  try {
    const revision = await bench.seed();
    preparedView(await bench.controller.planPrepare({ requestId: 'plan-2', accountId: WORLD.account.id }, TOKEN));
    const started = await bench.controller.planRun(
      { requestId: 'plan-2', accountId: WORLD.account.id, expectedSettingsRevision: revision },
      TOKEN,
    );
    await waitFor(() => gated.requests.length === 1, 'the paid call to be dispatched');

    // Another account learns nothing: no durable row, no owned operation, no plan.
    const foreign = await bench.controller.planStatus({ requestId: 'plan-2', accountId: 'someone-else' }, TOKEN);
    assert.equal(foreign.status, 'unknown');
    assert.equal(foreign.operation, null);
    assert.equal(foreign.plan, null);
    // ...and cannot repeat-start the request the owning account is still running.
    await assert.rejects(
      bench.controller.planRun(
        { requestId: 'plan-2', accountId: 'someone-else', expectedSettingsRevision: revision },
        TOKEN,
      ),
      failure('conflict'),
    );

    // The owning account sees its running operation but no plan yet: nothing is projected before a
    // plan exists.
    const running = foundStatus(
      await bench.controller.planStatus({ requestId: 'plan-2', accountId: WORLD.account.id }, TOKEN),
    );
    assert.equal(running.attempt.status, 'reserved');
    assert.equal(running.operation?.operationId, started.operation?.operationId);
    assert.equal(running.operation?.state, 'running');
    assert.equal(running.plan, null);

    gated.resolve();
    await bench.controller.whenSettled();
    // An explicit reveal is passed through to the workbench projection instead of being ignored.
    const revealed = foundStatus(
      await bench.controller.planStatus({ requestId: 'plan-2', accountId: WORLD.account.id, reveal: true }, TOKEN),
    );
    assert.equal(revealed.plan?.planId, revealed.attempt.planId);
    const lastProjection = bench.getPlanCalls[bench.getPlanCalls.length - 1];
    assert.equal(lastProjection?.reveal, true);
    assert.equal(lastProjection?.accountId, WORLD.account.id);
  } finally {
    await bench.close();
  }
});

void test('history is latest first and a free preparation replay recovers the captured revision', async () => {
  const bench = new Bench();
  try {
    const revision = await bench.seed();
    await bench.controller.planPrepare({ requestId: 'history-1', accountId: WORLD.account.id }, TOKEN);
    bench.clock = LATER;
    // The second preparation names an explicit selection, so the recovered scope is real.
    preparedView(
      await bench.controller.planPrepare(
        {
          requestId: 'history-2',
          accountId: WORLD.account.id,
          candidateProblemKeys: [WORLD.problem.key],
          candidateLimit: 1,
        },
        TOKEN,
      ),
    );
    bench.clock = LATER_STILL;
    await bench.controller.planPrepare({ requestId: 'history-3', accountId: WORLD.account.id }, TOKEN);

    const history = await bench.controller.planHistory({ accountId: WORLD.account.id }, TOKEN);
    assert.deepEqual(
      history.items.map((item) => item.requestId),
      ['history-3', 'history-2', 'history-1'],
    );
    assert.equal(history.total, 3);
    assert.ok(history.items.every((item) => item.accountId === WORLD.account.id));
    // Metadata only: no preparation, candidate material or plan body.
    const text = JSON.stringify(history);
    for (const forbidden of ['preparation', 'candidateId', 'taxonomyIds', 'weakness', 'inputHash']) {
      assert.equal(text.includes(forbidden), false, `history must not carry ${forbidden}`);
    }

    // A refreshed UI recovers the request id from history and learns its captured revision for free.
    const recovered = preparedView(
      await bench.controller.planPrepare({ requestId: 'history-1', accountId: WORLD.account.id }, TOKEN),
    );
    assert.equal(recovered.view.settingsRevision, revision);
    assert.equal(bench.planCalls.length, 0);

    // The page bound is validated, never clamped, and another account's history stays its own.
    await assert.rejects(bench.controller.planHistory({ accountId: WORLD.account.id, limit: 51 }, TOKEN), failure('invalid_input'));
    await assert.rejects(bench.controller.planHistory({ accountId: WORLD.account.id, limit: 0 }, TOKEN), failure('invalid_input'));
    assert.deepEqual(await bench.controller.planHistory({ accountId: WORLD.account.id, limit: 1 }, TOKEN).then((r) => r.items.length), 1);
    assert.deepEqual(await bench.controller.planHistory({ accountId: 'someone-else' }, TOKEN).then((r) => r.items), []);
  } finally {
    await bench.close();
  }
});

void test('malformed planning requests are refused before any work', async () => {
  const bench = new Bench();
  try {
    const revision = await bench.seed();
    const prepare = (request: unknown) =>
      bench.controller.planPrepare(request as Parameters<ModelOperations['planPrepare']>[0], TOKEN);
    const run = (request: unknown) =>
      bench.controller.planRun(request as Parameters<ModelOperations['planRun']>[0], TOKEN);

    await assert.rejects(prepare({ accountId: WORLD.account.id }), failure('invalid_input'));
    await assert.rejects(
      prepare({ requestId: 'bad-1', accountId: WORLD.account.id, typo: true }),
      failure('invalid_input'),
    );
    await assert.rejects(
      prepare({ requestId: 'bad-2', accountId: WORLD.account.id, candidateProblemKeys: [WORLD.problem.key, WORLD.problem.key] }),
      failure('invalid_input'),
    );
    await assert.rejects(
      prepare({ requestId: 'bad-3', accountId: WORLD.account.id, candidateLimit: 0 }),
      failure('invalid_input'),
    );
    await assert.rejects(
      prepare({ requestId: 'bad-4', accountId: WORLD.account.id, candidateLimit: 101 }),
      failure('invalid_input'),
    );
    await assert.rejects(
      prepare({ requestId: 'bad-5', accountId: WORLD.account.id, candidateProblemKeys: ['not-a-canonical-key'] }),
      failure('invalid_input'),
    );
    await assert.rejects(run({ requestId: 'never-prepared', accountId: WORLD.account.id }), failure('invalid_input'));
    await assert.rejects(
      run({ requestId: 'never-prepared', accountId: WORLD.account.id, expectedSettingsRevision: revision }),
      failure('not_found'),
    );
    await assert.rejects(
      run({ requestId: 'never-prepared', accountId: WORLD.account.id, expectedSettingsRevision: 0 }),
      failure('invalid_input'),
    );
    await assert.rejects(
      run({ requestId: 'never-prepared', accountId: WORLD.account.id, expectedSettingsRevision: revision, typo: 1 }),
      failure('invalid_input'),
    );
    await assert.rejects(
      bench.controller.planStatus(
        { requestId: 'x', accountId: WORLD.account.id, typo: true } as unknown as Parameters<ModelOperations['planStatus']>[0],
        TOKEN,
      ),
      failure('invalid_input'),
    );
    assert.equal(bench.planCalls.length, 0);
    assert.equal(await bench.store.countPlanAttempts({}), 0);
  } finally {
    await bench.close();
  }
});

void test('an explicit empty selection is an honest free refusal, never a silent fallback', async () => {
  const bench = new Bench();
  try {
    await bench.seed();
    const refused = await bench.controller.planPrepare(
      { requestId: 'empty-1', accountId: WORLD.account.id, candidateProblemKeys: [] },
      TOKEN,
    );
    assert.equal(refused.outcome, 'refused');
    if (refused.outcome === 'refused') {
      assert.equal(refused.error.code, 'preparation_empty');
    }
    assert.equal(bench.planCalls.length, 0);
    assert.equal(await bench.store.countPlanAttempts({}), 0, 'a refused free preparation stores nothing');
  } finally {
    await bench.close();
  }
});

// ---------------------------------------------------------------------------------------
// Guards, repeats and cancellation
// ---------------------------------------------------------------------------------------

void test('a paid run is gated by the stored settings revision and by the model probe', async () => {
  const bench = new Bench();
  try {
    const revision = await bench.seed();
    preparedView(await bench.controller.planPrepare({ requestId: 'plan-5', accountId: WORLD.account.id }, TOKEN));

    // A blocking model diagnostic refuses before any dispatch and never touches the attempt.
    bench.probeDiagnostics.push({ code: 'model_missing', severity: 'error', message: 'the model is not registered' });
    await assert.rejects(
      bench.controller.planRun({ requestId: 'plan-5', accountId: WORLD.account.id, expectedSettingsRevision: revision }, TOKEN),
      failure('model_invalid'),
    );
    assert.equal(bench.planCalls.length, 0);
    bench.probeDiagnostics.length = 0;

    // A stale revision refuses too; the accepted service would refuse it as well, but the
    // controller must not dispatch against a configuration the caller no longer sees.
    const moved = await bench.saveSettings(revision);
    await assert.rejects(
      bench.controller.planRun({ requestId: 'plan-5', accountId: WORLD.account.id, expectedSettingsRevision: revision }, TOKEN),
      failure('settings_changed'),
    );
    assert.equal(bench.planCalls.length, 0);

    const started = await bench.controller.planRun(
      { requestId: 'plan-5', accountId: WORLD.account.id, expectedSettingsRevision: moved },
      TOKEN,
    );
    assert.equal(started.operation?.settingsRevision, moved);
    await bench.controller.whenSettled();
    assert.equal(bench.planCalls.length, 0, 'a new revision cannot approve the old preparation');
    const stale = foundStatus(await bench.controller.planStatus({ requestId: 'plan-5', accountId: WORLD.account.id }, TOKEN));
    assert.equal(stale.operation?.errorCode, 'settings_changed');
    preparedView(await bench.controller.planPrepare({ requestId: 'plan-5-fresh', accountId: WORLD.account.id }, TOKEN));
    await bench.controller.planRun({ requestId: 'plan-5-fresh', accountId: WORLD.account.id, expectedSettingsRevision: moved }, TOKEN);
    await bench.controller.whenSettled();
    assert.equal(bench.planCalls.length, 1, 'only a freshly prepared revision may dispatch');
  } finally {
    await bench.close();
  }
});

void test('a repeated start never pays twice and a foreign account can never repeat it', async () => {
  const gated = gatedGenerator();
  const bench = new Bench({ generate: gated.generate });
  try {
    const revision = await bench.seed();
    preparedView(await bench.controller.planPrepare({ requestId: 'plan-6', accountId: WORLD.account.id }, TOKEN));
    const first = await bench.controller.planRun(
      { requestId: 'plan-6', accountId: WORLD.account.id, expectedSettingsRevision: revision },
      TOKEN,
    );
    await waitFor(() => gated.requests.length === 1, 'the first paid call');
    const repeat = await bench.controller.planRun(
      { requestId: 'plan-6', accountId: WORLD.account.id, expectedSettingsRevision: revision },
      TOKEN,
    );
    assert.equal(repeat.operation?.operationId, first.operation?.operationId);
    assert.equal(gated.requests.length, 1, 'an owned repeat is answered without a second dispatch');

    // Any other new paid start is refused while this run is active.
    preparedView(await bench.controller.planPrepare({ requestId: 'plan-7', accountId: WORLD.account.id }, TOKEN));
    await assert.rejects(
      bench.controller.planRun({ requestId: 'plan-7', accountId: WORLD.account.id, expectedSettingsRevision: revision }, TOKEN),
      failure('model_busy'),
    );

    gated.resolve();
    await bench.controller.whenSettled();
    // A durable settled attempt is returned as its own audit without a probe or a second call.
    const settledRepeat = await bench.controller.planRun(
      { requestId: 'plan-6', accountId: WORLD.account.id, expectedSettingsRevision: revision },
      TOKEN,
    );
    assert.equal(settledRepeat.attempt?.status, 'settled');
    assert.equal(settledRepeat.operation?.state, 'settled');
    assert.equal(gated.requests.length, 1);
    const status = foundStatus(
      await bench.controller.planStatus({ requestId: 'plan-6', accountId: WORLD.account.id }, TOKEN),
    );
    assert.equal(status.attempt.status, 'settled');
  } finally {
    await bench.close();
  }
});

void test('cancellation cancels the owned token first and keeps the known usage of the dispatched call', async () => {
  const gated = gatedGenerator();
  const bench = new Bench({ generate: gated.generate });
  try {
    const revision = await bench.seed();
    preparedView(await bench.controller.planPrepare({ requestId: 'plan-8', accountId: WORLD.account.id }, TOKEN));
    await bench.controller.planRun(
      { requestId: 'plan-8', accountId: WORLD.account.id, expectedSettingsRevision: revision },
      TOKEN,
    );
    await waitFor(() => gated.requests.length === 1, 'the paid call to be reserved');

    const cancelled = await bench.controller.planCancel(
      { requestId: 'plan-8', accountId: WORLD.account.id },
      TOKEN,
    );
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.status, 'reserved');
    assert.equal(cancelled.operation?.state, 'running');

    gated.resolve();
    await bench.controller.whenSettled();
    const status = foundStatus(
      await bench.controller.planStatus({ requestId: 'plan-8', accountId: WORLD.account.id }, TOKEN),
    );
    assert.equal(status.attempt.status, 'settled', 'the reservation is terminal, never stranded');
    assert.equal(status.attempt.error?.code, 'cancelled');
    assert.equal(status.attempt.planId, null);
    assert.deepEqual(status.attempt.usage, USAGE, 'the known paid usage is kept exactly');
    assert.deepEqual(await bench.store.listPlans(WORLD.account.id), [], 'a cancelled dispatch stores no plan');
    assert.equal(status.operation?.errorCode, null);

    // A preparation that never dispatched is abandoned for free and is never claimed as ours.
    preparedView(await bench.controller.planPrepare({ requestId: 'plan-9', accountId: WORLD.account.id }, TOKEN));
    const free = await bench.controller.planCancel({ requestId: 'plan-9', accountId: WORLD.account.id }, TOKEN);
    assert.equal(free.cancelled, false);
    assert.equal(free.status, 'cancelled');
    const abandoned = await bench.store.getPlanAttempt('plan-9');
    assert.equal(abandoned?.usage, null);
    assert.equal(await bench.store.countPlanAttempts({ statuses: ['reserved', 'settled', 'uncertain'] }), 1);
    assert.equal(bench.planCalls.length, 1);
  } finally {
    await bench.close();
  }
});

// ---------------------------------------------------------------------------------------
// Reciprocal exclusion, persistence and disposal
// ---------------------------------------------------------------------------------------

void test('plan work excludes batch/coaching/settings, and a persisted reservation blocks a restarted controller until it expires', async () => {
  const gated = gatedGenerator();
  const bench = new Bench({ generate: gated.generate });
  try {
    const revision = await bench.seed();
    preparedView(await bench.controller.planPrepare({ requestId: 'plan-10', accountId: WORLD.account.id }, TOKEN));
    await bench.controller.planRun(
      { requestId: 'plan-10', accountId: WORLD.account.id, expectedSettingsRevision: revision },
      TOKEN,
    );
    await waitFor(() => gated.requests.length === 1, 'the paid call to be reserved');

    // While the AI plan is active nothing else may start or save configuration.
    await assert.rejects(bench.saveSettings(revision), failure('model_busy'));
    await assert.rejects(
      bench.controller.prepareBatch({ problemKeys: [WORLD.problem.key] }, TOKEN),
      failure('model_busy'),
    );
    await assert.rejects(
      bench.controller.runBatch({ batchId: 'no-such-batch', expectedSettingsRevision: revision }, TOKEN),
      failure('model_busy'),
    );
    await assert.rejects(
      bench.controller.resumeBatch({ batchId: 'no-such-batch', expectedSettingsRevision: revision }, TOKEN),
      failure('model_busy'),
    );
    await assert.rejects(
      bench.controller.coachingAsk(
        {
          requestId: 'coach-1',
          accountId: WORLD.account.id,
          problemKey: WORLD.problem.key,
          level: 1,
          expectedSettingsRevision: revision,
        },
        TOKEN,
      ),
      failure('model_busy'),
    );
    gated.resolve();
    await bench.controller.whenSettled();
    assert.equal(await bench.saveSettings(revision), revision + 1);

    // A reservation left behind by a dead process still blocks a freshly started controller...
    const currentRevision = revision + 1;
    preparedView(await bench.controller.planPrepare({ requestId: 'plan-11', accountId: WORLD.account.id }, TOKEN));
    const row = await bench.store.getPlanAttempt('plan-11');
    assert.ok(row);
    const reserved: PlanAttempt = {
      ...row,
      status: 'reserved',
      requestedAt: AT,
      expiresAt: LATER,
    };
    await bench.store.savePlanAttempt(reserved);

    const restarted = bench.restart();
    assert.equal(restarted !== bench.controller, true);
    await assert.rejects(
      restarted.saveSettings({ expectedRevision: currentRevision, value: defaultWorkbenchSettings() }, TOKEN),
      failure('model_busy'),
    );
    await assert.rejects(
      restarted.prepareBatch({ problemKeys: [WORLD.problem.key] }, TOKEN),
      failure('model_busy'),
    );
    await assert.rejects(
      restarted.coachingAsk(
        {
          requestId: 'coach-2',
          accountId: WORLD.account.id,
          problemKey: WORLD.problem.key,
          level: 1,
          expectedSettingsRevision: currentRevision,
        },
        TOKEN,
      ),
      failure('model_busy'),
    );
    const pending = foundStatus(await restarted.planStatus({ requestId: 'plan-11', accountId: WORLD.account.id }, TOKEN));
    assert.equal(pending.attempt.status, 'reserved');
    assert.equal(pending.operation, null, 'the restarted controller owns no run for the old reservation');

    // A later status poll after restart recovers expiry without requiring a new paid start.
    bench.clock = LATER_STILL;
    assert.equal((await restarted.saveSettings({ expectedRevision: currentRevision, value: defaultWorkbenchSettings() }, TOKEN)).revision, currentRevision + 1);
    const expired = foundStatus(await restarted.planStatus({ requestId: 'plan-11', accountId: WORLD.account.id }, TOKEN));
    assert.equal(expired.attempt.status, 'uncertain');
    assert.equal(await bench.planning.recoverExpiredReservations(TOKEN), 0, 'status already recovered the expired orphan');
    const recovered = await bench.store.getPlanAttempt('plan-11');
    assert.equal(recovered?.status, 'uncertain');
    assert.equal(recovered?.usage, null, 'an expired reservation is never refunded or invented');
    assert.equal(await bench.store.countPlanAttempts({ statuses: ['uncertain'] }), 1);
    const afterRecovery = await restarted.planRun(
      { requestId: 'plan-11', accountId: WORLD.account.id, expectedSettingsRevision: currentRevision + 1 },
      TOKEN,
    );
    assert.equal(afterRecovery.attempt?.status, 'uncertain');
    assert.equal(afterRecovery.operation, null);
    assert.equal(bench.planCalls.length, 1, 'a recovered attempt is never redispatched');
  } finally {
    await bench.close();
  }
});

void test('a free preparation holds the start/save gate so a local settings save cannot invalidate it', async () => {
  class GatedAttemptStore extends SqliteTrainingStore {
    readonly entered = deferred<void>();
    readonly release = deferred<void>();
    private armed = true;
    override async getPlanAttempt(id: string): Promise<PlanAttempt | null> {
      if (this.armed && id === 'gate-1') {
        this.armed = false;
        this.entered.resolve();
        await this.release.promise;
      }
      return super.getPlanAttempt(id);
    }
  }
  const created: { store: GatedAttemptStore | null } = { store: null };
  const bench = new Bench({
    store: (path, now) => {
      const store = new GatedAttemptStore({ path, now });
      created.store = store;
      return store;
    },
  });
  try {
    const revision = await bench.seed();
    const preparing = bench.controller.planPrepare({ requestId: 'gate-1', accountId: WORLD.account.id }, TOKEN);
    const store = created.store;
    assert.ok(store);
    await store.entered.promise;
    // The preparation holds the one gate: a local save cannot move the settings under it.
    await assert.rejects(bench.saveSettings(revision), failure('model_busy'));
    store.release.resolve();
    const prepared = preparedView(await preparing);
    assert.equal(prepared.view.settingsRevision, revision);
    assert.equal(await bench.saveSettings(revision), revision + 1);
  } finally {
    await bench.close();
  }
});

void test('a bounded close reports the planning run as outstanding and the store stays open until it settles', async () => {
  const gated = gatedGenerator();
  const bench = new Bench({ generate: gated.generate, closeWaitMs: 50 });
  try {
    const revision = await bench.seed();
    preparedView(await bench.controller.planPrepare({ requestId: 'plan-12', accountId: WORLD.account.id }, TOKEN));
    const started = await bench.controller.planRun(
      { requestId: 'plan-12', accountId: WORLD.account.id, expectedSettingsRevision: revision },
      TOKEN,
    );
    await waitFor(() => gated.requests.length === 1, 'the paid call to be reserved');

    const report = await bench.controller.close();
    assert.deepEqual(report.settled, []);
    assert.deepEqual(report.outstanding, [started.operation?.operationId]);
    // The store is still open: the durable settlement of the outstanding run has not happened yet.
    assert.equal((await bench.store.getPlanAttempt('plan-12'))?.status, 'reserved');
    await assert.rejects(
      bench.controller.planRun({ requestId: 'plan-12', accountId: WORLD.account.id, expectedSettingsRevision: revision }, TOKEN),
      failure('model_busy'),
    );

    gated.resolve();
    const drained = await bench.controller.whenSettled();
    assert.deepEqual(drained.outstanding, []);
    assert.ok(drained.settled.includes(started.operation?.operationId ?? ''));
    // The durable settlement really finished before the store is allowed to close. Closing cancelled
    // the owned token, so the paid answer is retained with its usage and withheld as a cancelled
    // settlement — a plan is never stored for a run the controller was told to stop.
    const stored = await bench.store.getPlanAttempt('plan-12');
    assert.equal(stored?.status, 'settled');
    assert.equal(stored?.planId, null);
    assert.equal(stored?.error?.code, 'cancelled');
    assert.deepEqual(stored?.usage, USAGE);
  } finally {
    await bench.close();
  }
});

void test('an intentionally absent planning host refuses every plan operation with the typed unavailable code', async () => {
  const bench = new Bench({ withPlanning: false });
  try {
    const revision = await bench.seed();
    for (const call of [
      () => bench.controller.planPrepare({ requestId: 'x', accountId: WORLD.account.id }, TOKEN),
      () =>
        bench.controller.planRun(
          { requestId: 'x', accountId: WORLD.account.id, expectedSettingsRevision: revision },
          TOKEN,
        ),
      () => bench.controller.planStatus({ requestId: 'x', accountId: WORLD.account.id }, TOKEN),
      () => bench.controller.planCancel({ requestId: 'x', accountId: WORLD.account.id }, TOKEN),
      () => bench.controller.planHistory({ accountId: WORLD.account.id }, TOKEN),
    ]) {
      await assert.rejects(call(), failure('unavailable'));
    }
    // The rest of the controller keeps working: an absent planning host is not a broken host.
    assert.equal((await bench.controller.currentSettings()).revision, revision);
    assert.equal(await bench.store.countPlanAttempts({}), 0);
  } finally {
    await bench.close();
  }
});
