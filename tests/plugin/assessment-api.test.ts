/**
 * Assessment HTTP API over the real service chain (Stage 18f).
 *
 * Every case registers the real {@link registerAssessmentApi} routes on an in-process Fetch registry
 * and drives them with real `Request`/`Response` objects, exactly as the host carrier would. The
 * service behind the routes is the production chain — real `AssessmentService`, real
 * `WorkbenchService.captureAssessmentInput` over a temporary `SqliteTrainingStore`, and the real
 * `GuidanceMethodRegistry` with the installed balanced companion method — so the assertions cover
 * the actual transport projection, not a scripted double.
 *
 * Covered externally meaningful behaviour: the free configuration preview, the free prepare and its
 * durable status, the paid run and its owned settlement, status/cancel/history, account isolation
 * (a foreign request id is `not_found`/`null`, never another account's attempt), closed request
 * shapes, an unsupported method refused before any cost, a sanitized error vocabulary that never
 * leaks provider, store or path detail, and the projection boundary: no internal attempt, account,
 * source, correlation id or raw source hash travels, while a history page keeps the stored report's
 * citations intact and carries no evidence payload.
 *
 * Authentication belongs to the host Connection carrier and is already covered by the transport
 * tests; the routes here trust the authenticated caller just as production does.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectionFetchRoute, HostConnectionFetch } from '@deepseek-ai/dsh-client-connection';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { GuidanceMethodRegistry } from '../../src/adapters/guidance/index.js';
import { WorkbenchService } from '../../src/application/workbench-service.js';
import { AssessmentService } from '../../src/application/assessment-service.js';
import { registerAssessmentApi } from '../../src/plugin/assessment-api.js';
import { API_PREFIX, type ApiEnvelope } from '../../src/plugin/api-transport.js';
import type {
  AssessmentGenerationOutcome,
  AssessmentGenerationRequest,
  AssessmentGenerator,
} from '../../src/application/assessment-generation.js';
import { defaultWorkbenchSettings, validateWorkbenchSettings } from '../../src/application/workbench-settings.js';
import type { ModelCallResult } from '../../src/application/ports.js';
import { CURRENT_TAXONOMY, createTaxonomyIndex, validateOfficialRating } from '../../src/domain/index.js';
import * as balanced from '../../packages/dsh-icpc-method-balanced/index.js';
import { AT, USAGE, makeReport, officialRatingSnapshot } from '../assessment-fixtures.js';
import * as fx from '../storage/fixtures.js';

const METHOD = balanced.balancedMethod.methodId;
const TAXONOMY = createTaxonomyIndex(CURRENT_TAXONOMY);
/** A canonical account id that is deliberately never created in this bench. */
const OTHER_ACCOUNT_ID = 'codeforces:codeforces.com|bob';

function okFor(request: AssessmentGenerationRequest): ModelCallResult<AssessmentGenerationOutcome> {
  const refs = new Set(request.evidence.evidence.map((entry) => entry.evidenceRef));
  const pick = (...candidates: readonly string[]): string[] => candidates.filter((ref) => refs.has(ref));
  const anchored = request.evidence.anchor.kind !== 'none';
  const report = makeReport({
    confidenceEvidenceRefs: pick('ev-official-rating', 'ev-coverage'),
    thinking: {
      assessment: '建模与不变量推导的证据集中在同一分带，独立完成程度还需要更多样本。',
      evidenceRefs: pick('ev-self-assessment', 'ev-coverage'),
      uncertainties: [],
    },
    templates: {
      assessment: '模板与实现证据来自已通过的平台标签和知识分带统计。',
      evidenceRefs: pick('ev-knowledge-summary', 'ev-coverage'),
      uncertainties: [],
    },
    ...(anchored ? {} : { estimatedRange: null, priority: 'diagnostic' }),
  });
  return { ok: true, value: { report } as unknown as AssessmentGenerationOutcome, usage: USAGE, callId: 'call-1', sessionId: 'session-1' };
}

interface CallResult {
  readonly status: number;
  readonly body: ApiEnvelope<Record<string, any>>;
}

interface Bench {
  readonly store: SqliteTrainingStore;
  readonly scope: fx.Scope;
  readonly service: AssessmentService;
  readonly generatorCalls: AssessmentGenerationRequest[];
  call(operation: string, body: unknown): Promise<CallResult>;
  /** Call one route and require a 200 success envelope. */
  ok(operation: string, body: unknown): Promise<Record<string, any>>;
  /** Poll the registered status route until the request reaches a terminal status. */
  waitForTerminal(requestId: string): Promise<Record<string, any>>;
}

