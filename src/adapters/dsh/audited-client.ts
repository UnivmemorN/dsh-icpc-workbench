/**
 * Audited auxiliary model client (Stage 4a1).
 *
 * One `callJson` is one dispatch. The exact input, messages and effective options are appended to
 * a dedicated audit session and flushed before the provider is called; the raw chunks, assembled
 * text/reasoning, terminal finish and usage are appended and flushed before a value is adopted.
 *
 * One global deadline — the request timeout — covers the capability lookup, the input flush, the
 * stream and the output flush. Every awaited host dependency is raced against that deadline and
 * against the caller's cancellation token, so a host that ignores both can still delay one call by
 * at most `timeoutMs`. A cancellation observed before dispatch refuses the call with known-zero
 * usage and never creates a provider stream; a cancellation observed before adoption refuses the
 * value and keeps whatever usage the stream already reported. Failures of the audit log itself are
 * never retryable: paying again for data that could not be logged is worse than the refusal.
 */
import { randomUUID } from 'node:crypto';
import {
  BlockAssembler,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  createUserMessage,
  isHarnessError,
} from '@deepseek-ai/dsh-llm';
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  Message,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types';
import { MODEL_CALL_ROLES, type ModelCallRole } from '../../application/batch-types.js';
import type { ModelCallResult, ModelErrorCode } from '../../application/ports.js';
import { createModelUsage, type CancellationToken, type ModelUsage } from '../../domain/index.js';

/**
 * Largest accepted serialized input, in UTF-8 bytes: the length of
 * `JSON.stringify({ system, userPrompt })`, not the raw prompt length. JSON escaping expands
 * quotes, backslashes and control characters, so the cap applies to the serialized form.
 */
export const MAX_AUDIT_PROMPT_BYTES = 750_000;
/** Approved reasoning effort used when a caller omits `effort`; the host default is never used. */
const DEFAULT_AUDIT_EFFORT = ReasoningEffortId('max');
/** Best-effort flush budget of a cancelled refusal; a hanging log never parks the caller. */
const REFUSAL_FLUSH_BUDGET_MS = 100;
/** Smallest accepted `maxTokens`: a request without room for an answer is not dispatched. */
export const MIN_AUDIT_MAX_TOKENS = 1;
/** Largest accepted `maxTokens` (the approved v1 output cap). */
export const MAX_AUDIT_MAX_TOKENS = 65_536;
/** Largest accepted call timeout; longer waits are refused instead of parked forever. */
export const MAX_AUDIT_TIMEOUT_MS = 600_000;
/** Cap on the serialized raw chunks kept for the audit log; beyond it the stream is invalid. */
export const MAX_AUDIT_STREAM_BYTES = 16 * 1024 * 1024;
/** Cap on raw chunks kept for the audit log; a chunk flood is invalid output. */
export const MAX_AUDIT_STREAM_CHUNKS = 100_000;
/**
 * Fixed framing allowance of the conservative context estimate below, for the provider envelope
 * (role markers, template text, tool framing) that a request pays on top of its own content.
 */
export const AUDIT_CONTEXT_FRAMING_MARGIN_TOKENS = 4_096;

const MAX_AUDIT_JSON_DEPTH = 32;

/** Retryability of each declared failure code; a retry is decided by the caller, never here. */
const RETRYABLE: Readonly<Record<ModelErrorCode, boolean>> = {
  cancelled: false,
  timeout: true,
  rate_limited: true,
  quota_exhausted: false,
  invalid_output: false,
  provider_error: true,
  unsupported: false,
};

/**
 * Public provider-neutral failure codes this client routes on — never by message text.
 *
 * `QUOTA_EXCEEDED_CODE` and `CONTEXT_WINDOW_EXCEEDED_CODE` are exported by
 * `@deepseek-ai/dsh-llm`'s error module; `RATE_LIMIT`, `AUTH`, `NO_ADAPTER` and `INVALID_ARGS` are
 * the other stable codes documented there. A code this table does not know stays `provider_error`
 * instead of being guessed from its name or message.
 */
const MAPPED_FAILURE_CODES: Readonly<Record<string, ModelErrorCode>> = {
  [QUOTA_EXCEEDED_CODE]: 'quota_exhausted',
  [CONTEXT_WINDOW_EXCEEDED_CODE]: 'unsupported',
  RATE_LIMIT: 'rate_limited',
  AUTH: 'unsupported',
  NO_ADAPTER: 'unsupported',
  INVALID_ARGS: 'unsupported',
};

/**
 * Fixed caller-facing message of every failure code.
 *
 * A provider's own code/name/message is arbitrary text and is never echoed to the caller; it stays
 * in the audit record's `detail`, which only the host reads.
 */
const FAILURE_MESSAGES: Readonly<Record<ModelErrorCode, string>> = {
  cancelled: 'model call cancelled',
  timeout: 'model call exceeded its deadline',
  rate_limited: 'the model provider rate limit was reached',
  quota_exhausted: 'the model provider quota is exhausted',
  invalid_output: 'model output was rejected as invalid',
  provider_error: 'the model provider reported a failure',
  unsupported: 'the model provider rejected the request as unsupported',
};

/** Fixed message of a refusal caused by a known context window that cannot fit the request. */
const CONTEXT_REFUSAL_MESSAGE = 'the request does not fit the model context window';

/** Object shape accepted by the audit log (lossless JSON only). */
export type AuditedJsonObject = { readonly [key: string]: AuditedJson };
/** Value accepted by the audit log: exactly what the host session can persist losslessly. */
export type AuditedJson = string | number | boolean | null | readonly AuditedJson[] | AuditedJsonObject;

