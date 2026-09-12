/**
 * Progressive coaching service over a real SQLite store.
 *
 * Every case drives the real `CoachingService` with a scripted local generator and a real
 * `SqliteTrainingStore`; nothing here reaches a model, a platform or a paid API. The assertions
 * are about the externally meaningful protocol: one reservation per paid call (observed at the
 * generator boundary, outside any transaction), idempotent request ids, the plugin-wide rolling
 * quota and single-flight, level progression, a missing statement that costs nothing, durable
 * settlement when the user cancels, head changes that discard an answer, expired-lease recovery
 * that never refunds quota, account scoping, and spoiler discipline in history/getStatus.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore, StorageError } from '../../src/adapters/sqlite/index.js';
import {
  COACHING_LEASE_MARGIN_MS,
  CoachingService,
  CoachingServiceError,
  MAX_COACHING_REQUEST_ID_CHARS,
  type CoachingAnsweredView,
  type CoachingAskRequest,
  type CoachingAskResult,
  type CoachingHistoryResult,
  type CoachingInternalErrorReport,
  type CoachingUnansweredView,
} from '../../src/application/coaching-service.js';
import type {
  CoachingGenerationOutcome,
  CoachingGenerationRequest,
  CoachingGenerator,
} from '../../src/application/coaching-generation.js';
import type { CoachingAttempt, CoachingAttemptQuery, CoachingLevel } from '../../src/application/coaching-types.js';
import type { ModelCallResult, ModelErrorCode, Page } from '../../src/application/ports.js';
import { defaultWorkbenchSettings } from '../../src/application/workbench-settings.js';
import {
  createCancellationSource,
  createModelUsage,
  createNormalizedProblem,
  createProblemSnapshot,
  type Account,
  type CancellationToken,
  type ModelUsage,
  type NormalizedProblem,
  type ProblemSnapshot,
  type SourceInstance,
} from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';

const AT = '2026-10-01T08:00:00.000Z';
const LATER = '2026-10-01T09:00:00.000Z';
/** Default reservation lifetime: the configured 180s request timeout plus the safety margin. */
const LEASE_MS = 180_000 + COACHING_LEASE_MARGIN_MS;
const HINT_1 = '先想清楚一次区间修改会影响哪些节点，不要急着写代码。';
const HINT_2 = '关键不变量：每个节点维护自身区间和与待下传的加法标记。';
const USAGE = createModelUsage({ calls: 1, promptTokens: 120, completionTokens: 40 });
/** A token nobody cancels: the "normal caller" of most cases. */
const TOKEN = createCancellationSource().token;

function ok(text: string = HINT_1, usage: ModelUsage = USAGE): ModelCallResult<CoachingGenerationOutcome> {
  return { ok: true, value: { text }, usage, callId: 'call-1', sessionId: 'session-1' };
}

function fail(code: ModelErrorCode, usage: ModelUsage | null): ModelCallResult<CoachingGenerationOutcome> {
  return {
    ok: false,
    error: { code, message: `the model reported ${code}`, retryable: code === 'timeout' || code === 'rate_limited' },
    usage,
    callId: 'call-1',
  };
}

interface World {
  readonly instance: SourceInstance;
  readonly account: Account;
  readonly problem: NormalizedProblem;
  readonly snapshot: ProblemSnapshot;
}

function makeWorld(externalKey = '1234A'): World {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', externalKey);
  return {
    instance: scope.instance,
    account: scope.account,
    problem: scope.problem,
    snapshot: fx.makeSnapshot(scope.problem),
  };
}

async function seed(bench: Bench, world: World): Promise<void> {
  await bench.store.upsertSourceInstances([world.instance]);
  await bench.store.upsertAccounts([world.account]);
  await bench.store.upsertProblems([world.problem]);
  await bench.store.saveSnapshot(world.snapshot);
}

function askRequest(world: World, overrides: Partial<CoachingAskRequest> = {}): CoachingAskRequest {
  return { requestId: 'req-1', accountId: world.account.id, problemKey: world.problem.key, level: 1, ...overrides };
}

