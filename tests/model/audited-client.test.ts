/**
 * Behaviour of the audited dsh client against public host interfaces.
 *
 * The fake host uses a real detached `Session`, so the audit events are validated and replayable,
 * while streaming and flushing are scripted. Every assertion is observable behaviour — dispatch,
 * audit replay, returned usage, cleanup — never client internals.
 */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
  LlmError,
  ReasoningEffortId,
  ToolCallId,
  type GenerateOptions,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import {
  DshAuditedModelClient,
  MAX_AUDIT_MAX_TOKENS,
  MAX_AUDIT_PROMPT_BYTES,
  MAX_AUDIT_STREAM_BYTES,
  type AuditedJsonCallRequest,
  type DshAuditedHost,
  type IcpcModelCallAudit,
  type IcpcModelCallResultAudit,
} from '../../src/adapters/dsh/index.js';
import { createCancellationSource, type CancellationToken } from '../../src/domain/index.js';

const ZERO_USAGE = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const KNOWN_USAGE = { calls: 1, promptTokens: 100, completionTokens: 10, totalTokens: 110 };

interface FakeHostState {
  readonly dispatch: GenerateOptions[];
  /** Interleaved `flush`/`dispatch` labels, in call order. */
  readonly order: string[];
  readonly created: Session[];
  readonly flushed: Session[];
  readonly host: DshAuditedHost;
}

function makeHost(
  script: (options: GenerateOptions, index: number) => AsyncIterable<StreamChunk>,
  flushResults: readonly boolean[] = [],
): FakeHostState {
  const dispatch: GenerateOptions[] = [];
  const order: string[] = [];
  const created: Session[] = [];
  const flushed: Session[] = [];
  const pending = [...flushResults];
  let index = 0;
  const host: DshAuditedHost = {
    llm: {
      stream(options) {
        order.push('dispatch');
        const current = index;
        index += 1;
        dispatch.push(options);
        return script(options, current);
      },
    },
    sessions: {
      create(id: SessionId) {
        const session = Session.create(id);
        created.push(session);
        return session;
      },
      async flush(session) {
        order.push('flush');
        flushed.push(session);
        return pending.length > 0 ? pending.shift() === true : true;
      },
    },
  };
  return { dispatch, order, created, flushed, host };
}

function scripted(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  return (async function* generate(): AsyncGenerator<StreamChunk> {
    for (const chunk of chunks) {
      yield chunk;
    }
  })();
}

function textChunks(text: string, usage: TokenUsage | null = { inputTokens: 100, outputTokens: 10 }): StreamChunk[] {
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

/** A stream that never settles and ignores abort; `onClose` observes best-effort cleanup. */
function hangingStream(onClose: () => void): AsyncIterable<StreamChunk> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
      return {
        next: () => new Promise<IteratorResult<StreamChunk>>(() => undefined),
        return: () => {
          onClose();
          return new Promise<IteratorResult<StreamChunk>>(() => undefined);
        },
      };
    },
  };
}

function request(overrides: Partial<AuditedJsonCallRequest> = {}): AuditedJsonCallRequest {
  return {
    provider: 'fake-provider',
    model: 'fake-model',
    system: 'You return JSON.',
    userPrompt: 'Tag this problem.',
    maxTokens: 1024,
    temperature: 0,
    timeoutMs: 2_000,
    token: createCancellationSource().token,
    attemptId: 'attempt-1',
    promptVersion: 'analysis-v1',
    role: 'analysis',
    snapshotId: 'snapshot-1',
    ...overrides,
  };
}

function eventsOf(session: Session | undefined): readonly SessionEvent[] {
  return session?.snapshotEvents() ?? [];
}

function inputAudit(event: SessionEvent | undefined): IcpcModelCallAudit {
  assert.equal(event?.type, 'icpc/model-call-audit');
  return event?.data as IcpcModelCallAudit;
}

