/**
 * Boundary behaviour of the dsh coaching generator (Stage 4s2a).
 *
 * Every case drives the real `DshCoachingGenerator` through a real `DshAuditedModelClient` with a
 * scripted provider stream and a real detached `Session`. Nothing here reaches a model: the chunks
 * are local fakes, and the assertions are about the paid boundary (one dispatch, exact options, the
 * `coaching` audit role), the untrusted-data prompt shape and the strict output contract.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import { Session } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import {
  COACHING_SYSTEM_PROMPT,
  COACHING_TEMPERATURE,
  DshAuditedModelClient,
  DshCoachingGenerator,
  parseCoachingOutput,
  type DshAuditedHost,
  type IcpcModelCallAudit,
} from '../../src/adapters/dsh/index.js';
import {
  COACHING_EFFORT,
  COACHING_PROMPT_VERSION,
  type CoachingGenerationOutcome,
  type CoachingGenerationRequest,
} from '../../src/application/coaching-generation.js';
import { MAX_COACHING_RESPONSE_CHARS } from '../../src/application/coaching-types.js';
import type { ModelCallResult } from '../../src/application/ports.js';
import {
  createCancellationSource,
  createEditorialSolution,
  createEditorialSource,
  createNormalizedProblem,
  createProblemSnapshot,
  createSourceInstance,
  type CancellationToken,
  type ProblemSnapshot,
} from '../../src/domain/index.js';

const AT = '2026-09-20T08:00:00.000Z';
const STATEMENT = 'Given an array of n integers, support range add and range sum queries online.';
const EDITORIAL_TEXT = 'Editorial: keep a segment tree with lazy propagation so each update is O(log n).';
const SOLUTION_TEXT = 'Push the pending add down before descending; a node stores its own sum and a pending add.';
const ANSWER = '先想清楚一次区间修改覆盖了哪些节点：整段覆盖的节点可以整体打标记，部分覆盖的节点必须先下传。先不要急着写代码。';
const DEFAULT_USAGE: TokenUsage = { inputTokens: 120, outputTokens: 40 };
const KNOWN_USAGE = { calls: 1, promptTokens: 120, completionTokens: 40, totalTokens: 160 };
const ZERO_USAGE = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const TOKEN = createCancellationSource().token;

const INSTANCE = createSourceInstance({
  platform: 'codeforces',
  baseUrl: 'https://codeforces.com',
  domain: 'codeforces.com',
  displayName: 'Codeforces',
});
const REF = { sourceInstanceId: INSTANCE.id, domain: null, externalKey: '1234A' };

function problemWith(statement: string | null) {
  return createNormalizedProblem({
    ref: REF,
    title: 'Range update range sum',
    url: 'https://codeforces.com/problemset/problem/1234/A',
    statement,
    fetchedAt: AT,
    ratings: [{ dimension: 'rating', value: 1800, scale: { min: 800, max: 3500 }, raw: '1800' }],
    rawTags: ['data structures', 'segment tree'],
  });
}

/** One found editorial (with a solution) and one absent source: only the found one may be sent. */
function editorialSnapshot(): ProblemSnapshot {
  const found = createEditorialSource({
    id: 'editorial-1',
    kind: 'editorial',
    url: 'https://codeforces.com/blog/entry/12345',
    title: 'Editorial 1234A',
    availability: 'found',
    retrievedAt: AT,
    text: EDITORIAL_TEXT,
  });
  const absent = createEditorialSource({
    id: 'editorial-2',
    kind: 'editorial',
    url: 'https://codeforces.com/blog/entry/99999',
    title: 'Editorial without a body',
    availability: 'absent',
    retrievedAt: AT,
  });
  return createProblemSnapshot({
    problem: problemWith(STATEMENT),
    sources: [found, absent],
    solutions: [
      createEditorialSolution({
        solutionId: 'solution-1',
        sourceId: found.id,
        ordinal: 0,
        title: 'Solution 1',
        text: SOLUTION_TEXT,
      }),
    ],
    capturedAt: AT,
  });
}

const SNAPSHOT = editorialSnapshot();

interface ScriptedCall {
  readonly payload?: unknown;
  /** Assembled provider text instead of a JSON payload (whole-document fence case). */
  readonly raw?: string;
  /** `null` reports no usage at all; `undefined` uses {@link DEFAULT_USAGE}. */
  readonly usage?: TokenUsage | null;
}

interface HostState {
  readonly dispatch: GenerateOptions[];
  readonly created: Session[];
  readonly host: DshAuditedHost;
}

