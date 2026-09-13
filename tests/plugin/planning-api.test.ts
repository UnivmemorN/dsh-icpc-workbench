/**
 * Typed HTTP vocabulary of AI planning (Sprint 11d).
 *
 * The real `registerModelApi` boundary drives the real controller, the real `PlanningService` and a
 * real SQLite store; only the generator and the batch gateway are local fakes. The cases assert the
 * externally meaningful transport behaviour: every new route is registered through the shared
 * envelope and disposal, a free preparation dispatches nothing, strict request shapes are refused
 * with their own status, a paid start answers 202 and survives a client abort after the
 * acknowledgement, status stays account-scoped and spoiler-aware, history is bounded, and typed
 * failures keep stable sanitized codes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectionFetchRoute, HostConnectionFetch } from '@deepseek-ai/dsh-client-connection';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { AnalysisPipeline } from '../../src/application/analysis-pipeline.js';
import { CoachingService } from '../../src/application/coaching-service.js';
import { ModelOperationError, type ModelValidationDiagnostic } from '../../src/application/model-operation-types.js';
import type { ModelCallResult, ModelGateway } from '../../src/application/ports.js';
import type { PlanGenerationOutcome, PlanGenerationRequest } from '../../src/application/planning-generation.js';
import { PlanningService } from '../../src/application/planning-service.js';
import { WorkbenchService } from '../../src/application/workbench-service.js';
import { defaultWorkbenchSettings } from '../../src/application/workbench-settings.js';
import { CURRENT_TAXONOMY, createCancellationSource, createModelUsage, createTaxonomyIndex, type CancellationToken } from '../../src/domain/index.js';
import { ModelOperations } from '../../src/plugin/model-operations.js';
import { registerModelApi } from '../../src/plugin/model-api.js';
import * as fx from '../storage/fixtures.js';

/** In-memory Connection Fetch registry, identical to the batch/coaching API fixture. */
class Registry {
  routes = new Map<string, ConnectionFetchRoute>();
  failAt = Infinity;
  register(route: ConnectionFetchRoute): () => Promise<void> {
    if (this.routes.size === this.failAt) throw Error('registration failure');
    this.routes.set(route.path, route);
    return async () => { await Promise.resolve(); this.routes.delete(route.path); };
  }
  async call(operation: string, value: unknown, signal?: AbortSignal): Promise<{ status: number; body: any }> {
    const route = this.routes.get('/api/icpc/v1/' + operation)!;
    const response = await route.fetch(new Request('http://localhost/api/icpc/v1/' + operation, {
      method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(value), signal,
    }));
    return {status: response.status, body: await response.json()};
  }
}

const USAGE = createModelUsage({ calls: 1, promptTokens: 10, completionTokens: 10 });

interface SetupOptions {
  /** Hold every paid generation until the returned `releaseGate` is called. */
  readonly gate?: boolean;
  readonly probe?: readonly ModelValidationDiagnostic[];
  /** Build the controller without the planning host, for the typed `unavailable` case. */
  readonly withPlanning?: boolean;
}