/**
 * Roles this client may audit.
 *
 * The application's {@link ModelCallRole} union and its budget kinds are unchanged: `coaching` is
 * a parser-only role of the audited client, added here and nowhere else.
 */
export type AuditedModelRole = ModelCallRole | 'coaching';

/** The accepted audit roles; the application's own role list stays untouched. */
export const AUDITED_MODEL_ROLES: readonly AuditedModelRole[] = [...MODEL_CALL_ROLES, 'coaching'];

/** Pre-dispatch record: the exact input, messages and effective options of one call. */
export interface IcpcModelCallAudit {
  readonly callId: string;
  readonly attemptId: string;
  readonly role: AuditedModelRole;
  readonly provider: string;
  readonly model: string;
  readonly snapshotId: string;
  readonly promptVersion: string;
  readonly sessionId: string;
  readonly recordedAt: string;
  readonly promptBytes: number;
  readonly system: string;
  readonly messages: AuditedJson;
  /** Effective options; the AbortSignal is deliberately absent (not persistable, not input). */
  readonly options: AuditedJson;
  /** Result of the advisory model-capability lookup, or why it was unavailable. */
  readonly capability: AuditedJson;
}

/** Post-stream record: replay of the raw stream and the settled accounting of one call. */
export interface IcpcModelCallResultAudit {
  readonly callId: string;
  readonly attemptId: string;
  readonly role: AuditedModelRole;
  readonly sessionId: string;
  readonly recordedAt: string;
  readonly outcome: 'ok' | 'failed';
  readonly code: ModelErrorCode | null;
  /** Internal failure detail (never the caller-facing message). */
  readonly detail: string | null;
  readonly finish: string | null;
  readonly chunks: AuditedJson;
  /**
   * Raw chunk refused by the lossless/oversize gate, as `{ reason, bytes }`; `null` when every
   * received chunk was accepted. The refused chunk is absent from {@link chunks} on purpose — the
   * replay stays exactly what was kept, and the omission is visible instead of silent.
   */
  readonly omittedChunk: AuditedJson | null;
  readonly text: string;
  readonly reasoning: string;
  readonly rawUsage: AuditedJson | null;
  readonly usage: AuditedJson | null;
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'icpc/model-call-audit': IcpcModelCallAudit;
    'icpc/model-call-result': IcpcModelCallResultAudit;
  }
}

type IcpcAuditEventType = 'icpc/model-call-audit' | 'icpc/model-call-result';

/** Structural host dependency; a real Cordis `ctx` satisfies it. */
export interface DshAuditedHost {
  readonly llm: {
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /** Public capability query when the mounted runtime provides one; never invented here. */
    resolveModelInfo?(
      provider: string,
      model: string,
      signal?: AbortSignal,
    ): Promise<{
      /** Adapter-configured output cap materialized only when a caller omits `maxTokens`. */
      readonly defaultMaxTokens?: number;
      /** Provider-owned combined request+response capacity, when disclosed. */
      readonly context?: { readonly contextWindow?: number };
      /** Adapter-owned reasoning levels; recorded for the host, never used as the effort. */
      readonly reasoning?: { readonly defaultEffort?: ReasoningEffortId };
    }>;
  };
  readonly sessions: {
    create(id: SessionId): Session | Promise<Session>;
    flush(session: Session): Promise<boolean>;
  };
}

/** One auxiliary JSON call. `attemptId`/`promptVersion`/`snapshotId` correlate it with its host row. */
export interface AuditedJsonCallRequest {
  readonly provider: string;
  readonly model: string;
  readonly system: string;
  readonly userPrompt: string;
  readonly maxTokens: number;
  readonly temperature?: number;
  /** Opaque adapter-owned effort; when omitted, the approved `max` default applies. */
  readonly effort?: ReasoningEffortId;
  readonly timeoutMs: number;
  readonly token: CancellationToken;
  readonly attemptId: string;
  readonly promptVersion: string;
  readonly role: AuditedModelRole;
  readonly snapshotId: string;
}

/** Fixed, mapped failure of one audited call; `retryable` is policy input for the caller only. */
interface CallFailure {
  readonly code: ModelErrorCode;
  readonly message: string;
  readonly detail: string;
  readonly retryable: boolean;
}

/** What the advisory capability lookup settled on, plus the context gate it implies. */
interface CallPlan {
  /** Effective effort: the caller's opaque value, or the approved default when it was omitted. */
  readonly effort: ReasoningEffortId;
  /** Exactly what the audit log records about the lookup. */
  readonly capability: AuditedJson;
  /** `null` unless a known context window cannot fit the conservative request estimate. */
  readonly contextRefusal: CallFailure | null;
}

/** One settled stream: raw chunk replay, assembled text, usage and the mapped failure. */
interface ObservedCall {
  readonly chunks: readonly AuditedJson[];
  readonly omittedChunk: AuditedJson | null;
  readonly text: string;
  readonly reasoning: string;
  readonly finish: string | null;
  readonly rawUsage: TokenUsage | null;
  readonly usage: ModelUsage | null;
  readonly error: CallFailure | null;
}

/** Outcome of racing one host dependency against the global deadline and the cancellation token. */
type Raced<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cancelled' };

const SKIP: unique symbol = Symbol('skip');

/**
 * Reusable audited client over the public host services.
 *
 * The dedicated audit session is created lazily, once per client, under an explicit
 * `icpc-audit-<uuid>` id; the store's default `session-<n>` ids are never used because they
 * collide with a fresh process.
 */