/** A valid reservation written directly, for cases about recovery and bounded walks. */
function reservedAttempt(world: World, id: string, at: string): CoachingAttempt {
  return {
    id,
    accountId: world.account.id,
    problemKey: world.problem.key,
    snapshotId: world.snapshot.snapshotId,
    level: 1,
    requestedAt: at,
    expiresAt: new Date(Date.parse(at) + LEASE_MS).toISOString(),
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
}

function answered(result: CoachingAskResult): CoachingAnsweredView {
  if (result.status !== 'answered') {
    assert.fail(`expected an answered result, got ${result.status} (${result.error.code}: ${result.error.message})`);
  }
  return result;
}

function unanswered(result: CoachingAskResult): CoachingUnansweredView {
  if (result.status === 'answered') {
    assert.fail('expected a non-answered result');
  }
  return result;
}

function found(result: Awaited<ReturnType<CoachingService['getStatus']>>) {
  if (result.status !== 'found') {
    assert.fail(`expected a found attempt, got ${result.status}`);
  }
  return result.attempt;
}

const conflict = (error: unknown): boolean =>
  error instanceof CoachingServiceError && error.code === 'request_conflict';
const invalidRequest = (error: unknown): boolean =>
  error instanceof CoachingServiceError && error.code === 'invalid_request';

/** Service + real store + scripted generator; the generator records the paid boundary. */
class Bench {
  readonly paths = fx.tempDatabase();
  clock = AT;
  readonly calls: CoachingGenerationRequest[] = [];
  readonly internalErrors: CoachingInternalErrorReport[] = [];
  readonly atDispatch: { readonly reservation: CoachingAttempt | null; readonly nestedTransaction: string | null }[] = [];
  handler: (request: CoachingGenerationRequest) => Promise<ModelCallResult<CoachingGenerationOutcome>> = async () => ok();
  readonly store: SqliteTrainingStore;
  readonly service: CoachingService;

  constructor(
    options: { readonly maxHistoryScan?: number; readonly store?: (path: string, now: () => string) => SqliteTrainingStore } = {},
  ) {
    const now = () => this.clock;
    this.store = options.store
      ? options.store(this.paths.path, now)
      : new SqliteTrainingStore({ path: this.paths.path, now });
    const generator: CoachingGenerator = {
      generate: async (request) => {
        this.calls.push(request);
        const reservation = await this.store.getCoachingAttempt(request.attemptId);
        let nestedTransaction: string | null = null;
        try {
          // The service must not hold a store transaction across the model call; a nested
          // transaction here would fail loudly.
          await this.store.transaction(async () => undefined);
        } catch (error) {
          nestedTransaction = error instanceof StorageError ? error.code : String(error);
        }
        this.atDispatch.push({ reservation, nestedTransaction });
        return this.handler(request);
      },
    };
    this.service = new CoachingService({
      store: this.store,
      generator,
      now,
      onInternalError: (report) => {
        this.internalErrors.push(report);
      },
      ...(options.maxHistoryScan === undefined ? {} : { maxHistoryScan: options.maxHistoryScan }),
    });
  }

  async close(): Promise<void> {
    await this.store.close();
    fx.removeDirectory(this.paths.dir);
  }
}

// ---------------------------------------------------------------------------------------
// Reservation, dispatch and identity
// ---------------------------------------------------------------------------------------

void test('one ask reserves before dispatch, answers once and records the configured identity', async () => {
  const bench = new Bench();
  const world = makeWorld();
  try {
    await seed(bench, world);

    const result = answered(await bench.service.ask(askRequest(world), TOKEN));

    assert.equal(result.text, HINT_1);
    assert.deepEqual(result.usage, USAGE);
    assert.equal(result.attemptId, 'req-1');
    assert.equal(result.snapshotId, world.snapshot.snapshotId);
    assert.equal(result.snapshotState, 'current');
    assert.equal(result.verification, 'unverified_ai');
    assert.equal(result.finishedAt, AT);

    assert.equal(bench.calls.length, 1);
    const sent = bench.calls[0];
    assert.ok(sent);
    assert.equal(sent.level, 1);
    assert.equal(sent.provider, 'deepseek-official');
    assert.equal(sent.model, 'deepseek-flash');
    assert.equal(sent.maxOutputTokens, 65_536);
    assert.equal(sent.requestTimeoutMs, 180_000);
    assert.equal(sent.effort, 'max');
    assert.equal(sent.attemptId, 'req-1');
    assert.equal(sent.promptVersion, 'coaching-v1');
    assert.equal(sent.explicitFullSolution, false);
    assert.deepEqual(sent.previousHints, []);

    // The durable reservation exists before the call and no transaction spans the dispatch.
    const observed = bench.atDispatch[0];
    assert.ok(observed);
    assert.equal(observed.nestedTransaction, null);
    assert.equal(observed.reservation?.status, 'reserved');
    assert.equal(observed.reservation?.accountId, world.account.id);
    assert.equal(observed.reservation?.expiresAt, new Date(Date.parse(AT) + LEASE_MS).toISOString());

    const stored = await bench.store.getCoachingAttempt('req-1');
    assert.equal(stored?.status, 'settled');
    assert.deepEqual(stored?.usage, USAGE);
    assert.equal(stored?.hostCallId, 'call-1');
    assert.equal(stored?.hostSessionId, 'session-1');
    assert.equal(await bench.store.countCoachingAttempts({}), 1);

    // The result is plain JSON data for the future API.
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  } finally {
    await bench.close();
  }
});

void test('a repeated requestId returns the settled attempt and never pays twice', async () => {
  const bench = new Bench();
  const world = makeWorld();
  try {
    await seed(bench, world);
    const first = answered(await bench.service.ask(askRequest(world), TOKEN));
    const second = answered(await bench.service.ask(askRequest(world), TOKEN));
    assert.deepEqual(second, first);
    assert.equal(bench.calls.length, 1);
    assert.equal(await bench.store.countCoachingAttempts({}), 1);

    // The same id with a different identity is rejected, not paid for and not re-labelled.
    await assert.rejects(bench.service.ask(askRequest(world, { level: 2 }), TOKEN), conflict);
    await assert.rejects(bench.service.ask(askRequest(world, { accountId: null }), TOKEN), conflict);
    const otherProblem = fx.makeProblem(fx.makeRef(world.instance, '2B'));
    await assert.rejects(
      bench.service.ask({ ...askRequest(world), problemKey: otherProblem.key }, TOKEN),
      conflict,
    );
    assert.equal(bench.calls.length, 1);
    assert.equal(await bench.store.countCoachingAttempts({}), 1);
  } finally {
    await bench.close();
  }
});

void test('hint levels need the earlier settled hints of the current snapshot and forward them', async () => {
  const bench = new Bench();
  const world = makeWorld();
  try {
    await seed(bench, world);

    const early = unanswered(await bench.service.ask(askRequest(world, { requestId: 'req-2', level: 2 }), TOKEN));
    assert.equal(early.status, 'refused');
    assert.equal(early.error.code, 'level_not_earned');
    assert.equal(early.attemptId, null);
    assert.equal(bench.calls.length, 0, 'an unearned level is refused before dispatch');

    const level1 = answered(await bench.service.ask(askRequest(world, { requestId: 'req-1' }), TOKEN));
    bench.handler = async () => ok(HINT_2);
    const level2 = answered(await bench.service.ask(askRequest(world, { requestId: 'req-2', level: 2 }), TOKEN));
    assert.equal(level2.text, HINT_2);
    assert.deepEqual(bench.calls[1]?.previousHints, [{ level: 1, text: level1.text }]);

    bench.handler = async () => ok('伪代码：update(node, l, r) { ... }');
    const level3 = answered(await bench.service.ask(askRequest(world, { requestId: 'req-3', level: 3 }), TOKEN));
    assert.match(level3.text, /伪代码/);
    assert.deepEqual(bench.calls[2]?.previousHints, [
      { level: 1, text: level1.text },
      { level: 2, text: level2.text },
    ]);
  } finally {
    await bench.close();
  }
});

void test("level 'full' needs the explicit flag and may skip the hint ladder", async () => {
  const bench = new Bench();
  const world = makeWorld();
  try {
    await seed(bench, world);

    const withoutFlag = unanswered(
      await bench.service.ask(askRequest(world, { requestId: 'full-1', level: 'full' }), TOKEN),
    );
    assert.equal(withoutFlag.status, 'refused');
    assert.equal(withoutFlag.error.code, 'full_solution_not_requested');
    assert.equal(bench.calls.length, 0, 'a non-explicit full request costs nothing');

    await assert.rejects(
      bench.service.ask(askRequest(world, { requestId: 'full-2', level: 1, explicitFullSolution: true }), TOKEN),
      invalidRequest,
    );

    bench.handler = async () => ok(`${HINT_1}\n\n\`\`\`cpp\n// C++17\n\`\`\``);
    const full = answered(
      await bench.service.ask(
        askRequest(world, { requestId: 'full-1', level: 'full', explicitFullSolution: true }),
        TOKEN,
      ),
    );
    assert.equal(full.level, 'full');
    assert.equal(bench.calls.length, 1);
    assert.equal(bench.calls[0]?.explicitFullSolution, true);
    assert.deepEqual(bench.calls[0]?.previousHints, [], 'full may be requested directly');
  } finally {
    await bench.close();
  }
});

// ---------------------------------------------------------------------------------------
// Quota, single-flight and cost accounting
// ---------------------------------------------------------------------------------------

void test('the rolling global quota refuses before dispatch and settings are captured per reservation', async () => {
  const bench = new Bench();
  const world = makeWorld();
  try {
    await seed(bench, world);
    const base = defaultWorkbenchSettings();
    await bench.store.saveWorkbenchSettings(
      {
        ...base,
        provider: 'cfg-provider',
        coaching: { ...base.coaching, model: 'cfg-coach', maxCallsPer24Hours: 2 },
      },
      null,
    );

    answered(await bench.service.ask(askRequest(world, { requestId: 'q1' }), TOKEN));
    assert.equal(bench.calls[0]?.provider, 'cfg-provider');
    assert.equal(bench.calls[0]?.model, 'cfg-coach');
    answered(await bench.service.ask(askRequest(world, { requestId: 'q2', level: 2 }), TOKEN));

    const third = unanswered(await bench.service.ask(askRequest(world, { requestId: 'q3', level: 3 }), TOKEN));
    assert.equal(third.status, 'refused');
    assert.equal(third.error.code, 'coaching_quota_exhausted');
    assert.equal(third.error.retryable, true);
    assert.equal(bench.calls.length, 2, 'a quota refusal never dispatches');
    assert.equal(await bench.store.countCoachingAttempts({}), 2);

    const stored = await bench.store.getCoachingAttempt('q1');
    assert.equal(stored?.provider, 'cfg-provider');
    assert.equal(stored?.model, 'cfg-coach');
    assert.equal(stored?.promptVersion, 'coaching-v1');
  } finally {
    await bench.close();
  }
});

void test('two concurrent asks dispatch one paid call and the second is refused as busy', async () => {
  const bench = new Bench();
  const world = makeWorld();
  try {
    await seed(bench, world);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    bench.handler = async () => {
      started();
      await gate;
      return ok();
    };

    const first = bench.service.ask(askRequest(world, { requestId: 'c1' }), TOKEN);
    await startedPromise;
    const second = unanswered(await bench.service.ask(askRequest(world, { requestId: 'c2' }), TOKEN));
    assert.equal(second.status, 'refused');
    assert.equal(second.error.code, 'concurrent_call_active');
    assert.equal(second.error.retryable, true);

    release();
    assert.equal(answered(await first).text, HINT_1);
    assert.equal(bench.calls.length, 1, 'the reservation is the single-flight lock');
    assert.equal(await bench.store.countCoachingAttempts({}), 1);
  } finally {
    await bench.close();
  }
});

void test('unknown usage settles uncertain, counts against quota and never auto-retries', async () => {
  const bench = new Bench();
  const world = makeWorld();
  try {
    await seed(bench, world);
    bench.handler = async () => fail('timeout', null);

    const first = unanswered(await bench.service.ask(askRequest(world), TOKEN));
    assert.equal(first.status, 'uncertain');
    assert.equal(first.error.code, 'timeout');
    assert.equal(first.usage, null);
    assert.equal(bench.calls.length, 1);

    const stored = await bench.store.getCoachingAttempt('req-1');
    assert.equal(stored?.status, 'uncertain');
    assert.equal(stored?.usage, null);
    assert.equal(stored?.error?.code, 'timeout');
    assert.equal(await bench.store.countCoachingAttempts({}), 1, 'unknown usage is never free');

    const repeat = unanswered(await bench.service.ask(askRequest(world), TOKEN));
    assert.equal(repeat.status, 'uncertain');
    assert.equal(bench.calls.length, 1, 'an uncertain request is never retried automatically');

    const history = await bench.service.history({ accountId: world.account.id, problemKey: world.problem.key }, TOKEN);
    assert.equal(history.items[0]?.status, 'uncertain');
    assert.deepEqual(history.items[0]?.error, { code: 'timeout', retryable: true });
  } finally {
    await bench.close();
  }
});

void test('a known-usage failure settles, counts and stays metadata-only in history', async () => {
  const bench = new Bench();
  const world = makeWorld();
  try {
    await seed(bench, world);
    bench.handler = async () => fail('rate_limited', USAGE);

    const result = unanswered(await bench.service.ask(askRequest(world), TOKEN));
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'rate_limited');
    assert.deepEqual(result.usage, USAGE);

    const stored = await bench.store.getCoachingAttempt('req-1');
    assert.equal(stored?.status, 'settled');
    assert.equal(stored?.responseText, null);
    assert.deepEqual(stored?.usage, USAGE);
    assert.equal(await bench.store.countCoachingAttempts({}), 1);

    const history = await bench.service.history({ accountId: world.account.id, problemKey: world.problem.key }, TOKEN);
    const entry = history.items[0];
    assert.ok(entry);
    assert.equal(entry.status, 'settled');
    assert.deepEqual(entry.usage, USAGE);
    assert.deepEqual(entry.error, { code: 'rate_limited', retryable: true });
    assert.equal('responseText' in entry, false);
    assert.equal(entry.error !== null && 'message' in entry.error, false, 'history hides provider error internals');
  } finally {
    await bench.close();
  }
});

