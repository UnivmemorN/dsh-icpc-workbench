/**
 * Progressive coaching service (Stage 4s2b).
 *
 * One `ask` is one user-visible coaching request: it is deduplicated by the caller-supplied
 * `requestId`, reserves at most one paid model call, and returns a JSON-serializable DTO the
 * future API/UI can render without ever seeing a storage row. The service owns policy —
 * level progression, global quota, cancellation, staleness, spoiler discipline and audit
 * mapping — the injected {@link CoachingGenerator} owns the tutor prompt and the strict output
 * contract, and the injected store owns durability. Nothing here reads a clock, an environment
 * variable, a credential or a provider client; the model call is the only IO besides the store.
 *
 * ## The accounting protocol
 *
 * 1. Refusals that need no reservation (unknown problem/account, missing snapshot or statement,
 *    a `full` request without the explicit flag, an unearned hint level) are decided before any
 *    write, so they cost nothing and dispatch nothing.
 * 2. Exactly one transaction reserves a call: it re-reads the current snapshot head and the
 *    settings, deduplicates the request id, recovers expired reservations as `uncertain`,
 *    enforces global single-flight plus the rolling-24h quota, collects the eligible earlier
 *    hints of the current snapshot, writes the `reserved` row, and finally re-checks the
 *    cancellation token — a cancellation inside that transaction rolls the reservation back
 *    before any dispatch. The token is re-checked at the transaction entry, after every awaited
 *    recovery write and immediately before each early return, so a cancellation observed while
 *    recovery or a history walk was in flight rolls the whole transaction back — its recovery
 *    writes included — instead of escaping through a refusal or dedup branch. No provider IO ever
 *    runs inside a database transaction.
 * 3. A cancellation that lands between the reservation commit and dispatch settles the
 *    reservation with known-zero usage and a `cancelled` error: no model call is made and the
 *    audit stays honest.
 * 4. Every dispatch settles durably, whatever the caller does afterwards. A success keeps its
 *    text; a success whose snapshot stopped being the head is settled with its cost and a stale
 *    error and its text is discarded; unknown usage becomes `uncertain` (never a free call,
 *    never an automatic retry); a cancellation sampled at settlement time is recorded as a
 *    `cancelled` error with the known usage. The token is **sampled, never thrown** inside
 *    settlement, so a paid record can never be rolled back by a cancellation. A cancellation
 *    that lands after the settlement commit only hides the immediate return; the settled row is
 *    immutable and stays retrievable through {@link CoachingService.getStatus}. A success is
 *    returned as `answered` only while its snapshot is *still* the head at projection time: a
 *    head that moves between the settlement commit and the projection turns the immediate return
 *    into a `failed`/`stale_snapshot` view with no text, while the already settled cost and
 *    history stay untouched. An unexpected generator exception is recorded with a fixed
 *    sanitized message, never the raw exception text, so a provider secret, credential or local
 *    path cannot travel through a public ask/history/status result.
 * 5. Answers are spoilers. `ask` returns text only while the answer's snapshot is the current
 *    head; `history` is metadata-only unless one explicit level is requested for its body, and a
 *    stale snapshot additionally needs `includeStale`; `getStatus` follows the same rule. Every
 *    answer DTO is labelled `unverified_ai`: a model hint is never presented as verified.
 *
 * ## Bounded reads
 *
 * Quota checks, expired-reservation recovery and level progression never scan an unbounded
 * history: the service walks status-filtered pages of {@link COACHING_PAGE_SIZE} and refuses
 * with a typed `history_overflow` error once a walk would exceed {@link MAX_COACHING_HISTORY_SCAN}
 * attempts (`maxHistoryScan`). Refusing is deliberate — counting a truncated history would hand
 * out quota that is not actually available.
 *
 * ## Errors
 *
 * Malformed arguments and request-id identity conflicts are thrown as
 * {@link CoachingServiceError} with a stable `code`; every runtime outcome (refused, pending,
 * failed, uncertain, answered) is a result object. Storage and provider failures propagate as
 * their own typed errors; nothing is swallowed.
 */
import {
  COACHING_PROMPT_VERSION,
  type CoachingGenerationOutcome,
  type CoachingGenerationRequest,
  type CoachingGenerator,
  type CoachingPreviousHint,
} from './coaching-generation.js';
import {
  COACHING_LEVELS,
  type CoachingAttempt,
  type CoachingAttemptQuery,
  type CoachingLevel,
  type CoachingStatus,
  type CoachingStore,
} from './coaching-types.js';
import type { ModelCallResult, ModelErrorCode, ModelGatewayError, TrainingStore } from './ports.js';
import { defaultWorkbenchSettings, type SettingsStore, type WorkbenchSettings } from './workbench-settings.js';
import {
  DomainError,
  assertIsoTimestamp,
  createModelUsage,
  parseProblemKey,
  type CancellationToken,
  type ModelUsage,
  type ProblemSnapshot,
  type SnapshotHead,
} from '../domain/index.js';

/** Attempts read per store page; also the default and maximum page size of `history`. */
export const COACHING_PAGE_SIZE = 500;

/** Hard bound of one internal history walk; exceeding it is a typed refusal, never a truncation. */
export const MAX_COACHING_HISTORY_SCAN = 10_000;

/** Maximum accepted `requestId` length; the UI owns the uuid, the service only bounds it. */
export const MAX_COACHING_REQUEST_ID_CHARS = 200;

/** Reservation safety margin added to the configured model timeout. */
export const COACHING_LEASE_MARGIN_MS = 30_000;

/** Rolling window of the plugin-wide coaching quota. */
export const COACHING_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Stable codes of the errors this service throws for a caller contract violation. */
export type CoachingServiceErrorCode =
  | 'invalid_request'
  | 'request_conflict'
  | 'history_overflow'
  | 'storage_inconsistent';

/** Typed, code-bearing error for caller contract violations and saturation guards. */
export class CoachingServiceError extends Error {
  readonly code: CoachingServiceErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: CoachingServiceErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'CoachingServiceError';
    this.code = code;
    this.details = details;
  }
}

/** Refusals decided before any paid call; every one of them leaves the quota untouched. */
export type CoachingRefusalCode =
  | 'unknown_problem'
  | 'unknown_account'
  | 'account_mismatch'
  | 'snapshot_missing'
  | 'manual_statement_needed'
  | 'full_solution_not_requested'
  | 'level_not_earned'
  | 'coaching_quota_exhausted'
  | 'concurrent_call_active';

/** Stable code of one coaching failure: provider vocabulary plus service refusals and staleness. */
export type CoachingErrorCode = ModelErrorCode | CoachingRefusalCode | 'stale_snapshot';

