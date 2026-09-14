/**
 * Boundary behaviour of the dsh ability-assessment generator (Sprint 18d1 repair).
 *
 * Every case drives the real `DshAssessmentGenerator` through a real `DshAuditedModelClient` with a
 * scripted provider stream and a real detached `Session`. Nothing here reaches a model: the chunks
 * are local fakes, and the assertions are about the paid boundary (one `assessment` audit call at
 * `max` effort), the untrusted-data prompt shape — the identifier-free capture payload and never an
 * account identifier, handle, statement, link or note — the trusted method section of a guided call,
 * and the strict output contract whose refusals keep the usage the provider already reported.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import { Session } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import {
  ASSESSMENT_GUIDANCE_HEADING,
  ASSESSMENT_SYSTEM_PROMPT,
  ASSESSMENT_TEMPERATURE,
  DshAssessmentGenerator,
  DshAuditedModelClient,
  type DshAuditedHost,
  type IcpcModelCallAudit,
} from '../../src/adapters/dsh/index.js';
import {
  ASSESSMENT_PROMPT_VERSION,
  type AssessmentGenerationOutcome,
} from '../../src/application/assessment-generation.js';
import type { AssessmentCapture } from '../../src/application/assessment-capture.js';
import type { ModelCallResult } from '../../src/application/ports.js';
import { captureGuidanceSnapshot, validateGuidanceMethodRegistration } from '../../src/domain/index.js';
import * as balanced from '../../packages/dsh-icpc-method-balanced/index.js';
import {
  ACCOUNT_ID,
  AT,
  CONTEST_NAME,
  HANDLE,
  PROBLEM_STATEMENT,
  RETRO_NOTE,
  USAGE,
  makeCapture,
  makeReport,
  makeRequest,
  officialRatingSnapshot,
} from '../assessment-fixtures.js';
import * as fx from '../storage/fixtures.js';

interface ScriptedCall {
  readonly payload?: unknown;
  /** Assembled provider text instead of a JSON payload. */
  readonly raw?: string;
  /** `null` reports no usage at all; `undefined` uses the default known usage. */
  readonly usage?: TokenUsage | null;
}

interface HostState {
  readonly dispatch: GenerateOptions[];
  readonly created: Session[];
}

interface Harness {
  readonly state: HostState;
  readonly generator: DshAssessmentGenerator;
}

const DEFAULT_USAGE: TokenUsage = { inputTokens: 120, outputTokens: 40 };

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
  return { state: { dispatch, created }, generator: new DshAssessmentGenerator({ client, now }) };
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

function payloadOf(options: GenerateOptions | undefined): Record<string, unknown> {
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

// ---------------------------------------------------------------------------------------
// One paid boundary per request
// ---------------------------------------------------------------------------------------

test('an assessment request is exactly one audited assessment call at max effort', async () => {
  const capture = makeCapture({ officialRating: officialRatingSnapshot() });
  const { state, generator } = harness([{ payload: makeReport() }]);

  const result = await generator.generate(makeRequest(capture));

  const outcome = valueOf<AssessmentGenerationOutcome>(result);
  assert.equal(outcome.report.priority, 'thinking');
  assert.equal(outcome.report.estimatedRange?.min, 1400);
  assert.deepEqual(result.ok ? result.usage : null, USAGE);
  assert.equal(state.dispatch.length, 1, 'one request is one paid dispatch, never a retry');
  assert.equal(state.created.length, 1, 'one request creates exactly one audit session');

  const dispatched = state.dispatch[0];
  assert.ok(dispatched);
  assert.equal(dispatched.provider, 'fake-provider');
  assert.equal(dispatched.model, 'assessment-model');
  assert.equal(dispatched.system, ASSESSMENT_SYSTEM_PROMPT, 'the unguided call uses the fixed analyst prompt');
  assert.equal(dispatched.maxTokens, 4096);
  assert.equal(dispatched.temperature, ASSESSMENT_TEMPERATURE);
  assert.equal(dispatched.reasoningEffort, 'max');

  // The prompt states the untrusted-data, citation and anchor rules literally; no evidence leaks in.
  assert.match(ASSESSMENT_SYSTEM_PROMPT, /不受信任/);
  assert.match(ASSESSMENT_SYSTEM_PROMPT, /绝不编造引用/);
  assert.match(ASSESSMENT_SYSTEM_PROMPT, /estimatedRange 必须为 null/);
  assert.equal(ASSESSMENT_SYSTEM_PROMPT.includes('1500'), false);

  const audit = auditsOf(state)[0];
  assert.ok(audit);
  assert.equal(audit.role, 'assessment', 'the audit row carries the assessment role');
  assert.equal(audit.attemptId, 'attempt-1');
  assert.equal(audit.promptVersion, ASSESSMENT_PROMPT_VERSION);
  assert.equal(audit.snapshotId, 'assessment:attempt-1');
  assert.equal((audit.options as { reasoningEffort: string }).reasoningEffort, 'max');
});

test('the payload is the identifier-free capture and never the private source evidence', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A', { statement: PROBLEM_STATEMENT });
  const capture = makeCapture({
    officialRating: officialRatingSnapshot(),
    problems: [scope.problem],
    submissions: [fx.makeSubmission(scope.account, scope.problem.ref, 'submission-secret-77', 'accepted', fx.AT)],
    retrospectives: [fx.makeRetrospective(scope.problem, scope.account.id, { recordedAt: fx.AT, note: RETRO_NOTE })],
  });
  const { state, generator } = harness([{ payload: makeReport() }]);

  valueOf<AssessmentGenerationOutcome>(await generator.generate(makeRequest(capture)));

  const dispatched = state.dispatch[0];
  const payload = payloadOf(dispatched);
  assert.deepEqual(Object.keys(payload), ['task', 'evidence']);
  assert.equal(payload.task, 'ability_assessment');
  const evidence = payload.evidence as Record<string, unknown>;
  assert.deepEqual(Object.keys(evidence), [
    'version',
    'ability',
    'officialRating',
    'anchor',
    'knowledge',
    'knowledgeTotalRows',
    'knowledgeOmittedRows',
    'virtualPerformance',
    'evidence',
    'disclosure',
  ]);
  assert.deepEqual(evidence.evidence, capture.prompt.evidence, 'the captured evidence list is sent unchanged');
  assert.deepEqual(evidence.anchor, capture.prompt.anchor);
  assert.deepEqual(evidence.officialRating, capture.prompt.officialRating);

  const text = userText(dispatched);
  const statement = scope.problem.statement;
  assert.ok(statement !== null, 'the storage fixture carries a statement');
  for (const forbidden of [
    ACCOUNT_ID,
    HANDLE,
    scope.problem.title,
    statement,
    scope.problem.url,
    'submission-secret-77',
    RETRO_NOTE,
    CONTEST_NAME,
    AT,
    'data structures',
    'segment tree',
  ]) {
    assert.equal(text.includes(forbidden), false, `the assessment prompt must not carry ${forbidden}`);
  }
});