void test('a thrown generator exception is recorded sanitized and never echoed by ask, history or status', async () => {
  const bench = new Bench();
  const world = makeWorld();
  const SECRET = 'sk-live-9f4c-SENTINEL-SECRET';
  const SECRET_PATH = 'C:\\Users\\alice\\.dsh\\credentials.json';
  try {
    await seed(bench, world);
    bench.handler = async () => {
      throw new Error(`provider rejected the call: Authorization: Bearer ${SECRET} (loaded from ${SECRET_PATH})`);
    };

    const first = unanswered(await bench.service.ask(askRequest(world), TOKEN));
    assert.equal(first.status, 'uncertain');
    assert.equal(first.usage, null);
    assert.equal(first.error.code, 'provider_error');
    const firstJson = JSON.stringify(first);
    assert.equal(firstJson.includes(SECRET), false, 'the ask result never echoes the raw exception');
    assert.equal(firstJson.includes(SECRET_PATH), false);

    const dedup = unanswered(await bench.service.ask(askRequest(world), TOKEN));
    assert.equal(dedup.status, 'uncertain');
    assert.equal(dedup.usage, null);
    const dedupJson = JSON.stringify(dedup);
    assert.equal(dedupJson.includes(SECRET), false);
    assert.equal(dedupJson.includes(SECRET_PATH), false);

    const stored = await bench.store.getCoachingAttempt('req-1');
    assert.equal(stored?.status, 'uncertain');
    assert.equal(stored?.usage, null);
    assert.equal(stored?.hostCallId, null, 'a thrown call invents no host correlation');
    const storedJson = JSON.stringify(stored);
    assert.equal(storedJson.includes(SECRET), false, 'the durable row stays sanitized');
    assert.equal(storedJson.includes(SECRET_PATH), false);

    const historyJson = JSON.stringify(
      await bench.service.history({ accountId: world.account.id, problemKey: world.problem.key }, TOKEN),
    );
    assert.equal(historyJson.includes(SECRET), false);
    const statusJson = JSON.stringify(
      await bench.service.getStatus('req-1', world.account.id, world.problem.key, TOKEN),
    );
    assert.equal(statusJson.includes(SECRET), false);
    assert.equal(statusJson.includes(SECRET_PATH), false);

    // Exactly one attempt, still on the quota books; the raw value only reached the local hook.
    assert.equal(bench.calls.length, 1, 'an unknown outcome is never retried automatically');
    assert.equal(await bench.store.countCoachingAttempts({}), 1);
    const report = bench.internalErrors[0];
    assert.ok(report);
    assert.equal(report.attemptId, 'req-1');
    assert.equal(report.code, 'provider_error');
    const raw = report.error;
    assert.ok(raw instanceof Error);
    assert.match(raw.message, /SENTINEL-SECRET/);
  } finally {
    await bench.close();
  }
});