export class DshAuditedModelClient {
  private readonly host: DshAuditedHost;
  private readonly now: () => string;
  private session: Promise<Session> | null = null;

  constructor(host: DshAuditedHost, options: { readonly now?: () => string } = {}) {
    this.host = host;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Dispatch exactly one model call and adopt the parsed JSON only when its audit is durable.
   *
   * Never retries: one call, one stream, one audit row. A refusal before dispatch reports
   * known-zero usage; a dispatched call without usable usage reports `null` (unknown).
   */
  async callJson<T>(request: AuditedJsonCallRequest, parse: (value: unknown) => T): Promise<ModelCallResult<T>> {
    const callId = randomUUID();
    // Cancellation is checked before any audit work: a call that is already cancelled neither
    // creates a session nor a provider stream, so its cost is known to be zero.
    if (request.token.cancelled) {
      return failureResult(
        localFailure('cancelled', 'cancellation was observed before the call started'),
        zeroUsage(),
        callId,
        null,
      );
    }
    const refusal = validateRequest(request);
    if (refusal !== null) {
      return failureResult(localFailure('unsupported', refusal), zeroUsage(), callId, null);
    }
    const controller = new AbortController();
    const stopOnCancel = request.token.onCancel(() => controller.abort());
    try {
      return await this.dispatch<T>(request, parse, callId, controller, Date.now() + request.timeoutMs);
    } finally {
      stopOnCancel();
      // Every exit path is terminal for this controller: release a capability lookup, a flush or a
      // provider stream still parked on the signal. Abort is idempotent and never awaited.
      controller.abort();
    }
  }

  private async dispatch<T>(
    request: AuditedJsonCallRequest,
    parse: (value: unknown) => T,
    callId: string,
    controller: AbortController,
    deadline: number,
  ): Promise<ModelCallResult<T>> {
    const sessionRaced = await raceDeadline(this.auditSession(), deadline, request.token);
    if (sessionRaced.kind !== 'value') {
      return failureResult(
        stopFailure(sessionRaced, 'the host audit session was not created before the deadline'),
        zeroUsage(),
        callId,
        null,
      );
    }
    const session = sessionRaced.value;
    const sessionId = String(session.id);
    const messages: Message[] = [
      createUserMessage({
        content: [{ type: 'text', text: request.userPrompt }],
        source: { kind: 'user' },
      }),
    ];
    const planRaced = await raceDeadline(this.capabilityPlan(request, messages, controller), deadline, request.token);
    if (planRaced.kind !== 'value') {
      return failureResult(
        stopFailure(planRaced, 'the model capability lookup did not settle before the deadline'),
        zeroUsage(),
        callId,
        sessionId,
      );
    }
    const plan = planRaced.value;
    const options: GenerateOptions = {
      provider: request.provider,
      model: request.model,
      messages,
      system: request.system,
      maxTokens: request.maxTokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      // The effective effort is always present: the caller's, or the approved default.
      reasoningEffort: plan.effort,
      signal: controller.signal,
      sessionId: session.id,
    };
    const promptBytes = serializedInputBytes(request);
    const logged = appendAuditEvent(session, 'icpc/model-call-audit', {
      callId,
      attemptId: request.attemptId,
      role: request.role,
      provider: request.provider,
      model: request.model,
      snapshotId: request.snapshotId,
      promptVersion: request.promptVersion,
      sessionId,
      recordedAt: this.now(),
      promptBytes,
      system: request.system,
      messages: auditJson(messages),
      // Locally built options omit optional keys explicitly: no `undefined` ever reaches the log.
      options: auditJson({
        provider: request.provider,
        model: request.model,
        maxTokens: request.maxTokens,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        // The audited options must replay the effort actually dispatched.
        reasoningEffort: String(plan.effort),
        sessionId,
      }),
      capability: plan.capability,
    });
    if (!logged) {
      return failureResult(
        localFailure('provider_error', 'the host audit log rejected the call record', false),
        zeroUsage(),
        callId,
        sessionId,
      );
    }
    const inputFlush = await raceDeadline(this.durable(session), deadline, request.token);
    if (inputFlush.kind !== 'value' || inputFlush.value !== true) {
      // No dispatch: the input record is not durable (or its durability is unconfirmed), so a paid
      // call must not happen. The log is not usable, so no failure row is appended to it either.
      const failure =
        inputFlush.kind === 'value'
          ? localFailure('provider_error', 'the input audit flush reported the log as not durable', false)
          : stopFailure(inputFlush, 'the input audit flush did not settle before the deadline');
      return failureResult(failure, zeroUsage(), callId, sessionId);
    }
    // Re-checked after the awaits and immediately before dispatch: cancellation and the global
    // deadline both cover the capability lookup and the input flush.
    const beforeDispatch = stopBeforeDispatch(request.token, deadline);
    if (beforeDispatch !== null) {
      await this.recordRefusal(session, request, callId, sessionId, beforeDispatch, zeroUsage(), deadline);
      return failureResult(beforeDispatch, zeroUsage(), callId, sessionId);
    }
    if (plan.contextRefusal !== null) {
      await this.recordRefusal(session, request, callId, sessionId, plan.contextRefusal, zeroUsage(), deadline);
      return failureResult(plan.contextRefusal, zeroUsage(), callId, sessionId);
    }

    const observed = await this.observe(request, controller, options, deadline);
    const parsed = observed.error === null ? parseDocument(observed.text, parse) : null;
    const error: CallFailure | null =
      observed.error ??
      (parsed === null
        ? localFailure('invalid_output', 'the output callback produced no value')
        : parsed.ok
          ? null
          : localFailure('invalid_output', 'JSON extraction or the validating callback rejected the output'));
    const adopted = error === null && parsed !== null && parsed.ok;

    const resultLogged = appendAuditEvent(session, 'icpc/model-call-result', {
      callId,
      attemptId: request.attemptId,
      role: request.role,
      sessionId,
      recordedAt: this.now(),
      outcome: error === null ? 'ok' : 'failed',
      code: error?.code ?? null,
      detail: error?.detail ?? null,
      finish: observed.finish,
      chunks: observed.chunks,
      omittedChunk: observed.omittedChunk,
      text: observed.text,
      reasoning: observed.reasoning,
      rawUsage: observed.rawUsage === null ? null : auditJson(observed.rawUsage),
      usage: observed.usage === null ? null : auditJson(observed.usage),
    });
    // The output flush is the last awaited dependency, so it is inside the global deadline too. A
    // cancellation observed here refuses adoption even when the flush itself reported success: the
    // value is only adopted while the call is still live.
    const outputFlush: Raced<boolean> = request.token.cancelled
      ? { kind: 'cancelled' }
      : await raceDeadline(this.durable(session), deadline, request.token);
    const stopAfterOutput = adoptionStop(request.token, outputFlush, deadline);
    if (stopAfterOutput !== null) {
      return failureResult(stopAfterOutput, observed.usage, callId, sessionId);
    }
    const durable = outputFlush.kind === 'value' && outputFlush.value === true;
    if (error === null && adopted && resultLogged && durable) {
      return {
        ok: true,
        value: (parsed as { ok: true; value: T }).value,
        usage: observed.usage as ModelUsage,
        callId,
        sessionId,
      };
    }
    const refusalError: CallFailure =
      error ??
      (!resultLogged
        ? localFailure('provider_error', 'the host audit log rejected the result record', false)
        : localFailure('provider_error', 'the result audit is not durable; the value was not adopted', false));
    return failureResult(refusalError, observed.usage, callId, sessionId);
  }

  /** Dedicated audit session, created once per client; concurrent callers share one creation. */
  private async auditSession(): Promise<Session> {
    if (this.session === null) {
      this.session = Promise.resolve().then(() =>
        this.host.sessions.create(SessionId(`icpc-audit-${randomUUID()}`)),
      );
    }
    try {
      return await this.session;
    } catch (error) {
      this.session = null;
      throw error;
    }
  }

  /**
   * Advisory capability lookup plus the conservative context gate.
   *
   * `defaultMaxTokens` is a *default* the runtime materializes when a caller omits `maxTokens`;
   * this client always sends an explicit `maxTokens`, so the declared default is recorded but never
   * clamps the request. `context.contextWindow` is the combined input+output capacity: a request
   * whose conservative estimate does not fit is refused, never truncated. A lookup that is absent
   * or throws is recorded as unavailable, invents no cap and keeps the fixed
   * {@link MAX_AUDIT_PROMPT_BYTES} input bound. The effective effort is the caller's opaque,
   * non-empty value, or the approved {@link DEFAULT_AUDIT_EFFORT} when it was omitted: an
   * adapter-declared default effort is never substituted for the approved one.
   */
  private async capabilityPlan(
    request: AuditedJsonCallRequest,
    messages: readonly Message[],
    controller: AbortController,
  ): Promise<CallPlan> {
    const effort = effectiveEffort(request.effort);
    const resolveModelInfo = this.host.llm.resolveModelInfo;
    if (resolveModelInfo === undefined) {
      return { effort, capability: { resolved: false }, contextRefusal: null };
    }
    let info: Awaited<ReturnType<NonNullable<DshAuditedHost['llm']['resolveModelInfo']>>>;
    try {
      info = await resolveModelInfo.call(this.host.llm, request.provider, request.model, controller.signal);
    } catch (error) {
      // A failed advisory lookup is recorded, never silently treated as a capability.
      return { effort, capability: { resolved: false, error: auditErrorDetail(error) }, contextRefusal: null };
    }
    const declaredDefault = safeCount(info?.defaultMaxTokens);
    const defaultMaxTokens = declaredDefault !== null && declaredDefault >= 1 ? declaredDefault : null;
    const declaredContext = safeCount(info?.context?.contextWindow);
    const contextWindow = declaredContext !== null && declaredContext > 0 ? declaredContext : null;
    const capability: AuditedJson = {
      resolved: true,
      defaultMaxTokens,
      contextWindow,
      ...(info?.context === undefined || contextWindow !== null
        ? {}
        : { contextWindowError: 'the resolved context window is not a positive safe integer' }),
    };
    const estimated = estimatedRequestTokens(request, messages);
    return {
      effort,
      capability,
      contextRefusal:
        contextWindow !== null && estimated > contextWindow
          ? {
              code: 'unsupported',
              message: CONTEXT_REFUSAL_MESSAGE,
              detail: `conservative estimate ${estimated} tokens (serialized request + requested output + ${AUDIT_CONTEXT_FRAMING_MARGIN_TOKENS} framing) exceeds the model context window ${contextWindow}`,
              retryable: false,
            }
          : null,
    };
  }

  /** Read one stream under the global deadline, then settle text, finish and usage. */
  private async observe(
    request: AuditedJsonCallRequest,
    controller: AbortController,
    options: GenerateOptions,
    deadline: number,
  ): Promise<ObservedCall> {
    const assembler = new BlockAssembler();
    const chunks: AuditedJson[] = [];
    let finishReason: FinishReason | null = null;
    let emittedUsage: TokenUsage | null = null;
    let failure: CallFailure | null = null;
    let rawBytes = 0;
    let cancelled = false;
    let timedOut = false;
    let overflowReason: string | null = null;
    let omittedChunk: AuditedJson | null = null;
    let iterator: AsyncIterator<StreamChunk> | null = null;
    try {
      iterator = this.host.llm.stream(options)[Symbol.asyncIterator]();
    } catch (error) {
      failure = thrownFailure(error);
    }
    if (iterator !== null) {
      for (;;) {
        if (request.token.cancelled) {
          cancelled = true;
          break;
        }
        if (deadline - Date.now() <= 0) {
          timedOut = true;
          break;
        }
        let pending: Promise<IteratorResult<StreamChunk>>;
        try {
          pending = iterator.next();
        } catch (error) {
          failure = thrownFailure(error);
          break;
        }
        const next = await raceDeadline(pending, deadline, request.token);
        if (next.kind === 'cancelled') {
          cancelled = true;
          break;
        }
        if (next.kind === 'timeout') {
          timedOut = true;
          break;
        }
        if (next.kind === 'failed') {
          failure = thrownFailure(next.error);
          break;
        }
        if (next.value.done === true) {
          break;
        }
        const chunk = next.value.value;
        // The serialized chunk is bounded *before* it is kept or pushed into the assembler: every
        // chunk type (block-end, usage, finish and its replay state) counts, not only deltas.
        const serialized = losslessChunk(chunk);
        if (!serialized.ok) {
          overflowReason = `the raw chunk is not lossless JSON (${serialized.reason})`;
          omittedChunk = { reason: serialized.reason, bytes: null };
          break;
        }
        if (rawBytes + serialized.bytes > MAX_AUDIT_STREAM_BYTES || chunks.length >= MAX_AUDIT_STREAM_CHUNKS) {
          overflowReason = `the raw stream exceeds ${MAX_AUDIT_STREAM_BYTES} serialized bytes or ${MAX_AUDIT_STREAM_CHUNKS} chunks`;
          omittedChunk = { reason: overflowReason, bytes: serialized.bytes };
          break;
        }
        rawBytes += serialized.bytes;
        chunks.push(serialized.value);
        try {
          assembler.push(chunk);
        } catch (error) {
          failure = localFailure('invalid_output', `the model stream could not be assembled: ${auditErrorDetail(error)}`);
          break;
        }
        if (chunk.type === 'usage') {
          emittedUsage = chunk.usage;
        }
        if (chunk.type === 'finish') {
          finishReason = chunk.reason;
          break;
        }
      }
      if (cancelled || timedOut || overflowReason !== null || failure !== null || finishReason !== null) {
        // Stop paying for a stream this call will not adopt; the release is best effort and is
        // never awaited, so an iterator that ignores `return` cannot hold the caller.
        if (timedOut || overflowReason !== null || failure !== null) {
          controller.abort();
        }
        closeIterator(iterator);
      }
    }
    const assembled = readAssembled(assembler);
    const rawUsage = emittedUsage ?? assembler.usage ?? null;
    const usage = toKnownUsage(rawUsage ?? undefined);
    const finish = finishReason === null ? null : String(finishReason.kind);
    const error =
      failure ??
      (cancelled ? localFailure('cancelled', 'cancellation was observed while streaming') : null) ??
      (timedOut ? localFailure('timeout', 'the provider did not settle before the deadline') : null) ??
      (overflowReason !== null ? localFailure('invalid_output', overflowReason) : null) ??
      (assembled === null
        ? localFailure('invalid_output', 'only text and reasoning blocks are valid JSON output')
        : null) ??
      finishFailure(finishReason) ??
      (usage === null
        ? localFailure('invalid_output', 'successful output requires a validated non-negative integer usage')
        : null);
    return {
      chunks,
      omittedChunk,
      text: assembled?.text ?? '',
      reasoning: assembled?.reasoning ?? '',
      finish,
      rawUsage,
      usage,
      error,
    };
  }

  /**
   * Record a refusal reached after the input record was appended.
   *
   * The failed result row is appended where the log takes it, and its flush is bounded by the
   * global deadline — with a short extra budget for a cancelled refusal: a hanging log can never
   * hold the caller, and the refusal is never retried.
   */
  private async recordRefusal(
    session: Session,
    request: AuditedJsonCallRequest,
    callId: string,
    sessionId: string,
    failure: CallFailure,
    usage: ModelUsage | null,
    deadline: number,
  ): Promise<void> {
    const appended = appendAuditEvent(session, 'icpc/model-call-result', {
      callId,
      attemptId: request.attemptId,
      role: request.role,
      sessionId,
      recordedAt: this.now(),
      outcome: 'failed',
      code: failure.code,
      detail: failure.detail,
      finish: null,
      chunks: [],
      omittedChunk: null,
      text: '',
      reasoning: '',
      rawUsage: null,
      usage: usage === null ? null : auditJson(usage),
    });
    if (appended) {
      const flushDeadline =
        failure.code === 'cancelled'
          ? Math.min(deadline, Date.now() + REFUSAL_FLUSH_BUDGET_MS)
          : deadline;
      await this.flushBounded(session, flushDeadline);
    }
  }

  /** Flush one audit session within the remaining deadline; never awaited past it. */
  private async flushBounded(session: Session, deadline: number): Promise<boolean> {
    if (deadline - Date.now() <= 0) {
      return false;
    }
    const raced = await raceDeadline(this.durable(session), deadline);
    return raced.kind === 'value' && raced.value;
  }

  /** Flush one audit session; a rejected or `false` flush is never durable. */
  private async durable(session: Session): Promise<boolean> {
    try {
      return (await this.host.sessions.flush(session)) === true;
    } catch {
      return false;
    }
  }
}

/** Map a terminal finish reason to a failure, or `null` when the stream may still be adopted. */
function finishFailure(reason: FinishReason | null): CallFailure | null {
  if (reason === null) {
    return localFailure('invalid_output', 'the assembler default is not a real finish');
  }
  switch (reason.kind) {
    case 'stop':
      return null;
    case 'max-tokens':
      return localFailure('invalid_output', 'a truncated response is never accepted');
    case 'tool-calls':
      return localFailure('invalid_output', 'tool calls cannot be parsed as JSON output');
    case 'aborted':
      return mappedFailure(reason.failure.code, providerDetail(reason.failure));
    case 'error':
      return mappedFailure(reason.failure.code, providerDetail(reason.failure));
    default:
      return localFailure(
        'invalid_output',
        `the stream vocabulary is wider than this client can settle (${String((reason as { kind: string }).kind)})`,
      );
  }
}

/** Internal audit detail of one provider failure; never used as a caller-facing message. */
function providerDetail(failure: { readonly code: string; readonly message: string }): string {
  return `provider failure ${failure.code}: ${failure.message}`;
}

/** Map one provider-neutral failure code onto the fixed failure of this client. */
function mappedFailure(code: string | null | undefined, detail: string): CallFailure {
  const mapped = code === null || code === undefined ? undefined : MAPPED_FAILURE_CODES[code];
  const failureCode: ModelErrorCode = mapped ?? 'provider_error';
  return localFailure(failureCode, detail);
}

/** A failure of this client with its fixed message; `retryable` defaults to the code's policy. */
function localFailure(code: ModelErrorCode, detail: string, retryable: boolean = RETRYABLE[code]): CallFailure {
  return { code, message: FAILURE_MESSAGES[code], detail, retryable };
}

/** Map a thrown host failure: structured dsh errors route by their stable code, never by text. */
function thrownFailure(error: unknown): CallFailure {
  return mappedFailure(isHarnessError(error) ? error.code : null, auditErrorDetail(error));
}

/** The raced stop that happened before dispatch, or `null` when the call may proceed. */
function stopBeforeDispatch(token: CancellationToken, deadline: number): CallFailure | null {
  if (token.cancelled) {
    return localFailure('cancelled', 'cancellation was observed after the input audit and before dispatch');
  }
  if (Date.now() >= deadline) {
    return localFailure('timeout', 'the whole-call deadline expired before dispatch');
  }
  return null;
}

/** A cancellation or deadline observed while the output record was being made durable. */
function adoptionStop(token: CancellationToken, raced: Raced<boolean>, deadline: number): CallFailure | null {
  if (token.cancelled || raced.kind === 'cancelled') {
    return localFailure('cancelled', 'cancellation was observed before the value could be adopted');
  }
  if (raced.kind === 'timeout' || Date.now() >= deadline) {
    return localFailure('timeout', 'the audit log did not confirm durability before the deadline');
  }
  return null;
}

/**
 * A raced host dependency that did not settle: cancellation stays cancellation, a missed deadline a
 * timeout, and a thrown dependency an audit failure that is never retryable (paying again for a
 * dependency that already broke is worse than the refusal). The `value` variant is excluded because
 * every caller checks `kind !== 'value'` before asking for the failure.
 */
function stopFailure(raced: Exclude<Raced<unknown>, { readonly kind: 'value' }>, detail: string): CallFailure {
  if (raced.kind === 'cancelled') {
    return localFailure('cancelled', detail);
  }
  if (raced.kind === 'timeout') {
    return localFailure('timeout', detail);
  }
  return localFailure('provider_error', `${detail} (${auditErrorDetail(raced.error)})`, false);
}

/** Parse exactly one whole JSON document (an optional whole-document fence is allowed). */
function parseDocument<T>(text: string, parse: (value: unknown) => T): { ok: true; value: T } | { ok: false } {
  const document = extractJsonDocument(text);
  if (document === null) {
    return { ok: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    return { ok: false };
  }
  try {
    return { ok: true, value: parse(parsed) };
  } catch {
    return { ok: false };
  }
}

/** Whole-document fence or the raw text; never a substring search for embedded JSON. */
function extractJsonDocument(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  return candidate.length === 0 ? null : candidate;
}

/** Assemble text and reasoning; `null` when any block is not valid JSON output. */
function readAssembled(assembler: BlockAssembler): { readonly text: string; readonly reasoning: string } | null {
  let blocks: ContentBlock[];
  try {
    blocks = assembler.blocks();
  } catch {
    return null;
  }
  let text = '';
  let reasoning = '';
  for (const block of blocks) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'reasoning') {
      reasoning += block.text;
    } else {
      return null;
    }
  }
  return { text, reasoning };
}