async function setup(options: SetupOptions = {}) {
  const now = () => fx.AT;
  const store = new SqliteTrainingStore({ path: ':memory:', now });
  const world = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  await store.upsertSourceInstances([world.instance]);
  await store.upsertAccounts([world.account]);
  await store.upsertProblems([world.problem, fx.makeProblem(fx.makeRef(world.instance, '2B'))]);
  await store.saveWorkbenchSettings(defaultWorkbenchSettings(), null);
  let ids = 0, generated = 0;
  const requests: PlanGenerationRequest[] = [];
  let releaseGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const workbench = new WorkbenchService({
    store, taxonomy: createTaxonomyIndex(CURRENT_TAXONOMY), now, uniqueId: () => `wb-${(ids += 1)}`,
  });
  const planning = new PlanningService({
    store,
    now,
    generator: {
      generate: async (request: PlanGenerationRequest): Promise<ModelCallResult<PlanGenerationOutcome>> => {
        generated += 1;
        requests.push(request);
        if (options.gate === true) {
          await gate;
        }
        const first = request.candidates[0];
        if (first === undefined) throw new Error('the preparation carried no candidate');
        return {
          ok: true,
          value: { draft: { title: 'SPOILER_BINARY_SEARCH_TRAINING', tasks: [{ candidateId: first.candidateId, day: 1, minutes: 30, kind: 'solve' }] } },
          usage: USAGE,
          callId: 'plan-call-1',
          sessionId: 'plan-session-1',
        };
      },
    },
    preparation: {
      prepare: workbench.preparePlanInput.bind(workbench),
      revalidate: workbench.revalidatePlanInput.bind(workbench),
      savePlan: workbench.saveModelPlan.bind(workbench),
    },
  });
  const gateway: ModelGateway = {
    capabilities: () => ({ provider: 'fake', implemented: true, roles: ['analysis', 'verification', 'reasoning'], maxConcurrency: 1, notes: [] }),
    analyze: async () => { throw Error('unexpected analysis call'); },
    verify: async () => { throw Error('unexpected verification call'); },
    reason: async () => { throw Error('unexpected reasoning call'); },
  };
  const getPlanCalls: { planId: string; accountId: string; reveal: boolean }[] = [];
  const controller = new ModelOperations({
    store,
    coaching: new CoachingService({ store, now, generator: { generate: async () => { throw Error('unexpected coaching call'); } } }),
    createPipeline: (record) => new AnalysisPipeline({
      store, gateway, taxonomy: CURRENT_TAXONOMY, roles: record.value.roles,
      limits: record.value.modelLimits, now, uniqueId: (prefix) => `${prefix}-${(ids += 1)}`,
    }),
    validateModels: async () => options.probe ?? [],
    now,
    uniqueId: (prefix) => `${prefix}-${(ids += 1)}`,
    ...(options.withPlanning === false ? {} : {
      planning,
      getPlan: (planId: string, accountId: string, reveal: boolean, token: CancellationToken) => {
        getPlanCalls.push({ planId, accountId, reveal });
        return workbench.getPlan(reveal ? { planId, accountId, reveal: true } : { planId, accountId }, token);
      },
    }),
  });
  const registry = new Registry();
  const dispose = await registerModelApi({ registry: registry as unknown as HostConnectionFetch, controller });
  return {
    world, store, workbench, controller, registry, getPlanCalls, requests,
    calls: () => ({ generated }),
    releaseGate: () => releaseGate(),
    close: async () => { await dispose(); await controller.close(); await controller.whenSettled(); await store.close(); },
  };
}

/** Prepare + run + settle one request through the HTTP boundary, returning its request id. */
async function prepareAndRun(
  bench: Awaited<ReturnType<typeof setup>>,
  requestId: string,
): Promise<void> {
  const prepared = await bench.registry.call('plan.aiPrepare', { requestId, accountId: bench.world.account.id });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.body.value.outcome, 'prepared');
  const started = await bench.registry.call('plan.aiRun', {
    requestId, accountId: bench.world.account.id, expectedSettingsRevision: 1,
  });
  assert.equal(started.status, 202);
  await bench.controller.whenSettled();
}

// ---------------------------------------------------------------------------------------

test('AI planning routes are registered and a free preparation dispatches nothing', async () => {
  const bench = await setup();
  try {
    // 13 batch/coaching/settings routes + the 5 additive planning routes, all through one registration.
    assert.equal(bench.registry.routes.size, 18);
    const prepared = await bench.registry.call('plan.aiPrepare', { requestId: 'api-1', accountId: bench.world.account.id });
    assert.equal(prepared.status, 200);
    assert.equal(prepared.body.value.outcome, 'prepared');
    assert.equal(prepared.body.value.view.settingsRevision, 1);
    assert.ok(prepared.body.value.view.candidates.length >= 2);
    assert.equal(bench.calls().generated, 0);

    // An automatic-pool replay is free and idempotent.
    const replay = await bench.registry.call('plan.aiPrepare', { requestId: 'api-1', accountId: bench.world.account.id });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.value.view.contentHash, prepared.body.value.view.contentHash);

    // Strict closed shapes: an unknown member, a bad bound, a duplicate or malformed selection and
    // an oversized daily task limit are all refused as invalid input.
    const refused = [
      await bench.registry.call('plan.aiPrepare', { requestId: 'api-2', accountId: bench.world.account.id, typo: true }),
      await bench.registry.call('plan.aiPrepare', { requestId: 'api-3', accountId: bench.world.account.id, candidateLimit: 0 }),
      await bench.registry.call('plan.aiPrepare', { requestId: 'api-4', accountId: bench.world.account.id, candidateLimit: 101 }),
      await bench.registry.call('plan.aiPrepare', { requestId: 'api-5', accountId: bench.world.account.id, candidateProblemKeys: [bench.world.problem.key, bench.world.problem.key] }),
      await bench.registry.call('plan.aiPrepare', { requestId: 'api-6', accountId: bench.world.account.id, candidateProblemKeys: ['not-a-canonical-key'] }),
      await bench.registry.call('plan.aiPrepare', { requestId: 'api-7', accountId: bench.world.account.id, settings: { horizonDays: 31 } }),
      await bench.registry.call('plan.aiPrepare', { requestId: 'api-8', accountId: bench.world.account.id, settings: { maxTasksPerDay: 4 } }),
      await bench.registry.call('plan.aiPrepare', { requestId: 'api-9', accountId: bench.world.account.id, settings: { typo: 1 } }),
    ];
    assert.deepEqual(refused.map((entry) => entry.status), [400, 400, 400, 400, 400, 400, 400, 400]);

    const limited = await bench.registry.call('plan.aiPrepare', { requestId: 'api-limit-2', accountId: bench.world.account.id, settings: { maxTasksPerDay: 2 } });
    assert.equal(limited.status, 200);
    assert.equal(limited.body.value.view.settings.maxTasksPerDay, 2, 'the supplied daily task limit is preserved');
    // An explicit empty selection is a legal request that produces an honest free refusal.
    const empty = await bench.registry.call('plan.aiPrepare', {
      requestId: 'api-10', accountId: bench.world.account.id, candidateProblemKeys: [],
    });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.value.outcome, 'refused');
    assert.equal(empty.body.value.error.code, 'preparation_empty');
    assert.equal(bench.calls().generated, 0);
  } finally {
    await bench.close();
  }
});