// ---------------------------------------------------------------------------------------
// Cancellation, staleness and recovery
// ---------------------------------------------------------------------------------------

void test('a cancellation during the call keeps the paid audit and shows nothing', async () => {
  const bench = new Bench();
  const world = makeWorld();
  try {
    await seed(bench, world);
    const source = createCancellationSource();
    bench.handler = async () => {
      source.cancel('user cancelled while the model was answering');
      return ok();
    };

    const result = unanswered(await bench.service.ask(askRequest(world), source.token));
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'cancelled');
    assert.equal('text' in result, false);

    const stored = await bench.store.getCoachingAttempt('req-1');
    assert.equal(stored?.status, 'settled');
    assert.equal(stored?.responseText, null, 'a cancelled answer is never stored as a delivered result');
    assert.equal(stored?.error?.code, 'cancelled');
    assert.deepEqual(stored?.usage, USAGE, 'the paid usage is preserved');
    assert.equal(await bench.store.countCoachingAttempts({}), 1);

    // A token cancelled before the request writes nothing at all.
    const pre = createCancellationSource();
    pre.cancel('already gone');
    const refusedResult = unanswered(await bench.service.ask(askRequest(world, { requestId: 'pre-1' }), pre.token));
    assert.equal(refusedResult.status, 'refused');
    assert.equal(refusedResult.error.code, 'cancelled');
    assert.equal(refusedResult.attemptId, null);
    assert.equal(await bench.store.getCoachingAttempt('pre-1'), null);
    assert.equal(await bench.store.countCoachingAttempts({}), 1);
  } finally {
    await bench.close();
  }
});

void test('a cancellation racing after the settlement commit hides the return but keeps immutable history', async () => {
  const world = makeWorld();
  const source = createCancellationSource();
  class CancellingStore extends SqliteTrainingStore {
    override async saveCoachingAttempt(attempt: CoachingAttempt): Promise<void> {
      await super.saveCoachingAttempt(attempt);
      if (attempt.status === 'settled' && attempt.responseText !== null) {
        source.cancel('user cancelled while the answer was being committed');
      }
    }
  }
  const bench = new Bench({ store: (path, now) => new CancellingStore({ path, now }) });
  try {
    await seed(bench, world);

    const result = unanswered(await bench.service.ask(askRequest(world), source.token));
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'cancelled');
    assert.equal('text' in result, false, 'a cancelled return never leaks the hidden answer');
    assert.deepEqual(result.usage, USAGE);

    // The paid row is immutable history: an explicit later read with a fresh token still finds it.
    const attempt = found(
      await bench.service.getStatus('req-1', world.account.id, world.problem.key, TOKEN, {
        includeResponseText: true,
      }),
    );
    assert.equal(attempt.status, 'settled');
    assert.equal(attempt.responseText, HINT_1);
    assert.equal(attempt.snapshotState, 'current');
    assert.equal(await bench.store.countCoachingAttempts({}), 1);
  } finally {
    await bench.close();
  }
});