/**
 * Domain usage of one successful call; `null` when the raw usage is missing or invalid.
 *
 * Individual counts can be safe integers while their sum is not, so the aggregate prompt and total
 * sums are validated here — `createModelUsage` only requires a finite integer.
 */
function toKnownUsage(raw: TokenUsage | undefined): ModelUsage | null {
  if (raw === undefined) {
    return null;
  }
  const input = safeCount(raw.inputTokens);
  const output = safeCount(raw.outputTokens);
  const cacheRead = optionalCount(raw.cacheReadTokens);
  const cacheWrite = optionalCount(raw.cacheWriteTokens);
  if (input === null || output === null || cacheRead === null || cacheWrite === null) {
    return null;
  }
  if (raw.reasoningTokens !== undefined && safeCount(raw.reasoningTokens) === null) {
    return null;
  }
  // `inputTokens` is uncached input only; output already includes reasoning, so it is counted once.
  const promptTokens = input + cacheRead + cacheWrite;
  if (!Number.isSafeInteger(promptTokens) || !Number.isSafeInteger(promptTokens + output)) {
    return null;
  }
  return createModelUsage({ calls: 1, promptTokens, completionTokens: output });
}

function safeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function optionalCount(value: unknown): number | null {
  return value === undefined ? 0 : safeCount(value);
}