function resultAudit(event: SessionEvent | undefined): IcpcModelCallResultAudit {
  assert.equal(event?.type, 'icpc/model-call-result');
  return event?.data as IcpcModelCallResultAudit;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${label}`);
    }
    await delay(5);
  }
}

void test('valid JSON is adopted and the exact dispatch is audited before it happens', async () => {
  const state = makeHost(() => scripted(textChunks('{"tags":["greedy"]}')));
  const client = new DshAuditedModelClient(state.host, { now: () => '2026-09-12T08:00:00.000Z' });

  const result = await client.callJson(request(), (value) => value as { tags: string[] });

  assert.ok(result.ok);
  assert.deepEqual(result.value, { tags: ['greedy'] });
  assert.deepEqual(result.usage, KNOWN_USAGE);
  assert.equal(result.sessionId, state.created[0]?.id);
  assert.deepEqual(state.order, ['flush', 'dispatch', 'flush']);
  assert.equal(state.created.length, 1);
  assert.equal(state.dispatch.length, 1);
  assert.match(String(state.created[0]?.id), /^icpc-audit-/);
  assert.notEqual(String(state.created[0]?.id).startsWith('session-'), true);

  const dispatched = state.dispatch[0];
  assert.ok(dispatched);
  assert.equal('purpose' in dispatched, false);
  assert.equal(dispatched.provider, 'fake-provider');
  assert.equal(dispatched.model, 'fake-model');
  assert.equal(dispatched.system, 'You return JSON.');
  assert.equal(dispatched.maxTokens, 1024);
  assert.equal(dispatched.sessionId, state.created[0]?.id);
  assert.ok(dispatched.signal instanceof AbortSignal);
  assert.equal(dispatched.messages.length, 1);
  assert.equal(dispatched.messages[0]?.role, 'user');
  assert.deepEqual(dispatched.messages[0]?.content, [{ type: 'text', text: 'Tag this problem.' }]);

  const events = eventsOf(state.created[0]);
  assert.deepEqual(
    events.map((event) => event.type),
    ['icpc/model-call-audit', 'icpc/model-call-result'],
  );
  const input = inputAudit(events[0]);
  assert.equal(input.callId, result.callId);
  assert.equal(input.attemptId, 'attempt-1');
  assert.equal(input.role, 'analysis');
  assert.equal(input.provider, 'fake-provider');
  assert.equal(input.model, 'fake-model');
  assert.equal(input.snapshotId, 'snapshot-1');
  assert.equal(input.promptVersion, 'analysis-v1');
  assert.equal(input.sessionId, result.sessionId);
  assert.equal(input.recordedAt, '2026-09-12T08:00:00.000Z');
  assert.equal(input.system, 'You return JSON.');
  // The cap and the audit count the fully serialized input, not the raw prompt concatenation.
  assert.equal(
    input.promptBytes,
    Buffer.byteLength(JSON.stringify({ system: 'You return JSON.', userPrompt: 'Tag this problem.' }), 'utf8'),
  );
  const auditedMessages = input.messages as unknown as readonly {
    readonly id: string;
    readonly role: string;
    readonly content: unknown;
    readonly source: unknown;
  }[];
  assert.equal(auditedMessages.length, 1);
  assert.equal(auditedMessages[0]?.id, dispatched.messages[0]?.id);
  assert.equal(auditedMessages[0]?.role, 'user');
  assert.deepEqual(auditedMessages[0]?.content, [{ type: 'text', text: 'Tag this problem.' }]);
  assert.deepEqual(auditedMessages[0]?.source, { kind: 'user' });
  assert.equal('signal' in (input.options as unknown as Record<string, unknown>), false);
  assert.equal('purpose' in (input.options as unknown as Record<string, unknown>), false);
  assert.deepEqual(input.options as unknown, {
    provider: 'fake-provider',
    model: 'fake-model',
    maxTokens: 1024,
    temperature: 0,
    // The audited options replay the effort actually dispatched: the approved default here.
    reasoningEffort: 'max',
    sessionId: String(state.created[0]?.id),
  });

  const streamed = resultAudit(events[1]);
  assert.equal(streamed.callId, result.callId);
  assert.equal(streamed.attemptId, 'attempt-1');
  assert.equal(streamed.outcome, 'ok');
  assert.equal(streamed.code, null);
  assert.equal(streamed.finish, 'stop');
  assert.equal(streamed.text, '{"tags":["greedy"]}');
  assert.deepEqual(streamed.usage, KNOWN_USAGE);
  assert.equal(Array.isArray(streamed.chunks) && streamed.chunks.length === 5, true);
  // Audit events are log-only: they must never fabricate model-visible history.
  assert.deepEqual(state.created[0]?.deriveMessages(), []);
});

void test('two calls reuse one dedicated session and keep distinct call ids', async () => {
  const state = makeHost(() => scripted(textChunks('{"ok":true}')));
  const client = new DshAuditedModelClient(state.host);

  const first = await client.callJson(request(), () => true);
  const second = await client.callJson(request({ attemptId: 'attempt-2' }), () => true);

  assert.ok(first.ok && second.ok);
  assert.notEqual(first.callId, second.callId);
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(state.created.length, 1);
  assert.equal(state.dispatch.length, 2);
  const events = eventsOf(state.created[0]);
  assert.deepEqual(
    events.map((event) => event.type),
    ['icpc/model-call-audit', 'icpc/model-call-result', 'icpc/model-call-audit', 'icpc/model-call-result'],
  );
  assert.equal(inputAudit(events[0]).attemptId, 'attempt-1');
  assert.equal(inputAudit(events[2]).attemptId, 'attempt-2');
  assert.notEqual(inputAudit(events[0]).callId, inputAudit(events[2]).callId);
});

void test('a non-durable input audit refuses dispatch with known-zero usage', async () => {
  const state = makeHost(() => scripted(textChunks('{"ok":true}')), [false]);
  const client = new DshAuditedModelClient(state.host);

  const result = await client.callJson(request(), () => true);

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail('a non-durable input audit must refuse dispatch');
  }
  assert.equal(result.error.code, 'provider_error');
  assert.deepEqual(result.usage, ZERO_USAGE);
  assert.equal(result.sessionId, state.created[0]?.id);
  assert.deepEqual(state.order, ['flush']);
  assert.equal(state.dispatch.length, 0);
  assert.equal(state.flushed.length, 1);
  const events = eventsOf(state.created[0]);
  assert.deepEqual(
    events.map((event) => event.type),
    ['icpc/model-call-audit'],
  );
});

void test('a non-durable output audit never adopts a valid-looking value', async () => {
  const state = makeHost(() => scripted(textChunks('{"ok":true}')), [true, false]);
  const client = new DshAuditedModelClient(state.host);

  const result = await client.callJson(request(), () => 'ADOPTED');

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail('a non-durable output audit must not be adopted');
  }
  assert.equal(result.error.code, 'provider_error');
  // The call happened, so its known cost is still reported (unknown would be `null`).
  assert.deepEqual(result.usage, KNOWN_USAGE);
  assert.equal(result.sessionId, state.created[0]?.id);
  assert.equal(state.dispatch.length, 1);
  assert.deepEqual(state.order, ['flush', 'dispatch', 'flush']);
  const events = eventsOf(state.created[0]);
  assert.equal(events.length, 2);
  assert.equal(resultAudit(events[1]).outcome, 'ok');
});

void test('a stream without usable usage fails with unknown usage, never zero', async () => {
  const missing = makeHost(() => scripted(textChunks('{"ok":true}', null)));
  const missingResult = await new DshAuditedModelClient(missing.host).callJson(request(), () => true);
  assert.equal(missingResult.ok, false);
  if (missingResult.ok) {
    assert.fail('missing usage must not be adopted');
  }
  assert.equal(missingResult.error.code, 'invalid_output');
  assert.equal(missingResult.usage, null);
  const missingAudit = resultAudit(eventsOf(missing.created[0])[1]);
  assert.equal(missingAudit.outcome, 'failed');
  assert.equal(missingAudit.rawUsage, null);
  assert.equal(missingAudit.usage, null);

  const invalid = makeHost(() =>
    scripted(textChunks('{"ok":true}', { inputTokens: -1, outputTokens: 5 } as unknown as TokenUsage)),
  );
  const invalidResult = await new DshAuditedModelClient(invalid.host).callJson(request(), () => true);
  assert.equal(invalidResult.ok, false);
  assert.equal(invalidResult.usage, null);
});

void test('a provider failure keeps its known usage and stays sanitized in the result', async () => {
  const state = makeHost(() =>
    scripted([
      { type: 'usage', usage: { inputTokens: 40, outputTokens: 0 } },
      { type: 'finish', reason: { kind: 'error', failure: { code: 'E_UPSTREAM', message: 'upstream exploded' } } },
    ]),
  );
  const client = new DshAuditedModelClient(state.host);

  const result = await client.callJson(request(), () => true);

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail('a provider failure is never adopted');
  }
  assert.equal(result.error.code, 'provider_error');
  assert.equal(result.error.message.includes('upstream exploded'), false);
  assert.deepEqual(result.usage, { calls: 1, promptTokens: 40, completionTokens: 0, totalTokens: 40 });
  const audit = resultAudit(eventsOf(state.created[0])[1]);
  assert.equal(audit.outcome, 'failed');
  // Stage 25c: the upstream message is a diagnostic payload and is never recorded; the detail is
  // the fixed local projection and the kept finish replay is projected too.
  assert.equal(String(audit.detail).includes('upstream exploded'), false);
  assert.equal(audit.detail, 'the upstream provider reported provider_error');
  assert.deepEqual(audit.chunks, [
    { type: 'usage', usage: { inputTokens: 40, outputTokens: 0 } },
    { type: 'finish', reason: { kind: 'error', code: 'provider_error' } },
  ]);
});

void test('missing finish, max-tokens and tool-call finishes are invalid output', async () => {
  const cases: readonly { readonly label: string; readonly chunks: readonly StreamChunk[] }[] = [
    {
      label: 'missing finish',
      chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: '{"ok":true}' },
        { type: 'block-end', index: 0, block: { type: 'text', text: '{"ok":true}' } },
        { type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } },
      ],
    },
    {
      label: 'max-tokens',
      chunks: textChunks('{"ok":true}').map((chunk) =>
        chunk.type === 'finish' ? { type: 'finish', reason: { kind: 'max-tokens' } } : chunk,
      ),
    },
    {
      label: 'tool-calls',
      chunks: textChunks('{"ok":true}').map((chunk) =>
        chunk.type === 'finish' ? { type: 'finish', reason: { kind: 'tool-calls' } } : chunk,
      ),
    },
  ];
  for (const entry of cases) {
    const state = makeHost(() => scripted(entry.chunks));
    const result = await new DshAuditedModelClient(state.host).callJson(request(), () => true);
    assert.equal(result.ok, false, entry.label);
    if (result.ok) {
      assert.fail(`${entry.label} must not be adopted`);
    }
    assert.equal(result.error.code, 'invalid_output', entry.label);
  }
});

void test('only one whole JSON document is accepted', async () => {
  const fenced = makeHost(() => scripted(textChunks('```json\n{"ok":true}\n```')));
  const fencedResult = await new DshAuditedModelClient(fenced.host).callJson(request(), (value) => value);
  assert.ok(fencedResult.ok);
  assert.deepEqual(fencedResult.value, { ok: true });

  for (const text of ['Here is the JSON: {"ok":true}', '{"ok":true}{"ok":false}', 'not json at all']) {
    const state = makeHost(() => scripted(textChunks(text)));
    const result = await new DshAuditedModelClient(state.host).callJson(request(), (value) => value);
    assert.equal(result.ok, false, text);
    if (result.ok) {
      assert.fail(`text "${text}" must not be adopted`);
    }
    assert.equal(result.error.code, 'invalid_output', text);
  }

  const rejecting = makeHost(() => scripted(textChunks('{"ok":true}')));
  const rejected = await new DshAuditedModelClient(rejecting.host).callJson(request(), () => {
    throw new Error('shape rejected by the callback');
  });
  assert.equal(rejected.ok, false);
  if (rejected.ok) {
    assert.fail('a rejecting callback must not be adopted');
  }
  assert.equal(rejected.error.code, 'invalid_output');
});

void test('an unsupported assembled block is invalid output', async () => {
  const state = makeHost(() =>
    scripted([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('tool-1'), name: 'tag', arguments: '{}' } },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]),
  );
  const result = await new DshAuditedModelClient(state.host).callJson(request(), () => true);

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail('a tool-call block is not JSON output');
  }
  assert.equal(result.error.code, 'invalid_output');
});

void test('timeout and cancellation release a stream that ignores the abort signal', async () => {
  let timeoutsClosed = 0;
  const timeoutState = makeHost(() => hangingStream(() => (timeoutsClosed += 1)));
  const timeoutClient = new DshAuditedModelClient(timeoutState.host);
  const started = Date.now();
  const timedOut = await timeoutClient.callJson(request({ timeoutMs: 25 }), () => true);

  assert.equal(timedOut.ok, false);
  if (timedOut.ok) {
    assert.fail('a hanging stream must time out');
  }
  assert.equal(timedOut.error.code, 'timeout');
  assert.equal(timedOut.usage, null);
  assert.equal(timeoutState.dispatch[0]?.signal?.aborted, true);
  assert.ok(Date.now() - started >= 20);
  // The provider ignored the signal; the client must still release the iterator itself.
  await waitFor(() => timeoutsClosed === 1, 'iterator cleanup after timeout');

  let cancelsClosed = 0;
  const cancelState = makeHost(() => hangingStream(() => (cancelsClosed += 1)));
  const source = createCancellationSource();
  const pending = new DshAuditedModelClient(cancelState.host).callJson(
    request({ token: source.token, timeoutMs: 5_000 }),
    () => true,
  );
  await delay(10);
  source.cancel('test cancellation');
  const cancelled = await pending;

  assert.equal(cancelled.ok, false);
  if (cancelled.ok) {
    assert.fail('a cancelled call must not be adopted');
  }
  assert.equal(cancelled.error.code, 'cancelled');
  assert.equal(cancelled.usage, null);
  await waitFor(() => cancelsClosed === 1, 'iterator cleanup after cancellation');
});

void test('cache counts are added to the uncached prompt input exactly once', async () => {
  const usage: TokenUsage = {
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 20,
    cacheWriteTokens: 5,
    reasoningTokens: 7,
    totalTokens: 135,
  };
  const state = makeHost(() => scripted(textChunks('{"ok":true}', usage)));

  const result = await new DshAuditedModelClient(state.host).callJson(request(), () => true);

  assert.ok(result.ok);
  // Uncached input + cache read + cache write; output already includes reasoning exactly once.
  assert.deepEqual(result.usage, { calls: 1, promptTokens: 125, completionTokens: 10, totalTokens: 135 });
  assert.deepEqual(resultAudit(eventsOf(state.created[0])[1]).rawUsage, usage);
});

void test('oversized or unsupported requests are refused before any session or dispatch', async () => {
  const state = makeHost(() => scripted(textChunks('{"ok":true}')));
  const client = new DshAuditedModelClient(state.host);

  const oversized = await client.callJson(
    request({ userPrompt: 'a'.repeat(MAX_AUDIT_PROMPT_BYTES + 1) }),
    () => true,
  );
  assert.equal(oversized.ok, false);
  if (oversized.ok) {
    assert.fail('an oversized prompt must be refused');
  }
  assert.equal(oversized.error.code, 'unsupported');
  assert.deepEqual(oversized.usage, ZERO_USAGE);
  assert.equal(state.created.length, 0);
  assert.equal(state.dispatch.length, 0);

  const tooManyTokens = await client.callJson(request({ maxTokens: MAX_AUDIT_MAX_TOKENS + 1 }), () => true);
  assert.equal(tooManyTokens.ok, false);
  const badTimeout = await client.callJson(request({ timeoutMs: 0 }), () => true);
  assert.equal(badTimeout.ok, false);
  assert.equal(state.created.length, 0);
  assert.equal(state.dispatch.length, 0);

  const blankEffort = await client.callJson(request({ effort: '' as ReasoningEffortId }), () => true);
  assert.equal(blankEffort.ok, false);
  if (blankEffort.ok) {
    assert.fail('a blank effort must be refused');
  }
  assert.equal(blankEffort.error.code, 'unsupported');

  // The cap counts the serialized input, so JSON escaping can push a short raw prompt over it.
  const expanded = await client.callJson(request({ userPrompt: '"'.repeat(MAX_AUDIT_PROMPT_BYTES / 2 + 1) }), () => true);
  assert.equal(expanded.ok, false);
  if (expanded.ok) {
    assert.fail('a prompt expanded by JSON escaping must be refused');
  }
  assert.equal(expanded.error.code, 'unsupported');
  assert.equal(state.dispatch.length, 0);

  const atCap = await client.callJson(
    request({
      userPrompt: 'a'.repeat(
        MAX_AUDIT_PROMPT_BYTES -
          Buffer.byteLength(JSON.stringify({ system: 'You return JSON.', userPrompt: '' }), 'utf8'),
      ),
    }),
    () => true,
  );
  assert.ok(atCap.ok);
  assert.equal(state.dispatch.length, 1);
});

// ---------------------------------------------------------------------------------------
// Cancellation, whole-call deadline, context, raw-chunk and failure-code boundaries
// ---------------------------------------------------------------------------------------

/** Assert one bounded refusal: a mapped code, the expected usage and no dispatch. */
function assertRefused(
  result: Awaited<ReturnType<DshAuditedModelClient['callJson']>>,
  code: string,
  usage: unknown,
  state: FakeHostState,
): void {
  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail(`a refused call must not be adopted (${code})`);
  }
  assert.equal(result.error.code, code);
  assert.deepEqual(result.usage, usage);
  assert.equal(state.dispatch.length, 0);
}

void test('an already-cancelled token refuses before any audit session or stream', async () => {
  const state = makeHost(() => scripted(textChunks('{"ok":true}')));
  const source = createCancellationSource();
  source.cancel('test cancellation before the call');

  const result = await new DshAuditedModelClient(state.host).callJson(request({ token: source.token }), () => true);

  assertRefused(result, 'cancelled', ZERO_USAGE, state);
  assert.equal(result.sessionId, null);
  assert.equal(state.created.length, 0);
  assert.deepEqual(state.order, []);
});

void test('a cancellation observed while the input audit flushes never dispatches', async () => {
  const state = makeHost(() => scripted(textChunks('{"ok":true}')));
  const source = createCancellationSource();
  const host: DshAuditedHost = {
    llm: { stream: (options) => state.host.llm.stream(options) },
    sessions: {
      create: (id) => state.host.sessions.create(id),
      async flush(session) {
        const durable = await state.host.sessions.flush(session);
        source.cancel('test cancellation during the input audit flush');
        return durable;
      },
    },
  };

  const result = await new DshAuditedModelClient(host).callJson(request({ token: source.token }), () => true);

  assertRefused(result, 'cancelled', ZERO_USAGE, state);
  // The input record was appended and flushed before the cancellation was observed.
  assert.equal(state.flushed.length, 1);
});

void test('a cancellation observed while the output audit flushes refuses the value but keeps usage', async () => {
  const state = makeHost(() => scripted(textChunks('{"ok":true}')));
  const source = createCancellationSource();
  let flushes = 0;
  const host: DshAuditedHost = {
    llm: { stream: (options) => state.host.llm.stream(options) },
    sessions: {
      create: (id) => state.host.sessions.create(id),
      async flush(session) {
        flushes += 1;
        const durable = await state.host.sessions.flush(session);
        if (flushes === 2) {
          source.cancel('test cancellation during the output audit flush');
        }
        return durable;
      },
    },
  };

  const result = await new DshAuditedModelClient(host).callJson(request({ token: source.token }), () => 'ADOPTED');

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail('a cancelled call must not be adopted');
  }
  assert.equal(result.error.code, 'cancelled');
  assert.deepEqual(result.usage, KNOWN_USAGE);
  assert.equal(result.sessionId, state.created[0]?.id);
  assert.equal(state.dispatch.length, 1);
  // The stream itself completed, so its audit still replays that success; only the value is refused.
  assert.equal(resultAudit(eventsOf(state.created[0])[1]).outcome, 'ok');
  assert.equal(resultAudit(eventsOf(state.created[0])[1]).usage as unknown !== null, true);
});

void test('an explicit maxTokens is never clamped by the declared default, which is audited', async () => {
  const state = makeHost(() => scripted(textChunks('{"ok":true}')));
  const host: DshAuditedHost = {
    llm: {
      stream: (options) => state.host.llm.stream(options),
      resolveModelInfo: async () => ({ defaultMaxTokens: 64, context: { contextWindow: 1_000_000 } }),
    },
    sessions: state.host.sessions,
  };

  const result = await new DshAuditedModelClient(host).callJson(
    request({ maxTokens: MAX_AUDIT_MAX_TOKENS }),
    () => true,
  );

  assert.ok(result.ok);
  assert.equal(state.dispatch[0]?.maxTokens, MAX_AUDIT_MAX_TOKENS);
  // No effort was requested, so the approved default is dispatched even without a declared one.
  assert.equal(state.dispatch[0]?.reasoningEffort, ReasoningEffortId('max'));
  assert.deepEqual(inputAudit(eventsOf(state.created[0])[0]).capability, {
    resolved: true,
    defaultMaxTokens: 64,
    contextWindow: 1_000_000,
  });
});

void test('an omitted effort uses the approved default, never the host default', async () => {
  const declared = makeHost(() => scripted(textChunks('{"ok":true}')));
  const declaredHost: DshAuditedHost = {
    llm: {
      stream: (options) => declared.host.llm.stream(options),
      resolveModelInfo: async () => ({ reasoning: { defaultEffort: ReasoningEffortId('high') } }),
    },
    sessions: declared.host.sessions,
  };
  const declaredClient = new DshAuditedModelClient(declaredHost);

  const omitted = await declaredClient.callJson(request(), () => true);
  assert.ok(omitted.ok);
  assert.equal(declared.dispatch[0]?.reasoningEffort, ReasoningEffortId('max'));

  const explicit = await declaredClient.callJson(request({ effort: ReasoningEffortId('low') }), () => true);
  assert.ok(explicit.ok);
  assert.equal(declared.dispatch[1]?.reasoningEffort, ReasoningEffortId('low'));
  const events = eventsOf(declared.created[0]);
  assert.equal((inputAudit(events[0]).options as unknown as Record<string, unknown>)['reasoningEffort'], 'max');
  assert.equal((inputAudit(events[2]).options as unknown as Record<string, unknown>)['reasoningEffort'], 'low');

  // The approved default survives a lookup that is absent or fails; an explicit effort still wins.
  const absent = makeHost(() => scripted(textChunks('{"ok":true}')));
  const absentResult = await new DshAuditedModelClient(absent.host).callJson(request(), () => true);
  assert.ok(absentResult.ok);
  assert.equal(absent.dispatch[0]?.reasoningEffort, ReasoningEffortId('max'));

  const failing = makeHost(() => scripted(textChunks('{"ok":true}')));
  const failingHost: DshAuditedHost = {
    llm: {
      stream: (options) => failing.host.llm.stream(options),
      resolveModelInfo: async () => {
        throw new Error('capability endpoint unavailable');
      },
    },
    sessions: failing.host.sessions,
  };
  const failingClient = new DshAuditedModelClient(failingHost);
  const failingDefault = await failingClient.callJson(request(), () => true);
  assert.ok(failingDefault.ok);
  assert.equal(failing.dispatch[0]?.reasoningEffort, ReasoningEffortId('max'));
  const failingExplicit = await failingClient.callJson(request({ effort: ReasoningEffortId('low') }), () => true);
  assert.ok(failingExplicit.ok);
  assert.equal(failing.dispatch[1]?.reasoningEffort, ReasoningEffortId('low'));
});

void test('a request that cannot fit a known context window is refused instead of truncated', async () => {
  const state = makeHost(() => scripted(textChunks('{"ok":true}')));
  const host: DshAuditedHost = {
    llm: {
      stream: (options) => state.host.llm.stream(options),
      resolveModelInfo: async () => ({ context: { contextWindow: 10 } }),
    },
    sessions: state.host.sessions,
  };

  const result = await new DshAuditedModelClient(host).callJson(request({ maxTokens: 1024 }), () => true);

  assertRefused(result, 'unsupported', ZERO_USAGE, state);
  if (result.ok) {
    assert.fail('an unfittable request must not be dispatched');
  }
  assert.equal(result.error.retryable, false);
  const events = eventsOf(state.created[0]);
  assert.deepEqual(
    events.map((event) => event.type),
    ['icpc/model-call-audit', 'icpc/model-call-result'],
  );
  // The refusal is auditable: the input record carries the resolved capability it was based on.
  assert.deepEqual(inputAudit(events[0]).capability, { resolved: true, defaultMaxTokens: null, contextWindow: 10 });
  assert.equal(resultAudit(events[1]).outcome, 'failed');
  assert.equal(resultAudit(events[1]).code, 'unsupported');
});

void test('a failed capability lookup is audited, invents no cap and still dispatches', async () => {
  const state = makeHost(() => scripted(textChunks('{"ok":true}')));
  const host: DshAuditedHost = {
    llm: {
      stream: (options) => state.host.llm.stream(options),
      resolveModelInfo: async () => {
        throw new Error('capability endpoint unavailable');
      },
    },
    sessions: state.host.sessions,
  };

  const result = await new DshAuditedModelClient(host).callJson(request({ maxTokens: 512 }), () => true);

  assert.ok(result.ok);
  assert.equal(state.dispatch[0]?.maxTokens, 512);
  const capability = inputAudit(eventsOf(state.created[0])[0]).capability as unknown as Record<string, unknown>;
  assert.equal(capability['resolved'], false);
  // Stage 25c: the lookup exception is projected; its message is never recorded.
  assert.equal(capability['error'], 'an upstream host exception was projected (mapped code=provider_error)');
  assert.equal(String(capability['error']).includes('capability endpoint unavailable'), false);
});

void test('an oversized raw block-end or finish replay is invalid output, never truncated', async () => {
  const giant = 'a'.repeat(MAX_AUDIT_STREAM_BYTES + 10);
  const cases: readonly { readonly label: string; readonly chunks: readonly StreamChunk[] }[] = [
    {
      label: 'block-end',
      chunks: [
        { type: 'usage', usage: { inputTokens: 7, outputTokens: 1 } },
        { type: 'block-end', index: 0, block: { type: 'text', text: giant } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
    {
      label: 'finish replay',
      chunks: [
        { type: 'usage', usage: { inputTokens: 7, outputTokens: 1 } },
        { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { blob: giant } } },
      ],
    },
  ];
  for (const entry of cases) {
    const state = makeHost(() => scripted(entry.chunks));
    const result = await new DshAuditedModelClient(state.host).callJson(request(), () => true);

    assert.equal(result.ok, false, entry.label);
    if (result.ok) {
      assert.fail(`${entry.label} must not be adopted`);
    }
    assert.equal(result.error.code, 'invalid_output', entry.label);
    // Known usage of the valid chunks received before the oversized one is retained.
    assert.deepEqual(result.usage, { calls: 1, promptTokens: 7, completionTokens: 1, totalTokens: 8 }, entry.label);
    assert.equal(state.dispatch[0]?.signal?.aborted, true, entry.label);
    const audit = resultAudit(eventsOf(state.created[0])[1]);
    assert.equal(audit.outcome, 'failed', entry.label);
    assert.equal(Array.isArray(audit.chunks) && audit.chunks.length === 1, true, entry.label);
    const omitted = audit.omittedChunk as unknown as { readonly bytes?: number } | null;
    assert.equal(typeof omitted?.bytes, 'number', entry.label);
    assert.ok((omitted?.bytes ?? 0) > MAX_AUDIT_STREAM_BYTES, entry.label);
  }
});

void test('a raw chunk JSON cannot round-trip faithfully is invalid output', async () => {
  const cyclic: Record<string, unknown> = { type: 'text-delta', index: 0, text: '{}' };
  cyclic['self'] = cyclic;
  const cases: readonly { readonly label: string; readonly chunk: StreamChunk }[] = [
    {
      label: 'undefined field',
      chunk: { type: 'text-delta', index: 0, text: '{}', extra: undefined } as unknown as StreamChunk,
    },
    {
      label: 'bigint field',
      chunk: { type: 'text-delta', index: 0, text: '{}', extra: 1n } as unknown as StreamChunk,
    },
    { label: 'cyclic chunk', chunk: cyclic as unknown as StreamChunk },
    {
      label: 'date field',
      chunk: { type: 'text-delta', index: 0, text: '{}', extra: new Date(0) } as unknown as StreamChunk,
    },
  ];
  for (const entry of cases) {
    const state = makeHost(() => scripted([entry.chunk]));
    const result = await new DshAuditedModelClient(state.host).callJson(request(), () => true);

    assert.equal(result.ok, false, entry.label);
    if (result.ok) {
      assert.fail(`${entry.label} must not be adopted`);
    }
    assert.equal(result.error.code, 'invalid_output', entry.label);
    const audit = resultAudit(eventsOf(state.created[0])[1]);
    assert.equal(audit.outcome, 'failed', entry.label);
    assert.equal(Array.isArray(audit.chunks) && audit.chunks.length === 0, true, entry.label);
    assert.equal(audit.omittedChunk !== null, true, entry.label);
  }
});

void test('hanging capability, input flush and output flush stay bounded by the deadline', async () => {
  const started = Date.now();

  const hangingInfoState = makeHost(() => scripted(textChunks('{"ok":true}')));
  let lookupSignal: AbortSignal | undefined;
  const hangingInfo: DshAuditedHost = {
    llm: {
      stream: (options) => hangingInfoState.host.llm.stream(options),
      resolveModelInfo: (_provider, _model, signal) => {
        lookupSignal = signal;
        return new Promise<never>(() => undefined);
      },
    },
    sessions: hangingInfoState.host.sessions,
  };
  const infoResult = await new DshAuditedModelClient(hangingInfo).callJson(request({ timeoutMs: 40 }), () => true);
  assertRefused(infoResult, 'timeout', ZERO_USAGE, hangingInfoState);
  // A lookup that ignored the deadline is still released when the call exits.
  assert.equal(lookupSignal?.aborted, true);

  const hangingInputState = makeHost(() => scripted(textChunks('{"ok":true}')));
  const hangingInput: DshAuditedHost = {
    llm: hangingInputState.host.llm,
    sessions: {
      create: (id) => hangingInputState.host.sessions.create(id),
      flush: () => new Promise<boolean>(() => undefined),
    },
  };
  const inputResult = await new DshAuditedModelClient(hangingInput).callJson(request({ timeoutMs: 40 }), () => true);
  assertRefused(inputResult, 'timeout', ZERO_USAGE, hangingInputState);

  const hangingOutputState = makeHost(() => scripted(textChunks('{"ok":true}')));
  let flushes = 0;
  const hangingOutput: DshAuditedHost = {
    llm: hangingOutputState.host.llm,
    sessions: {
      create: (id) => hangingOutputState.host.sessions.create(id),
      flush() {
        flushes += 1;
        return flushes === 1 ? Promise.resolve(true) : new Promise<boolean>(() => undefined);
      },
    },
  };
  const outputResult = await new DshAuditedModelClient(hangingOutput).callJson(request({ timeoutMs: 40 }), () => true);

  assert.equal(outputResult.ok, false);
  if (outputResult.ok) {
    assert.fail('a hanging output flush must not adopt a valid-looking value');
  }
  assert.equal(outputResult.error.code, 'timeout');
  assert.deepEqual(outputResult.usage, KNOWN_USAGE);
  assert.equal(hangingOutputState.dispatch.length, 1);
  // The provider stream parked on the signal is released when the call exits.
  assert.equal(hangingOutputState.dispatch[0]?.signal?.aborted, true);
  assert.ok(Date.now() - started < 5_000);
});

void test('a cancelled refusal never waits for a hanging result flush', async () => {
  const state = makeHost(() => scripted(textChunks('{"ok":true}')));
  const source = createCancellationSource();
  const real = source.token;
  let armOnRelease = false;
  // The token cancels itself exactly when the client releases the input-flush race: the race has
  // already adopted its durable value, so the cancellation is observed at the pre-dispatch check
  // and the refusal still has to append and flush its own result row.
  const token: CancellationToken = {
    get cancelled() {
      return real.cancelled;
    },
    get reason() {
      return real.reason;
    },
    throwIfCancelled() {
      real.throwIfCancelled();
    },
    onCancel(handler) {
      const off = real.onCancel(handler);
      return () => {
        off();
        if (armOnRelease) {
          armOnRelease = false;
          source.cancel('cancellation released with the input flush race');
        }
      };
    },
  };
  let flushes = 0;
  const host: DshAuditedHost = {
    llm: { stream: (options) => state.host.llm.stream(options) },
    sessions: {
      create: (id) => state.host.sessions.create(id),
      flush() {
        flushes += 1;
        if (flushes === 1) {
          armOnRelease = true;
          return Promise.resolve(true);
        }
        // The refusal flush hangs: the caller must still be released promptly.
        return new Promise<boolean>(() => undefined);
      },
    },
  };

  const started = Date.now();
  const result = await new DshAuditedModelClient(host).callJson(
    request({ token, timeoutMs: 180_000 }),
    () => 'ADOPTED',
  );

  assertRefused(result, 'cancelled', ZERO_USAGE, state);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(flushes, 2);
  const events = eventsOf(state.created[0]);
  assert.deepEqual(
    events.map((event) => event.type),
    ['icpc/model-call-audit', 'icpc/model-call-result'],
  );
  assert.equal(resultAudit(events[1]).code, 'cancelled');
  assert.equal(resultAudit(events[1]).outcome, 'failed');
  assert.deepEqual(resultAudit(events[1]).usage, ZERO_USAGE);
});

void test('raw replay metadata keeps a literal __proto__ key instead of mutating a prototype', async () => {
  const metadata = JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown>;
  const chunks = textChunks('{"ok":true}').map((chunk) =>
    chunk.type === 'finish' ? ({ ...chunk, replayState: metadata } as unknown as StreamChunk) : chunk,
  );
  const state = makeHost(() => scripted(chunks));

  const result = await new DshAuditedModelClient(state.host).callJson(request(), () => true);

  assert.ok(result.ok);
  const auditedChunks = resultAudit(eventsOf(state.created[0])[1]).chunks as unknown as readonly Record<
    string,
    unknown
  >[];
  const replayState = auditedChunks[4]?.['replayState'] as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(replayState, '__proto__'), true);
  assert.deepEqual(replayState['__proto__'], { x: 1 });
  assert.equal(Object.getPrototypeOf(replayState), Object.prototype);
  assert.equal(JSON.stringify(replayState), '{"__proto__":{"x":1}}');
  assert.equal(({} as Record<string, unknown>)['x'], undefined);
});

void test('typed provider failures route by code and never echo provider text', async () => {
  const cases: readonly { readonly code: string; readonly expected: string }[] = [
    { code: 'QUOTA', expected: 'quota_exhausted' },
    { code: 'RATE_LIMIT', expected: 'rate_limited' },
    { code: 'AUTH', expected: 'unsupported' },
    { code: 'NO_ADAPTER', expected: 'unsupported' },
    { code: 'INVALID_ARGS', expected: 'unsupported' },
    { code: 'CONTEXT_WINDOW_EXCEEDED', expected: 'unsupported' },
    { code: 'E_UPSTREAM', expected: 'provider_error' },
  ];
  for (const entry of cases) {
    const state = makeHost(() =>
      scripted([
        { type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } },
        {
          type: 'finish',
          reason: { kind: 'error', failure: { code: entry.code, message: 'provider detail text' } },
        },
      ]),
    );
    const result = await new DshAuditedModelClient(state.host).callJson(request(), () => true);

    assert.equal(result.ok, false, entry.code);
    if (result.ok) {
      assert.fail(`${entry.code} must not be adopted`);
    }
    assert.equal(result.error.code, entry.expected, entry.code);
    assert.equal(result.error.message.includes('provider detail text'), false, entry.code);
    assert.equal(result.error.message.includes(entry.code), false, entry.code);
    assert.deepEqual(result.usage, { calls: 1, promptTokens: 5, completionTokens: 1, totalTokens: 6 }, entry.code);
    const audit = resultAudit(eventsOf(state.created[0])[1]);
    // Stage 25c: neither the provider's message nor its own code text is recorded, in the detail
    // or in the projected finish replay.
    assert.equal(String(audit.detail).includes('provider detail text'), false, entry.code);
    assert.equal(String(audit.detail).includes(entry.code), false, entry.code);
    assert.equal(audit.detail, `the upstream provider reported ${entry.expected}`, entry.code);
    const finishReplay = (audit.chunks as unknown as readonly Record<string, unknown>[])[1];
    assert.deepEqual(finishReplay, { type: 'finish', reason: { kind: 'error', code: entry.expected } }, entry.code);
  }

  const thrownState = makeHost(() => ({
    [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
      throw new LlmError('quota exhausted upstream', 'QUOTA');
    },
  }));
  const thrown = await new DshAuditedModelClient(thrownState.host).callJson(request(), () => true);
  assert.equal(thrown.ok, false);
  if (thrown.ok) {
    assert.fail('a thrown quota failure must not be adopted');
  }
  assert.equal(thrown.error.code, 'quota_exhausted');
  assert.equal(thrown.error.message.includes('quota exhausted upstream'), false);
  assert.equal(thrown.usage, null);
});

void test('an aggregate usage sum that is not a safe integer is unknown, never fabricated', async () => {
  const state = makeHost(() =>
    scripted(
      textChunks('{"ok":true}', {
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: 10,
        cacheReadTokens: 1,
      } as TokenUsage),
    ),
  );

  const result = await new DshAuditedModelClient(state.host).callJson(request(), () => true);

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail('an unrepresentable usage must not be adopted');
  }
  assert.equal(result.error.code, 'invalid_output');
  assert.equal(result.usage, null);
  const audit = resultAudit(eventsOf(state.created[0])[1]);
  assert.equal(audit.usage, null);
  // The provider's own numbers are still replayed, only the derived aggregate is refused.
  assert.notEqual(audit.rawUsage, null);
});

void test('synchronous output validation cannot adopt after the whole-call deadline', async () => {
  const state = makeHost(() => scripted(textChunks('{"ok":true}')));
  const result = await new DshAuditedModelClient(state.host).callJson(request({ timeoutMs: 25 }), () => {
    const doneAt = Date.now() + 35;
    while (Date.now() < doneAt) { /* A synchronous validator cannot yield to the timeout timer. */ }
    return true;
  });
  assert.equal(result.ok, false);
  if (result.ok) assert.fail('late validation must not adopt');
  assert.equal(result.error.code, 'timeout');
  assert.deepEqual(result.usage, KNOWN_USAGE);
});
void test('installed Flash policy rejects every other model before audit or provider IO', async () => {
  const f = makeHost(() => scripted([]));
  const client = new DshAuditedModelClient(f.host, {flashOnly:true});
  for (const role of ['analysis','verification','reasoning','coaching','planning'] as const) {
    for (const selection of [
      {provider:'deepseek-official',model:'deepseek-v4-pro'},
      {provider:'other-provider',model:'deepseek-flash'},
      {provider:'deepseek-official',model:'custom-model'},
      {provider:'deepseek-official',model:'deepseek-flash',effort:'low' as ReasoningEffortId},
    ]) {
      const result=await client.callJson(request({...selection,role}),value=>value);
      assert.equal(result.ok,false);assert.deepEqual(result.usage,ZERO_USAGE);
    }
  }
  assert.equal(f.dispatch.length,0);assert.equal(f.created.length,0);assert.equal(f.flushed.length,0);
});

void test('installed policy still dispatches Flash at max for every auxiliary role',async()=>{
 const f=makeHost(()=>scripted(textChunks('{"ok":true}')));
 const client=new DshAuditedModelClient(f.host,{flashOnly:true});
 for(const role of ['analysis','verification','reasoning','coaching','planning'] as const){
  const result=await client.callJson(request({provider:'deepseek-official',model:'deepseek-flash',role}),value=>value);
  assert.equal(result.ok,true);
 }
 assert.equal(f.dispatch.length,5);
 for(const d of f.dispatch){assert.equal(d.provider,'deepseek-official');assert.equal(d.model,'deepseek-flash');assert.equal(String(d.reasoningEffort),'max');}
});

// ---------------------------------------------------------------------------------------
// Stage 25c: upstream diagnostics, and any credentials they carry, never reach the audit log
// ---------------------------------------------------------------------------------------

/**
 * Synthetic, deliberately fake secret-shaped canaries — never real credentials. They stand in for
 * whatever a provider may put into an exception or a failure payload.
 */
const CANARY_BEARER = 'CANARY-SECRET-BEARER-9f2c';
const CANARY_API_KEY = 'sk-canary-0000000000000000';
const CANARIES = [CANARY_BEARER, CANARY_API_KEY, `Bearer ${CANARY_BEARER}`] as const;

/** Assert that no synthetic canary appears anywhere in one serialized observation. */
function assertNoCanary(text: string, label: string): void {
  for (const canary of CANARIES) {
    assert.equal(text.includes(canary), false, `${label} leaked a synthetic canary secret`);
  }
}

/** The recorded events exactly as the host would persist them, with their typed payloads. */
function recordedAuditJson(session: Session | undefined): string {
  return JSON.stringify(eventsOf(session).map((event) => ({ type: event.type, data: event.data })));
}

/** A thrown host exception carrying a canary in name, message, cause and arbitrary fields. */
function canaryBearingError(message: string, code?: string): Error {
  const error = new Error(`${message} ${CANARY_BEARER}`);
  return Object.assign(error, {
    name: `CanaryError ${CANARY_BEARER}`,
    code: code ?? 'E_CANARY-UNMAPPED',
    cause: new Error(`cause ${CANARY_BEARER}`),
    apiKey: CANARY_API_KEY,
    authorization: `Bearer ${CANARY_BEARER}`,
    headers: { authorization: `Bearer ${CANARY_BEARER}` },
    metadata: { apiKey: CANARY_API_KEY },
  });
}

void test('a capability-lookup exception is projected, never serialized into the audit', async () => {
  const state = makeHost(() => scripted(textChunks('{"ok":true}')));
  const host: DshAuditedHost = {
    llm: {
      stream: (options) => state.host.llm.stream(options),
      resolveModelInfo: async () => {
        throw canaryBearingError('capability endpoint unavailable');
      },
    },
    sessions: state.host.sessions,
  };

  const result = await new DshAuditedModelClient(host).callJson(request(), () => true);

  // A failed advisory lookup never blocks the call; it is only recorded as unavailable.
  assert.ok(result.ok);
  const capability = inputAudit(eventsOf(state.created[0])[0]).capability as unknown as Record<string, unknown>;
  assert.equal(capability['resolved'], false);
  assert.equal(capability['error'], 'an upstream host exception was projected (mapped code=provider_error)');
  const recorded = recordedAuditJson(state.created[0]);
  assertNoCanary(recorded, 'the capability lookup audit');
  assert.equal(recorded.includes('CanaryError'), false);
  assert.equal(recorded.includes('apiKey'), false);
  assert.equal(recorded.includes('authorization'), false);
  // The successful input/output audit itself stays exactly what the model was given.
  const audit = resultAudit(eventsOf(state.created[0])[1]);
  assert.equal(audit.text, '{"ok":true}');
  assert.deepEqual(audit.usage, KNOWN_USAGE);
});

void test('a provider failure finish is projected and its nested credentials are dropped', async () => {
  const failureChunk = {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        code: 'RATE_LIMIT',
        message: `upstream exploded ${CANARY_BEARER}`,
        headers: { authorization: `Bearer ${CANARY_BEARER}` },
        metadata: { apiKey: CANARY_API_KEY },
      },
    },
    replayState: { apiKey: CANARY_API_KEY, authorization: `Bearer ${CANARY_BEARER}` },
    apiKey: CANARY_API_KEY,
  } as unknown as StreamChunk;
  const state = makeHost(() =>
    scripted([{ type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } }, failureChunk]),
  );

  const result = await new DshAuditedModelClient(state.host).callJson(request(), () => true);

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail('a provider failure finish is never adopted');
  }
  // The caller receives the typed, fixed error; upstream text and the provider's own code are not
  // echoed either.
  assert.equal(result.error.code, 'rate_limited');
  assert.equal(result.error.message, 'the model provider rate limit was reached');
  assert.equal(result.error.retryable, true);
  assertNoCanary(JSON.stringify(result), 'the returned result');
  assert.deepEqual(result.usage, { calls: 1, promptTokens: 5, completionTokens: 1, totalTokens: 6 });

  const audit = resultAudit(eventsOf(state.created[0])[1]);
  assert.equal(audit.outcome, 'failed');
  assert.equal(audit.detail, 'the upstream provider reported rate_limited');
  assert.deepEqual(audit.chunks, [
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'error', code: 'rate_limited' } },
  ]);
  const recorded = recordedAuditJson(state.created[0]);
  assertNoCanary(recorded, 'the failure audit');
  for (const dropped of ['apiKey', 'authorization', 'metadata', 'replayState', 'upstream exploded']) {
    assert.equal(recorded.includes(dropped), false, `the failure audit kept ${dropped}`);
  }
});

void test('a thrown host exception while streaming is projected, never recorded', async () => {
  const state = makeHost(() => ({
    [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
      throw Object.assign(new LlmError(`stream exploded ${CANARY_BEARER}`, 'QUOTA'), {
        apiKey: CANARY_API_KEY,
        authorization: `Bearer ${CANARY_BEARER}`,
      });
    },
  }));

  const result = await new DshAuditedModelClient(state.host).callJson(request(), () => true);

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail('a thrown stream failure is never adopted');
  }
  assert.equal(result.error.code, 'quota_exhausted');
  assert.equal(result.error.message, 'the model provider quota is exhausted');
  assert.equal(result.usage, null);
  assertNoCanary(JSON.stringify(result), 'the returned result');
  const audit = resultAudit(eventsOf(state.created[0])[1]);
  assert.equal(audit.detail, 'an upstream host exception was projected (mapped code=quota_exhausted)');
  const recorded = recordedAuditJson(state.created[0]);
  assertNoCanary(recorded, 'the thrown-failure audit');
  assert.equal(recorded.includes('apiKey'), false);
});

void test('an uncreatable audit session refuses with a fixed projection, not the host exception', async () => {
  const state = makeHost(() => scripted(textChunks('{"ok":true}')));
  const host: DshAuditedHost = {
    llm: state.host.llm,
    sessions: {
      create: () => {
        throw canaryBearingError('audit session store unavailable');
      },
      flush: state.host.sessions.flush,
    },
  };

  const result = await new DshAuditedModelClient(host).callJson(request(), () => true);

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail('a call whose audit session cannot be created must be refused');
  }
  assert.equal(result.error.code, 'provider_error');
  assert.equal(result.error.retryable, false);
  assert.deepEqual(result.usage, ZERO_USAGE);
  assert.equal(result.sessionId, null);
  assert.equal(state.dispatch.length, 0);
  assert.equal(state.created.length, 0);
  assertNoCanary(JSON.stringify(result), 'the returned result');
});

void test('a throwing audit flush is never recorded as text and refuses dispatch', async () => {
  const state = makeHost(() => scripted(textChunks('{"ok":true}')));
  const host: DshAuditedHost = {
    llm: state.host.llm,
    sessions: {
      create: (id) => state.host.sessions.create(id),
      flush: () => {
        throw canaryBearingError('audit log disk failure');
      },
    },
  };

  const result = await new DshAuditedModelClient(host).callJson(request(), () => true);

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail('a non-durable input audit must refuse dispatch');
  }
  assert.equal(result.error.code, 'provider_error');
  assert.deepEqual(result.usage, ZERO_USAGE);
  assert.equal(state.dispatch.length, 0);
  assertNoCanary(JSON.stringify(result), 'the returned result');
  assertNoCanary(recordedAuditJson(state.created[0]), 'the input-only audit');
});

void test('a successful stream stays byte-exact while user material is still audited by design', async () => {
  const chunks = textChunks('{"tags":["dp"]}');
  const state = makeHost(() => scripted(chunks));
  const material = `user material ${CANARY_API_KEY}`;

  const result = await new DshAuditedModelClient(state.host).callJson(
    request({ system: `system ${CANARY_BEARER}`, userPrompt: material }),
    (value) => value,
  );

  assert.ok(result.ok);
  assert.deepEqual(result.value, { tags: ['dp'] });
  const events = eventsOf(state.created[0]);
  const input = inputAudit(events[0]);
  // The documented boundary: user-provided material is recorded verbatim, so secrets must not be
  // pasted into a statement or prompt. Only *upstream diagnostics* are projected.
  assert.equal(input.system, `system ${CANARY_BEARER}`);
  const auditedMessages = input.messages as unknown as readonly {
    readonly content: readonly { readonly text: string }[];
  }[];
  assert.equal(auditedMessages[0]?.content[0]?.text, material);
  const audit = resultAudit(events[1]);
  assert.equal(audit.text, '{"tags":["dp"]}');
  // Every chunk of a successful stream is replayed exactly as received.
  assert.deepEqual(audit.chunks, chunks);
  assert.deepEqual(audit.rawUsage, { inputTokens: 100, outputTokens: 10 });
  assert.deepEqual(audit.usage, KNOWN_USAGE);
  assert.equal(state.dispatch.length, 1);
});

void test('unknown terminal vocabulary and inherited failure codes cannot escape the audit projection', async () => {
  for (const reason of [
    { kind: 'aborted', failure: { code: '__proto__', message: CANARY_API_KEY } },
    { kind: CANARY_API_KEY, replayState: { secret: CANARY_BEARER } },
  ]) {
    const state = makeHost(() => scripted([{ type: 'finish', reason } as unknown as StreamChunk]));
    const result = await new DshAuditedModelClient(state.host).callJson(request(), () => true);
    assert.equal(result.ok, false);
    if (result.ok) assert.fail('invalid terminal must fail');
    assert.equal(result.error.code, reason.kind === 'aborted' ? 'provider_error' : 'invalid_output');
    assertNoCanary(recordedAuditJson(state.created[0]), 'unrecognized terminal audit');
    assertNoCanary(JSON.stringify(result), 'unrecognized terminal result');
  }
});

void test('a recognized truncation keeps its original terminal replay', async () => {
  const chunk = { type: 'finish', reason: { kind: 'max-tokens' } } as const;
  const state = makeHost(() => scripted([chunk]));
  const result = await new DshAuditedModelClient(state.host).callJson(request(), () => true);
  assert.equal(result.ok, false);
  const audit = resultAudit(eventsOf(state.created[0])[1]);
  assert.equal(audit.finish, 'max-tokens');
  assert.deepEqual(audit.chunks, [chunk]);
});