/** One typed failure a caller/UI can render without parsing prose. */
export interface CoachingErrorView {
  readonly code: CoachingErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

/** Request of one coaching `ask`; `requestId` is the caller-owned idempotency key. */
export interface CoachingAskRequest {
  /** Stable UI-owned id (a uuid, at most {@link MAX_COACHING_REQUEST_ID_CHARS} characters). */
  readonly requestId: string;
  /** Selected account, or `null` for the anonymous scope. */
  readonly accountId: string | null;
  readonly problemKey: string;
  readonly level: CoachingLevel;
  /** Only `true` is accepted for `level: 'full'`; hint levels must not set it. */
  readonly explicitFullSolution?: boolean;
}

/** A successful coaching answer. `text` is Markdown/plain text, never interpreted as HTML. */
export interface CoachingAnsweredView {
  readonly status: 'answered';
  readonly requestId: string;
  readonly attemptId: string;
  readonly accountId: string | null;
  readonly problemKey: string;
  readonly level: CoachingLevel;
  readonly snapshotId: string;
  /** Always `current`: a stale answer is never returned as a success. */
  readonly snapshotState: 'current';
  readonly finishedAt: string;
  readonly text: string;
  readonly usage: ModelUsage;
  /** AI output is never independently verified; the API must keep labelling it. */
  readonly verification: 'unverified_ai';
}

/**
 * A request that produced no answer.
 *
 * `refused` charged nothing (no attempt row), `pending` has a live reservation for this very
 * request, `failed` has a durable attempt with known usage and a terminal error (including a
 * withheld answer), and `uncertain` has a durable attempt whose usage the provider never
 * reported — it still counts against the quota and is never retried automatically.
 */
export interface CoachingUnansweredView {
  readonly status: 'refused' | 'pending' | 'failed' | 'uncertain';
  readonly requestId: string;
  readonly attemptId: string | null;
  readonly accountId: string | null;
  readonly problemKey: string;
  readonly level: CoachingLevel;
  readonly snapshotId: string | null;
  readonly snapshotState: 'current' | 'stale' | 'unknown';
  readonly usage: ModelUsage | null;
  readonly error: CoachingErrorView;
  readonly verification: 'unverified_ai';
}

export type CoachingAskResult = CoachingAnsweredView | CoachingUnansweredView;

/** Metadata-only view of one durable attempt; `responseText` only when spoilers allow it. */
export interface CoachingAttemptView {
  readonly attemptId: string;
  readonly accountId: string | null;
  readonly level: CoachingLevel;
  readonly status: CoachingStatus;
  readonly snapshotId: string;
  readonly snapshotState: 'current' | 'stale';
  readonly requestedAt: string;
  readonly finishedAt: string | null;
  readonly usage: ModelUsage | null;
  /** Code and retryability only: provider error internals are never exposed here. */
  readonly error: { readonly code: CoachingErrorCode; readonly retryable: boolean } | null;
  readonly verification: 'unverified_ai';
  /** Present only when the caller explicitly asked for this level's body and spoilers allow it. */
  readonly responseText?: string;
}

/** One page of coaching history; the cursor is bound to the account/problem filter set. */
export interface CoachingHistoryResult {
  readonly accountId: string | null;
  readonly problemKey: string;
  readonly level: CoachingLevel | null;
  readonly headSnapshotId: string | null;
  readonly items: readonly CoachingAttemptView[];
  readonly nextCursor: string | null;
  readonly verification: 'unverified_ai';
}

/** Request of one `history` read; `accountId: null` means the anonymous scope only. */
export interface CoachingHistoryRequest {
  readonly accountId: string | null;
  readonly problemKey: string;
  /** Optional single-level filter; required to request an answer body. */
  readonly level?: CoachingLevel | null;
  /** Request the body of that one level; metadata-only pages never carry answers. */
  readonly includeResponseText?: boolean;
  /** Explicitly allow the body of a snapshot that is no longer current (for `level` only). */
  readonly includeStale?: boolean;
  readonly limit?: number;
  readonly cursor?: string | null;
}

/** Spoiler options shared by `history` and `getStatus`. */
export interface CoachingSpoilerOptions {
  readonly includeResponseText?: boolean;
  readonly includeStale?: boolean;
}

export type CoachingStatusResult =
  | {
      readonly status: 'unknown';
      readonly requestId: string;
      readonly accountId: string | null;
      readonly problemKey: string;
      readonly verification: 'unverified_ai';
    }
  | {
      readonly status: 'found';
      readonly requestId: string;
      readonly attempt: CoachingAttemptView;
      readonly verification: 'unverified_ai';
    };

/** Persistence surface the service needs; one SQLite store implements all three ports. */
export type CoachingServiceStore = CoachingStore & TrainingStore & SettingsStore;

/**
 * One unexpected generator exception, offered to {@link CoachingServiceOptions.onInternalError}.
 *
 * No public ask/history/status DTO ever carries this: the durable row and every public result
 * keep a fixed sanitized message, so a provider secret, a credential or a local path cannot leak
 * out of a coaching result. `error` is the original thrown value, local diagnostic material only.
 */
export interface CoachingInternalErrorReport {
  readonly attemptId: string;
  readonly phase: 'generation';
  /** Sanitized code the attempt was settled with. */
  readonly code: ModelErrorCode;
  /** The original thrown value; never persisted and never returned in a result. */
  readonly error: unknown;
}

export interface CoachingServiceOptions {
  readonly store: CoachingServiceStore;
  readonly generator: CoachingGenerator;
  /** Injected clock; every timestamp the service persists comes from here. */
  readonly now: () => string;
  /** Bound of one internal history walk; defaults to {@link MAX_COACHING_HISTORY_SCAN}. */
  readonly maxHistoryScan?: number;
  /**
   * Optional local diagnostic sink for an unexpected generator exception.
   *
   * Called once per thrown generator call, *after* its `uncertain` settlement is durable, so a
   * failing hook can never roll back a paid record. This hook is the only place the raw thrown
   * value is handed out; no public result carries it. A hook that throws propagates to the caller
   * of `ask` — the service never swallows a failure — and the settled row stays retrievable.
   */
  readonly onInternalError?: (report: CoachingInternalErrorReport) => void;
}

interface ParsedAsk {
  readonly requestId: string;
  readonly accountId: string | null;
  readonly problemKey: string;
  readonly level: CoachingLevel;
  readonly explicitFullSolution: boolean;
}

type ReserveOutcome =
  | {
      readonly kind: 'reserved';
      readonly reservation: CoachingAttempt;
      readonly hints: readonly CoachingPreviousHint[];
      readonly settings: WorkbenchSettings;
    }
  | { readonly kind: 'existing'; readonly attempt: CoachingAttempt }
  | { readonly kind: 'refused'; readonly error: CoachingErrorView };

/** How a settled dispatch ended; the durable row alone cannot always tell (a stale answer). */
type SettlementOutcome = 'answered' | 'cancelled' | 'stale' | 'error' | 'uncertain';

interface SettledCall {
  readonly attempt: CoachingAttempt;
  readonly outcome: SettlementOutcome;
  readonly error: ModelGatewayError | null;
}

interface SettlementPatch {
  readonly status: 'settled' | 'uncertain';
  readonly finishedAt: string;
  readonly usage: ModelUsage | null;
  readonly responseText: string | null;
  readonly error: ModelGatewayError | null;
  readonly hostSessionId: string | null;
  readonly hostCallId: string | null;
}

/**
 * Progressive coaching use case. One instance may serve many concurrent callers; the durable
 * reservation row (inserted under the store's transaction) is what prevents two paid calls,
 * so sharing the service is safe and no in-process lock is needed.
 */
export class CoachingService {
  private readonly store: CoachingServiceStore;
  private readonly generator: CoachingGenerator;
  private readonly now: () => string;
  private readonly maxHistoryScan: number;
  private readonly onInternalError: ((report: CoachingInternalErrorReport) => void) | undefined;