/** A configured effort is opaque but must still be a non-empty identifier to be sent. */
function opaqueEffort(value: unknown): ReasoningEffortId | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? ReasoningEffortId(value) : undefined;
}

/**
 * Effective reasoning effort of one call: the caller's opaque non-empty value, else the approved
 * default. An adapter-declared default effort is deliberately not substituted.
 */
function effectiveEffort(requested: ReasoningEffortId | undefined): ReasoningEffortId {
  return opaqueEffort(requested) ?? DEFAULT_AUDIT_EFFORT;
}

/**
 * Conservative token estimate of one request.
 *
 * The estimate charges one UTF-8 byte as one token — above the ~4 bytes/token of English JSON, so
 * it over-counts rather than under-counts — and adds a fixed framing margin for the provider's own
 * envelope. It is only ever used to *refuse* a request that cannot fit a known context window; it
 * never truncates one, and it is not applied when no context window is known.
 */
function estimatedRequestTokens(request: AuditedJsonCallRequest, messages: readonly Message[]): number {
  const serialized = JSON.stringify({
    provider: request.provider,
    model: request.model,
    system: request.system,
    messages,
  });
  return Buffer.byteLength(serialized, 'utf8') + request.maxTokens + AUDIT_CONTEXT_FRAMING_MARGIN_TOKENS;
}