async function withBench(run: (bench: Bench) => Promise<void>): Promise<void> {
  const paths = fx.tempDatabase();
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const clock = AT;
  const store = new SqliteTrainingStore({ path: paths.path, now: () => clock });
  const registry = new GuidanceMethodRegistry();
  const unregister = registry.register(balanced.balancedMethod);
  const workbench = new WorkbenchService({
    store,
    taxonomy: TAXONOMY,
    now: () => clock,
    uniqueId: (() => {
      let minted = 0;
      return () => `api-${(minted += 1)}`;
    })(),
    guidance: registry,
  });
  const generatorCalls: AssessmentGenerationRequest[] = [];
  const generator: AssessmentGenerator = {
    generate: (request) => {
      generatorCalls.push(request);
      return Promise.resolve(okFor(request));
    },
  };
  const service = new AssessmentService({ store, capture: workbench, generator, now: () => clock });
  const routes = new Map<string, ConnectionFetchRoute>();
  const hostRegistry: HostConnectionFetch = {
    register(route) {
      routes.set(route.path, route);
      return async () => {
        routes.delete(route.path);
      };
    },
  };
  const disposeRoutes = await registerAssessmentApi(hostRegistry, service);

  await store.upsertSourceInstances([scope.instance]);
  await store.upsertAccounts([scope.account]);
  await store.upsertProblems([scope.problem]);
  await store.upsertSubmissions([
    fx.makeSubmission(scope.account, scope.problem.ref, 'sub-1', 'accepted', fx.AT),
  ]);
  await store.saveOfficialRating(
    validateOfficialRating({ ...officialRatingSnapshot(), accountId: scope.account.id }),
    0,
  );
  const defaults = defaultWorkbenchSettings();
  await store.saveWorkbenchSettings(validateWorkbenchSettings(defaults), null);

  const call = async (operation: string, body: unknown): Promise<CallResult> => {
    const route = routes.get(`${API_PREFIX}${operation}`);
    assert.ok(route, `route ${operation} must be registered`);
    const response = await route.fetch(
      new Request(`http://localhost${API_PREFIX}${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: (await response.json()) as ApiEnvelope<Record<string, any>> };
  };
  const ok = async (operation: string, body: unknown): Promise<Record<string, any>> => {
    const answer = await call(operation, body);
    assert.equal(answer.status, 200, `${operation} should succeed: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.ok, true, `${operation} answered a failed envelope`);
    return answer.body.ok ? answer.body.value : assert.fail(`${operation} failed`);
  };
  const waitForTerminal = async (requestId: string): Promise<Record<string, any>> => {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const value = await ok('assessment.status', { requestId, accountId: scope.account.id });
      if (value === null) {
        assert.fail(`assessment ${requestId} disappeared`);
      }
      if (value.status === 'settled' || value.status === 'uncertain' || value.status === 'cancelled') {
        return value;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 2);
      });
    }
    return assert.fail(`assessment ${requestId} did not reach a terminal status`);
  };

  try {
    await run({ store, scope, service, generatorCalls, call, ok, waitForTerminal });
  } finally {
    await disposeRoutes();
    await service.close();
    await store.close();
    unregister();
    fx.removeDirectory(paths.dir);
  }
}

async function preparedBench(bench: Bench, requestId: string): Promise<Record<string, any>> {
  return bench.ok('assessment.prepare', {
    requestId,
    accountId: bench.scope.account.id,
    methodIds: [METHOD],
  });
}

// ---------------------------------------------------------------------------------------
// Lifecycle over the registered routes
// ---------------------------------------------------------------------------------------