  constructor(options: CoachingServiceOptions) {
    if (options === null || typeof options !== 'object') {
      throw new CoachingServiceError('invalid_request', 'coaching service needs an options object', {});
    }
    if (options.store === null || typeof options.store !== 'object') {
      throw new CoachingServiceError('invalid_request', 'coaching service needs a store intersection', {});
    }
    if (options.generator === null || typeof options.generator !== 'object') {
      throw new CoachingServiceError('invalid_request', 'coaching service needs a generator', {});
    }
    if (typeof options.now !== 'function') {
      throw new CoachingServiceError('invalid_request', 'coaching service needs an injected now()', {});
    }
    const maxHistoryScan = options.maxHistoryScan ?? MAX_COACHING_HISTORY_SCAN;
    if (!Number.isSafeInteger(maxHistoryScan) || maxHistoryScan < 1) {
      throw new CoachingServiceError('invalid_request', 'maxHistoryScan must be a positive integer', {
        maxHistoryScan,
      });
    }
    if (options.onInternalError !== undefined && typeof options.onInternalError !== 'function') {
      throw new CoachingServiceError('invalid_request', 'onInternalError must be a function when present', {});
    }
    this.store = options.store;
    this.generator = options.generator;
    this.now = options.now;
    this.maxHistoryScan = maxHistoryScan;
    this.onInternalError = options.onInternalError;
  }

  // -------------------------------------------------------------------------------------
  // Ask
  // -------------------------------------------------------------------------------------

  /**
   * Ask for one progressive hint or the full explanation.
   *
   * See the module comment for the accounting protocol. The returned DTO always identifies the
   * request; a repeat of the same `requestId` with the same account/problem/level never pays
   * again, and a repeat with a different identity is rejected as a `request_conflict`.
   */
  async ask(request: CoachingAskRequest, token: CancellationToken): Promise<CoachingAskResult> {
    const ask = parseAskRequest(request);
    requireToken(token);
    if (token.cancelled) {
      return refused(ask, 'cancelled', 'coaching request was cancelled before any call was made', false);
    }
    if (ask.level === 'full' && !ask.explicitFullSolution) {
      return refused(
        ask,
        'full_solution_not_requested',
        "coaching level 'full' is generated only when the full solution was explicitly requested (explicitFullSolution: true)",
        false,
      );
    }

    // Fast path: a durable attempt for this request id is returned as-is, whatever its status.
    const known = await this.store.getCoachingAttempt(ask.requestId);
    if (known !== null) {
      assertRequestIdentity(known, ask);
      if (known.status !== 'reserved' || !this.isExpired(known)) {
        return this.resultOfAttempt(known, token);
      }
      // An expired reservation is recovered by the reservation transaction below.
    }

    const problem = await this.store.getProblem(ask.problemKey);
    if (problem === null) {
      return refused(ask, 'unknown_problem', `problem ${ask.problemKey} is not stored; sync or import it first`, false);
    }
    if (ask.accountId !== null) {
      const account = await this.store.getAccount(ask.accountId);
      if (account === null) {
        return refused(ask, 'unknown_account', `account ${ask.accountId} is not stored`, false);
      }
      if (account.sourceInstanceId !== problem.ref.sourceInstanceId) {
        return refused(
          ask,
          'account_mismatch',
          `account ${ask.accountId} belongs to ${account.sourceInstanceId}, not to the problem's source instance ${problem.ref.sourceInstanceId}`,
          false,
        );
      }
    }
    const head = await this.store.getCurrentSnapshotHead(problem.ref);
    const snapshot = head === null ? null : await this.store.getSnapshot(head.snapshotId);
    if (head === null || snapshot === null) {
      return refused(
        ask,
        'snapshot_missing',
        head === null
          ? `problem ${ask.problemKey} has no snapshot; freeze a current snapshot before asking for coaching`
          : `snapshot ${head.snapshotId} is the recorded head of ${ask.problemKey} but is not stored`,
        false,
      );
    }
    const statement = snapshot.problem.statement;
    if (statement === null || statement.trim().length === 0) {
      return refused(
        ask,
        'manual_statement_needed',
        `snapshot ${snapshot.snapshotId} has no problem statement; coaching never guesses from the title, so add the statement and freeze a new snapshot`,
        false,
      );
    }
    if (token.cancelled) {
      return refused(ask, 'cancelled', 'coaching request was cancelled before any call was made', false);
    }

    let reserved: ReserveOutcome;
    try {
      reserved = await this.reserve(ask, snapshot, token);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'cancelled') {
        // The token check inside the reservation transaction rolled the reservation back.
        return refused(ask, 'cancelled', 'coaching request was cancelled before the model call; no call was paid', false);
      }
      throw error;
    }
    if (reserved.kind === 'refused') {
      return refusedWith(ask, reserved.error);
    }
    if (reserved.kind === 'existing') {
      assertRequestIdentity(reserved.attempt, ask);
      return this.resultOfAttempt(reserved.attempt, token);
    }

    if (token.cancelled) {
      // The reservation is already durable: close it with known-zero usage instead of dispatching.
      return this.settlementResult(await this.settleCancelled(reserved.reservation), token);
    }

    const generation: CoachingGenerationRequest = {
      snapshot,
      level: ask.level,
      provider: reserved.settings.provider,
      model: reserved.settings.coaching.model,
      maxOutputTokens: reserved.settings.coaching.maxOutputTokens,
      requestTimeoutMs: reserved.settings.coaching.requestTimeoutMs,
      effort: reserved.settings.coaching.effort,
      attemptId: reserved.reservation.id,
      promptVersion: COACHING_PROMPT_VERSION,
      token,
      previousHints: reserved.hints,
      explicitFullSolution: ask.level === 'full',
    };

