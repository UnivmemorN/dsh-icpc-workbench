/**
 * The source-gated business view of one Luogu adapter (Sprint 33C revision).
 *
 * The plugin owns exactly one source-wide pacing gate per Luogu instance, and the sync service and the
 * connection manager already run their own operations through it. This file pins the wrapper that puts
 * the *business* adapter's operations — anonymous statement/profile/catalog reads as well as
 * authenticated submissions and solution material — on that same gate, so a business read can never
 * start on top of another gated operation of the same source, or of another account.
 *
 * Everything here is synthetic: a stub adapter, a stub clock and a stub wait. No credential, socket,
 * database or model is involved, and the assertions describe the externally meaningful contract
 * (exactly one gated whole operation per adapter call, a floor between whole operations, no overlap,
 * unchanged identity/capabilities/errors/cancellation).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLuoguSourceGate, LUOGU_SOURCE_MIN_INTERVAL_MS } from '../../src/application/luogu-source-gate.js';
import type {
  AccountProfile,
  EditorialFetchResult,
  FetchAccountProfileRequest,
  FetchEditorialRequest,
  FetchProblemRequest,
  ListProblemsRequest,
  ListSubmissionsRequest,
  Page,
  PlatformAdapter,
  PlatformCapabilities,
} from '../../src/application/ports.js';
import { PlatformError } from '../../src/application/platform-errors.js';
import { createGatedLuoguAdapter } from '../../src/plugin/luogu-gated-adapter.js';
import {
  createCancellationSource,
  createNormalizedProblem,
  type CancellationToken,
  type NormalizedProblem,
  type Submission,
} from '../../src/domain/index.js';
import { createLuoguAccount, luoguSourceInstance } from '../../src/adapters/luogu/index.js';

const SOURCE = luoguSourceInstance();
const ACCOUNT_A = createLuoguAccount(SOURCE, '800001');
const ACCOUNT_B = createLuoguAccount(SOURCE, '800002');
const LIMITS = { minRequestIntervalMs: 0, requestTimeoutMs: 30_000, maxRetries: 0, pageSize: 100, maxConcurrency: 1 };
const TOKEN: CancellationToken = createCancellationSource().token;
const AT = '2026-09-15T00:00:00.000Z';

/** One observed step of the gate or the wrapped adapter, with the fake instant it happened at. */
interface Step {
  readonly what: string;
  readonly at: number;
  readonly accountId?: string;
}

interface World {
  readonly gate: ReturnType<typeof createLuoguSourceGate>;
  adapter: PlatformAdapter & { fetchProblemDetail?(request: FetchProblemRequest): Promise<unknown> };
  readonly steps: Step[];
  readonly innerCalls: string[];
  readonly waits: number[];
  now(): number;
  /** What the next inner operation does before it answers. */
  innerHook: ((label: string) => Promise<void>) | null;
  /** How the next inner operation fails, if it does. */
  innerFailure: unknown;
}

/**
 * One gate, one stub adapter and a fake clock whose only advance is a paced wait.
 *
 * The stub adapter records every inner call, so a test can prove the wrapper invokes the *whole*
 * operation once (the transport inside it owns any per-page pacing) rather than once per page.
 */
