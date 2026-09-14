/**
 * Durable assessment-service lifecycle over a real SQLite store (Stage 18d2).
 *
 * Every case drives the real `AssessmentService` with a real `SqliteTrainingStore`, a scripted
 * `AssessmentDataPort` that builds genuine 18d1 captures from mutable account evidence, and a
 * scripted `AssessmentGenerator` that is the only place a paid dispatch is observed. Nothing here
 * reaches a platform, a model or the network.
 *
 * The assertions are about the externally meaningful protocol: the free preparation and its
 * idempotent replay, the one charged reservation per paid call (including concurrent retries and
 * the global quota), pre-cost refusals when the method/evidence/settings moved, report rejection
 * with retained usage when they move in flight, cancellation before and after dispatch, recovery of
 * an expired reservation without refunding quota, history that keeps an uninstalled method's report,
 * and close-time drainage plus charged retention when the settlement write itself fails.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import {
  AssessmentService,
  AssessmentServiceError,
  MAX_ASSESSMENT_HISTORY_LIMIT,
  MAX_ASSESSMENT_METHODS,
  type AssessmentAttemptView,
  type AssessmentServiceStore,
} from '../../src/application/assessment-service.js';
import type {
  AssessmentGenerationOutcome,
  AssessmentGenerationRequest,
  AssessmentGenerator,
} from '../../src/application/assessment-generation.js';
import type {
  AssessmentCapture,
  AssessmentCaptureRequest,
  AssessmentDataPort,
} from '../../src/application/assessment-capture.js';
import {
  ASSESSMENT_ATTEMPT_CHARGED_STATUSES,
  type AssessmentAttempt,
} from '../../src/application/assessment-types.js';
import type { ModelCallResult, ModelErrorCode } from '../../src/application/ports.js';
import {
  defaultWorkbenchSettings,
  validateWorkbenchSettings,
  type WorkbenchSettings,
} from '../../src/application/workbench-settings.js';
import {
  DomainError,
  GUIDANCE_SEAM_VERSION,
  captureGuidanceSnapshot,
  createCancellationSource,
  validateGuidanceMethodDefinition,
  type CancellationToken,
  type GuidanceMethodDefinition,
  type ModelUsage,
  type NormalizedProblem,
  type OfficialRatingSnapshot,
  type Submission,
} from '../../src/domain/index.js';
import {
  ACCOUNT_ID,
  AT,
  LATER,
  USAGE,
  makeCapture,
  makeReport,
  officialRatingSnapshot,
} from '../assessment-fixtures.js';
import * as fx from '../storage/fixtures.js';

const OTHER_ACCOUNT_ID = 'codeforces:codeforces.com|bob';
/** A token nobody cancels: the "normal caller" of most cases. */
const TOKEN = createCancellationSource().token;
const METHOD_1 = 'balanced-dual-axis';
const METHOD_2 = 'diagnosis-first';

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AssessmentServiceError && error.code === code;
}

function ok(report: unknown = makeReport(), usage: ModelUsage = USAGE): ModelCallResult<AssessmentGenerationOutcome> {
  return { ok: true, value: { report } as AssessmentGenerationOutcome, usage, callId: 'call-1', sessionId: 'session-1' };
}