    let result: ModelCallResult<CoachingGenerationOutcome>;
    try {
      result = await this.generator.generate(generation);
    } catch (error) {
      // A thrown generator has an unknown outcome: the call stays on the books as uncertain with a
      // sanitized error, and the raw value only ever reaches the local diagnostic hook.
      const settled = await this.settleThrow(reserved.reservation, error, token);
      this.reportInternalError(settled.attempt.id, settled.error?.code ?? 'provider_error', error);
      return this.settlementResult(settled, token);
    }
    return this.settlementResult(await this.settleAfterDispatch(reserved.reservation, snapshot, result, token), token);
  }

  // -------------------------------------------------------------------------------------
  // History & status
  // -------------------------------------------------------------------------------------

  /**
   * One metadata page of the coaching history of one account/problem.
   *
   * Bodies are spoilers: `responseText` is attached only when the caller names exactly one
   * `level`, asks for `includeResponseText`, and either that level's snapshot is still the head
   * or `includeStale` was set explicitly. Without a level the page never carries an answer, so a
   * caller cannot bootstrap every hint and the full solution by accident. The head is read after
   * the page — the last read before projection — so currentness is decided against the state the
   * page is actually projected onto.
   */
  async history(request: CoachingHistoryRequest, token: CancellationToken): Promise<CoachingHistoryResult> {
    requireToken(token);
    token.throwIfCancelled();
    if (request === null || typeof request !== 'object') {
      throw new CoachingServiceError('invalid_request', 'history needs a request object', {});
    }
    const accountId = requireAccountScope(request.accountId);
    const problemKey = requireProblemKey(request.problemKey);
    const level = request.level === undefined || request.level === null ? null : requireLevel(request.level);
    const includeResponseText = request.includeResponseText === true;
    const includeStale = request.includeStale === true;
    if (includeStale && !includeResponseText) {
      throw new CoachingServiceError(
        'invalid_request',
        'includeStale only applies together with includeResponseText for one explicit level',
        { problemKey },
      );
    }
    if (includeResponseText && level === null) {
      throw new CoachingServiceError(
        'invalid_request',
        'history needs an explicit single level to include an answer body; metadata pages never carry answers',
        { problemKey },
      );
    }
    const limit = requireLimit(request.limit);
    const cursor = request.cursor ?? null;
    if (cursor !== null && typeof cursor !== 'string') {
      throw new CoachingServiceError('invalid_request', 'history cursor must be null or an opaque string', {});
    }

    // The page is read first and the head last: a head advance during the page read must not be
    // missed just because the head was snapshotted before that await — that would project a stale
    // answer as current without `includeStale`.
    const page = await this.store.listCoachingAttempts({ accountId, problemKey, limit, cursor });
    token.throwIfCancelled();
    const head = await this.store.getCurrentSnapshotHead(parseProblemKey(problemKey));
    token.throwIfCancelled();
    const items = page.items
      .filter((attempt) => level === null || attempt.level === level)
      .map((attempt) => attemptViewOf(attempt, head, { includeResponseText, includeStale }));
    return {
      accountId,
      problemKey,
      level,
      headSnapshotId: head?.snapshotId ?? null,
      items,
      nextCursor: page.nextCursor,
      verification: 'unverified_ai',
    };
  }

  /**
   * Status of one durable attempt by request id.
   *
   * The request id is a correlation key, not an authorization boundary, but the account and
   * problem in the call must match the stored attempt or the read is rejected as a
   * `request_conflict`. A stale answer is hidden unless `includeStale` explicitly asks for it.
   */
  async getStatus(
    requestId: string,
    accountId: string | null,
    problemKey: string,
    token: CancellationToken,
    options: CoachingSpoilerOptions = {},
  ): Promise<CoachingStatusResult> {
    requireToken(token);
    token.throwIfCancelled();
    const id = requireRequestId(requestId);
    const account = requireAccountScope(accountId);
    const key = requireProblemKey(problemKey);
    const includeResponseText = options.includeResponseText === true;
    const includeStale = options.includeStale === true;
    if (includeStale && !includeResponseText) {
      throw new CoachingServiceError(
        'invalid_request',
        'includeStale only applies together with includeResponseText',
        { requestId: id },
      );
    }

    const attempt = await this.store.getCoachingAttempt(id);
    token.throwIfCancelled();
    if (attempt === null) {
      return { status: 'unknown', requestId: id, accountId: account, problemKey: key, verification: 'unverified_ai' };
    }
    assertRequestIdentity(attempt, {
      requestId: id,
      accountId: account,
      problemKey: key,
      level: attempt.level,
      explicitFullSolution: attempt.level === 'full',
    });
    const head = await this.store.getCurrentSnapshotHead(parseProblemKey(attempt.problemKey));
    token.throwIfCancelled();
    return {
      status: 'found',
      requestId: id,
      attempt: attemptViewOf(attempt, head, { includeResponseText, includeStale }),
      verification: 'unverified_ai',
    };
  }

  // -------------------------------------------------------------------------------------
  // Reservation
  // -------------------------------------------------------------------------------------