function world(): World {
  let now = 0;
  const steps: Step[] = [];
  const innerCalls: string[] = [];
  const waits: number[] = [];
  const state: World = {
    steps,
    innerCalls,
    waits,
    now: () => now,
    innerHook: null,
    innerFailure: undefined,
    gate: createLuoguSourceGate({
      now: () => now,
      wait: async (ms, token) => {
        token.throwIfCancelled();
        waits.push(ms);
        now += ms;
      },
    }),
    adapter: null as unknown as World['adapter'],
  };
  const wrap = async <T>(label: string, answer: T): Promise<T> => {
    innerCalls.push(label);
    steps.push({ what: `inner:${label}`, at: now });
    if (state.innerHook !== null) {
      await state.innerHook(label);
    }
    if (state.innerFailure !== undefined) {
      throw state.innerFailure;
    }
    return answer;
  };
  const capabilities = (): PlatformCapabilities => ({
    platform: 'luogu',
    implemented: true,
    problems: true,
    submissions: true,
    editorial: true,
    pagedProblems: true,
    pagedSubmissions: true,
    requiresAuth: true,
    supportsAccountHistory: true,
    minRequestIntervalMs: null,
    notes: [],
  });
  state.adapter = {
    sourceInstance: SOURCE,
    capabilities,
    listProblems: (_request: ListProblemsRequest) =>
      wrap('listProblems', { items: [], nextCursor: null, fetchedAt: AT } satisfies Page<NormalizedProblem>),
    listSubmissions: (_request: ListSubmissionsRequest) =>
      wrap('listSubmissions', { items: [], nextCursor: null, fetchedAt: AT } satisfies Page<Submission>),
    fetchProblem: (request: FetchProblemRequest) =>
      wrap(
        'fetchProblem',
        createNormalizedProblem({
          ref: request.problemRef,
          title: 'Synthetic',
          url: 'https://www.luogu.com.cn/problem/P1001',
          statement: null,
          fetchedAt: AT,
          ratings: [],
          rawTags: [],
        }),
      ),
    fetchEditorial: (request: FetchEditorialRequest) => {
      const label = `fetchEditorial:${request.account?.id ?? 'anonymous'}`;
      return wrap(label, { status: 'absent', detail: 'synthetic' } satisfies EditorialFetchResult);
    },
    fetchAccountProfile: (request: FetchAccountProfileRequest) =>
      wrap(`fetchAccountProfile:${request.account.id}`, {
        sourceInstanceId: SOURCE.id,
        uid: request.account.handle,
        displayName: 'Synthetic',
      } satisfies AccountProfile),
    fetchProblemDetail: (_request: FetchProblemRequest) => wrap('fetchProblemDetail', { ok: true }),
  };
  return state;
}

/** One wrapped adapter over the world's stub, plus a helper that runs a whole operation through it. */
function gated(w: World) {
  const adapter = createGatedLuoguAdapter({ adapter: w.adapter, gate: w.gate });
  return {
    adapter,
    async editorial(accountId = ACCOUNT_A.id): Promise<EditorialFetchResult> {
      const account = accountId === ACCOUNT_B.id ? ACCOUNT_B : ACCOUNT_A;
      return await adapter.fetchEditorial({
        problemRef: { sourceInstanceId: SOURCE.id, domain: null, externalKey: 'P1001' },
        account,
        token: TOKEN,
        limits: LIMITS,
      });
    },
    async submissions(accountId = ACCOUNT_A.id): Promise<Page<Submission>> {
      const account = accountId === ACCOUNT_B.id ? ACCOUNT_B : ACCOUNT_A;
      return await adapter.listSubmissions({ account, cursor: null, limit: 10, token: TOKEN, limits: LIMITS });
    },
  };
}

void test('every HTTP-capable operation is one whole gated operation', async () => {
  const w = world();
  const a = gated(w);
  await a.adapter.listProblems({ cursor: null, limit: 10, token: TOKEN, limits: LIMITS });
  await a.adapter.fetchProblem({
    problemRef: { sourceInstanceId: SOURCE.id, domain: null, externalKey: 'P1001' },
    token: TOKEN,
    limits: LIMITS,
  });
  await a.editorial();
  await a.submissions();
  await a.adapter.fetchAccountProfile?.({ account: ACCOUNT_A, token: TOKEN, limits: LIMITS });
  await a.adapter.fetchProblemDetail?.({
    problemRef: { sourceInstanceId: SOURCE.id, domain: null, externalKey: 'P1001' },
    token: TOKEN,
    limits: LIMITS,
  });
  assert.deepEqual(w.innerCalls, [
    'listProblems',
    'fetchProblem',
    `fetchEditorial:${ACCOUNT_A.id}`,
    'listSubmissions',
    `fetchAccountProfile:${ACCOUNT_A.id}`,
    'fetchProblemDetail',
  ]);
  // One gated whole operation per call, and exactly one floor wait between consecutive operations.
  assert.equal(w.waits.length, 5, JSON.stringify(w.waits));
  assert.equal(w.waits.every((ms) => ms === LUOGU_SOURCE_MIN_INTERVAL_MS), true, JSON.stringify(w.waits));
});