test('a guided call keeps the selected method text in the trusted system prompt, not in the task data', async () => {
  const method = validateGuidanceMethodRegistration(balanced.balancedMethod);
  const assessment = method.assessmentGuidance;
  assert.ok(assessment !== null, 'the balanced method offers assessment guidance');
  const guidance = captureGuidanceSnapshot('assessment', [method]);
  const capture = makeCapture({ officialRating: officialRatingSnapshot(), guidance });
  const { state, generator } = harness([{ payload: makeReport() }]);

  assert.equal((await generator.generate(makeRequest(capture, { guidance }))).ok, true);

  const dispatched = state.dispatch[0];
  assert.ok(dispatched);
  const system = dispatched.system ?? '';
  assert.ok(system.startsWith(ASSESSMENT_SYSTEM_PROMPT), 'the fixed prompt stays byte-identical and comes first');
  assert.ok(system.includes(ASSESSMENT_GUIDANCE_HEADING));
  assert.ok(system.includes(method.name));
  assert.ok(system.includes(assessment.summary));
  for (const section of assessment.sections) {
    assert.ok(system.includes(section.title));
    assert.ok(system.includes(section.text));
  }
  assert.equal(
    userText(dispatched).includes(assessment.summary),
    false,
    'method instruction text is trusted system content, never untrusted task data',
  );
  assert.equal(auditsOf(state)[0]?.role, 'assessment');
});

// ---------------------------------------------------------------------------------------
// Strict output, usage accounting and refusals
// ---------------------------------------------------------------------------------------

test('malformed, unanchored and miscited answers are refused while known usage is retained', async () => {
  const anchored = makeCapture({ officialRating: officialRatingSnapshot() });
  const bare = makeCapture({ officialRating: null });
  const missing = makeReport();
  delete (missing as Record<string, unknown>)['summary'];
  const cases: readonly { readonly label: string; readonly capture: AssessmentCapture; readonly payload: unknown }[] = [
    { label: 'unknown key', capture: anchored, payload: { ...makeReport(), officialScore: 1500 } },
    { label: 'missing key', capture: anchored, payload: missing },
    { label: 'unknown evidence ref', capture: anchored, payload: makeReport({ confidenceEvidenceRefs: ['ev-invented'] }) },
    { label: 'fabricated URL', capture: anchored, payload: makeReport({ summary: '参考 https://example.org/fake-editorial 的结论' }) },
    { label: 'range without an anchor', capture: bare, payload: makeReport() },
  ];
  for (const scriptedCase of cases) {
    const { state, generator } = harness([{ payload: scriptedCase.payload }]);
    const failure = failureOf(await generator.generate(makeRequest(scriptedCase.capture)));
    assert.equal(failure.error.code, 'invalid_output', scriptedCase.label);
    assert.equal(failure.error.retryable, false, scriptedCase.label);
    assert.deepEqual(failure.usage, USAGE, `${scriptedCase.label} keeps the usage the provider reported`);
    assert.equal(state.dispatch.length, 1, `${scriptedCase.label} is never retried`);
  }

  // The honest diagnostic answer stays valid without an anchor, and usage the provider never
  // reported stays null instead of becoming a free call.
  const honest = harness([{ payload: makeReport({ estimatedRange: null, priority: 'diagnostic' }) }]);
  assert.equal(
    valueOf<AssessmentGenerationOutcome>(await honest.generator.generate(makeRequest(bare))).report.estimatedRange,
    null,
  );
  assert.deepEqual(honest.state.dispatch.length, 1);
  const unknown = harness([{ payload: makeReport(), usage: null }]);
  const unknownFailure = failureOf(await unknown.generator.generate(makeRequest(anchored)));
  assert.equal(unknownFailure.error.code, 'invalid_output');
  assert.equal(unknownFailure.usage, null, 'unknown usage is never fabricated as zero');
});