test('aiRun answers 202 and a client abort after the acknowledgement cannot cancel the paid run', async () => {
  const bench = await setup({ gate: true });
  try {
    assert.equal((await bench.registry.call('plan.aiPrepare', { requestId: 'api-run-1', accountId: bench.world.account.id })).status, 200);
    const signal = new AbortController();
    const acknowledged = await bench.registry.call('plan.aiRun', {
      requestId: 'api-run-1', accountId: bench.world.account.id, expectedSettingsRevision: 1,
    }, signal.signal);
    assert.equal(acknowledged.status, 202);
    assert.equal(acknowledged.body.value.operation.state, 'running');
    assert.equal(acknowledged.body.value.operation.settingsRevision, 1);
    assert.equal(acknowledged.body.value.attempt.status, 'prepared');
    assert.ok(String(acknowledged.body.value.operation.operationId).startsWith('model-op'));
    // Dispatch is asynchronous; the exact call count is asserted after durable settlement below.

    // The browser aborted after the acknowledgement: the owned run is untouched.
    signal.abort();
    bench.releaseGate();
    await bench.controller.whenSettled();
    assert.equal(bench.calls().generated, 1);

    const status = await bench.registry.call('plan.aiStatus', { requestId: 'api-run-1', accountId: bench.world.account.id });
    assert.equal(status.status, 200);
    assert.equal(status.body.value.status, 'found');
    assert.equal(status.body.value.attempt.status, 'settled');
    assert.equal(status.body.value.operation.state, 'settled');
    assert.equal(status.body.value.plan.source, 'model');
    assert.equal(status.body.value.plan.tasks.length, 1);

    // A repeat start returns the durable audit without a second paid call.
    const repeat = await bench.registry.call('plan.aiRun', {
      requestId: 'api-run-1', accountId: bench.world.account.id, expectedSettingsRevision: 1,
    });
    assert.equal(repeat.status, 202);
    assert.equal(repeat.body.value.attempt.status, 'settled');
    assert.equal(bench.calls().generated, 1);
  } finally {
    await bench.close();
  }
});