/**
 * Run one body while the inner operation parks, and release it on **every** path.
 *
 * The gate only checks a queued call's token when that call reaches the head of the queue, so a test
 * that asserts "the queued call did not dispatch" must be able to fail *before* releasing the head —
 * without a guaranteed release, a failed assertion would park the first operation forever and hang the
 * whole file. The release clears the hook first so the queued operation runs unparked.
 */
async function withParkedInner(
  w: World,
  body: (release: () => void) => Promise<void>,
): Promise<void> {
  let releasePark!: () => void;
  const parked = new Promise<void>((resolve) => {
    releasePark = resolve;
  });
  w.innerHook = async () => {
    await parked;
  };
  const release = (): void => {
    w.innerHook = null;
    releasePark();
  };
  try {
    await body(release);
  } finally {
    release();
  }
}

void test('the gate serializes operations and keeps the floor after each whole operation', async () => {
  const w = world();
  const a = gated(w);
  await withParkedInner(w, async (release) => {
    // The first operation parks until this test releases it, so the second is queued behind it.
    const first = a.editorial(ACCOUNT_A.id);
    await Promise.resolve();
    const second = a.editorial(ACCOUNT_B.id);
    // The queued operation must not have reached the adapter at all while the first is in flight.
    await Promise.resolve();
    assert.deepEqual(w.innerCalls, [`fetchEditorial:${ACCOUNT_A.id}`]);
    release();
    await first;
    await second;
  });
  assert.deepEqual(w.innerCalls, [`fetchEditorial:${ACCOUNT_A.id}`, `fetchEditorial:${ACCOUNT_B.id}`]);
  const firstStart = w.steps.find((step) => step.what === `inner:fetchEditorial:${ACCOUNT_A.id}`);
  const secondStart = w.steps.find((step) => step.what === `inner:fetchEditorial:${ACCOUNT_B.id}`);
  assert.ok(firstStart && secondStart);
  // Cross-account reads share one gate, so the second account's read starts at the floor after the
  // first whole operation ended — never on top of it.
  assert.equal(secondStart.at - firstStart.at >= LUOGU_SOURCE_MIN_INTERVAL_MS, true, JSON.stringify(w.steps));
});

void test('a business read cannot overlap an operation the host already gated', async () => {
  const w = world();
  const a = gated(w);
  // A host-owned operation (the sync service or a connection probe) runs on the same gate.
  await withParkedInner(w, async (release) => {
    const hostOperation = w.gate.run(TOKEN, async () => {
      w.steps.push({ what: 'host:start', at: w.now() });
      await w.innerHook?.('host');
      w.steps.push({ what: 'host:end', at: w.now() });
    });
    const business = a.editorial();
    await Promise.resolve();
    assert.equal(
      w.innerCalls.length,
      0,
      'the business read must wait for the host operation instead of running beside it',
    );
    release();
    await hostOperation;
    await business;
  });
  assert.deepEqual(w.innerCalls, [`fetchEditorial:${ACCOUNT_A.id}`]);
  assert.equal(w.waits.length, 1, 'exactly one floor wait separates the two whole operations');
});

void test('the gate wraps the operation once, not once per page', async () => {
  const w = world();
  const a = gated(w);
  // An inner operation that walks six "pages" itself: the transport inside the adapter owns that
  // pacing, so the wrapper must not re-enter the gate per page.
  w.innerHook = async () => {
    for (let page = 0; page < 6; page += 1) {
      await Promise.resolve();
    }
  };
  await a.editorial();
  assert.deepEqual(w.innerCalls, [`fetchEditorial:${ACCOUNT_A.id}`]);
  assert.deepEqual(w.waits, [], 'the first operation has no predecessor to pace against');
});

