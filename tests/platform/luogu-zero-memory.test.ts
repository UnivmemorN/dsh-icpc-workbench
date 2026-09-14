/**
 * Sprint 31 — Luogu zero memory limit compatibility.
 *
 * The official Luogu payload can declare `limits.memory: [0]` while carrying a complete statement;
 * `0` is the raw platform value for "no positive limit supplied", not a proven unlimited or
 * zero-byte limit. This suite pins that such a problem imports with all sections and samples, that
 * the raw zero survives verbatim in the detail, and that negative/nonfinite/nonnumeric/absent/
 * empty/wrong-shape limits and the existing statement/identity refusals stay untouched. Everything
 * here is a small original synthetic payload served in-process; there is no network, credential or
 * downloaded statement.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LUOGU_BASE_URL,
  createLuoguAccount,
  createLuoguAdapter,
  createLuoguProblemSessionSource,
  luoguSourceInstance,
  parseProblemDetail,
  type LuoguAdapterOptions,
  type LuoguProblemSessionSource,
  type LuoguSession,
  type LuoguSessionProvider,
} from '../../src/adapters/luogu/index.js';
import type { PlatformLimits } from '../../src/application/ports.js';
import { createCancellationSource } from '../../src/domain/index.js';
import {
  AT,
  createHttpHarness,
  jsonResponse,
  type HttpHarness,
  type HttpHarnessOptions,
} from './fixtures.js';

const LIMITS: PlatformLimits = {
  minRequestIntervalMs: 0,
  requestTimeoutMs: 30_000,
  maxRetries: 0,
  pageSize: 100,
  maxConcurrency: 1,
};
const SOURCE = luoguSourceInstance();
const PID = 'P3374';
const UID = '248159';
const SESSION: LuoguSession = { uid: UID, cookie: `__client_id=${'b7f1c0a94e2d4f6a8c1b3d5e7f901234'}; _uid=${UID}` };
const ref = (pid = PID) => ({ sourceInstanceId: SOURCE.id, domain: null, externalKey: pid });

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: string }).code : undefined;
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<Error> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  assert.notEqual(error, null, `expected a ${code} rejection`);
  assert.equal(codeOf(error), code, `expected ${code}, got ${String(error)}`);
  return error as Error;
}

function harness(routes: HttpHarnessOptions['routes']): HttpHarness {
  return createHttpHarness({ origin: LUOGU_BASE_URL, routes });
}

function adapterFor(h: HttpHarness, options: Partial<LuoguAdapterOptions> = {}) {
  return createLuoguAdapter({
    sourceInstance: SOURCE,
    transport: h.transport,
    clock: () => Date.parse(AT),
    ...options,
  });
}

function detailPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: {
      problem: {
        pid: PID,
        difficulty: 4,
        tags: [53, 523],
        content: {
          name: '零内存限制',
          background: '题目背景文本。',
          description: '求 $a + b$ 的值。',
          formatI: '一行两个整数。',
          formatO: '一行一个整数。',
          hint: '提示文本。',
          locale: 'zh-CN',
        },
        samples: [['1 2', '3']],
        limits: { time: [3000], memory: [0] },
        ...overrides,
      },
    },
  };
}

/** The same detail assembled as a plain object, for values JSON cannot carry (NaN, Infinity). */
function rawDetail(memory: unknown, time: unknown = [3000]): Record<string, unknown> {
  const payload = detailPayload();
  const data = payload.data as Record<string, unknown>;
  const problem = data.problem as Record<string, unknown>;
  problem.limits = { time, memory };
  return payload;
}

function token() {
  return createCancellationSource().token;
}

test('a zero-memory problem imports with its full statement and samples', async () => {
  const h = harness({ [`/problem/${PID}`]: () => jsonResponse(detailPayload()) });
  const adapter = adapterFor(h);

  const problem = await adapter.fetchProblem({ problemRef: ref(), token: token(), limits: LIMITS });
  assert.equal(problem.title, '零内存限制');
  assert.equal(problem.ref.externalKey, PID);
  const statement = problem.statement ?? '';
  for (const marker of ['## 题目背景', '## 题目描述', '## 输入格式', '## 输出格式', '## 样例 #1', '## 提示', '1 2', '3']) {
    assert.ok(statement.includes(marker), `statement is missing ${marker}`);
  }
  assert.deepEqual(
    problem.rawTags.map((tag) => tag.raw),
    ['luogu-tag:53', 'luogu-tag:523'],
  );

  // The raw platform values survive the detail verbatim: memory `0` is not replaced by a guess.
  const detail = await (
    await adapter.fetchProblemDetail({ problemRef: ref(), token: token(), limits: LIMITS })
  ).detail;
  assert.deepEqual(detail.memoryLimitsKib, [0]);
  assert.deepEqual(detail.timeLimitsMs, [3000]);
});