test('aiStatus is account-scoped and spoiler-aware while aiHistory is bounded and newest-first', async () => {
  const bench = await setup();
  try {
    await prepareAndRun(bench, 'api-2-1');
    const identity = { requestId: 'api-2-1', accountId: bench.world.account.id };

    // Another account learns nothing, not even that this instance owns the run.
    const foreign = await bench.registry.call('plan.aiStatus', { requestId: 'api-2-1', accountId: 'someone-else' });
    assert.equal(foreign.status, 200);
    assert.equal(foreign.body.value.status, 'unknown');
    assert.equal(foreign.body.value.operation, null);
    assert.equal(foreign.body.value.plan, null);

    const hidden = await bench.registry.call('plan.aiStatus', identity);
    assert.equal(hidden.body.value.status, 'found');
    assert.equal(hidden.body.value.attempt.planId !== null, true);
    assert.equal(hidden.body.value.plan.source, 'model');
    assert.equal(hidden.body.value.plan.title, 'AI 训练计划');
    assert.equal(JSON.stringify(hidden).includes('SPOILER_BINARY_SEARCH_TRAINING'), false);
    const titles = await bench.workbench.listPlans({ accountId: bench.world.account.id }, createCancellationSource().token);
    assert.equal(titles.plans[0]?.title, 'AI 训练计划', 'saved-plan selectors also withhold AI algorithm titles');
    const hiddenProjection = bench.getPlanCalls[bench.getPlanCalls.length - 1];
    assert.equal(hiddenProjection?.reveal, false);
    assert.equal(hiddenProjection?.accountId, bench.world.account.id);
    const revealed = await bench.registry.call('plan.aiStatus', { ...identity, reveal: true });
    assert.equal(revealed.body.value.status, 'found');
    assert.equal(revealed.body.value.plan.title, 'SPOILER_BINARY_SEARCH_TRAINING');
    assert.equal(revealed.body.value.plan.contentHash, hidden.body.value.plan.contentHash, 'redaction does not rewrite the stored plan');
    assert.equal(bench.getPlanCalls[bench.getPlanCalls.length - 1]?.reveal, true);

    // History carries metadata only and is the read a refreshed page uses to recover request ids.
    const history = await bench.registry.call('plan.aiHistory', { accountId: bench.world.account.id });
    assert.equal(history.status, 200);
    assert.equal(history.body.value.items.length, 1);
    assert.equal(history.body.value.items[0].requestId, 'api-2-1');
    assert.equal(JSON.stringify(history).includes('preparation'), false);
    assert.equal((await bench.registry.call('plan.aiHistory', { accountId: bench.world.account.id, limit: 51 })).status, 400);
    assert.equal((await bench.registry.call('plan.aiHistory', { accountId: bench.world.account.id, limit: 0 })).status, 400);
    assert.equal((await bench.registry.call('plan.aiHistory', {})).status, 400);

    // Cancelling an unknown request is an honest metadata answer, never a fabricated settlement.
    const missing = await bench.registry.call('plan.aiCancel', { requestId: 'api-2-missing', accountId: bench.world.account.id });
    assert.equal(missing.status, 200);
    assert.deepEqual(
      { requestId: missing.body.value.requestId, cancelled: missing.body.value.cancelled, status: missing.body.value.status },
      { requestId: 'api-2-missing', cancelled: false, status: 'unknown' },
    );
  } finally {
    await bench.close();
  }
});

test('plan failures keep stable sanitized codes for missing preparations, stale revisions and blocking probes', async () => {
  const bench = await setup();
  try {
    assert.equal((await bench.registry.call('plan.aiRun', { requestId: 'nope', accountId: bench.world.account.id, expectedSettingsRevision: 1 })).status, 404);
    assert.equal((await bench.registry.call('plan.aiRun', { requestId: 'nope', accountId: bench.world.account.id, expectedSettingsRevision: 0 })).status, 400);
    assert.equal((await bench.registry.call('plan.aiRun', { requestId: 'nope', accountId: bench.world.account.id })).status, 400);

    await bench.registry.call('plan.aiPrepare', { requestId: 'api-3-1', accountId: bench.world.account.id });
    // Move the stored revision: the run must refuse instead of dispatching under a stale screen.
    const saved = await bench.registry.call('settings.save', { expectedRevision: 1, value: defaultWorkbenchSettings() });
    assert.equal(saved.status, 200);
    const stale = await bench.registry.call('plan.aiRun', { requestId: 'api-3-1', accountId: bench.world.account.id, expectedSettingsRevision: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'settings_changed');
    assert.equal(bench.calls().generated, 0);
  } finally {
    await bench.close();
  }

  const blocked = await setup({ probe: [{ code: 'model_missing', severity: 'error', message: 'the model is not registered' }] });
  try {
    await blocked.registry.call('plan.aiPrepare', { requestId: 'api-3-2', accountId: blocked.world.account.id });
    const refused = await blocked.registry.call('plan.aiRun', { requestId: 'api-3-2', accountId: blocked.world.account.id, expectedSettingsRevision: 1 });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'model_invalid');
    assert.equal(blocked.calls().generated, 0);
  } finally {
    await blocked.close();
  }
});

test('a host without the planning injection answers the typed unavailable refusal', async () => {
  const bench = await setup({ withPlanning: false });
  try {
    const answer = await bench.registry.call('plan.aiPrepare', { requestId: 'api-4-1', accountId: bench.world.account.id });
    assert.equal(answer.status, 409);
    assert.equal(answer.body.error.code, 'conflict');
    assert.match(String(answer.body.error.message), /AI planning is not available/);
    // The other model routes keep working: the absence is typed, not a broken boundary.
    assert.equal((await bench.registry.call('batch.list', {})).status, 200);
    // The typed controller error is what the message above is derived from.
    await assert.rejects(
      bench.controller.planPrepare({ requestId: 'api-4-1', accountId: bench.world.account.id }, createCancellationSource().token),
      (error: unknown) => error instanceof ModelOperationError && error.code === 'unavailable',
    );
  } finally {
    await bench.close();
  }
});