function fail(code: ModelErrorCode, usage: ModelUsage | null): ModelCallResult<AssessmentGenerationOutcome> {
  return {
    ok: false,
    error: { code, message: `the model reported ${code}`, retryable: code === 'timeout' || code === 'rate_limited' },
    usage,
    callId: 'call-1',
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** One valid assessment-capable method definition; `version` simulates a replaced method. */
function methodDefinition(methodId: string, version = '1.0.0'): GuidanceMethodDefinition {
  return validateGuidanceMethodDefinition({
    methodId,
    version,
    seamVersion: GUIDANCE_SEAM_VERSION,
    name: `方法 ${methodId}`,
    summary: `${methodId} 的评估方法与训练安排`,
    capabilities: { plan: true, assessment: true },
    planGuidance: {
      summary: '按诊断与模板两条轴安排训练。',
      sections: [{ title: '安排', text: '先诊断瓶颈，再按轴排题。' }],
      trainingSteps: ['诊断瓶颈', '安排练习', '复盘确认'],
    },
    assessmentGuidance: {
      summary: '按独立完成程度自评。',
      sections: [{ title: '自评', text: '区分独立完成、提示辅助与参考答案。' }],
    },
    sources: [],
  });
}

/** Settings with one explicit quota (and optional output-token) change over the defaults. */
function settingsOf(maxCallsPer24Hours = 10, maxOutputTokens?: number): WorkbenchSettings {
  const defaults = defaultWorkbenchSettings();
  return validateWorkbenchSettings({
    ...defaults,
    roles: maxOutputTokens === undefined ? defaults.roles : { ...defaults.roles, maxOutputTokens },
    coaching: { ...defaults.coaching, maxCallsPer24Hours },
  });
}

type GeneratorHandler = (request: AssessmentGenerationRequest) => Promise<ModelCallResult<AssessmentGenerationOutcome>>;

/**
 * Service + real store + scripted capture port and generator.
 *
 * The mutable evidence fields are the account's own source: changing one between `prepare` and
 * `run` really changes the 18d1 `sourceHash`, because the capture port rebuilds a genuine capture
 * through the same factories the workbench uses.
 */
class Bench {
  clock = AT;
  readonly calls: AssessmentGenerationRequest[] = [];
  readonly installed = new Map<string, GuidanceMethodDefinition>();
  readonly submissions: Submission[] = [];
  readonly problems: NormalizedProblem[] = [];
  captureCalls = 0;
  official: OfficialRatingSnapshot | null = officialRatingSnapshot(1500);
  handler: GeneratorHandler = async () => ok();
  failSettlements = false;
  readonly store: SqliteTrainingStore;
  readonly service: AssessmentService;
  private readonly paths: { readonly path: string; readonly dir: string };

  constructor() {
    this.paths = fx.tempDatabase();
    const store = new SqliteTrainingStore({ path: this.paths.path, now: () => this.clock });
    this.store = store;
    const capture: AssessmentDataPort = {
      captureAssessmentInput: (request, token) => this.captureInput(request, token),
    };
    const generator: AssessmentGenerator = {
      generate: (request) => {
        this.calls.push(request);
        return this.handler(request);
      },
    };
    this.service = new AssessmentService({ store: this.storeProxy(), capture, generator, now: () => this.clock });
  }

  async seed(maxCallsPer24Hours = 10): Promise<void> {
    await this.store.saveWorkbenchSettings(settingsOf(maxCallsPer24Hours), null);
  }

  /** One more accepted solve plus a refreshed official rating: an account evidence mutation. */
  changeEvidence(): void {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1234A');
    this.problems.push(scope.problem);
    this.submissions.push(
      fx.makeSubmission(scope.account, scope.problem.ref, `sub-${this.submissions.length + 1}`, 'accepted', AT),
    );
    this.official = officialRatingSnapshot(1600);
  }

  async waitForView(
    requestId: string,
    predicate: (view: AssessmentAttemptView) => boolean,
    label: string,
  ): Promise<AssessmentAttemptView> {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const view = await this.service.status({ requestId, accountId: ACCOUNT_ID }, TOKEN);
      if (view !== null && predicate(view)) {
        return view;
      }
      await sleep(2);
    }
    assert.fail(`timed out waiting for ${label}`);
  }

  async waitForTerminal(requestId: string): Promise<AssessmentAttemptView> {
    return this.waitForView(
      requestId,
      (view) => view.status === 'settled' || view.status === 'uncertain' || view.status === 'cancelled',
      `assessment ${requestId} to reach a terminal status`,
    );
  }

  async statusOf(requestId: string, accountId = ACCOUNT_ID): Promise<AssessmentAttemptView | null> {
    return this.service.status({ requestId, accountId }, TOKEN);
  }

  async dispose(): Promise<void> {
    await this.service.close();
    await this.store.close();
    fx.removeDirectory(this.paths.dir);
  }

  /** The real store, with one switchable settlement-write failure for the retention case. */
  private storeProxy(): AssessmentServiceStore {
    const target = this.store;
    return new Proxy(target, {
      get: (inner, property) => {
        if (property === 'saveAssessmentAttempt' && this.failSettlements) {
          return async (attempt: AssessmentAttempt): Promise<void> => {
            if (attempt.status === 'settled' || attempt.status === 'uncertain') {
              throw new Error('simulated storage failure while writing an assessment outcome');
            }
            return inner.saveAssessmentAttempt(attempt);
          };
        }
        const value = Reflect.get(inner, property, inner) as unknown;
        return typeof value === 'function' ? (value as (...args: readonly unknown[]) => unknown).bind(inner) : value;
      },
    }) as AssessmentServiceStore;
  }

  private async captureInput(request: AssessmentCaptureRequest, token: CancellationToken): Promise<AssessmentCapture> {
    token.throwIfCancelled();
    this.captureCalls += 1;
    const definitions = (request.guidanceMethodIds ?? []).map((methodId) => {
      const definition = this.installed.get(methodId);
      if (definition === undefined) {
        throw new DomainError('invalid_input', `assessment method ${methodId} is not installed`, {
          reason: 'missing_method',
        });
      }
      return definition;
    });
    return makeCapture({
      accountId: request.accountId,
      officialRating: this.official,
      submissions: this.submissions,
      problems: this.problems,
      guidance: captureGuidanceSnapshot('assessment', definitions),
      at: request.capturedAt,
    });
  }
}

async function withBench(
  run: (bench: Bench) => Promise<void>,
  options: { readonly maxCallsPer24Hours?: number } = {},
): Promise<void> {
  const bench = new Bench();
  await bench.seed(options.maxCallsPer24Hours ?? 10);
  try {
    await run(bench);
  } finally {
    await bench.dispose();
  }
}

test('prepare is free and durable, replays idempotently, and conflicts without disclosing the stored attempt', async () => {
  await withBench(async (bench) => {
    bench.installed.set(METHOD_1, methodDefinition(METHOD_1));
    bench.installed.set(METHOD_2, methodDefinition(METHOD_2));
    const request = { requestId: 'req-free', accountId: ACCOUNT_ID, methodIds: [METHOD_1] };

    const prepared = await bench.service.prepare(request, TOKEN);
    assert.equal(prepared.status, 'prepared');
    assert.deepEqual(prepared.methodIds, [METHOD_1]);
    assert.equal(prepared.settingsRevision, 1);
    assert.equal(prepared.provider, 'deepseek-official');
    assert.equal(prepared.model, 'deepseek-flash');
    assert.equal(prepared.usage, null);
    assert.equal(prepared.report, null);
    assert.equal(prepared.error, null);
    assert.equal(bench.calls.length, 0, 'prepare never dispatches a model call');
    assert.equal(bench.captureCalls, 1);
    assert.equal(await bench.store.countAssessmentAttempts({ statuses: ASSESSMENT_ATTEMPT_CHARGED_STATUSES }), 0);

    // A replay returns the original durable data and captures nothing again.
    const replayed = await bench.service.prepare(request, TOKEN);
    assert.deepEqual(replayed, prepared);
    assert.equal(bench.captureCalls, 1);

    // One request id cannot be rebound to another selection or account; the refusal names neither.
    await assert.rejects(
      bench.service.prepare({ ...request, methodIds: [METHOD_2] }, TOKEN),
      hasCode('conflict'),
    );
    await assert.rejects(bench.service.prepare({ ...request, accountId: OTHER_ACCOUNT_ID }, TOKEN), (error: unknown) => {
      assert.ok(error instanceof AssessmentServiceError && error.code === 'conflict');
      assert.ok(!error.message.includes(ACCOUNT_ID), 'a conflict never discloses the stored account');
      return true;
    });

    // Every read proves the account: a foreign or missing request id is simply not found.
    assert.equal(await bench.statusOf('req-free', OTHER_ACCOUNT_ID), null);
    assert.equal(await bench.statusOf('missing'), null);
    await assert.rejects(
      bench.service.run({ requestId: 'req-free', accountId: OTHER_ACCOUNT_ID }, TOKEN),
      hasCode('not_found'),
    );

    // Malformed selections never reach the capture port, and unknown methods never reach the store.
    assert.equal(MAX_ASSESSMENT_METHODS, 4);
    const capturesBefore = bench.captureCalls;
    await assert.rejects(
      bench.service.prepare({ requestId: 'req-bad', accountId: ACCOUNT_ID, methodIds: [] }, TOKEN),
      hasCode('invalid_request'),
    );
    await assert.rejects(
      bench.service.prepare({ requestId: 'req-bad', accountId: ACCOUNT_ID, methodIds: [METHOD_1, METHOD_1] }, TOKEN),
      hasCode('invalid_request'),
    );
    await assert.rejects(
      bench.service.prepare(
        { requestId: 'req-bad', accountId: ACCOUNT_ID, methodIds: [METHOD_1, METHOD_2, METHOD_1, METHOD_2, METHOD_1] },
        TOKEN,
      ),
      hasCode('invalid_request'),
    );
    await assert.rejects(
      bench.service.prepare({ requestId: 'x'.repeat(201), accountId: ACCOUNT_ID, methodIds: [METHOD_1] }, TOKEN),
      hasCode('invalid_request'),
    );
    assert.equal(bench.captureCalls, capturesBefore);
    await assert.rejects(
      bench.service.prepare({ requestId: 'req-gone', accountId: ACCOUNT_ID, methodIds: ['gone-method'] }, TOKEN),
      hasCode('invalid_request'),
    );
    assert.equal(await bench.statusOf('req-gone'), null);

    // The free configuration preview describes the same budgets prepare will bind.
    const config = await bench.service.config(TOKEN);
    assert.equal(config.settingsRevision, 1);
    assert.equal(config.model, 'deepseek-flash');
    assert.equal(config.maxMethods, MAX_ASSESSMENT_METHODS);
    assert.equal(config.quota.maxCallsPer24Hours, 10);
    assert.equal(config.effort, 'max');
  });
});

test('run reserves and dispatches exactly one paid call, refuses a concurrent call, then the rolling quota', async () => {
  await withBench(
    async (bench) => {
      bench.installed.set(METHOD_1, methodDefinition(METHOD_1));
      const held = deferred<ModelCallResult<AssessmentGenerationOutcome>>();
      bench.handler = () => held.promise;
      const first = { requestId: 'req-1', accountId: ACCOUNT_ID };
      await bench.service.prepare({ ...first, methodIds: [METHOD_1] }, TOKEN);

      const [left, right] = await Promise.all([bench.service.run(first, TOKEN), bench.service.run(first, TOKEN)]);
      assert.equal([left.started, right.started].filter(Boolean).length, 1, 'one retry reserves, the other replays');
      assert.equal(bench.calls.length, 1, 'the paid call is dispatched exactly once');
      assert.equal(left.attempt.status, 'reserved');
      assert.equal(right.attempt.status, 'reserved');
      assert.equal(left.attempt.usage, null);
      assert.equal(await bench.store.countAssessmentAttempts({ statuses: ASSESSMENT_ATTEMPT_CHARGED_STATUSES }), 1);

      // A second prepared attempt cannot start while the first reservation is live.
      await bench.service.prepare({ requestId: 'req-2', accountId: ACCOUNT_ID, methodIds: [METHOD_1] }, TOKEN);
      await assert.rejects(bench.service.run({ requestId: 'req-2', accountId: ACCOUNT_ID }, TOKEN), hasCode('busy'));

      held.resolve(ok());
      const settled = await bench.waitForTerminal('req-1');
      assert.equal(settled.status, 'settled');
      assert.equal(settled.report?.source, 'ai_inferred');
      assert.deepEqual(settled.usage, USAGE);
      assert.equal(settled.error, null);
      assert.equal(bench.calls.length, 1);

      // The rolling 24h quota counts this service's own charged attempts (max 1) globally.
      await assert.rejects(bench.service.run({ requestId: 'req-2', accountId: ACCOUNT_ID }, TOKEN), hasCode('quota'));

      // Running a terminal attempt is an idempotent replay, never a second paid call.
      const replay = await bench.service.run(first, TOKEN);
      assert.equal(replay.started, false);
      assert.equal(replay.attempt.status, 'settled');
      assert.equal(bench.calls.length, 1);
      assert.equal(await bench.store.countAssessmentAttempts({ statuses: ASSESSMENT_ATTEMPT_CHARGED_STATUSES }), 1);
    },
    { maxCallsPer24Hours: 1 },
  );
});

test('run refuses a replaced or uninstalled method, moved evidence and changed settings before any cost', async () => {
  await withBench(async (bench) => {
    bench.installed.set(METHOD_1, methodDefinition(METHOD_1));
    await bench.service.prepare({ requestId: 'req-a', accountId: ACCOUNT_ID, methodIds: [METHOD_1] }, TOKEN);

    // A replaced method changes the frozen guidance hash -> a different source hash -> stale.
    bench.installed.set(METHOD_1, methodDefinition(METHOD_1, '2.0.0'));
    await assert.rejects(bench.service.run({ requestId: 'req-a', accountId: ACCOUNT_ID }, TOKEN), hasCode('stale'));

    // An uninstalled method makes the capture port refuse -> the preparation is not reproducible.
    bench.installed.delete(METHOD_1);
    await assert.rejects(bench.service.run({ requestId: 'req-a', accountId: ACCOUNT_ID }, TOKEN), hasCode('stale'));

    // New account evidence (a solve and a rating refresh) moves the source hash.
    bench.installed.set(METHOD_1, methodDefinition(METHOD_1));
    bench.changeEvidence();
    await assert.rejects(bench.service.run({ requestId: 'req-a', accountId: ACCOUNT_ID }, TOKEN), hasCode('stale'));

    // A settings save between prepare and run refuses without spending.
    await bench.service.prepare({ requestId: 'req-b', accountId: ACCOUNT_ID, methodIds: [METHOD_1] }, TOKEN);
    await bench.store.saveWorkbenchSettings(settingsOf(10, 2048), 1);
    await assert.rejects(bench.service.run({ requestId: 'req-b', accountId: ACCOUNT_ID }, TOKEN), hasCode('settings'));

    assert.equal(bench.calls.length, 0, 'no refusal above reached the paid boundary');
    assert.equal(await bench.store.countAssessmentAttempts({ statuses: ASSESSMENT_ATTEMPT_CHARGED_STATUSES }), 0);
    assert.equal((await bench.statusOf('req-a'))?.status, 'prepared', 'a refused run leaves the free preparation intact');
    assert.equal((await bench.statusOf('req-b'))?.status, 'prepared');
  });
});

test('an in-flight evidence, settings, method or answer change discards the report but keeps the paid usage', async () => {
  await withBench(async (bench) => {
    bench.installed.set(METHOD_1, methodDefinition(METHOD_1));

    // Evidence moves while the paid call is in flight.
    bench.handler = async () => {
      bench.changeEvidence();
      return ok();
    };
    await bench.service.prepare({ requestId: 'req-evidence', accountId: ACCOUNT_ID, methodIds: [METHOD_1] }, TOKEN);
    await bench.service.run({ requestId: 'req-evidence', accountId: ACCOUNT_ID }, TOKEN);

    // Settings move while another paid call is in flight.
    bench.handler = async () => {
      await bench.store.saveWorkbenchSettings(settingsOf(10, 2048), 1);
      return ok();
    };
    await bench.service.prepare({ requestId: 'req-settings', accountId: ACCOUNT_ID, methodIds: [METHOD_1] }, TOKEN);
    await bench.service.run({ requestId: 'req-settings', accountId: ACCOUNT_ID }, TOKEN);

    // The selected method disappears while the paid call is in flight.
    bench.handler = async () => {
      bench.installed.delete(METHOD_1);
      return ok();
    };
    await bench.service.prepare({ requestId: 'req-method', accountId: ACCOUNT_ID, methodIds: [METHOD_1] }, TOKEN);
    await bench.service.run({ requestId: 'req-method', accountId: ACCOUNT_ID }, TOKEN);
    // The install is restored only after that settlement wrote its terminal row.
    const method = await bench.waitForTerminal('req-method');

    // The generator returns a structurally invalid answer for this capture.
    bench.installed.set(METHOD_1, methodDefinition(METHOD_1));
    bench.handler = async () => ok({ summary: 'not a valid report' });
    await bench.service.prepare({ requestId: 'req-malformed', accountId: ACCOUNT_ID, methodIds: [METHOD_1] }, TOKEN);
    await bench.service.run({ requestId: 'req-malformed', accountId: ACCOUNT_ID }, TOKEN);

    const evidence = await bench.waitForTerminal('req-evidence');
    const settings = await bench.waitForTerminal('req-settings');
    const malformed = await bench.waitForTerminal('req-malformed');
    for (const view of [evidence, settings, method]) {
      assert.equal(view.status, 'settled', `${view.requestId} should settle`);
      assert.equal(view.report, null, `${view.requestId}: a stale answer is never stored as a report`);
      assert.deepEqual(view.usage, USAGE, `${view.requestId}: the usage the provider reported is retained`);
      assert.equal(view.error?.code, 'provider_error', `${view.requestId}: the refusal is sanitized`);
      assert.equal(view.settlementFailure, null);
    }
    assert.equal(malformed.status, 'settled');
    assert.equal(malformed.report, null);
    assert.deepEqual(malformed.usage, USAGE);
    assert.equal(malformed.error?.code, 'invalid_output');
    assert.equal(bench.calls.length, 4);
    assert.equal(await bench.store.countAssessmentAttempts({ statuses: ASSESSMENT_ATTEMPT_CHARGED_STATUSES }), 4);
  });
});

test('cancellation before dispatch is known-zero; after dispatch it keeps the reported or unknown usage', async () => {
  await withBench(async (bench) => {
    bench.installed.set(METHOD_1, methodDefinition(METHOD_1));

    // A free preparation can be cancelled for nothing.
    await bench.service.prepare({ requestId: 'req-prepared', accountId: ACCOUNT_ID, methodIds: [METHOD_1] }, TOKEN);
    const cancelled = await bench.service.cancel({ requestId: 'req-prepared', accountId: ACCOUNT_ID }, TOKEN);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.usage?.calls, 0);
    assert.equal(cancelled.error?.code, 'cancelled');
    assert.equal(await bench.store.countAssessmentAttempts({ statuses: ASSESSMENT_ATTEMPT_CHARGED_STATUSES }), 0);
    const repeated = await bench.service.cancel({ requestId: 'req-prepared', accountId: ACCOUNT_ID }, TOKEN);
    assert.deepEqual(repeated, cancelled, 'repeated cancellation is idempotent');
    assert.equal(bench.calls.length, 0);

    // After dispatch with known usage: the model reports the cancellation and the cost is recorded.
    bench.handler = (request) =>
      new Promise((resolve) => {
        request.token.onCancel(() => resolve(fail('cancelled', USAGE)));
      });
    await bench.service.prepare({ requestId: 'req-known', accountId: ACCOUNT_ID, methodIds: [METHOD_1] }, TOKEN);
    const running = await bench.service.run({ requestId: 'req-known', accountId: ACCOUNT_ID }, TOKEN);
    assert.equal(running.attempt.status, 'reserved');
    await bench.service.cancel({ requestId: 'req-known', accountId: ACCOUNT_ID }, TOKEN);
    const known = await bench.waitForTerminal('req-known');
    assert.equal(known.status, 'settled');
    assert.deepEqual(known.usage, USAGE);
    assert.equal(known.report, null);
    assert.equal(known.error?.code, 'cancelled');
    assert.equal('message' in (known.error ?? {}), false, 'a provider message never reaches the view');

    // After dispatch with unknown usage: uncertain, and the charged slot is retained.
    bench.handler = (request) =>
      new Promise((resolve) => {
        request.token.onCancel(() => resolve(fail('cancelled', null)));
      });
    await bench.service.prepare({ requestId: 'req-unknown', accountId: ACCOUNT_ID, methodIds: [METHOD_1] }, TOKEN);
    await bench.service.run({ requestId: 'req-unknown', accountId: ACCOUNT_ID }, TOKEN);
    await bench.service.cancel({ requestId: 'req-unknown', accountId: ACCOUNT_ID }, TOKEN);
    const unknown = await bench.waitForTerminal('req-unknown');
    assert.equal(unknown.status, 'uncertain');
    assert.equal(unknown.usage, null, 'unknown usage is never fabricated as zero');
    assert.equal(await bench.store.countAssessmentAttempts({ statuses: ASSESSMENT_ATTEMPT_CHARGED_STATUSES }), 2);

    // Cancelling someone else's request id is not found, without disclosing its contents.
    await assert.rejects(
      bench.service.cancel({ requestId: 'req-known', accountId: OTHER_ACCOUNT_ID }, TOKEN),
      hasCode('not_found'),
    );
  });
});