  /**
   * The only reservation transaction.
   *
   * Recovery, dedup, single-flight, quota, progression and the reservation write all happen
   * under one store transaction with no provider IO. Every token check here is a *throw* — at the
   * entry, after each awaited recovery write and before each early return — so a cancellation
   * observed anywhere inside the transaction rolls the whole transaction back (recovery writes
   * included) and nothing is charged for a request that was cancelled before dispatch. Charged
   * settlement is the opposite: there the token is sampled, never thrown.
   */
  private async reserve(ask: ParsedAsk, snapshot: ProblemSnapshot, token: CancellationToken): Promise<ReserveOutcome> {
    return this.store.transaction(async (): Promise<ReserveOutcome> => {
      token.throwIfCancelled();
      const at = assertIsoTimestamp('coaching now', this.now());
      const active = await this.recoverExpiredReservations(at, token);

      const existing = await this.store.getCoachingAttempt(ask.requestId);
      token.throwIfCancelled();
      if (existing !== null) {
        return { kind: 'existing', attempt: existing };
      }
      const head = await this.store.getCurrentSnapshotHead(snapshot.problem.ref);
      token.throwIfCancelled();
      if (head === null || head.snapshotId !== snapshot.snapshotId) {
        return {
          kind: 'refused',
          error: {
            code: 'stale_snapshot',
            message: `snapshot ${snapshot.snapshotId} stopped being the current head of ${ask.problemKey} before the call was reserved`,
            retryable: false,
          },
        };
      }
      const settings = await this.readSettings();
      token.throwIfCancelled();
      const blocking = active[0];
      if (blocking !== undefined && active.length >= settings.coaching.maxConcurrent) {
        return {
          kind: 'refused',
          error: {
            code: 'concurrent_call_active',
            message: `coaching call ${blocking.id} is reserved until ${blocking.expiresAt}; only ${settings.coaching.maxConcurrent} coaching call(s) may be in flight`,
            retryable: true,
          },
        };
      }
      const since = new Date(Date.parse(at) - COACHING_QUOTA_WINDOW_MS).toISOString();
      const used = await this.store.countCoachingAttempts({ since });
      token.throwIfCancelled();
      if (used >= settings.coaching.maxCallsPer24Hours) {
        return {
          kind: 'refused',
          error: {
            code: 'coaching_quota_exhausted',
            message: `coaching quota: ${used} of ${settings.coaching.maxCallsPer24Hours} calls were used in the rolling 24 hours ending ${at}`,
            retryable: true,
          },
        };
      }

      const successes = await this.lowerLevelSuccesses(snapshot, ask);
      token.throwIfCancelled();
      const missing = requiredLowerLevels(ask.level).find((level) => !successes.has(level));
      if (missing !== undefined) {
        return {
          kind: 'refused',
          error: {
            code: 'level_not_earned',
            message: `coaching level ${String(ask.level)} needs a settled level-${missing} hint on snapshot ${snapshot.snapshotId}; ask for level ${missing} first`,
            retryable: false,
          },
        };
      }
      const hints: CoachingPreviousHint[] = [];
      for (const level of levelsBelow(ask.level)) {
        const attempt = successes.get(level);
        if (attempt !== undefined && attempt.responseText !== null) {
          hints.push({ level, text: attempt.responseText });
        }
      }

      const reservation: CoachingAttempt = {
        id: ask.requestId,
        accountId: ask.accountId,
        problemKey: snapshot.problem.key,
        snapshotId: snapshot.snapshotId,
        level: ask.level,
        requestedAt: at,
        expiresAt: new Date(
          Date.parse(at) + settings.coaching.requestTimeoutMs + COACHING_LEASE_MARGIN_MS,
        ).toISOString(),
        finishedAt: null,
        status: 'reserved',
        provider: settings.provider,
        model: settings.coaching.model,
        promptVersion: COACHING_PROMPT_VERSION,
        hostSessionId: null,
        hostCallId: null,
        usage: null,
        responseText: null,
        error: null,
      };
      await this.store.saveCoachingAttempt(reservation);
      token.throwIfCancelled();
      return { kind: 'reserved', reservation, hints, settings };
    });
  }

  /**
   * Turn every expired `reserved` attempt into `uncertain` and return the still-live ones.
   *
   * The walk is status-filtered and bounded; an overflowing walk throws `history_overflow` and
   * the transaction rolls back, so a truncated history can never be used to grant quota. The
   * caller's token is re-checked after the walk and after every recovery write, so a cancellation
   * that lands during recovery rolls the recovery back together with the rest of the transaction.
   * Quota is never refunded: a recovered attempt keeps its place in the rolling count and simply
   * records a timeout error because its provider outcome is unknown.
   */
  private async recoverExpiredReservations(at: string, token: CancellationToken): Promise<readonly CoachingAttempt[]> {
    const reserved = await this.walkAttempts({ status: 'reserved' });
    token.throwIfCancelled();
    const active: CoachingAttempt[] = [];
    for (const attempt of reserved) {
      if (Date.parse(attempt.expiresAt) > Date.parse(at)) {
        active.push(attempt);
        continue;
      }
      await this.store.saveCoachingAttempt({
        ...attempt,
        status: 'uncertain',
        finishedAt: at,
        error: {
          code: 'timeout',
          message: `coaching reservation ${attempt.id} expired at ${attempt.expiresAt} before it settled; the provider outcome is unknown and the call still counts`,
          retryable: false,
        },
      });
      // A cancellation observed here throws: the transaction rolls back, so the expired row
      // returns to `reserved` instead of being silently recovered for a cancelled request.
      token.throwIfCancelled();
    }
    return active;
  }

  /** Latest settled successful hint per level below the requested one, current snapshot only. */
  private async lowerLevelSuccesses(
    snapshot: ProblemSnapshot,
    ask: ParsedAsk,
  ): Promise<Map<1 | 2 | 3, CoachingAttempt>> {
    const rows = await this.walkAttempts({
      accountId: ask.accountId,
      problemKey: ask.problemKey,
      status: 'settled',
    });
    const successes = new Map<1 | 2 | 3, CoachingAttempt>();
    for (const attempt of rows) {
      if (attempt.snapshotId !== snapshot.snapshotId) continue;
      if (attempt.level === 'full' || attempt.responseText === null) continue;
      // Rows arrive in `requestedAt, id` order, so a later row is the latest success of its level.
      successes.set(attempt.level, attempt);
    }
    return successes;
  }

  /** One bounded status-filtered walk; see the module comment on bounded reads. */
  private async walkAttempts(query: Omit<CoachingAttemptQuery, 'limit' | 'cursor'>): Promise<readonly CoachingAttempt[]> {
    const collected: CoachingAttempt[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await this.store.listCoachingAttempts({ ...query, limit: COACHING_PAGE_SIZE, cursor });
      collected.push(...page.items);
      if (collected.length > this.maxHistoryScan) {
        throw new CoachingServiceError(
          'history_overflow',
          `coaching history walk exceeded ${this.maxHistoryScan} attempts; narrow the account, problem or time window instead of counting a truncated history`,
          { bound: this.maxHistoryScan, scanned: collected.length },
        );
      }
      cursor = page.nextCursor;
      if (cursor === null) {
        return collected;
      }
    }
  }

  // -------------------------------------------------------------------------------------
  // Settlement
  // -------------------------------------------------------------------------------------