void test('a head change during the call settles the cost as stale and discards the answer', async () => {
  const bench = new Bench();
  const world = makeWorld();
  try {
    await seed(bench, world);
    const changed = fx.makeProblem(world.problem.ref, {
      statement: 'The statement was rewritten while the hint was generated.',
    });
    const next = fx.makeSnapshot(changed, { previous: world.snapshot, capturedAt: LATER });
    assert.equal(next.version, 2);
    bench.handler = async () => {
      await bench.store.saveSnapshot(next);
      return ok();
    };

    const result = unanswered(await bench.service.ask(askRequest(world), TOKEN));
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'stale_snapshot');
    assert.equal(result.snapshotState, 'stale');
    assert.equal('text' in result, false);
    assert.deepEqual(result.usage, USAGE, 'the paid cost is preserved');

    const stored = await bench.store.getCoachingAttempt('req-1');
    assert.equal(stored?.status, 'settled');
    assert.equal(stored?.responseText, null, 'a stale answer is never stored as a delivered result');
    assert.equal(stored?.snapshotId, world.snapshot.snapshotId);
    assert.equal(stored?.error?.code, 'provider_error');
    assert.match(String(stored?.error?.message), /discarded as stale/);

    const attempt = found(
      await bench.service.getStatus('req-1', world.account.id, world.problem.key, TOKEN, {
        includeResponseText: true,
        includeStale: true,
      }),
    );
    assert.equal(attempt.snapshotState, 'stale');
    assert.equal('responseText' in attempt, false, 'nothing was stored to reveal');
  } finally {
    await bench.close();
  }
});

void test('a head that moves after the settlement commit is projected as stale and never leaks the answer', async () => {
  const world = makeWorld();
  const changed = fx.makeProblem(world.problem.ref, { statement: 'rewritten right after the answer was settled' });
  const next = fx.makeSnapshot(changed, { previous: world.snapshot, capturedAt: LATER });
  /** Fires once, immediately after the next store transaction has committed. */
  const armed: { run: (() => Promise<void>) | null } = { run: null };
  class HeadAdvancingStore extends SqliteTrainingStore {
    override async transaction<T>(work: () => Promise<T>): Promise<T> {
      const result = await super.transaction(work);
      const hook = armed.run;
      armed.run = null;
      if (hook !== null) {
        await hook();
      }
      return result;
    }
  }
  const bench = new Bench({ store: (path, now) => new HeadAdvancingStore({ path, now }) });
  try {
    await seed(bench, world);
    // Arm inside the generator: the only transaction still to commit is the settlement itself.
    bench.handler = async () => {
      armed.run = async () => {
        await bench.store.saveSnapshot(next);
      };
      return ok();
    };

    const result = unanswered(await bench.service.ask(askRequest(world), TOKEN));
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'stale_snapshot');
    assert.equal(result.snapshotState, 'stale');
    assert.equal('text' in result, false, 'a head that moved before projection never returns the answer');
    assert.deepEqual(result.usage, USAGE, 'the settled cost is retained');
    assert.equal(bench.calls.length, 1);

    // The settled row itself is immutable history: text and cost both stayed.
    const stored = await bench.store.getCoachingAttempt('req-1');
    assert.equal(stored?.status, 'settled');
    assert.equal(stored?.responseText, HINT_1);
    assert.deepEqual(stored?.usage, USAGE);

    const repeat = unanswered(await bench.service.ask(askRequest(world), TOKEN));
    assert.equal(repeat.status, 'failed');
    assert.equal(repeat.error.code, 'stale_snapshot');
    assert.equal('text' in repeat, false);
    assert.equal(bench.calls.length, 1, 'the dedup read never pays again');

    const explicit = found(
      await bench.service.getStatus('req-1', world.account.id, world.problem.key, TOKEN, {
        includeResponseText: true,
        includeStale: true,
      }),
    );
    assert.equal(explicit.responseText, HINT_1);
    assert.equal(explicit.snapshotState, 'stale');
    assert.equal(await bench.store.countCoachingAttempts({}), 1);
  } finally {
    await bench.close();
  }
});

void test('an expired reservation is recovered as uncertain by the next reservation and quota is retained', async () => {
  const bench = new Bench();
  const world = makeWorld();
  try {
    await seed(bench, world);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    bench.handler = async () => {
      started();
      await gate;
      return ok();
    };

    const first = bench.service.ask(askRequest(world, { requestId: 'slow-1' }), TOKEN);
    await startedPromise;

    bench.clock = new Date(Date.parse(AT) + LEASE_MS + 1000).toISOString();
    bench.handler = async () => ok(HINT_2);
    const second = answered(await bench.service.ask(askRequest(world, { requestId: 'next-1' }), TOKEN));
    assert.equal(second.text, HINT_2);

    const recovered = await bench.store.getCoachingAttempt('slow-1');
    assert.equal(recovered?.status, 'uncertain');
    assert.equal(recovered?.error?.code, 'timeout');
    assert.equal(await bench.store.countCoachingAttempts({}), 2, 'recovery never refunds quota');

    // The late answer of the recovered call still settles the paid record it belongs to.
    release();
    assert.equal(answered(await first).text, HINT_1);
    assert.equal((await bench.store.getCoachingAttempt('slow-1'))?.status, 'settled');
    assert.equal(await bench.store.countCoachingAttempts({}), 2);
  } finally {
    await bench.close();
  }
});