/** Race one host promise against the global deadline and, when given, the cancellation token. */
function raceDeadline<T>(work: Promise<T>, deadline: number, token?: CancellationToken): Promise<Raced<T>> {
  return new Promise<Raced<T>>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let off: (() => void) | undefined;
    const finish = (result: Raced<T>): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      off?.();
      resolve(result);
    };
    // Both settlements route through `finish`, so a late provider rejection is never unhandled.
    work.then(
      (value) => finish({ kind: 'value', value }),
      (error: unknown) => finish({ kind: 'failed', error }),
    );
    timer = setTimeout(() => finish({ kind: 'timeout' }), Math.max(1, deadline - Date.now()));
    off = token?.onCancel(() => finish({ kind: 'cancelled' }));
    if (token?.cancelled === true) {
      finish({ kind: 'cancelled' });
    }
  });
}

/** Best-effort iterator release that never awaits or blocks the caller. */
function closeIterator(iterator: AsyncIterator<StreamChunk>): void {
  let pending: unknown;
  try {
    pending = iterator.return?.();
  } catch {
    pending = undefined;
  }
  if (pending !== undefined && pending !== null && typeof (pending as { then?: unknown }).then === 'function') {
    void Promise.resolve(pending).catch(() => undefined);
  }
}

/** A rejected dispatch is only ever a refusal: nothing was adopted and no value returned. */
function failureResult<T>(
  failure: CallFailure,
  usage: ModelUsage | null,
  callId: string,
  sessionId: string | null,
): ModelCallResult<T> {
  return { ok: false, error: { code: failure.code, message: failure.message, retryable: failure.retryable }, usage, callId, sessionId };
}

