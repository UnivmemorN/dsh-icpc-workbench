/**
 * Sprint 18b2a: the service seam between an installed training method and an AI plan.
 *
 * These cases drive the real {@link PlanningService} with the real {@link WorkbenchService} as its
 * data collaborator over a real SQLite store, a real {@link GuidanceMethodRegistry} and a scripted
 * generator. They pin the externally meaningful behaviour of the seam the generator/adapter stage
 * builds on:
 *
 * - an explicit `guidanceMethodIds` selection is captured through the live catalogue into the
 *   durable preparation and its evidence hash, while an omitted selection keeps the pre-guidance
 *   preparation byte-for-byte (no capture key at all);
 * - the free preparation view retains both the explicit ids and the captured method text;
 * - a paid dispatch carries the stored capture, and the reservation's capture — never the model
 *   answer — decides whether the answer must be guided: a guided attempt without per-task
 *   axis/objective and an unguided attempt that invents guided fields are both refused with their
 *   cost retained;
 * - a method replaced or uninstalled after the preparation refuses the stale attempt before any
 *   dispatch, a fresh preparation captures the replaced version instead of reusing old text, and a
 *   missing method refuses a new preparation instead of degrading it to an unguided one.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GuidanceMethodRegistry } from '../../src/adapters/guidance/index.js';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import {
  PlanningService,
  PlanningServiceError,
} from '../../src/application/planning-service.js';
import type {
  PlanGenerationDraft,
  PlanGenerationRequest,
} from '../../src/application/planning-generation.js';
import { WorkbenchService } from '../../src/application/workbench-service.js';
import {
  CURRENT_TAXONOMY,
  DomainError,
  captureGuidanceSnapshot,
  createCancellationSource,
  createModelUsage,
  createTaxonomyIndex,
  guidanceMethodHash,
  validateGuidanceMethodRegistration,
} from '../../src/domain/index.js';
import * as balanced from '../../packages/dsh-icpc-method-balanced/index.js';
import * as fx from '../storage/fixtures.js';

const AT = '2026-11-01T08:00:00.000Z';
const TOKEN = createCancellationSource().token;
const TAXONOMY = createTaxonomyIndex(CURRENT_TAXONOMY);
const METHOD_ID = 'balanced-dual-axis';

interface Bench {
  readonly store: SqliteTrainingStore;
  readonly registry: GuidanceMethodRegistry;
  readonly workbench: WorkbenchService;
  readonly planning: PlanningService;
  readonly scope: fx.Scope;
  readonly calls: PlanGenerationRequest[];
}

/**
 * One real store, one workbench with the live method catalogue, one planning service and a scripted
 * generator that records every dispatch. Nothing reaches a platform, a model or the network.
 */