test('mixed and ordinary positive memory entries keep their exact values and order', async () => {
  const mixed = harness({
    [`/problem/${PID}`]: () => jsonResponse(detailPayload({ limits: { time: [1000, 2000], memory: [524288, 0, 262144] } })),
  });
  const mixedDetail = await adapterFor(mixed).fetchProblemDetail({ problemRef: ref(), token: token(), limits: LIMITS });
  assert.deepEqual(mixedDetail.detail.memoryLimitsKib, [524288, 0, 262144]);
  assert.deepEqual(mixedDetail.detail.timeLimitsMs, [1000, 2000]);
  const mixedProblem = await adapterFor(mixed).fetchProblem({ problemRef: ref(), token: token(), limits: LIMITS });
  assert.ok((mixedProblem.statement ?? '').includes('## 题目描述'));

  const positive = harness({
    [`/problem/${PID}`]: () => jsonResponse(detailPayload({ limits: { time: [1000], memory: [524288] } })),
  });
  const positiveDetail = await (
    await adapterFor(positive).fetchProblemDetail({ problemRef: ref(), token: token(), limits: LIMITS })
  ).detail;
  assert.deepEqual(positiveDetail.memoryLimitsKib, [524288]);
  assert.deepEqual(positiveDetail.timeLimitsMs, [1000]);
});

test('malformed memory inputs are still rejected before any result', async () => {
  const cases: readonly (readonly [string, unknown])[] = [
    ['empty array', []],
    ['string entry', ['0']],
    ['null entry', [null]],
    ['boolean entry', [true]],
    ['object entry', [{}]],
    ['negative entry', [-1]],
    ['non-array', 0],
    ['absent', undefined],
  ];
  for (const [label, memory] of cases) {
    const limits = memory === undefined ? { time: [3000] } : { time: [3000], memory };
    const h = harness({ [`/problem/${PID}`]: () => jsonResponse(detailPayload({ limits })) });
    const error = await adapterFor(h)
      .fetchProblem({ problemRef: ref(), token: token(), limits: LIMITS })
      .then(
        () => null,
        (cause: unknown) => cause,
      );
    assert.equal(codeOf(error), 'changed_response', `${label}: expected changed_response, got ${String(error)}`);
  }

  // `NaN`/`Infinity` cannot travel through JSON; the pure parser is checked directly.
  for (const memory of [[Number.NaN], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY]]) {
    assert.throws(
      () => parseProblemDetail(rawDetail(memory), PID),
      (error: unknown) => codeOf(error) === 'changed_response',
      `expected a changed_response for ${String(memory[0])}`,
    );
  }
  const negative = await rejectsWithCode(
    (async () => parseProblemDetail(rawDetail([-1]), PID))(),
    'changed_response',
  );
  assert.match(negative.message, /non-negative finite number/);
});

test('positive fractional limits preserve the existing numeric contract', () => {
  const detail = parseProblemDetail(rawDetail([0.5, 0], [0.5]), PID);
  assert.deepEqual(detail.memoryLimitsKib, [0.5, 0]);
  assert.deepEqual(detail.timeLimitsMs, [0.5]);
});

test('zero and negative time limits stay strictly rejected', async () => {
  for (const time of [[0], [-1], []]) {
    const h = harness({ [`/problem/${PID}`]: () => jsonResponse(detailPayload({ limits: { time, memory: [0] } })) });
    const error = await rejectsWithCode(
      adapterFor(h).fetchProblem({ problemRef: ref(), token: token(), limits: LIMITS }),
      'changed_response',
    );
    if (time.length > 0) {
      assert.match(error.message, /positive finite number/);
    }
  }
});

test('a missing description and a mismatched pid remain rejected', async () => {
  const missing = harness({
    [`/problem/${PID}`]: () =>
      jsonResponse(detailPayload({ content: { name: 'X', background: '背景', description: null, formatI: '输入', formatO: '输出', hint: null } })),
  });
  await rejectsWithCode(
    adapterFor(missing).fetchProblem({ problemRef: ref(), token: token(), limits: LIMITS }),
    'changed_response',
  );

  const blank = harness({
    [`/problem/${PID}`]: () => jsonResponse(detailPayload({ content: { name: 'X', description: '   ' } })),
  });
  await rejectsWithCode(adapterFor(blank).fetchProblem({ problemRef: ref(), token: token(), limits: LIMITS }), 'changed_response');

  const foreign = harness({ [`/problem/${PID}`]: () => jsonResponse(detailPayload({ pid: 'P9999' })) });
  await rejectsWithCode(adapterFor(foreign).fetchProblem({ problemRef: ref(), token: token(), limits: LIMITS }), 'changed_response');
});

test('the authenticated problem reader imports the same zero-memory payload', async () => {
  const h = harness({ [`/problem/${PID}`]: () => jsonResponse(detailPayload()) });
  const sessions: LuoguSessionProvider = { sessionFor: async () => SESSION };
  const source: LuoguProblemSessionSource = createLuoguProblemSessionSource({
    sourceInstance: SOURCE,
    account: createLuoguAccount(SOURCE, UID, 'Synthetic User'),
    sessions,
    ...h.impl,
  });

  const problem = await source.fetchProblem({ problemRef: ref(), token: token(), limits: LIMITS });
  assert.equal(problem.title, '零内存限制');
  assert.equal(problem.ref.externalKey, PID);
  assert.ok((problem.statement ?? '').includes('## 样例 #1'));
  assert.equal(h.requests.length, 1);
});