function zeroUsage(): ModelUsage {
  return createModelUsage({ calls: 0 });
}

/** Append one typed audit event; `false` means the log refused it. */
function appendAuditEvent<T extends IcpcAuditEventType>(
  session: Session,
  type: T,
  data: SessionEventMap[T],
): boolean {
  try {
    if (type === 'icpc/model-call-audit') {
      session.append('icpc/model-call-audit', data as SessionEventMap['icpc/model-call-audit']);
    } else {
      session.append('icpc/model-call-result', data as SessionEventMap['icpc/model-call-result']);
    }
    return true;
  } catch {
    return false;
  }
}

/** One accepted raw chunk: its lossless JSON replay plus the bytes that representation costs. */
type LosslessChunk =
  | { readonly ok: true; readonly value: AuditedJson; readonly bytes: number }
  | { readonly ok: false; readonly reason: string };

/** Refusal of a value that has no faithful JSON form. */
class LosslessError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'LosslessError';
    this.reason = reason;
  }
}

/** Serialize one raw chunk, refusing anything JSON cannot round-trip faithfully. */
function losslessChunk(chunk: StreamChunk): LosslessChunk {
  try {
    const value = toLosslessJson(chunk, 0, new Set<object>());
    return { ok: true, value, bytes: Buffer.byteLength(JSON.stringify(value), 'utf8') };
  } catch (error) {
    return { ok: false, reason: error instanceof LosslessError ? error.reason : 'the chunk could not be serialized' };
  }
}

/**
 * Convert a raw provider chunk into exactly what JSON can round-trip losslessly.
 *
 * `undefined`, functions, symbols, bigints, non-finite numbers, class instances, `Date`s, functions
 * and cycles have no faithful JSON form, so they are refused instead of being silently dropped,
 * stringified or nulled: the audit record claims to replay the raw stream, and a value it cannot
 * replay must fail the call rather than be rewritten. Symbol-keyed and non-enumerable own
 * properties are refused too, because `Object.entries` would drop them without a trace.
 */