test('the registered routes serve config, prepare, run, status, cancel and history over the real chain', async () => {
  await withBench(async (bench) => {
    const accountId = bench.scope.account.id;

    const config = await bench.ok('assessment.config', {});
    assert.equal(config.settingsRevision, 1);
    assert.equal(config.provider, 'deepseek-official');
    assert.equal(config.model, 'deepseek-flash');
    assert.equal(config.effort, 'max');
    assert.equal(config.maxMethods, 4);
    assert.ok(config.disclosure.length > 0);

    const prepared = await preparedBench(bench, 'api-1');
    assert.equal(prepared.status, 'prepared');
    assert.deepEqual(prepared.methodIds, [METHOD]);
    assert.equal(prepared.usage, null);
    assert.equal(prepared.report, null);
    assert.equal(prepared.guidance.kind, 'assessment');
    assert.equal(prepared.guidance.methods[0]?.methodId, METHOD, 'the frozen method capture reaches the UI');
    assert.notEqual(prepared.evidence, null, 'prepare publishes the identifier-free capture payload');
    assert.equal(bench.generatorCalls.length, 0, 'preparing is free');

    const run = await bench.ok('assessment.run', { requestId: 'api-1', accountId });
    assert.equal(run.started, true);
    assert.equal(run.attempt.status, 'reserved');
    const settled = await bench.waitForTerminal('api-1');
    assert.equal(settled.status, 'settled');
    assert.equal(settled.report.source, 'ai_inferred');
    assert.ok(settled.report.report.confidenceEvidenceRefs.length > 0);
    assert.deepEqual(settled.usage, USAGE);

    const status = await bench.ok('assessment.status', { requestId: 'api-1', accountId });
    assert.equal(status.status, 'settled');
    assert.equal(status.requestId, 'api-1');
    assert.notEqual(status.evidence, null, 'status still carries the capture payload');

    const history = await bench.ok('assessment.history', { accountId });
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0].requestId, 'api-1');
    assert.equal(history.items[0].evidence, null, 'a history page carries metadata only');
    assert.equal(history.nextCursor, null);

    // Cancelling a free preparation is known-zero and idempotent through the route.
    await preparedBench(bench, 'api-2');
    const cancelled = await bench.ok('assessment.cancel', { requestId: 'api-2', accountId });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.usage.calls, 0);
    assert.equal(cancelled.error.code, 'cancelled');
    const repeated = await bench.ok('assessment.cancel', { requestId: 'api-2', accountId });
    assert.deepEqual(repeated, cancelled);
    assert.equal(bench.generatorCalls.length, 1, 'only the paid attempt ever reached the generator');
  });
});

// ---------------------------------------------------------------------------------------
// Account isolation, closed shapes, pre-cost refusal and sanitized errors
// ---------------------------------------------------------------------------------------