test('an expired reservation is recovered as uncertain with its charged slot, and the late answer never rewrites it', async () => {
  await withBench(async (bench) => {
    bench.installed.set(METHOD_1, methodDefinition(METHOD_1));
    const held = deferred<ModelCallResult<AssessmentGenerationOutcome>>();
    bench.handler = () => held.promise;
    await bench.service.prepare({ requestId: 'req-expired', accountId: ACCOUNT_ID, methodIds: [METHOD_1] }, TOKEN);
    const running = await bench.service.run({ requestId: 'req-expired', accountId: ACCOUNT_ID }, TOKEN);
    assert.equal(running.attempt.status, 'reserved');
    assert.equal(bench.calls.length, 1);

    // An hour later the lease is long expired: restart recovery makes it terminal, never refunded.
    bench.clock = LATER;
    const recovered = await bench.service.recoverExpiredReservations(TOKEN);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.status, 'uncertain');
    assert.equal(recovered[0]?.error?.code, 'timeout');
    assert.equal(recovered[0]?.usage, null);
    assert.equal(
      await bench.store.countAssessmentAttempts({ statuses: ASSESSMENT_ATTEMPT_CHARGED_STATUSES }),
      1,
      'an expired reservation keeps its charged slot',
    );

    // The orphaned call finally answers: a terminal row is immutable, so nothing is overwritten.
    held.resolve(ok());
    const report = await bench.service.close();
    assert.deepEqual(report.failures, []);
    const after = await bench.statusOf('req-expired');
    assert.equal(after?.status, 'uncertain');
    assert.equal(after?.report, null);
    assert.equal(bench.calls.length, 1);
  });
});