function toLosslessJson(value: unknown, depth: number, ancestors: Set<object>): AuditedJson {
  if (depth > MAX_AUDIT_JSON_DEPTH) {
    throw new LosslessError(`nesting deeper than ${MAX_AUDIT_JSON_DEPTH} levels cannot be replayed`);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new LosslessError('a non-finite number cannot be replayed');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new LosslessError('a cyclic array cannot be replayed');
    }
    ancestors.add(value);
    const items: AuditedJson[] = [];
    // `for..of` visits holes as `undefined`, which the recursion then refuses: a sparse array would
    // otherwise be silently rewritten to `null` by JSON.
    for (const entry of value) {
      items.push(toLosslessJson(entry, depth + 1, ancestors));
    }
    ancestors.delete(value);
    return items;
  }
  if (typeof value === 'object') {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new LosslessError(`a ${constructorName(value)} value cannot be replayed`);
    }
    if (ancestors.has(value)) {
      throw new LosslessError('a cyclic object cannot be replayed');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new LosslessError('a symbol-keyed property cannot be replayed');
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) {
        throw new LosslessError(`the non-enumerable property ${key} cannot be replayed`);
      }
    }
    ancestors.add(value);
    const record: Record<string, AuditedJson> = {};
    for (const [key, entry] of Object.entries(value)) {
      defineJsonKey(record, key, toLosslessJson(entry, depth + 1, ancestors));
    }
    ancestors.delete(value);
    return record;
  }
  throw new LosslessError(`a ${typeof value} value cannot be replayed`);
}

function constructorName(value: object): string {
  const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === 'string' && name.length > 0 ? name : 'class';
}

/**
 * UTF-8 bytes of the fully serialized input `{ system, userPrompt }`.
 *
 * JSON escaping expands quotes, backslashes and control characters, so the raw prompt length
 * under-counts what the request serializes: the prompt cap applies to this value.
 */
function serializedInputBytes(input: { readonly system: string; readonly userPrompt: string }): number {
  return Buffer.byteLength(JSON.stringify({ system: input.system, userPrompt: input.userPrompt }), 'utf8');
}

function validateRequest(request: AuditedJsonCallRequest): string | null {
  if (!AUDITED_MODEL_ROLES.includes(request.role)) {
    return `unknown model call role ${String(request.role)}`;
  }
  for (const [label, value] of [
    ['provider', request.provider],
    ['model', request.model],
    ['attemptId', request.attemptId],
    ['promptVersion', request.promptVersion],
    ['snapshotId', request.snapshotId],
  ] as const) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return `${label} is required`;
    }
  }
  if (typeof request.system !== 'string' || typeof request.userPrompt !== 'string') {
    return 'system and userPrompt must be strings';
  }
  const promptBytes = serializedInputBytes(request);
  if (promptBytes > MAX_AUDIT_PROMPT_BYTES) {
    return `the serialized system + userPrompt input is ${promptBytes} UTF-8 bytes, above the ${MAX_AUDIT_PROMPT_BYTES}-byte cap`;
  }
  if (
    !Number.isSafeInteger(request.maxTokens) ||
    request.maxTokens < MIN_AUDIT_MAX_TOKENS ||
    request.maxTokens > MAX_AUDIT_MAX_TOKENS
  ) {
    return `maxTokens must be an integer within ${MIN_AUDIT_MAX_TOKENS}..${MAX_AUDIT_MAX_TOKENS}`;
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > MAX_AUDIT_TIMEOUT_MS) {
    return `timeoutMs must be an integer within 1..${MAX_AUDIT_TIMEOUT_MS}`;
  }
  if (request.temperature !== undefined && !Number.isFinite(request.temperature)) {
    return 'temperature must be a finite number';
  }
  if (
    request.effort !== undefined &&
    (typeof request.effort !== 'string' || String(request.effort).trim().length === 0)
  ) {
    return 'effort must be a non-empty identifier when supplied';
  }
  return null;
}

/** Internal detail for the audit log; the caller-facing message stays fixed per failure code. */
function auditErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return `thrown ${typeof error}`;
}

/** Convert a locally built value for the audit log; unsupported leaves become `null`. */
function auditJson(value: unknown): AuditedJson {
  const converted = toAuditJson(value);
  return converted === SKIP ? null : converted;
}

/** Lossless-JSON conversion for values this client built itself; undefined leaves are omitted. */
function toAuditJson(value: unknown, depth = 0): AuditedJson | typeof SKIP {
  if (depth > MAX_AUDIT_JSON_DEPTH) {
    return null;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    const items: AuditedJson[] = [];
    for (const entry of value) {
      const converted = toAuditJson(entry, depth + 1);
      if (converted !== SKIP) {
        items.push(converted);
      }
    }
    return items;
  }
  if (typeof value === 'object') {
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (value instanceof Error) {
      return { name: value.name, message: value.message };
    }
    const record: Record<string, AuditedJson> = {};
    for (const [key, entry] of Object.entries(value)) {
      const converted = toAuditJson(entry, depth + 1);
      if (converted !== SKIP) {
        defineJsonKey(record, key, converted);
      }
    }
    return record;
  }
  return SKIP;
}

/**
 * Define one own, enumerable JSON key.
 *
 * A literal `__proto__` key must become own data: `record[key] = value` would invoke the prototype
 * setter, mutate the prototype and drop the key instead of round-tripping it.
 */
function defineJsonKey(record: Record<string, AuditedJson>, key: string, value: AuditedJson): void {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}