void test('a token cancelled during reservation recovery rolls the transaction back before any dedup or refusal return', async () => {
  const world = makeWorld();
  const firstCancel = createCancellationSource();
  const secondCancel = createCancellationSource();
  class CancellingRecoveryStore extends SqliteTrainingStore {
    /** Fires once, immediately after the next expired reservation has been rewritten. */
    onRecovered: (() => void) | null = null;
    override async saveCoachingAttempt(attempt: CoachingAttempt): Promise<void> {
      await super.saveCoachingAttempt(attempt);
      if (attempt.status === 'uncertain' && attempt.error?.code === 'timeout') {
        const hook = this.onRecovered;
        this.onRecovered = null;
        hook?.();
      }
    }
  }
  const created: { store: CancellingRecoveryStore | null } = { store: null };
  const bench = new Bench({
    store: (path, now) => {
      const store = new CancellingRecoveryStore({ path, now });
      created.store = store;
      return store;
    },
  });
  try {
    await seed(bench, world);
    await bench.store.saveCoachingAttempt(reservedAttempt(world, 'old-1', AT));
    bench.clock = new Date(Date.parse(AT) + LEASE_MS + 1000).toISOString();
    const store = created.store;
    assert.ok(store);

    // Phase 1 — the dedup branch would return the expired reservation; the cancellation that lands
    // during the recovery write must roll back the recovery and the whole ask with it.
    store.onRecovered = () => firstCancel.cancel('cancelled while the expired reservation was recovered');
    const dedup = unanswered(await bench.service.ask(askRequest(world, { requestId: 'old-1' }), firstCancel.token));
    assert.equal(dedup.status, 'refused');
    assert.equal(dedup.error.code, 'cancelled');
    assert.equal(dedup.attemptId, null);
    assert.equal(bench.calls.length, 0, 'a rolled-back reservation never dispatches');
    const untouched = await bench.store.getCoachingAttempt('old-1');
    assert.equal(untouched?.status, 'reserved', 'the rolled-back recovery write left the original row untouched');
    assert.equal(untouched?.finishedAt, null);

    // Phase 2 — with a healthy token this level-3 ask is refused as `level_not_earned`; the guard
    // must beat that refusal and still leave no new row.
    store.onRecovered = () => secondCancel.cancel('cancelled while the expired reservation was recovered');
    const refusedByCancel = unanswered(
      await bench.service.ask(askRequest(world, { requestId: 'fresh-1', level: 3 }), secondCancel.token),
    );
    assert.equal(refusedByCancel.status, 'refused');
    assert.equal(refusedByCancel.error.code, 'cancelled');
    assert.equal(refusedByCancel.attemptId, null);
    assert.equal(await bench.store.getCoachingAttempt('fresh-1'), null);
    assert.equal((await bench.store.getCoachingAttempt('old-1'))?.status, 'reserved', 'recovery stayed rolled back');
    assert.equal(await bench.store.countCoachingAttempts({}), 1);
    assert.equal(bench.calls.length, 0);
  } finally {
    await bench.close();
  }
});

// ---------------------------------------------------------------------------------------
// Missing material, scope and spoilers
// ---------------------------------------------------------------------------------------

void test('a missing statement, problem or account is refused without any paid call', async () => {
  const bench = new Bench();
  try {
    const instance = fx.makeInstance('codeforces', 'codeforces.com');
    const account = fx.makeAccount(instance, 'alice');
    const ref = fx.makeRef(instance, '9001A');
    const bare = createNormalizedProblem({
      ref,
      title: 'No statement yet',
      url: 'https://codeforces.com/problemset/problem/9001/A',
      statement: null,
      fetchedAt: AT,
      ratings: [],
      rawTags: [],
    });
    await bench.store.upsertSourceInstances([instance]);
    await bench.store.upsertAccounts([account]);
    await bench.store.upsertProblems([bare]);
    await bench.store.saveSnapshot(
      createProblemSnapshot({ problem: bare, sources: [], solutions: [], capturedAt: AT }),
    );

    const missingStatement = unanswered(
      await bench.service.ask({ requestId: 'r1', accountId: account.id, problemKey: bare.key, level: 1 }, TOKEN),
    );
    assert.equal(missingStatement.status, 'refused');
    assert.equal(missingStatement.error.code, 'manual_statement_needed');
    assert.equal(missingStatement.attemptId, null);

    const unknownProblem = unanswered(
      await bench.service.ask(
        { requestId: 'r2', accountId: null, problemKey: fx.keyOf(fx.makeRef(instance, '404A')), level: 1 },
        TOKEN,
      ),
    );
    assert.equal(unknownProblem.error.code, 'unknown_problem');

    const unknownAccount = unanswered(
      await bench.service.ask({ requestId: 'r3', accountId: 'codeforces:codeforces.com|nobody', problemKey: bare.key, level: 1 }, TOKEN),
    );
    assert.equal(unknownAccount.error.code, 'unknown_account');

    assert.equal(bench.calls.length, 0);
    assert.equal(await bench.store.countCoachingAttempts({}), 0);
  } finally {
    await bench.close();
  }
});

void test('account scope keeps anonymous and named attempts apart while quota stays global', async () => {
  const bench = new Bench();
  const world = makeWorld();
  try {
    await seed(bench, world);

    answered(
      await bench.service.ask(
        { requestId: 'anon-1', accountId: null, problemKey: world.problem.key, level: 1 },
        TOKEN,
      ),
    );
    const namedLevel2 = unanswered(await bench.service.ask(askRequest(world, { requestId: 'named-1', level: 2 }), TOKEN));
    assert.equal(namedLevel2.error.code, 'level_not_earned', 'the named scope does not see the anonymous hint');

    answered(
      await bench.service.ask(
        { requestId: 'anon-2', accountId: null, problemKey: world.problem.key, level: 2 },
        TOKEN,
      ),
    );
    assert.deepEqual(bench.calls[1]?.previousHints, [{ level: 1, text: HINT_1 }]);

    const anonymous = await bench.service.history(
      { accountId: null, problemKey: world.problem.key },
      TOKEN,
    );
    assert.deepEqual(
      anonymous.items.map((item) => item.attemptId),
      ['anon-1', 'anon-2'],
    );
    const named = await bench.service.history(
      { accountId: world.account.id, problemKey: world.problem.key },
      TOKEN,
    );
    assert.deepEqual(named.items, []);
    assert.equal(await bench.store.countCoachingAttempts({}), 2, 'the quota count is global across scopes');

    // A selected account must belong to the problem's source instance.
    const foreign = fx.makeScope('luogu', 'luogu.com.cn', 'bob', 'P1001');
    await bench.store.upsertSourceInstances([foreign.instance]);
    await bench.store.upsertAccounts([foreign.account]);
    const mismatch = unanswered(
      await bench.service.ask(
        { requestId: 'foreign-1', accountId: foreign.account.id, problemKey: world.problem.key, level: 1 },
        TOKEN,
      ),
    );
    assert.equal(mismatch.error.code, 'account_mismatch');
    assert.equal(await bench.store.getCoachingAttempt('foreign-1'), null);
  } finally {
    await bench.close();
  }
});