test('history is account-scoped, cursored and keeps a report whose method was uninstalled', async () => {
  await withBench(async (bench) => {
    bench.installed.set(METHOD_1, methodDefinition(METHOD_1));
    bench.handler = async () => ok();
    await bench.service.prepare({ requestId: 'req-h1', accountId: ACCOUNT_ID, methodIds: [METHOD_1] }, TOKEN);
    await bench.service.run({ requestId: 'req-h1', accountId: ACCOUNT_ID }, TOKEN);
    const settled = await bench.waitForTerminal('req-h1');
    assert.equal(settled.report?.source, 'ai_inferred');

    bench.clock = '2026-11-01T08:30:00.000Z';
    await bench.service.prepare({ requestId: 'req-h2', accountId: ACCOUNT_ID, methodIds: [METHOD_1] }, TOKEN);
    bench.installed.delete(METHOD_1);

    assert.equal(MAX_ASSESSMENT_HISTORY_LIMIT, 20);
    const page = await bench.service.history({ accountId: ACCOUNT_ID, limit: 1 }, TOKEN);
    assert.deepEqual(page.items.map((item) => item.requestId), ['req-h2']);
    assert.notEqual(page.nextCursor, null);
    const next = await bench.service.history({ accountId: ACCOUNT_ID, limit: 1, cursor: page.nextCursor }, TOKEN);
    assert.deepEqual(next.items.map((item) => item.requestId), ['req-h1']);
    assert.equal(next.nextCursor, null);
    assert.equal(next.items[0]?.report?.evidenceHash, settled.report?.evidenceHash);
    assert.equal(next.items[0]?.report?.report.summary, makeReport()['summary']);
    assert.deepEqual(next.items[0]?.methodIds, [METHOD_1], 'the frozen selection survives an uninstall');

    assert.deepEqual((await bench.service.history({ accountId: OTHER_ACCOUNT_ID }, TOKEN)).items, []);
    await assert.rejects(
      bench.service.history({ accountId: ACCOUNT_ID, limit: MAX_ASSESSMENT_HISTORY_LIMIT + 1 }, TOKEN),
      hasCode('invalid_request'),
    );
    await assert.rejects(
      bench.service.history({ accountId: ACCOUNT_ID, status: 'nonsense' as never }, TOKEN),
      hasCode('invalid_request'),
    );
  });
});