async function withBench(
  run: (bench: Bench) => Promise<void>,
  answer: (request: PlanGenerationRequest) => PlanGenerationDraft,
): Promise<void> {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => AT });
  const registry = new GuidanceMethodRegistry();
  let minted = 0;
  const workbench = new WorkbenchService({
    store,
    taxonomy: TAXONOMY,
    now: () => AT,
    uniqueId: () => `guided-${(minted += 1)}`,
    guidance: registry,
  });
  const calls: PlanGenerationRequest[] = [];
  const planning = new PlanningService({
    store,
    generator: {
      async generate(request: PlanGenerationRequest) {
        calls.push(request);
        return {
          ok: true,
          value: { draft: answer(request) },
          usage: createModelUsage({ calls: 1, promptTokens: 100, completionTokens: 20 }),
          callId: 'host-call-1',
          sessionId: null,
        };
      },
    },
    preparation: {
      prepare: workbench.preparePlanInput.bind(workbench),
      revalidate: workbench.revalidatePlanInput.bind(workbench),
      savePlan: workbench.saveModelPlan.bind(workbench),
    },
    now: () => AT,
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
    registry.register(balanced.balancedMethod);
    await run({ store, registry, workbench, planning, scope, calls });
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
}

const EMPTY_DRAFT = (): PlanGenerationDraft => ({ title: null, tasks: [] });

test('an explicit method selection is captured into the preparation while the legacy omission stays absent', async () => {
  await withBench(async ({ store, planning, scope }) => {
    // The legacy contract: no field, no capture key, and the view states that no method was involved.
    const legacy = await planning.prepare({ requestId: 'legacy-omission', accountId: scope.account.id }, TOKEN);
    assert.equal(legacy.outcome, 'prepared');
    if (legacy.outcome !== 'prepared') return;
    assert.equal(legacy.view.guidance, null);
    assert.equal(legacy.view.guidanceMethodIds, null);
    const legacyRow = await store.getPlanAttempt('legacy-omission');
    assert.ok(legacyRow !== null);
    assert.equal(
      Object.hasOwn(legacyRow.preparation, 'guidanceSnapshot'),
      false,
      'a legacy preparation must stay byte-identical to a pre-guidance row',
    );

    const prepared = await planning.prepare(
      { requestId: 'guided-1', accountId: scope.account.id, guidanceMethodIds: [METHOD_ID] },
      TOKEN,
    );
    assert.equal(prepared.outcome, 'prepared');
    if (prepared.outcome !== 'prepared') return;

    const definition = validateGuidanceMethodRegistration(balanced.balancedMethod);
    const expected = captureGuidanceSnapshot('plan', [definition]);
    assert.deepEqual(prepared.view.guidanceMethodIds, [METHOD_ID]);
    assert.equal(prepared.view.guidance?.hash, expected.hash, 'the view carries the exact installed capture');
    assert.equal(prepared.view.guidance?.methods[0]?.methodHash, guidanceMethodHash(definition));

    const row = await store.getPlanAttempt('guided-1');
    assert.ok(row !== null);
    assert.deepEqual(row.preparation.guidanceSnapshot, expected, 'the durable preparation stores the captured method text');

    // The capture is part of the immutable input identity: an identical replay is idempotent ...
    const replay = await planning.prepare(
      { requestId: 'guided-1', accountId: scope.account.id, guidanceMethodIds: [METHOD_ID] },
      TOKEN,
    );
    assert.equal(replay.outcome === 'prepared' ? replay.view.contentHash : null, row.inputHash);

    // ... another selection under the same id is a typed conflict instead of a silent re-bind ...
    await assert.rejects(
      () =>
        planning.prepare(
          { requestId: 'guided-1', accountId: scope.account.id, guidanceMethodIds: ['some-other-method'] },
          TOKEN,
        ),
      (error: unknown) =>
        error instanceof PlanningServiceError &&
        error.code === 'request_conflict' &&
        error.details['reason'] === 'request_guidance_conflict',
    );

    // ... and an explicit empty selection is refused instead of being read as "no method".
    await assert.rejects(
      () => planning.prepare({ requestId: 'guided-empty', accountId: scope.account.id, guidanceMethodIds: [] }, TOKEN),
      (error: unknown) => error instanceof PlanningServiceError && error.code === 'invalid_request',
    );
  }, EMPTY_DRAFT);
});

test('the reservation capture, not the model answer, decides the guided answer shape', async () => {
  await withBench(
    async ({ planning, scope, calls }) => {
      const prepared = await planning.prepare(
        { requestId: 'guided-shape', accountId: scope.account.id, guidanceMethodIds: [METHOD_ID] },
        TOKEN,
      );
      assert.equal(prepared.outcome, 'prepared');

      const run = await planning.run({ requestId: 'guided-shape', accountId: scope.account.id }, TOKEN);
      assert.equal(run.outcome, 'failed', 'a guided answer without an axis is refused, never repaired');
      assert.equal(run.attempt?.status, 'settled');
      assert.equal(run.attempt?.planId, null);
      assert.equal(run.attempt?.usage?.calls, 1, 'the paid call is retained');
      assert.equal(run.error?.code, 'invalid_output');
      assert.match(run.error?.message ?? '', /invalid_axis/u);

      const dispatch = calls[0];
      assert.ok(dispatch !== undefined);
      assert.deepEqual(dispatch.guidance?.selectedMethodIds, [METHOD_ID]);
      assert.equal(dispatch.guidance?.methods[0]?.planGuidance.trainingSteps.length, 5);
    },
    (request) => ({
      title: 'guided',
      diagnosis: {
        priority: 'thinking',
        reason: '最近的复盘证据显示建模是前置瓶颈',
        readinessCheck: '能独立写出状态定义与转移',
        confidence: 'medium',
      },
      tasks: [
        // The first task deliberately omits its axis: without a capture this answer would be a
        // perfectly valid unguided plan, which is exactly what must not happen here.
        { candidateId: request.candidates[0]!.candidateId, day: 1, minutes: 30, kind: 'solve', objective: '先写状态定义' },
        {
          candidateId: request.candidates[1]!.candidateId,
          day: 2,
          minutes: null,
          kind: null,
          axis: 'templates',
          objective: '手写模板并复盘',
        },
      ],
    }),
  );
});

test('an unguided attempt refuses a model answer that invents guided fields', async () => {
  await withBench(
    async ({ planning, scope, calls }) => {
      const prepared = await planning.prepare({ requestId: 'legacy-shape', accountId: scope.account.id }, TOKEN);
      assert.equal(prepared.outcome, 'prepared');
      const run = await planning.run({ requestId: 'legacy-shape', accountId: scope.account.id }, TOKEN);
      assert.equal(run.outcome, 'failed');
      assert.equal(run.error?.code, 'invalid_output');
      assert.match(run.error?.message ?? '', /invalid_shape/u);
      assert.equal(calls[0]?.guidance, null, 'a legacy dispatch states that no method was captured');
    },
    (request) => ({
      title: null,
      tasks: [
        {
          candidateId: request.candidates[0]!.candidateId,
          day: 1,
          minutes: 20,
          kind: 'solve',
          axis: 'thinking',
          objective: 'legacy plans carry no axis or objective',
        },
      ],
    }),
  );
});

test('a method replaced or uninstalled after preparation refuses the stale attempt before any dispatch', async () => {
  await withBench(async ({ store, registry, workbench, planning, scope, calls }) => {
    const prepared = await planning.prepare(
      { requestId: 'guided-replaced', accountId: scope.account.id, guidanceMethodIds: [METHOD_ID] },
      TOKEN,
    );
    assert.equal(prepared.outcome, 'prepared');
    const row = await store.getPlanAttempt('guided-replaced');
    assert.ok(row !== null);

    // An upgrade replaces the installed definition: the stored capture is no longer what would run.
    registry.clear();
    registry.register({ ...balanced.balancedMethod, version: '2.0.0' });
    const revalidated = await workbench.revalidatePlanInput(row.preparation, TOKEN);
    assert.equal(revalidated.ok, false);
    if (!revalidated.ok) {
      assert.equal(revalidated.staleness.reason, 'guidance_changed');
    }

    const refused = await planning.run({ requestId: 'guided-replaced', accountId: scope.account.id }, TOKEN);
    assert.equal(refused.outcome, 'refused');
    assert.equal(refused.error?.code, 'stale_preparation');
    assert.equal(calls.length, 0, 'no paid call is dispatched against a replaced method');

    // A new preparation under the changed catalogue captures the new version instead of reusing text.
    const fresh = await planning.prepare(
      { requestId: 'guided-fresh', accountId: scope.account.id, guidanceMethodIds: [METHOD_ID] },
      TOKEN,
    );
    assert.equal(fresh.outcome === 'prepared' ? fresh.view.guidance?.methods[0]?.version : null, '2.0.0');

    // Uninstalling the method refuses a preparation outright instead of degrading it to unguided.
    registry.clear();
    await assert.rejects(
      () =>
        planning.prepare(
          { requestId: 'guided-missing', accountId: scope.account.id, guidanceMethodIds: [METHOD_ID] },
          TOKEN,
        ),
      (error: unknown) =>
        error instanceof DomainError &&
        error.details['reason'] === 'guidance_refused' &&
        error.details['refusal'] === 'missing_method',
    );
  }, EMPTY_DRAFT);
});
test('guided success survives storage, method uninstall, and spoiler-safe projection', async () => {
  await withBench(async ({ store, registry, workbench, planning, scope, calls }) => {
    const prepared = await planning.prepare({requestId:'guided-roundtrip',accountId:scope.account.id,guidanceMethodIds:[METHOD_ID]}, TOKEN);
    assert.equal(prepared.outcome,'prepared');
    const run = await planning.run({requestId:'guided-roundtrip',accountId:scope.account.id},TOKEN);
    assert.equal(run.outcome,'planned',JSON.stringify(run.error));
    assert.ok(run.attempt?.planId);
    const stored = await store.getPlan(run.attempt.planId);
    assert.ok(stored);
    assert.equal(stored.guidanceSnapshot?.hash,calls[0]?.guidance?.hash);
    assert.equal(stored.diagnosis?.priority,'thinking');
    assert.deepEqual(stored.tasks.map(t=>t.axis),['thinking','templates']);
    assert.equal(stored.tasks[1]?.objective,'练习模板并解释不变量');
    registry.clear();
    const safe=await workbench.getPlan({planId:stored.planId,accountId:scope.account.id},TOKEN);
    assert.equal(safe.guidanceSnapshot?.hash,stored.guidanceSnapshot?.hash);
    assert.equal(safe.diagnosis,undefined);
    assert.equal(safe.diagnosisHidden,true);
    assert.ok(safe.tasks.every(t=>t.objective===undefined));
    const revealed=await workbench.getPlan({planId:stored.planId,accountId:scope.account.id,reveal:true},TOKEN);
    assert.deepEqual(revealed.diagnosis,stored.diagnosis);
    assert.equal(revealed.tasks[0]?.objective,'先独立建模，再实现验证');
    assert.equal((await store.getPlan(stored.planId))?.guidanceSnapshot?.methods[0]?.version,'1.0.0');
  }, request=>({title:'双方向训练',diagnosis:{priority:'thinking',reason:'先补齐建模能力以支撑模板应用',readinessCheck:'独立说明模板的适用条件',confidence:'low'},tasks:[
    {candidateId:request.candidates[0]!.candidateId,day:1,minutes:30,kind:'solve',axis:'thinking',objective:'先独立建模，再实现验证'},
    {candidateId:request.candidates[1]!.candidateId,day:2,minutes:30,kind:'solve',axis:'templates',objective:'练习模板并解释不变量'}
  ]}));
});