void test('history is metadata-only unless one level and currentness (or an explicit stale request) allow the body', async () => {
  const bench = new Bench();
  const world = makeWorld();
  try {
    await seed(bench, world);
    answered(await bench.service.ask(askRequest(world, { requestId: 'h1' }), TOKEN));
    bench.handler = async () => ok(HINT_2);
    answered(await bench.service.ask(askRequest(world, { requestId: 'h2', level: 2 }), TOKEN));

    const metadata: CoachingHistoryResult = await bench.service.history(
      { accountId: world.account.id, problemKey: world.problem.key },
      TOKEN,
    );
    assert.equal(metadata.headSnapshotId, world.snapshot.snapshotId);
    assert.deepEqual(
      metadata.items.map((item) => item.level),
      [1, 2],
    );
    for (const item of metadata.items) {
      assert.equal('responseText' in item, false, 'a metadata page never carries an answer');
      assert.equal(item.verification, 'unverified_ai');
      assert.equal(item.snapshotState, 'current');
    }
    assert.deepEqual(JSON.parse(JSON.stringify(metadata)), metadata);

    const levelOne = await bench.service.history(
      { accountId: world.account.id, problemKey: world.problem.key, level: 1, includeResponseText: true },
      TOKEN,
    );
    assert.deepEqual(
      levelOne.items.map((item) => item.level),
      [1],
    );
    assert.equal(levelOne.items[0]?.responseText, HINT_1);

    await assert.rejects(
      bench.service.history(
        { accountId: world.account.id, problemKey: world.problem.key, includeResponseText: true },
        TOKEN,
      ),
      invalidRequest,
    );
    await assert.rejects(
      bench.service.history(
        { accountId: world.account.id, problemKey: world.problem.key, level: 1, includeStale: true },
        TOKEN,
      ),
      invalidRequest,
    );

    // A new head makes the stored answers stale: bodies stay hidden unless stale history is
    // requested explicitly for that one level.
    const changed = fx.makeProblem(world.problem.ref, { statement: 'rewritten' });
    await bench.store.saveSnapshot(fx.makeSnapshot(changed, { previous: world.snapshot, capturedAt: LATER }));

    const stale = await bench.service.history(
      { accountId: world.account.id, problemKey: world.problem.key, level: 1, includeResponseText: true },
      TOKEN,
    );
    assert.equal(stale.items[0]?.snapshotState, 'stale');
    assert.equal('responseText' in (stale.items[0] ?? {}), false);

    const explicit = await bench.service.history(
      {
        accountId: world.account.id,
        problemKey: world.problem.key,
        level: 1,
        includeResponseText: true,
        includeStale: true,
      },
      TOKEN,
    );
    assert.equal(explicit.items[0]?.responseText, HINT_1);
  } finally {
    await bench.close();
  }
});

void test('history reads the head after the page, so a head advance during the read is never projected as current', async () => {
  const armed: { run: (() => Promise<void>) | null } = { run: null };
  class PageHookStore extends SqliteTrainingStore {
    override async listCoachingAttempts(query: CoachingAttemptQuery): Promise<Page<CoachingAttempt>> {
      const page = await super.listCoachingAttempts(query);
      const hook = armed.run;
      armed.run = null;
      if (hook !== null) {
        await hook();
      }
      return page;
    }
  }
  const bench = new Bench({ store: (path, now) => new PageHookStore({ path, now }) });
  const world = makeWorld();
  try {
    await seed(bench, world);
    answered(await bench.service.ask(askRequest(world, { requestId: 'h1' }), TOKEN));

    const changed = fx.makeProblem(world.problem.ref, { statement: 'rewritten while the history page was read' });
    const next = fx.makeSnapshot(changed, { previous: world.snapshot, capturedAt: LATER });
    armed.run = async () => {
      await bench.store.saveSnapshot(next);
    };

    const body = await bench.service.history(
      { accountId: world.account.id, problemKey: world.problem.key, level: 1, includeResponseText: true },
      TOKEN,
    );
    assert.equal(body.headSnapshotId, next.snapshotId, 'the head is the one read after the page');
    assert.equal(body.items[0]?.snapshotState, 'stale');
    assert.equal('responseText' in (body.items[0] ?? {}), false, 'a head advance during the page read hides the body');

    const explicit = await bench.service.history(
      {
        accountId: world.account.id,
        problemKey: world.problem.key,
        level: 1,
        includeResponseText: true,
        includeStale: true,
      },
      TOKEN,
    );
    assert.equal(explicit.items[0]?.responseText, HINT_1, 'an explicit stale read may still reveal it');
    assert.equal(explicit.headSnapshotId, next.snapshotId);
  } finally {
    await bench.close();
  }
});

void test('getStatus matches identity and keeps stale answers behind the spoiler rule', async () => {
  const bench = new Bench();
  const world = makeWorld();
  try {
    await seed(bench, world);
    answered(await bench.service.ask(askRequest(world, { requestId: 's1' }), TOKEN));

    const unknown = await bench.service.getStatus('missing', world.account.id, world.problem.key, TOKEN);
    assert.equal(unknown.status, 'unknown');

    await assert.rejects(bench.service.getStatus('s1', null, world.problem.key, TOKEN), conflict);
    const otherProblem = fx.makeProblem(fx.makeRef(world.instance, '2B'));
    await assert.rejects(bench.service.getStatus('s1', world.account.id, otherProblem.key, TOKEN), conflict);

    const current = found(
      await bench.service.getStatus('s1', world.account.id, world.problem.key, TOKEN, {
        includeResponseText: true,
      }),
    );
    assert.equal(current.responseText, HINT_1);
    assert.equal(current.snapshotState, 'current');

    const changed = fx.makeProblem(world.problem.ref, { statement: 'rewritten' });
    await bench.store.saveSnapshot(fx.makeSnapshot(changed, { previous: world.snapshot, capturedAt: LATER }));
    const stale = found(
      await bench.service.getStatus('s1', world.account.id, world.problem.key, TOKEN, {
        includeResponseText: true,
      }),
    );
    assert.equal(stale.snapshotState, 'stale');
    assert.equal('responseText' in stale, false);

    const explicit = found(
      await bench.service.getStatus('s1', world.account.id, world.problem.key, TOKEN, {
        includeResponseText: true,
        includeStale: true,
      }),
    );
    assert.equal(explicit.responseText, HINT_1);
  } finally {
    await bench.close();
  }
});