interface Harness {
  readonly state: HostState;
  readonly generator: DshCoachingGenerator;
}

function scripted(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  return (async function* generate(): AsyncGenerator<StreamChunk> {
    for (const chunk of chunks) {
      yield chunk;
    }
  })();
}

function textChunks(text: string, usage: TokenUsage | null): StreamChunk[] {
  const chunks: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
  ];
  if (usage !== null) {
    chunks.push({ type: 'usage', usage });
  }
  chunks.push({ type: 'finish', reason: { kind: 'stop' } });
  return chunks;
}

/** Real client + generator over scripted streams; each dispatch consumes the next scripted call. */
function harness(calls: readonly ScriptedCall[]): Harness {
  const dispatch: GenerateOptions[] = [];
  const created: Session[] = [];
  let index = 0;
  const host: DshAuditedHost = {
    llm: {
      stream(options) {
        dispatch.push(options);
        const call: ScriptedCall = calls[index++] ?? { payload: {} };
        const usage = call.usage === undefined ? DEFAULT_USAGE : call.usage;
        const text = call.raw ?? JSON.stringify(call.payload ?? {});
        return scripted(textChunks(text, usage));
      },
    },
    sessions: {
      create(id) {
        const session = Session.create(id);
        created.push(session);
        return session;
      },
      async flush() {
        return true;
      },
    },
  };
  const now = () => AT;
  const client = new DshAuditedModelClient(host, { now });
  const generator = new DshCoachingGenerator({ client, now });
  return { state: { dispatch, created, host }, generator };
}

function auditsOf(state: HostState): readonly IcpcModelCallAudit[] {
  const events: readonly SessionEvent[] = state.created[0]?.snapshotEvents() ?? [];
  return events.filter((event) => event.type === 'icpc/model-call-audit').map((event) => event.data as IcpcModelCallAudit);
}

function userText(options: GenerateOptions | undefined): string {
  const blocks = options?.messages[0]?.content ?? [];
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
}

function promptPayload(options: GenerateOptions | undefined): Record<string, unknown> {
  return JSON.parse(userText(options)) as Record<string, unknown>;
}