  /**
   * Persist the outcome of one completed dispatch.
   *
   * The token is sampled, never thrown: settlement must commit even when the user cancelled, so
   * the paid record is never rolled back. Staleness wins over cancellation because it describes
   * the stored data, and an unknown-usage result always becomes `uncertain` (never a free call,
   * never an automatic retry).
   */
  private async settleAfterDispatch(
    reservation: CoachingAttempt,
    snapshot: ProblemSnapshot,
    result: ModelCallResult<CoachingGenerationOutcome>,
    token: CancellationToken,
  ): Promise<SettledCall> {
    return this.store.transaction(async (): Promise<SettledCall> => {
      const at = assertIsoTimestamp('coaching now', this.now());
      const cancelled = token.cancelled;
      const hostSessionId = result.sessionId ?? null;
      const hostCallId = result.callId;
      if (result.ok) {
        const head = await this.store.getCurrentSnapshotHead(snapshot.problem.ref);
        if (head === null || head.snapshotId !== snapshot.snapshotId) {
          const error = staleCompletionError(snapshot, head);
          const attempt = await this.saveSettlement(reservation, {
            status: 'settled',
            finishedAt: at,
            usage: result.usage,
            responseText: null,
            error,
            hostSessionId,
            hostCallId,
          });
          return { attempt, outcome: 'stale', error };
        }
        if (cancelled) {
          const error = cancelledError('coaching request was cancelled by the user; the paid answer was withheld');
          const attempt = await this.saveSettlement(reservation, {
            status: 'settled',
            finishedAt: at,
            usage: result.usage,
            responseText: null,
            error,
            hostSessionId,
            hostCallId,
          });
          return { attempt, outcome: 'cancelled', error };
        }
        const attempt = await this.saveSettlement(reservation, {
          status: 'settled',
          finishedAt: at,
          usage: result.usage,
          responseText: result.value.text,
          error: null,
          hostSessionId,
          hostCallId,
        });
        return { attempt, outcome: 'answered', error: null };
      }
      const error = cancelled
        ? cancelledError('coaching request was cancelled by the user; the provider outcome was discarded')
        : result.error;
      if (result.usage === null) {
        const attempt = await this.saveSettlement(reservation, {
          status: 'uncertain',
          finishedAt: at,
          usage: null,
          responseText: null,
          error,
          hostSessionId,
          hostCallId,
        });
        return { attempt, outcome: 'uncertain', error };
      }
      const attempt = await this.saveSettlement(reservation, {
        status: 'settled',
        finishedAt: at,
        usage: result.usage,
        responseText: null,
        error,
        hostSessionId,
        hostCallId,
      });
      return { attempt, outcome: 'error', error };
    });
  }

  /**
   * A generator that threw produced an unknown outcome; no call id is known.
   *
   * The thrown value is arbitrary provider/internal text, so it is never copied into the durable
   * error or into any public result: only fixed sanitized messages are recorded. The status stays
   * `uncertain` with `null` usage (the call keeps its quota slot), and the host correlation stays
   * exactly as it was — nothing is invented for a call that never reported one. The optional
   * {@link CoachingServiceOptions.onInternalError} hook is the only place the original value is
   * handed out.
   */
  private async settleThrow(
    reservation: CoachingAttempt,
    error: unknown,
    token: CancellationToken,
  ): Promise<SettledCall> {
    return this.store.transaction(async (): Promise<SettledCall> => {
      const at = assertIsoTimestamp('coaching now', this.now());
      const cancelled = token.cancelled || (error instanceof DomainError && error.code === 'cancelled');
      const gatewayError: ModelGatewayError = cancelled
        ? cancelledError(GENERATION_CANCELLED_MESSAGE)
        : {
            code: 'provider_error',
            message: GENERATION_THREW_MESSAGE,
            retryable: false,
          };
      const attempt = await this.saveSettlement(reservation, {
        status: 'uncertain',
        finishedAt: at,
        usage: null,
        responseText: null,
        error: gatewayError,
        hostSessionId: null,
        hostCallId: null,
      });
      return { attempt, outcome: 'uncertain', error: gatewayError };
    });
  }

  /** A cancellation observed after the reservation commit, before dispatch: zero paid usage. */
  private async settleCancelled(reservation: CoachingAttempt): Promise<SettledCall> {
    return this.store.transaction(async (): Promise<SettledCall> => {
      const at = assertIsoTimestamp('coaching now', this.now());
      const error = cancelledError(
        'coaching request was cancelled before the model call; the reservation was closed without a paid call',
      );
      const attempt = await this.saveSettlement(reservation, {
        status: 'settled',
        finishedAt: at,
        usage: createModelUsage(),
        responseText: null,
        error,
        hostSessionId: null,
        hostCallId: null,
      });
      return { attempt, outcome: 'cancelled', error };
    });
  }

  /** Write the terminal state of a reservation, keeping every immutable identity field. */
  private async saveSettlement(reservation: CoachingAttempt, patch: SettlementPatch): Promise<CoachingAttempt> {
    const next: CoachingAttempt = {
      id: reservation.id,
      accountId: reservation.accountId,
      problemKey: reservation.problemKey,
      snapshotId: reservation.snapshotId,
      level: reservation.level,
      requestedAt: reservation.requestedAt,
      expiresAt: reservation.expiresAt,
      finishedAt: patch.finishedAt,
      status: patch.status,
      provider: reservation.provider,
      model: reservation.model,
      promptVersion: reservation.promptVersion,
      hostSessionId: patch.hostSessionId,
      hostCallId: patch.hostCallId,
      usage: patch.usage,
      responseText: patch.responseText,
      error: patch.error,
    };
    await this.store.saveCoachingAttempt(next);
    return next;
  }

  // -------------------------------------------------------------------------------------
  // Result mapping
  // -------------------------------------------------------------------------------------

  /** Immediate result of a settlement, using the outcome the dispatch actually reached. */
  private async settlementResult(settled: SettledCall, token: CancellationToken): Promise<CoachingAskResult> {
    const attempt = settled.attempt;
    const snapshotState = await this.snapshotStateOf(attempt);
    const identity = attemptIdentity(attempt);
    if (settled.outcome === 'answered') {
      if (snapshotState === 'stale') {
        // The head moved between the settlement commit and this projection: the settled cost and
        // history stay exactly as committed, but the text is not handed out as a current answer.
        return {
          ...identity,
          status: 'failed',
          attemptId: attempt.id,
          snapshotId: attempt.snapshotId,
          snapshotState,
          usage: attempt.usage,
          error: {
            code: 'stale_snapshot',
            message: `answer for snapshot ${attempt.snapshotId} was settled but is no longer the current head; the text is withheld and the settled cost remains in the coaching history`,
            retryable: false,
          },
        };
      }
      if (!token.cancelled) {
        return {
          ...identity,
          status: 'answered',
          attemptId: attempt.id,
          snapshotId: attempt.snapshotId,
          snapshotState,
          finishedAt: attempt.finishedAt ?? attempt.requestedAt,
          text: requireStored(attempt.responseText, 'settled coaching answer has no text', attempt.id),
          usage: requireStored(attempt.usage, 'settled coaching answer has no usage', attempt.id),
        };
      }
      // The cancellation landed after the settlement commit: hide the return, keep the history.
      return {
        ...identity,
        status: 'failed',
        attemptId: attempt.id,
        snapshotId: attempt.snapshotId,
        snapshotState,
        usage: attempt.usage,
        error: { code: 'cancelled', message: HIDDEN_ANSWER_MESSAGE, retryable: false },
      };
    }
    if (settled.outcome === 'uncertain') {
      return {
        ...identity,
        status: 'uncertain',
        attemptId: attempt.id,
        snapshotId: attempt.snapshotId,
        snapshotState,
        usage: null,
        error: errorViewOf(settled.error),
      };
    }
    const code: CoachingErrorCode =
      settled.outcome === 'cancelled' ? 'cancelled' : settled.outcome === 'stale' ? 'stale_snapshot' : (settled.error?.code ?? 'provider_error');
    return {
      ...identity,
      status: 'failed',
      attemptId: attempt.id,
      snapshotId: attempt.snapshotId,
      snapshotState,
      usage: attempt.usage,
      error: {
        code,
        message: settled.error?.message ?? 'the coaching call failed',
        retryable: settled.error?.retryable ?? false,
      },
    };
  }