// ---------------------------------------------------------------------------------------
// Bounded reads and malformed input
// ---------------------------------------------------------------------------------------

void test('a bounded history walk that would overflow refuses instead of counting a truncated history', async () => {
  const bench = new Bench({ maxHistoryScan: 2 });
  const world = makeWorld();
  try {
    await seed(bench, world);
    for (const id of ['r1', 'r2', 'r3']) {
      await bench.store.saveCoachingAttempt(reservedAttempt(world, id, AT));
    }
    assert.equal(await bench.store.countCoachingAttempts({}), 3);

    await assert.rejects(
      bench.service.ask(askRequest(world, { requestId: 'fresh-1' }), TOKEN),
      (error) => error instanceof CoachingServiceError && error.code === 'history_overflow',
    );
    for (const id of ['r1', 'r2', 'r3']) {
      assert.equal((await bench.store.getCoachingAttempt(id))?.status, 'reserved', 'nothing was half-recovered');
    }
    assert.equal(await bench.store.getCoachingAttempt('fresh-1'), null);
    assert.equal(bench.calls.length, 0);
  } finally {
    await bench.close();
  }
});

void test('malformed asks and history reads are refused with a stable code and no store write', async () => {
  const bench = new Bench();
  const world = makeWorld();
  try {
    await seed(bench, world);
    const base = askRequest(world);
    await assert.rejects(bench.service.ask({ ...base, level: 4 as CoachingLevel }, TOKEN), invalidRequest);
    await assert.rejects(bench.service.ask({ ...base, requestId: '' }, TOKEN), invalidRequest);
    await assert.rejects(
      bench.service.ask({ ...base, requestId: 'x'.repeat(MAX_COACHING_REQUEST_ID_CHARS + 1) }, TOKEN),
      invalidRequest,
    );
    await assert.rejects(bench.service.ask({ ...base, problemKey: 'not-a-key' }, TOKEN), invalidRequest);
    await assert.rejects(bench.service.ask({ ...base, accountId: '   ' }, TOKEN), invalidRequest);
    await assert.rejects(
      bench.service.ask({ ...base, explicitFullSolution: 'yes' as unknown as boolean }, TOKEN),
      invalidRequest,
    );
    await assert.rejects(bench.service.ask(base, { cancelled: false } as unknown as CancellationToken), invalidRequest);
    await assert.rejects(
      bench.service.history({ accountId: world.account.id, problemKey: world.problem.key, limit: 501 }, TOKEN),
      invalidRequest,
    );
    await assert.rejects(
      bench.service.history(
        { accountId: world.account.id, problemKey: world.problem.key, level: 9 as CoachingLevel },
        TOKEN,
      ),
      invalidRequest,
    );

    assert.equal(bench.calls.length, 0);
    assert.equal(await bench.store.countCoachingAttempts({}), 0);

    // A cancelled read token is a typed cancellation, not a silent empty page.
    const cancelled = createCancellationSource();
    cancelled.cancel('user left the screen');
    await assert.rejects(
      bench.service.history({ accountId: world.account.id, problemKey: world.problem.key }, cancelled.token),
      (error) => error instanceof Error && error.name === 'DomainError' && 'code' in error && error.code === 'cancelled',
    );
  } finally {
    await bench.close();
  }
});

void test('a supplied settings revision needs a stored record: missing or mismatched refuses before any reservation', async () => {
  const bench = new Bench();
  const world = makeWorld();
  try {
    await seed(bench, world);

    // No stored record: a supplied revision cannot be the stored one, so nothing is reserved.
    const missing = unanswered(
      await bench.service.ask(askRequest(world, { requestId: 'guard-missing', expectedSettingsRevision: 1 }), TOKEN),
    );
    assert.equal(missing.status, 'refused');
    assert.equal(missing.error.code, 'settings_changed');
    assert.equal(missing.error.retryable, true);
    assert.equal(missing.attemptId, null);
    assert.equal(await bench.store.getCoachingAttempt('guard-missing'), null);
    assert.equal(bench.calls.length, 0);

    // An omitted revision keeps the legacy behaviour for direct callers that never stored settings.
    assert.equal(answered(await bench.service.ask(askRequest(world, { requestId: 'legacy-1' }), TOKEN)).text, HINT_1);
    assert.equal(bench.calls.length, 1);

    assert.equal(await bench.store.saveWorkbenchSettings(defaultWorkbenchSettings(), null), 1);
    const mismatch = unanswered(
      await bench.service.ask(
        askRequest(world, { requestId: 'guard-mismatch', level: 2, expectedSettingsRevision: 7 }),
        TOKEN,
      ),
    );
    assert.equal(mismatch.error.code, 'settings_changed');
    assert.equal(await bench.store.getCoachingAttempt('guard-mismatch'), null);
    assert.equal(bench.calls.length, 1);

    // A revision that matches the stored record still reserves and dispatches normally.
    assert.equal(
      answered(
        await bench.service.ask(
          askRequest(world, { requestId: 'guard-ok', level: 2, expectedSettingsRevision: 1 }),
          TOKEN,
        ),
      ).text,
      HINT_1,
    );
    assert.equal(bench.calls.length, 2);

    // A durable request id still replays for free after the configuration changed.
    assert.equal(
      answered(
        await bench.service.ask(askRequest(world, { requestId: 'legacy-1', expectedSettingsRevision: 7 }), TOKEN),
      ).text,
      HINT_1,
    );
    assert.equal(bench.calls.length, 2);

    // An undeclared ask member is refused, never ignored.
    await assert.rejects(
      bench.service.ask(
        { ...askRequest(world, { requestId: 'strict-1' }), typo: true } as unknown as CoachingAskRequest,
        TOKEN,
      ),
      invalidRequest,
    );
    assert.equal(await bench.store.getCoachingAttempt('strict-1'), null);
  } finally {
    await bench.close();
  }
});