void test('a cancelled queued operation never reaches the adapter', async () => {
  const w = world();
  const a = gated(w);
  const queuedSource = createCancellationSource();
  await withParkedInner(w, async (release) => {
    const first = a.editorial(ACCOUNT_A.id);
    await Promise.resolve();
    const queued = createGatedLuoguAdapter({ adapter: w.adapter, gate: w.gate }).fetchEditorial({
      problemRef: { sourceInstanceId: SOURCE.id, domain: null, externalKey: 'P1001' },
      account: ACCOUNT_B,
      token: queuedSource.token,
      limits: LIMITS,
    });
    // The gate checks a queued call's token only when it reaches the head of the queue, so the refusal
    // is observed after the first operation finishes. What this asserts *now* is the important part:
    // the cancelled call has dispatched nothing.
    queuedSource.cancel('cancelled while queued');
    await Promise.resolve();
    assert.deepEqual(w.innerCalls, [`fetchEditorial:${ACCOUNT_A.id}`]);
    release();
    await first;
    await assert.rejects(queued, (error: unknown) => (error as { code?: string }).code === 'cancelled');
  });
  assert.deepEqual(w.innerCalls, [`fetchEditorial:${ACCOUNT_A.id}`], 'the cancelled call dispatched nothing');
});

void test('a failing operation still releases the queue and keeps its own error', async () => {
  const w = world();
  const a = gated(w);
  const failure = new PlatformError({
    code: 'auth_required',
    operation: 'editorial',
    retryable: false,
    detail: 'synthetic refusal',
  });
  w.innerFailure = failure;
  await assert.rejects(a.editorial(), (error: unknown) => error === failure);
  w.innerFailure = undefined;
  // The gate is not poisoned: the next operation runs, after the floor.
  await a.editorial(ACCOUNT_B.id);
  assert.deepEqual(w.innerCalls, [`fetchEditorial:${ACCOUNT_A.id}`, `fetchEditorial:${ACCOUNT_B.id}`]);
  assert.equal(w.waits.length, 1);
});

void test('the wrapper changes neither identity, capabilities nor optional methods', () => {
  const w = world();
  const adapter = createGatedLuoguAdapter({ adapter: w.adapter, gate: w.gate });
  assert.equal(adapter.sourceInstance, SOURCE);
  assert.deepEqual(adapter.capabilities(), w.adapter.capabilities());
  assert.equal(typeof adapter.fetchAccountProfile, 'function');
  assert.equal(typeof adapter.fetchProblemDetail, 'function');

  // A wrapped adapter without the profile read must not gain one: a caller's own capability check is
  // what decides whether a nickname can be fetched at all.
  const minimal: PlatformAdapter = {
    sourceInstance: SOURCE,
    capabilities: w.adapter.capabilities,
    listProblems: w.adapter.listProblems,
    listSubmissions: w.adapter.listSubmissions,
    fetchProblem: w.adapter.fetchProblem,
    fetchEditorial: w.adapter.fetchEditorial,
  };
  const wrappedMinimal = createGatedLuoguAdapter({ adapter: minimal, gate: w.gate });
  assert.equal(wrappedMinimal.fetchAccountProfile, undefined);
  assert.equal(wrappedMinimal.fetchProblemDetail, undefined);
  assert.equal(typeof wrappedMinimal.fetchEditorial, 'function');
});

void test('the wrapper refuses to be built without a usable gate', () => {
  const w = world();
  assert.throws(
    () => createGatedLuoguAdapter({ adapter: w.adapter, gate: null as unknown as ReturnType<typeof createLuoguSourceGate> }),
    TypeError,
  );
  assert.throws(
    () => createGatedLuoguAdapter({ adapter: null as unknown as PlatformAdapter, gate: w.gate }),
    TypeError,
  );
});