function valueOf<T>(result: ModelCallResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected a successful call, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

function failureOf<T>(result: ModelCallResult<T>): Extract<ModelCallResult<T>, { ok: false }> {
  if (result.ok) {
    assert.fail('expected a failed model call');
  }
  return result;
}

function request(overrides: Partial<CoachingGenerationRequest> = {}): CoachingGenerationRequest {
  return {
    snapshot: SNAPSHOT,
    level: 1,
    provider: 'fake-provider',
    model: 'coaching-model',
    maxOutputTokens: 4096,
    requestTimeoutMs: 5_000,
    effort: COACHING_EFFORT,
    attemptId: 'attempt-1',
    promptVersion: COACHING_PROMPT_VERSION,
    token: TOKEN,
    previousHints: [],
    explicitFullSolution: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------
// One paid boundary per request
// ---------------------------------------------------------------------------------------

void test('a level-1 hint is exactly one audited coaching call with the request identity and full statement', async () => {
  const { state, generator } = harness([{ payload: { text: ANSWER } }]);

  const result = await generator.generate(request());

  const outcome = valueOf<CoachingGenerationOutcome>(result);
  assert.equal(outcome.text, ANSWER);
  assert.equal(result.ok ? result.usage.calls : null, KNOWN_USAGE.calls);
  assert.deepEqual(result.ok ? result.usage : null, KNOWN_USAGE);
  assert.equal(state.dispatch.length, 1, 'one request is one paid dispatch, never a retry');

  const dispatched = state.dispatch[0];
  assert.ok(dispatched);
  assert.equal(dispatched.provider, 'fake-provider');
  assert.equal(dispatched.model, 'coaching-model');
  assert.equal(dispatched.system, COACHING_SYSTEM_PROMPT);
  assert.equal(dispatched.maxTokens, 4096);
  assert.equal(dispatched.temperature, COACHING_TEMPERATURE);
  assert.equal(dispatched.reasoningEffort, 'max');

  // The tutor prompt states the approved level discipline, the untrusted-data rule and the
  // no-compilation-claims rule literally; task data never leaks into it.
  assert.match(COACHING_SYSTEM_PROMPT, /不受信任/);
  assert.match(COACHING_SYSTEM_PROMPT, /level 1/);
  assert.match(COACHING_SYSTEM_PROMPT, /不变量/);
  assert.match(COACHING_SYSTEM_PROMPT, /伪代码/);
  assert.match(COACHING_SYSTEM_PROMPT, /C\+\+17/);
  assert.match(COACHING_SYSTEM_PROMPT, /编译、运行或通过评测/);
  assert.equal(dispatched.system.includes(STATEMENT), false);

  const payload = promptPayload(dispatched);
  assert.deepEqual(Object.keys(payload), [
    'task',
    'level',
    'fullSolutionExplicitlyRequested',
    'problem',
    'editorial',
    'previousHints',
  ]);
  assert.equal(payload.task, 'coaching_hint');
  assert.equal(payload.level, 1);
  assert.equal(payload.fullSolutionExplicitlyRequested, false);
  const problem = payload.problem as { statement: string; rawTags: readonly string[] };
  assert.equal(problem.statement, STATEMENT);
  assert.deepEqual(problem.rawTags, ['data structures', 'segment tree']);
  const editorial = payload.editorial as {
    sources: readonly { id: string; title: string; note: string | null }[];
    solutions: readonly { solutionId: string; text: string }[];
  };
  assert.deepEqual(editorial.sources.map((source) => source.id), ['editorial-1']);
  assert.equal(editorial.sources[0]?.title, 'Editorial 1234A');
  assert.equal(editorial.sources[0]?.note, null, 'a source without a stored note sends an explicit null');
  assert.equal(editorial.solutions[0]?.solutionId, 'solution-1');
  assert.equal(editorial.solutions[0]?.text, SOLUTION_TEXT);
  assert.deepEqual(payload.previousHints, []);

  const text = userText(dispatched);
  assert.equal(text.includes('taxonomy'), false, 'no taxonomy labels are sent');
  assert.equal(text.includes('expectedLabels'), false, 'no reference benchmark labels are sent');
  assert.equal(text.includes('apiKey'), false, 'no credentials are sent');

  const audit = auditsOf(state)[0];
  assert.ok(audit);
  assert.equal(audit.role, 'coaching');
  assert.equal(audit.attemptId, 'attempt-1');
  assert.equal(audit.promptVersion, COACHING_PROMPT_VERSION);
  assert.equal(audit.snapshotId, SNAPSHOT.snapshotId);
  assert.equal((audit.options as { reasoningEffort: string }).reasoningEffort, 'max');
});

void test('the payload carries only found editorial material and the earlier lower hints', async () => {
  const { state, generator } = harness([{ payload: { text: ANSWER } }]);

  const result = await generator.generate(
    request({ level: 2, previousHints: [{ level: 1, text: '先考虑暴力枚举每个区间。' }] }),
  );

  assert.equal(valueOf<CoachingGenerationOutcome>(result).text, ANSWER);
  const text = userText(state.dispatch[0]);
  assert.equal(text.includes(SOLUTION_TEXT), true, 'the found solution text is sent');
  assert.equal(text.includes('editorial-2'), false, 'an absent source is not sent');
  assert.deepEqual(promptPayload(state.dispatch[0]).previousHints, [{ level: 1, text: '先考虑暴力枚举每个区间。' }]);
  assert.equal(state.dispatch.length, 1);
});

void test('a pasted user answer reaches the coaching prompt with its text and provenance note', async () => {
  const sourceId = 'user-answer-0123456789abcdef0123456789abcdef';
  const answerText = 'Pasted answer body: binary search the answer, then check with a prefix-sum sweep.';
  const note = '用户提供解析（非官方题解；本插件未抓取、未核验其内容，正确性未经核验）；来源标注：教师解析；来源链接由用户提供，仅作标注；本插件不会抓取该链接。';
  const source = createEditorialSource({
    id: sourceId,
    kind: 'other',
    url: 'https://codeforces.com/problemset/problem/1234/A',
    title: '用户提供解析（教师解析）',
    availability: 'found',
    retrievedAt: AT,
    text: answerText,
    note,
  });
  const snapshot = createProblemSnapshot({
    problem: problemWith(STATEMENT),
    sources: [source],
    solutions: [
      createEditorialSolution({
        solutionId: `${sourceId}-solution-0`,
        sourceId,
        ordinal: 0,
        title: source.title,
        text: answerText,
      }),
    ],
    capturedAt: AT,
  });
  const { state, generator } = harness([{ payload: { text: ANSWER } }]);

  const result = await generator.generate(request({ snapshot }));

  assert.equal(valueOf<CoachingGenerationOutcome>(result).text, ANSWER);
  const dispatched = state.dispatch[0];
  assert.ok(dispatched);
  const payload = promptPayload(dispatched);
  const editorial = payload.editorial as {
    sources: readonly { id: string; kind: string; note: string | null }[];
    solutions: readonly { text: string }[];
  };
  assert.equal(editorial.sources[0]?.id, sourceId);
  assert.equal(editorial.sources[0]?.kind, 'other');
  assert.equal(editorial.sources[0]?.note, note, 'the user-provided provenance travels with the source');
  assert.equal(editorial.solutions[0]?.text, answerText, 'the exact provided text is the reference material');
  assert.equal(dispatched.system, COACHING_SYSTEM_PROMPT);
  assert.equal(dispatched.system.includes(answerText), false, 'task data never enters the system prompt');
  assert.equal(state.dispatch.length, 1);
});

void test('level 3 may ask for pseudocode with both earlier hints and still needs no full-solution flag', async () => {
  const previousHints = [
    { level: 1, text: '先想清楚一次区间修改影响哪些节点。' },
    { level: 2, text: '关键不变量：每个节点保存自身区间和与待下传的加法标记。' },
  ] as const;
  const { state, generator } = harness([{ payload: { text: `伪代码：update(node, l, r) { ... }` } }]);

  const outcome = valueOf<CoachingGenerationOutcome>(
    await generator.generate(request({ level: 3, previousHints: [...previousHints] })),
  );

  assert.match(outcome.text, /伪代码/);
  const payload = promptPayload(state.dispatch[0]);
  assert.equal(payload.level, 3);
  assert.deepEqual(payload.previousHints, [
    { level: 1, text: '先想清楚一次区间修改影响哪些节点。' },
    { level: 2, text: '关键不变量：每个节点保存自身区间和与待下传的加法标记。' },
  ]);
  assert.equal(payload.fullSolutionExplicitlyRequested, false);
});

// ---------------------------------------------------------------------------------------
// Full-solution defence in depth
// ---------------------------------------------------------------------------------------

void test("level 'full' is refused without the explicit flag and dispatched exactly once with it", async () => {
  const withoutFlag = harness([{ payload: { text: ANSWER } }]);
  const refused = failureOf(await withoutFlag.generator.generate(request({ level: 'full' })));
  assert.equal(refused.error.code, 'unsupported');
  assert.equal(refused.error.retryable, false);
  assert.deepEqual(refused.usage, ZERO_USAGE);
  assert.equal(withoutFlag.state.dispatch.length, 0, 'a non-explicit full request never reaches the provider');
  assert.equal(withoutFlag.state.created.length, 0);

  const withFlag = harness([{ payload: { text: `${ANSWER}\n\n\`\`\`cpp\n// C++17\n\`\`\`` } }]);
  const adopted = valueOf<CoachingGenerationOutcome>(
    await withFlag.generator.generate(request({ level: 'full', explicitFullSolution: true })),
  );
  assert.match(adopted.text, /C\+\+17/);
  const payload = promptPayload(withFlag.state.dispatch[0]);
  assert.equal(payload.level, 'full');
  assert.equal(payload.fullSolutionExplicitlyRequested, true);

  const earlyFlag = harness([{ payload: { text: ANSWER } }]);
  const contradictory = failureOf(
    await earlyFlag.generator.generate(request({ level: 2, explicitFullSolution: true })),
  );
  assert.equal(contradictory.error.code, 'unsupported');
  assert.equal(earlyFlag.state.dispatch.length, 0, 'the full-solution flag never attaches to a hint request');
});

// ---------------------------------------------------------------------------------------
// Requests refused before dispatch
// ---------------------------------------------------------------------------------------

void test('incoherent requests are refused with zero known usage and no dispatch', async () => {
  const noStatement = createProblemSnapshot({ problem: problemWith(null), sources: [], solutions: [], capturedAt: AT });
  const cases: readonly Partial<CoachingGenerationRequest>[] = [
    { snapshot: noStatement },
    { level: 4 as CoachingGenerationRequest['level'] },
    { provider: '   ' },
    { model: '' },
    { attemptId: '' },
    { promptVersion: '' },
    { maxOutputTokens: 0 },
    { maxOutputTokens: 1.5 },
    { requestTimeoutMs: 0 },
    { effort: 'low' as 'max' },
    { explicitFullSolution: 'yes' as unknown as boolean },
    { level: 1, previousHints: [{ level: 1, text: '同级别提示' }] },
    { level: 2, previousHints: [{ level: 2, text: '同级别提示' }] },
    { level: 2, previousHints: [{ level: 3, text: '更高一级的提示' }] },
    { level: 3, previousHints: [{ level: 1, text: 'a' }, { level: 1, text: 'b' }] },
    { level: 2, previousHints: [{ level: 1, text: '   ' }] },
    { level: 2, previousHints: [{ level: 1, text: 'x'.repeat(MAX_COACHING_RESPONSE_CHARS + 1) }] },
    { level: 1, previousHints: [{ level: 1, text: 'a' }, { level: 2, text: 'b' }, { level: 3, text: 'c' }, { level: 1, text: 'd' }] },
    { token: { cancelled: false } as unknown as CancellationToken },
  ];
  for (const overrides of cases) {
    const { state, generator } = harness([{ payload: { text: ANSWER } }]);
    const failure = failureOf(await generator.generate(request(overrides)));
    assert.equal(failure.error.code, 'unsupported', JSON.stringify(overrides).slice(0, 120));
    assert.equal(failure.error.retryable, false);
    assert.deepEqual(failure.usage, ZERO_USAGE);
    assert.equal(state.dispatch.length, 0, 'a refused request costs nothing');
    assert.equal(state.created.length, 0, 'a refused request creates no audit session');
  }
});

void test('a missing or non-object request is a typed refusal, not a crash', async () => {
  const { state, generator } = harness([]);
  const failure = failureOf(
    await generator.generate(undefined as unknown as CoachingGenerationRequest),
  );
  assert.equal(failure.error.code, 'unsupported');
  assert.equal(failure.error.retryable, false);
  assert.deepEqual(failure.usage, ZERO_USAGE);
  assert.equal(state.dispatch.length, 0);
});

// ---------------------------------------------------------------------------------------
// Strict output, usage accounting and cancellation
// ---------------------------------------------------------------------------------------

void test('malformed answers are rejected as invalid output while known usage is retained', async () => {
  const payloads: readonly unknown[] = [
    { text: ANSWER, note: 'unknown key' },
    {},
    { text: 42 },
    { text: '   ' },
    { text: 'x'.repeat(MAX_COACHING_RESPONSE_CHARS + 1) },
    [],
    'plain text without a JSON object',
  ];
  for (const payload of payloads) {
    const { state, generator } = harness([{ payload }]);
    const failure = failureOf(await generator.generate(request()));
    assert.equal(failure.error.code, 'invalid_output', JSON.stringify(payload).slice(0, 80));
    assert.equal(failure.error.retryable, false);
    assert.deepEqual(failure.usage, KNOWN_USAGE, 'known usage survives a parser refusal');
    assert.equal(state.dispatch.length, 1, 'the generator never retries a rejected parse');
  }

  assert.throws(() => parseCoachingOutput({}), /missing_key/);
  assert.throws(() => parseCoachingOutput({ text: 7 }), /invalid_type/);
  assert.throws(() => parseCoachingOutput({ text: 'a\u0000b' }), /invalid_text/);
});

void test('a padded answer is trimmed and a whole-document JSON fence is still one call', async () => {
  const padded = harness([{ payload: { text: `\n  ${ANSWER}  \n` } }]);
  assert.equal(valueOf<CoachingGenerationOutcome>(await padded.generator.generate(request())).text, ANSWER);

  const fenced = harness([{ raw: `\`\`\`json\n${JSON.stringify({ text: ANSWER })}\n\`\`\`` }]);
  assert.equal(valueOf<CoachingGenerationOutcome>(await fenced.generator.generate(request())).text, ANSWER);
  assert.equal(fenced.state.dispatch.length, 1);
});

void test('usage the provider never reported stays null instead of becoming a free paid call', async () => {
  const { state, generator } = harness([{ payload: { text: ANSWER }, usage: null }]);

  const failure = failureOf(await generator.generate(request()));

  assert.equal(failure.error.code, 'invalid_output');
  assert.equal(failure.usage, null, 'unknown usage is never fabricated as zero');
  assert.equal(state.dispatch.length, 1);
});

void test('a cancellation observed before dispatch costs nothing and creates no audit session', async () => {
  const source = createCancellationSource();
  source.cancel();
  const { state, generator } = harness([{ payload: { text: ANSWER } }]);

  const failure = failureOf(await generator.generate(request({ token: source.token })));

  assert.equal(failure.error.code, 'cancelled');
  assert.deepEqual(failure.usage, ZERO_USAGE);
  assert.equal(state.dispatch.length, 0);
  assert.equal(state.created.length, 0);
});