test('a foreign account is not found, the request shapes are closed and an unsupported method is refused before cost', async () => {
  await withBench(async (bench) => {
    const accountId = bench.scope.account.id;
    await preparedBench(bench, 'api-owned');

    // A foreign or missing request id is `null`/`not_found`; nothing about the stored attempt leaks.
    const foreignStatus = await bench.call('assessment.status', { requestId: 'api-owned', accountId: OTHER_ACCOUNT_ID });
    assert.equal(foreignStatus.status, 200);
    assert.deepEqual(foreignStatus.body, { apiVersion: 1, ok: true, value: null });
    for (const operation of ['assessment.run', 'assessment.cancel']) {
      const refused = await bench.call(operation, { requestId: 'api-owned', accountId: OTHER_ACCOUNT_ID });
      assert.equal(refused.status, 404, `${operation} must refuse a foreign account`);
      assert.equal(refused.body.ok ? null : refused.body.error.code, 'not_found');
      assert.equal(JSON.stringify(refused.body).includes(accountId), false);
    }
    const foreignHistory = await bench.ok('assessment.history', { accountId: OTHER_ACCOUNT_ID });
    assert.deepEqual(foreignHistory.items, []);

    // Closed request shapes: a missing required field and an unknown field are both 400.
    const shapes: readonly (readonly [string, unknown])[] = [
      ['assessment.config', { extra: true }],
      ['assessment.prepare', { requestId: 'api-shape', accountId, methodIds: [METHOD], extra: true }],
      ['assessment.prepare', { requestId: 'api-shape', methodIds: [METHOD] }],
      ['assessment.run', { requestId: 'api-owned', accountId, methodIds: [METHOD] }],
      ['assessment.status', { requestId: 'api-owned' }],
      ['assessment.cancel', { requestId: 'api-owned', accountId, unknown: 1 }],
      ['assessment.history', { limit: 1 }],
      ['assessment.history', { accountId, extra: true }],
    ];
    for (const [operation, body] of shapes) {
      const refused = await bench.call(operation, body);
      assert.equal(refused.status, 400, `${operation} must refuse ${JSON.stringify(body)}`);
      assert.equal(refused.body.ok ? null : refused.body.error.code, 'invalid_input');
    }

    // An uninstalled method is refused by the real capture before any evidence read or cost.
    const unsupported = await bench.call('assessment.prepare', {
      requestId: 'api-unsupported',
      accountId,
      methodIds: ['method-that-is-not-installed'],
    });
    assert.equal(unsupported.status, 400);
    assert.equal(unsupported.body.ok ? null : unsupported.body.error.code, 'invalid_input');
    assert.equal(await bench.store.getAssessmentAttempt('api-unsupported'), null, 'a refused prepare stores nothing');
    assert.equal(bench.generatorCalls.length, 0);

    // Real evidence movement maps to the stable `conflict` code with a fixed, sanitized message.
    const extra = fx.makeProblem(fx.makeRef(bench.scope.instance, '2B'));
    await bench.store.upsertProblems([extra]);
    await bench.store.upsertSubmissions([fx.makeSubmission(bench.scope.account, extra.ref, 'sub-2', 'accepted', fx.AT)]);
    const stale = await bench.call('assessment.run', { requestId: 'api-owned', accountId });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.ok ? null : stale.body.error.code, 'conflict');
    const serialized = JSON.stringify(stale.body);
    for (const forbidden of ['missing_method', 'nested_transaction', 'SQLITE', 'assessment-service.ts', 'D:\\']) {
      assert.equal(serialized.includes(forbidden), false, `the refusal must not leak ${forbidden}`);
    }
    assert.equal(bench.generatorCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------------------
// Projection boundary and history citations
// ---------------------------------------------------------------------------------------

test('the projection hides internal attempt data while history keeps the stored citations and drops the evidence', async () => {
  await withBench(async (bench) => {
    const accountId = bench.scope.account.id;
    const prepared = await preparedBench(bench, 'api-projection');

    for (const key of ['attempt', 'accountId', 'sourceInstanceId', 'inputHash', 'preparation', 'hostSessionId', 'hostCallId']) {
      assert.equal(Object.hasOwn(prepared, key), false, `the projection must not expose ${key}`);
    }
    const serialized = JSON.stringify(prepared);
    for (const forbidden of [accountId, 'alice', 'sourceEvidenceHash', 'inputHash', 'hostCallId', 'hostSessionId']) {
      assert.equal(serialized.includes(forbidden), false, `the projection must not leak ${forbidden}`);
    }
    // The raw source hash of the frozen capture is internal: only the report's own evidence hash may
    // travel (the guidance snapshot's public citation hashes are method metadata, not source evidence).
    const storedAttempt = await bench.store.getAssessmentAttempt('api-projection');
    assert.ok(storedAttempt !== null);
    const rawSourceHash = storedAttempt.preparation.capture.sourceHash;
    assert.match(rawSourceHash, /^[0-9a-f]{64}$/u);
    assert.equal(serialized.includes(rawSourceHash), false, 'the raw source hash must not travel');
    // The evidence payload is useful and identifier-free, and the internal snapshot is not sent.
    assert.notEqual(prepared.evidence, null);
    assert.equal(Object.hasOwn(prepared.evidence, 'snapshot'), false);

    await bench.ok('assessment.run', { requestId: 'api-projection', accountId });
    const settled = await bench.waitForTerminal('api-projection');
    assert.equal(settled.status, 'settled');
    assert.ok(settled.report.report.confidenceEvidenceRefs.length > 0);

    const history = await bench.ok('assessment.history', { accountId, status: 'settled', limit: 5 });
    assert.ok(history.items.length > 0 && history.items.every((entry: { status: string }) => entry.status === 'settled'));
    assert.equal(Object.hasOwn(history, 'accountId'), false, 'the history envelope stays account-free');
    const item = history.items[0];
    assert.ok(item, 'the settled attempt is on the history page');
    assert.equal(item.evidence, null, 'history never republishes the model payload');
    assert.equal(Object.hasOwn(item, 'accountId'), false);
    const historySerialized = JSON.stringify(history);
    assert.equal(historySerialized.includes(accountId), false, 'a history page never carries the account id');
    assert.equal(historySerialized.includes(rawSourceHash), false, 'a history page never carries the raw source hash');
    // The stored answer is intact, including every citation it was validated against.
    const stored = await bench.store.getAssessmentAttempt('api-projection');
    assert.ok(stored !== null && stored.report !== null);
    assert.deepEqual(item.report, stored.report);
    assert.deepEqual(item.report.report.confidenceEvidenceRefs, stored.report.report.confidenceEvidenceRefs);
    const capturedRefs = new Set(stored.preparation.capture.prompt.evidence.map((entry) => entry.evidenceRef));
    for (const ref of item.report.report.thinking.evidenceRefs) {
      assert.ok(capturedRefs.has(ref));
    }
  });
});