  /**
   * Result of an attempt that is read back later (dedup, `history`, `getStatus`).
   *
   * A durable settled row whose text is hidden by staleness was recorded with the model-gateway
   * vocabulary (`provider_error` plus an explicit stale message), so a later read reports that
   * code together with the explicit `snapshotState: 'stale'`; the immediate return uses the
   * precise `stale_snapshot` code.
   */
  private async resultOfAttempt(attempt: CoachingAttempt, token: CancellationToken): Promise<CoachingAskResult> {
    const snapshotState = await this.snapshotStateOf(attempt);
    const cancelled = token.cancelled;
    const identity = attemptIdentity(attempt);
    if (attempt.status === 'reserved') {
      return {
        ...identity,
        status: 'pending',
        attemptId: attempt.id,
        snapshotId: attempt.snapshotId,
        snapshotState,
        usage: null,
        error: {
          code: 'concurrent_call_active',
          message: `coaching request ${attempt.id} is reserved until ${attempt.expiresAt}`,
          retryable: true,
        },
      };
    }
    if (attempt.status === 'uncertain') {
      const stored = attempt.error;
      return {
        ...identity,
        status: 'uncertain',
        attemptId: attempt.id,
        snapshotId: attempt.snapshotId,
        snapshotState,
        usage: null,
        error: cancelled
          ? { code: 'cancelled', message: 'coaching request was cancelled by the user', retryable: false }
          : {
              code: stored?.code ?? 'provider_error',
              message: stored?.message ?? 'the coaching call finished with unknown usage',
              retryable: false,
            },
      };
    }
    if (attempt.responseText !== null) {
      if (cancelled) {
        return {
          ...identity,
          status: 'failed',
          attemptId: attempt.id,
          snapshotId: attempt.snapshotId,
          snapshotState,
          usage: attempt.usage,
          error: { code: 'cancelled', message: HIDDEN_ANSWER_MESSAGE, retryable: false },
        };
      }
      if (snapshotState === 'stale') {
        return {
          ...identity,
          status: 'failed',
          attemptId: attempt.id,
          snapshotId: attempt.snapshotId,
          snapshotState,
          usage: attempt.usage,
          error: {
            code: 'stale_snapshot',
            message: `answer for snapshot ${attempt.snapshotId} is no longer current; request the stale history explicitly to read it`,
            retryable: false,
          },
        };
      }
      return {
        ...identity,
        status: 'answered',
        attemptId: attempt.id,
        snapshotId: attempt.snapshotId,
        snapshotState: 'current',
        finishedAt: attempt.finishedAt ?? attempt.requestedAt,
        text: attempt.responseText,
        usage: requireStored(attempt.usage, 'settled coaching answer has no usage', attempt.id),
      };
    }
    const stored = requireStored(attempt.error, 'settled coaching attempt has neither answer nor error', attempt.id);
    return {
      ...identity,
      status: 'failed',
      attemptId: attempt.id,
      snapshotId: attempt.snapshotId,
      snapshotState,
      usage: attempt.usage,
      error: cancelled
        ? { code: 'cancelled', message: 'coaching request was cancelled by the user', retryable: false }
        : { code: stored.code, message: stored.message, retryable: stored.retryable },
    };
  }

  private async snapshotStateOf(attempt: CoachingAttempt): Promise<'current' | 'stale'> {
    const head = await this.store.getCurrentSnapshotHead(parseProblemKey(attempt.problemKey));
    return head !== null && head.snapshotId === attempt.snapshotId ? 'current' : 'stale';
  }

  /**
   * Hand one unexpected generator exception to the optional local diagnostic hook.
   *
   * Called only after the settlement transaction is durable, so a hook failure cannot roll back a
   * paid record; a throwing hook propagates, because the service never swallows a failure.
   */
  private reportInternalError(attemptId: string, code: ModelErrorCode, error: unknown): void {
    if (this.onInternalError === undefined) {
      return;
    }
    this.onInternalError({ attemptId, phase: 'generation', code, error });
  }

  private isExpired(attempt: CoachingAttempt): boolean {
    return Date.parse(attempt.expiresAt) <= Date.parse(this.now());
  }

  private async readSettings(): Promise<WorkbenchSettings> {
    const record = await this.store.getWorkbenchSettings();
    return record?.value ?? defaultWorkbenchSettings();
  }
}

// ---------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------

const HIDDEN_ANSWER_MESSAGE =
  'coaching request was cancelled by the user; the paid answer is not shown and remains in the coaching history';

/**
 * Sanitized message of a generator that was cancelled before it reported an outcome.
 *
 * Fixed on purpose: the thrown value is provider/internal text and must never be echoed into a
 * durable row or a public result.
 */
const GENERATION_CANCELLED_MESSAGE =
  'coaching generation was cancelled before it reported an outcome; the provider outcome is unknown and the call still counts';

/** Sanitized message of an unexpected generator exception; see {@link GENERATION_CANCELLED_MESSAGE}. */
const GENERATION_THREW_MESSAGE =
  'coaching generation failed before it reported an outcome; the provider outcome is unknown and the call still counts';

function parseAskRequest(request: CoachingAskRequest): ParsedAsk {
  if (request === null || typeof request !== 'object') {
    throw new CoachingServiceError('invalid_request', 'ask needs a request object', {});
  }
  const requestId = requireRequestId(request.requestId);
  const accountId = requireAccountScope(request.accountId);
  const problemKey = requireProblemKey(request.problemKey);
  const level = requireLevel(request.level);
  if (request.explicitFullSolution !== undefined && typeof request.explicitFullSolution !== 'boolean') {
    throw new CoachingServiceError('invalid_request', 'explicitFullSolution must be boolean when present', {
      explicitFullSolution: request.explicitFullSolution,
    });
  }
  const explicitFullSolution = request.explicitFullSolution === true;
  if (level !== 'full' && explicitFullSolution) {
    throw new CoachingServiceError(
      'invalid_request',
      `coaching level ${String(level)} must not request the full solution`,
      { level },
    );
  }
  return { requestId, accountId, problemKey, level, explicitFullSolution };
}