test('close drains owned calls and stops admission; a failed settlement leaves the charged reservation observable', async () => {
  await withBench(async (bench) => {
    bench.installed.set(METHOD_1, methodDefinition(METHOD_1));
    bench.handler = (request) =>
      new Promise((resolve) => {
        request.token.onCancel(() => resolve(fail('cancelled', USAGE)));
      });
    await bench.service.prepare({ requestId: 'req-drain', accountId: ACCOUNT_ID, methodIds: [METHOD_1] }, TOKEN);
    await bench.service.run({ requestId: 'req-drain', accountId: ACCOUNT_ID }, TOKEN);

    const report = await bench.service.close();
    assert.deepEqual(report.failures, []);
    const drained = await bench.statusOf('req-drain');
    assert.equal(drained?.status, 'settled');
    assert.deepEqual(drained?.usage, USAGE, 'close waits for the owned settlement');

    await assert.rejects(
      bench.service.prepare({ requestId: 'req-late', accountId: ACCOUNT_ID, methodIds: [METHOD_1] }, TOKEN),
      hasCode('closing'),
    );
    await assert.rejects(bench.service.run({ requestId: 'req-drain', accountId: ACCOUNT_ID }, TOKEN), hasCode('closing'));
    await assert.rejects(
      bench.service.recoverExpiredReservations(TOKEN),
      hasCode('closing'),
    );
    assert.deepEqual(await bench.service.close(), report, 'repeated close returns the first drain report');
    assert.equal((await bench.statusOf('req-drain'))?.status, 'settled', 'reads still work after close');
  });

  await withBench(async (bench) => {
    bench.installed.set(METHOD_1, methodDefinition(METHOD_1));
    bench.handler = async () => ok();
    bench.failSettlements = true;
    await bench.service.prepare({ requestId: 'req-fail', accountId: ACCOUNT_ID, methodIds: [METHOD_1] }, TOKEN);
    const running = await bench.service.run({ requestId: 'req-fail', accountId: ACCOUNT_ID }, TOKEN);
    assert.equal(running.attempt.status, 'reserved');

    const failed = await bench.waitForView(
      'req-fail',
      (view) => view.settlementFailure !== null,
      'the failed settlement to become observable',
    );
    assert.equal(failed.status, 'reserved', 'the durable row is still the charged reservation');
    assert.equal(failed.report, null, 'a failed settlement is never marked successful');
    assert.equal(failed.usage, null);
    assert.equal(bench.calls.length, 1);

    const report = await bench.service.close();
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0]?.requestId, 'req-fail');
    assert.equal(report.failures[0]?.code, 'settlement_failed');
    assert.equal(bench.calls.length, 1, 'a failed settlement is never re-dispatched');
    assert.equal(
      await bench.store.countAssessmentAttempts({ statuses: ASSESSMENT_ATTEMPT_CHARGED_STATUSES }),
      1,
      'the charged reservation is retained for recovery',
    );
    assert.equal((await bench.statusOf('req-fail'))?.settlementFailure?.code, 'settlement_failed');
  });
});