function requireRequestId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_COACHING_REQUEST_ID_CHARS) {
    throw new CoachingServiceError(
      'invalid_request',
      `requestId must be a non-empty string of at most ${MAX_COACHING_REQUEST_ID_CHARS} characters`,
      { requestId: typeof value === 'string' ? value.slice(0, 64) : value },
    );
  }
  return value;
}

function requireAccountScope(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CoachingServiceError(
      'invalid_request',
      'accountId must be null (anonymous scope) or a non-empty stored account id',
      { accountId: value },
    );
  }
  return value;
}

function requireProblemKey(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CoachingServiceError('invalid_request', 'problemKey must be a canonical non-empty problem key', {
      problemKey: value,
    });
  }
  try {
    parseProblemKey(value);
  } catch (cause) {
    throw new CoachingServiceError('invalid_request', `problemKey is not a canonical problem key: ${describeError(cause)}`, {
      problemKey: value,
    });
  }
  return value;
}

function requireLevel(value: unknown): CoachingLevel {
  if (!COACHING_LEVELS.includes(value as CoachingLevel)) {
    throw new CoachingServiceError('invalid_request', `unknown coaching level ${String(value)}`, { level: value });
  }
  return value as CoachingLevel;
}

function requireToken(token: CancellationToken): void {
  if (
    token === null ||
    typeof token !== 'object' ||
    typeof token.cancelled !== 'boolean' ||
    typeof token.throwIfCancelled !== 'function' ||
    typeof token.onCancel !== 'function'
  ) {
    throw new CoachingServiceError('invalid_request', 'coaching calls need a cancellation token', {});
  }
}

function requireLimit(value: unknown): number {
  if (value === undefined) {
    return COACHING_PAGE_SIZE;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > COACHING_PAGE_SIZE) {
    throw new CoachingServiceError('invalid_request', `history limit must be an integer within 1..${COACHING_PAGE_SIZE}`, {
      limit: value,
    });
  }
  return value;
}

/** Levels strictly below the requested one; `full` sits above every hint level. */
function levelsBelow(level: CoachingLevel): readonly (1 | 2 | 3)[] {
  return level === 'full' ? [1, 2, 3] : ([1, 2, 3] as const).filter((candidate) => candidate < level);
}

/** Levels that must already be settled before the requested hint level may be asked. */
function requiredLowerLevels(level: CoachingLevel): readonly (1 | 2 | 3)[] {
  return level === 'full' ? [] : levelsBelow(level);
}

function assertRequestIdentity(attempt: CoachingAttempt, ask: ParsedAsk): void {
  if (attempt.accountId !== ask.accountId || attempt.problemKey !== ask.problemKey || attempt.level !== ask.level) {
    throw new CoachingServiceError(
      'request_conflict',
      `request ${ask.requestId} already belongs to account ${String(attempt.accountId)}, problem ${attempt.problemKey}, level ${String(attempt.level)}; it cannot be reused for account ${String(ask.accountId)}, problem ${ask.problemKey}, level ${String(ask.level)}`,
      {
        requestId: ask.requestId,
        stored: { accountId: attempt.accountId, problemKey: attempt.problemKey, level: attempt.level },
        requested: { accountId: ask.accountId, problemKey: ask.problemKey, level: ask.level },
      },
    );
  }
}

function attemptIdentity(attempt: CoachingAttempt): {
  readonly requestId: string;
  readonly accountId: string | null;
  readonly problemKey: string;
  readonly level: CoachingLevel;
  readonly verification: 'unverified_ai';
} {
  return {
    requestId: attempt.id,
    accountId: attempt.accountId,
    problemKey: attempt.problemKey,
    level: attempt.level,
    verification: 'unverified_ai',
  };
}

function attemptViewOf(
  attempt: CoachingAttempt,
  head: SnapshotHead | null,
  options: { readonly includeResponseText: boolean; readonly includeStale: boolean },
): CoachingAttemptView {
  const current = head !== null && head.snapshotId === attempt.snapshotId;
  const includeText =
    options.includeResponseText &&
    attempt.responseText !== null &&
    (current || options.includeStale);
  return {
    attemptId: attempt.id,
    accountId: attempt.accountId,
    level: attempt.level,
    status: attempt.status,
    snapshotId: attempt.snapshotId,
    snapshotState: current ? 'current' : 'stale',
    requestedAt: attempt.requestedAt,
    finishedAt: attempt.finishedAt,
    usage: attempt.usage,
    error: attempt.error === null ? null : { code: attempt.error.code, retryable: attempt.error.retryable },
    verification: 'unverified_ai',
    ...(includeText ? { responseText: attempt.responseText } : {}),
  };
}

function refused(
  ask: ParsedAsk,
  code: CoachingErrorCode,
  message: string,
  retryable: boolean,
): CoachingUnansweredView {
  return {
    status: 'refused',
    requestId: ask.requestId,
    attemptId: null,
    accountId: ask.accountId,
    problemKey: ask.problemKey,
    level: ask.level,
    snapshotId: null,
    snapshotState: 'unknown',
    usage: null,
    error: { code, message, retryable },
    verification: 'unverified_ai',
  };
}

function refusedWith(ask: ParsedAsk, error: CoachingErrorView): CoachingUnansweredView {
  return refused(ask, error.code, error.message, error.retryable);
}

function cancelledError(message: string): ModelGatewayError {
  return { code: 'cancelled', message, retryable: false };
}

/**
 * A completed answer whose snapshot is no longer the head.
 *
 * The durable attempt vocabulary is the model-gateway vocabulary, so this is recorded as
 * `provider_error` with an explicit stale message; the service DTO reports the precise
 * `stale_snapshot` code and never exposes the text.
 */
function staleCompletionError(snapshot: ProblemSnapshot, head: SnapshotHead | null): ModelGatewayError {
  return {
    code: 'provider_error',
    message: `the answer for snapshot ${snapshot.snapshotId} arrived after the head moved to ${head?.snapshotId ?? 'no snapshot'}; the answer was discarded as stale`,
    retryable: false,
  };
}

function errorViewOf(error: ModelGatewayError | null): CoachingErrorView {
  return error === null
    ? { code: 'provider_error', message: 'the coaching call failed without a recorded error', retryable: false }
    : { code: error.code, message: error.message, retryable: error.retryable };
}

function requireStored<T>(value: T | null, message: string, attemptId: string): T {
  if (value === null) {
    throw new CoachingServiceError('storage_inconsistent', message, { attemptId });
  }
  return value;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
