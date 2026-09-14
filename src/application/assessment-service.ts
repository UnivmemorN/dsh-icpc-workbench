/**
 * Durable ability-assessment service (Stage 18d2).
 *
 * One assessment is two explicit, auditable steps over one durable row:
 *
 * 1. {@link AssessmentService.prepare} is **free**: it captures the account's current evidence
 *    (through the workbench's read-only {@link AssessmentDataPort}), freezes it together with the
 *    stored workbench settings and the explicit method selection into an immutable `prepared`
 *    attempt, and returns. No provider is contacted and nothing is charged.
 * 2. {@link AssessmentService.run} is **paid**: it recaptures the same selection, proves the source
 *    hash and the settings revision still match, reserves exactly one call under the store's
 *    transaction, writes the charged `reserved` row **before** dispatch, then starts an *owned*
 *    background operation and returns the durable status immediately. The caller polls
 *    {@link AssessmentService.status}; the owned operation settles the row whatever the caller does
 *    afterwards — including an HTTP disconnect.
 *
 * ## Accounting rules
 *
 * - The rolling-24h quota counts this service's **own** attempt table
 *   ({@link ASSESSMENT_ATTEMPT_CHARGED_STATUSES} since `requestedAt`) against
 *   `coaching.maxCallsPer24Hours`, and at most one assessment call may be reserved or live at a
 *   time, globally. Both are checked inside the reservation transaction, after expired reservations
 *   are recovered, so two concurrent callers cannot both reserve.
 * - A `prepared` attempt that is cancelled is known-zero and stays outside the charged set. A
 *   reserved attempt is never released for free: an expired reservation becomes `uncertain` with its
 *   charged slot retained, and a cancellation after dispatch settles through the model path with the
 *   usage the provider reported (or `uncertain` when it reported none).
 * - Unknown usage is never fabricated as zero; a malformed or stale answer is discarded **with** its
 *   actual usage, never stored as a report.
 * - If the settlement write itself fails, the durable row stays the charged `reserved` reservation:
 *   the service never re-dispatches and never marks a success. The sanitized failure is exposed on
 *   {@link AssessmentAttemptView.settlementFailure} and in {@link AssessmentCloseReport}.
 *
 * ## Ownership
 *
 * The service owns every dispatched model promise and its cancellation source. {@link
 * AssessmentService.cancel} cancels the owned source of an active attempt and is idempotent;
 * {@link AssessmentService.close} stops admission, cancels every owned call and waits for them to
 * settle before returning, so storage may be closed after it.
 *
 * ## Errors and disclosure
 *
 * Caller-contract violations and pre-cost refusals are thrown as {@link AssessmentServiceError} with
 * a stable code (`invalid_request`, `not_found`, `conflict`, `stale`, `settings`, `quota`, `busy`,
 * `closing`); a cancellation observed before dispatch propagates as the domain's typed `cancelled`
 * error. Status/history views carry only a sanitized `{code, retryable}` error — a provider message
 * never reaches a UI projection — and every account-scoped read proves the account, answering
 * `null`/`not_found` instead of disclosing another account's attempt.
 */
import {
  ASSESSMENT_EFFORT,
  ASSESSMENT_PROMPT_VERSION,
  type AssessmentGenerationOutcome,
  type AssessmentGenerationRequest,
  type AssessmentGenerator,
} from './assessment-generation.js';
import type { AssessmentCapture, AssessmentDataPort } from './assessment-capture.js';
import {
  ASSESSMENT_ATTEMPT_CHARGED_STATUSES,
  ASSESSMENT_ATTEMPT_STATUSES,
  ASSESSMENT_DISCLOSURE,
  ASSESSMENT_LEASE_MARGIN_MS,
  ASSESSMENT_QUOTA_WINDOW_MS,
  MAX_ASSESSMENT_REQUEST_ID_CHARS,
  assessmentInputHash,
  reportContextOf,
  type AssessmentAttempt,
  type AssessmentAttemptStatus,
  type AssessmentStore,
} from './assessment-types.js';
import type { ModelCallResult, ModelGatewayError, TrainingStore } from './ports.js';
import { requireFlashOnlySettings, type SettingsStore, type WorkbenchSettings } from './workbench-settings.js';
import {
  DomainError,
  MAX_GUIDANCE_SELECTION,
  assertIsoTimestamp,
  createAssessmentReportRecord,
  createCancellationSource,
  createModelUsage,
  type AssessmentReportRecord,
  type CancellationSource,
  type CancellationToken,
  type ModelUsage,
} from '../domain/index.js';

/** Largest accepted method selection of a new preparation (the domain's guidance bound). */
export const MAX_ASSESSMENT_METHODS = MAX_GUIDANCE_SELECTION;

/** Largest `history` page; the UI asks for fewer, the bound keeps one response small. */
export const MAX_ASSESSMENT_HISTORY_LIMIT = 20;

/** Store page size of the recovery walk (the store's own maximum). */
export const ASSESSMENT_STORE_PAGE_SIZE = 500;

/** Stable codes of the typed local errors this service throws. */
export type AssessmentServiceErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'stale'
  | 'settings'
  | 'quota'
  | 'busy'
  | 'closing';

/** Typed, code-bearing error for a caller contract violation or a pre-cost refusal. */
export class AssessmentServiceError extends Error {
  readonly code: AssessmentServiceErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: AssessmentServiceErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'AssessmentServiceError';
    this.code = code;
    this.details = details;
  }
}

/** Free preparation request: the caller-owned request id plus the explicit method selection. */
export interface AssessmentPrepareRequest {
  /** Stable UI-owned id (a uuid, at most {@link MAX_ASSESSMENT_REQUEST_ID_CHARS} characters). */
  readonly requestId: string;
  /** The one account this assessment is about; every later read must name it again. */
  readonly accountId: string;
  /**
   * Explicit ordered selection of 1..{@link MAX_ASSESSMENT_METHODS} distinct installed method ids.
   *
   * A new assessment is never prepared without it: the unguided baseline remains available to the
   * 18d1 fixtures, but a durable attempt must be bound to the method text the user selected. A
   * missing, replaced or assessment-incapable method is refused by the capture port before any
   * evidence is read.
   */
  readonly methodIds: readonly string[];
}

/** Paid run request: the durable attempt is identified by its request id. */
export interface AssessmentRunRequest {
  readonly requestId: string;
  readonly accountId: string;
}

/** Status/cancel request; the account is re-proved against the stored attempt. */
export interface AssessmentStatusRequest {
  readonly requestId: string;
  readonly accountId: string;
}

/** One account-scoped metadata page of the assessment history. */
export interface AssessmentHistoryRequest {
  readonly accountId: string;
  readonly status?: AssessmentAttemptStatus | null;
  /** Page size, `1..{@link MAX_ASSESSMENT_HISTORY_LIMIT}`; omitted means the maximum. */
  readonly limit?: number;
  /** Opaque cursor returned by the previous page; bound to this account/status filter set. */
  readonly cursor?: string | null;
}

/** Safe one-page history of one account; bodies are validated reports, never raw provider data. */
export interface AssessmentHistoryResult {
  readonly accountId: string;
  readonly status: AssessmentAttemptStatus | null;
  readonly items: readonly AssessmentAttemptView[];
  readonly nextCursor: string | null;
  readonly verification: 'unverified_ai';
}

/** Result of a run: the durable status now, plus whether this call reserved the paid attempt. */
export interface AssessmentRunResult {
  /** `true` when this call wrote the reservation and started the owned paid dispatch. */
  readonly started: boolean;
  readonly attempt: AssessmentAttemptView;
}

/** Sanitized code/retryability of a stored outcome; a provider message is never exposed here. */
export interface AssessmentErrorView {
  readonly code: string;
  readonly retryable: boolean;
}

/** Sanitized marker of a settlement write that failed; the reservation stays charged. */
export interface AssessmentSettlementFailureView {
  readonly requestId: string;
  readonly code: 'settlement_failed';
  /** Fixed sanitized message; the raw storage error is never exposed. */
  readonly message: string;
}

/**
 * Durable status of one attempt, safe for a UI projection.
 *
 * `attempt` is the internal audit row for the **next stage's** plugin projection; it still carries
 * the sanitized stored error message, so an API layer must project the safe members above it rather
 * than hand the row to a UI.
 */
export interface AssessmentAttemptView {
  readonly requestId: string;
  readonly accountId: string;
  readonly sourceInstanceId: string;
  readonly status: AssessmentAttemptStatus;
  /** Reservation instant of a charged row; the preparation instant while `prepared`. */
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly finishedAt: string | null;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly settingsRevision: number | null;
  /** Exact frozen method selection this attempt is bound to, in order. */
  readonly methodIds: readonly string[];
  readonly usage: ModelUsage | null;
  readonly report: AssessmentReportRecord | null;
  readonly error: AssessmentErrorView | null;
  readonly settlementFailure: AssessmentSettlementFailureView | null;
  readonly verification: 'unverified_ai';
  /** Internal audit row; never handed to a UI as-is. */
  readonly attempt: AssessmentAttempt;
}

/** Free configuration preview a UI may render before preparing anything. */
export interface AssessmentConfigView {
  readonly settingsRevision: number;
  readonly provider: string;
  /** The analysis-role model every assessment uses (`settings.roles.analysisModel`). */
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly requestTimeoutMs: number;
  readonly effort: 'max';
  readonly quota: {
    readonly maxCallsPer24Hours: number;
    readonly windowMs: number;
  };
  readonly maxMethods: number;
  readonly maxRequestIdChars: number;
  readonly maxHistoryLimit: number;
  /** Fixed disclosure that must travel next to a rendered report. */
  readonly disclosure: string;
}

/** What teardown observed; empty means every owned call settled durably. */
export interface AssessmentCloseReport {
  readonly failures: readonly AssessmentSettlementFailureView[];
}

/** Persistence surface the service needs; one SQLite store implements all three ports. */
export type AssessmentServiceStore = AssessmentStore & SettingsStore & TrainingStore;

export interface AssessmentServiceOptions {
  readonly store: AssessmentServiceStore;
  readonly capture: AssessmentDataPort;
  readonly generator: AssessmentGenerator;
  /** Injected clock; every timestamp the service persists comes from here. */
  readonly now: () => string;
}

/** One owned paid dispatch: its cancellation source and the promise the service must drain. */
interface OwnedDispatch {
  readonly requestId: string;
  readonly source: CancellationSource;
  readonly promise: Promise<void>;
}

/** Terminal shape one settlement write commits. */
interface SettlementDraft {
  readonly status: 'settled' | 'uncertain';
  readonly usage: ModelUsage | null;
  readonly report: AssessmentReportRecord | null;
  readonly error: ModelGatewayError | null;
  readonly hostSessionId: string | null;
  readonly hostCallId: string | null;
}

/** Outcome of the one reservation transaction. */
type ReserveOutcome =
  | { readonly kind: 'reserved'; readonly attempt: AssessmentAttempt }
  | { readonly kind: 'existing'; readonly attempt: AssessmentAttempt }
  | {
      readonly kind: 'refused';
      readonly code: 'not_found' | 'settings' | 'quota' | 'busy';
      readonly message: string;
    };

/** Result of one recovery walk: still-live reservations plus the rows it recovered. */
interface RecoveryOutcome {
  readonly active: readonly AssessmentAttempt[];
  readonly recovered: readonly AssessmentAttempt[];
}

/** Parsed, validated preparation request. */
interface ParsedPrepare {
  readonly requestId: string;
  readonly accountId: string;
  readonly methodIds: readonly string[];
}

/** Parsed, validated status/run request. */
interface ParsedStatus {
  readonly requestId: string;
  readonly accountId: string;
}

/**
 * Durable assessment use case.
 *
 * One instance may serve many concurrent callers: the durable `reserved` row written under the
 * store's transaction is what prevents two paid calls, so sharing the service is safe and no
 * in-process lock is needed.
 */
export class AssessmentService {
  private readonly store: AssessmentServiceStore;
  private readonly capture: AssessmentDataPort;
  private readonly generator: AssessmentGenerator;
  private readonly now: () => string;
  private readonly jobs = new Map<string, OwnedDispatch>();
  private readonly settlementFailures = new Map<string, AssessmentSettlementFailureView>();
  private readonly operations = new Set<Promise<void>>();
  private closing = false;
  private closeReport: Promise<AssessmentCloseReport> | null = null;

  constructor(options: AssessmentServiceOptions) {
    if (options === null || typeof options !== 'object') {
      throw new AssessmentServiceError('invalid_request', 'assessment service needs an options object', {});
    }
    if (
      options.store === null ||
      typeof options.store !== 'object' ||
      typeof options.store.transaction !== 'function'
    ) {
      throw new AssessmentServiceError('invalid_request', 'assessment service needs a transactional store', {});
    }
    if (
      options.capture === null ||
      typeof options.capture !== 'object' ||
      typeof options.capture.captureAssessmentInput !== 'function'
    ) {
      throw new AssessmentServiceError('invalid_request', 'assessment service needs an assessment capture port', {});
    }
    if (
      options.generator === null ||
      typeof options.generator !== 'object' ||
      typeof options.generator.generate !== 'function'
    ) {
      throw new AssessmentServiceError('invalid_request', 'assessment service needs an assessment generator', {});
    }
    if (typeof options.now !== 'function') {
      throw new AssessmentServiceError('invalid_request', 'assessment service needs an injected now()', {});
    }
    this.store = options.store;
    this.capture = options.capture;
    this.generator = options.generator;
    this.now = options.now;
  }

  // -------------------------------------------------------------------------------------
  // Free preparation
  // -------------------------------------------------------------------------------------

  /**
   * Prepare one durable assessment for free.
   *
   * The capture port reads the account's own evidence and is refused — never substituted — when a
   * selected method is missing, replaced or assessment-incapable; nothing is charged and no model is
   * contacted. A replay of the same request id returns the stored attempt unchanged after proving
   * the account and the method selection match; reusing it for another account or selection is a
   * typed `conflict` that discloses neither.
   */
  prepare(request: AssessmentPrepareRequest, token: CancellationToken): Promise<AssessmentAttemptView> {
    return this.withOperation(() => this.prepareOwned(request, token));
  }

  private async prepareOwned(request: AssessmentPrepareRequest, token: CancellationToken): Promise<AssessmentAttemptView> {
    const parsed = parsePrepareRequest(request);
    requireToken(token);
    this.requireOpen();
    token.throwIfCancelled();

    const known = await this.store.getAssessmentAttempt(parsed.requestId);
    token.throwIfCancelled();
    if (known !== null) {
      return this.viewOf(replayOf(known, parsed));
    }

    const settings = await this.requireSettings();
    token.throwIfCancelled();
    const capture = await this.captureSelection(parsed, 'invalid_request', token);
    token.throwIfCancelled();
    const methodIds = capture.snapshot.guidance.selectedMethodIds;
    if (!sameSelection(methodIds, parsed.methodIds)) {
      throw new AssessmentServiceError(
        'invalid_request',
        `assessment capture returned methods ${methodIds.join(', ') || '(none)'}, not the requested selection`,
        { requestId: parsed.requestId },
      );
    }
    const at = assertIsoTimestamp('assessment now', this.now());
    const attempt = preparedAttempt(parsed, capture, settings, at);

    // The transaction makes a concurrent double-prepare of one request id replay instead of
    // colliding: the loser re-reads the winner's row and returns it unchanged.
    const raced = await this.store.transaction(async () => {
      const existing = await this.store.getAssessmentAttempt(parsed.requestId);
      if (existing !== null) {
        return existing;
      }
      await this.store.saveAssessmentAttempt(attempt);
      return null;
    });
    return this.viewOf(raced === null ? attempt : replayOf(raced, parsed));
  }

  // -------------------------------------------------------------------------------------
  // Paid run
  // -------------------------------------------------------------------------------------

  /**
   * Reserve and start **one** paid assessment call.
   *
   * Refusals that cost nothing happen before the reservation: a request id that was never prepared
   * (`not_found`), another account's request id (`not_found`), a stored settings revision or
   * Flash-policy mismatch (`settings`), a method that is gone or replaced, or evidence that moved
   * (`stale`), a live call (`busy`) and an exhausted rolling quota (`quota`). The reservation row is
   * written before dispatch, and the owned model call is settled durably even if the caller
   * disconnects and never polls again.
   */
  run(request: AssessmentRunRequest, token: CancellationToken): Promise<AssessmentRunResult> {
    return this.withOperation(() => this.runOwned(request, token));
  }

  private async runOwned(request: AssessmentRunRequest, token: CancellationToken): Promise<AssessmentRunResult> {
    const parsed = parseStatusRequest(request, RUN_REQUEST_KEYS, 'run');
    requireToken(token);
    this.requireOpen();
    token.throwIfCancelled();

    const known = await this.store.getAssessmentAttempt(parsed.requestId);
    token.throwIfCancelled();
    if (known === null || known.accountId !== parsed.accountId) {
      throw new AssessmentServiceError(
        'not_found',
        `assessment request ${parsed.requestId} is not prepared for this account; prepare it first`,
        { requestId: parsed.requestId },
      );
    }
    if (known.status !== 'prepared') {
      // A durable reserved/terminal row is returned as-is: a retry can never dispatch a second call.
      return { started: false, attempt: this.viewOf(known) };
    }

    const settings = await this.requireSettings();
    token.throwIfCancelled();
    const problem = settingsProblem(known, settings);
    if (problem !== null) {
      throw new AssessmentServiceError('settings', problem, { requestId: known.id });
    }
    const recaptured = await this.captureSelection(
      { requestId: parsed.requestId, accountId: parsed.accountId, methodIds: methodIdsOf(known) },
      'stale',
      token,
    );
    token.throwIfCancelled();
    if (recaptured.sourceHash !== known.preparation.capture.sourceHash) {
      throw new AssessmentServiceError(
        'stale',
        `assessment ${known.id} was prepared from evidence that has since changed; prepare it again before spending a call`,
        { requestId: known.id },
      );
    }

    const at = assertIsoTimestamp('assessment now', this.now());
    const outcome = await this.reserve(known, at, token);
    if (outcome.kind === 'refused') {
      throw new AssessmentServiceError(outcome.code, outcome.message, { requestId: known.id });
    }
    if (outcome.kind === 'existing') {
      return { started: false, attempt: this.viewOf(outcome.attempt) };
    }
    this.startDispatch(outcome.attempt, settings.value);
    return { started: true, attempt: this.viewOf(outcome.attempt) };
  }

  // -------------------------------------------------------------------------------------
  // Reads, cancellation and recovery
  // -------------------------------------------------------------------------------------

  /**
   * Durable status of one attempt, or `null` when it does not exist **or belongs to another
   * account** — a missing and a foreign request id are deliberately indistinguishable.
   */
  async status(request: AssessmentStatusRequest, token: CancellationToken): Promise<AssessmentAttemptView | null> {
    const parsed = parseStatusRequest(request, STATUS_REQUEST_KEYS, 'status');
    requireToken(token);
    token.throwIfCancelled();
    const attempt = await this.store.getAssessmentAttempt(parsed.requestId);
    token.throwIfCancelled();
    if (attempt === null || attempt.accountId !== parsed.accountId) {
      return null;
    }
    return this.viewOf(attempt);
  }

  /**
   * Cancel one attempt and return its durable status.
   *
   * A `prepared` row is closed immediately as a known-zero `cancelled` attempt (no call was ever
   * made). A `reserved` row is already charged, so cancellation only signals the owned model call;
   * its settlement records the usage the provider reports, or `uncertain` when it reports none. A
   * terminal row is returned unchanged, which makes repeated cancellation idempotent.
   */
  cancel(request: AssessmentStatusRequest, token: CancellationToken): Promise<AssessmentAttemptView> {
    return this.withOperation(() => this.cancelOwned(request, token));
  }

  private async cancelOwned(request: AssessmentStatusRequest, token: CancellationToken): Promise<AssessmentAttemptView> {
    const parsed = parseStatusRequest(request, STATUS_REQUEST_KEYS, 'cancel');
    requireToken(token);
    this.requireOpen();
    token.throwIfCancelled();
    const known = await this.store.getAssessmentAttempt(parsed.requestId);
    token.throwIfCancelled();
    if (known === null || known.accountId !== parsed.accountId) {
      throw new AssessmentServiceError(
        'not_found',
        `assessment request ${parsed.requestId} is not available for this account`,
        { requestId: parsed.requestId },
      );
    }
    if (known.status === 'prepared') {
      const cancelled = await this.store.transaction(async () => {
        const stored = await this.store.getAssessmentAttempt(parsed.requestId);
        if (stored === null || stored.accountId !== parsed.accountId) {
          throw new AssessmentServiceError(
            'not_found',
            `assessment request ${parsed.requestId} is not available for this account`,
            { requestId: parsed.requestId },
          );
        }
        if (stored.status !== 'prepared') {
          return stored;
        }
        const next: AssessmentAttempt = {
          ...stored,
          status: 'cancelled',
          revision: stored.revision + 1,
          finishedAt: assertIsoTimestamp('assessment now', this.now()),
          usage: createModelUsage({ calls: 0 }),
          error: { code: 'cancelled', message: CANCELLED_BEFORE_DISPATCH_MESSAGE, retryable: false },
        };
        await this.store.saveAssessmentAttempt(next);
        return next;
      });
      return this.viewOf(cancelled);
    }
    if (known.status === 'reserved') {
      this.jobs.get(parsed.requestId)?.source.cancel('the user cancelled the assessment');
    }
    return this.viewOf(known);
  }

  /**
   * One account-scoped metadata page, newest first.
   *
   * The page carries validated reports (they were labelled and hash-checked before storage) and
   * sanitized errors only. `nextCursor` continues exactly this filter set through the store.
   */
  async history(request: AssessmentHistoryRequest, token: CancellationToken): Promise<AssessmentHistoryResult> {
    requireToken(token);
    token.throwIfCancelled();
    if (request === null || typeof request !== 'object') {
      throw new AssessmentServiceError('invalid_request', 'history needs a request object', {});
    }
    requireKnownKeys('history', request, HISTORY_REQUEST_KEYS);
    const accountId = requireAccountId(request.accountId, 'history');
    const status = request.status === undefined || request.status === null ? null : requireStatus(request.status);
    const limit = requireHistoryLimit(request.limit);
    const cursor = request.cursor ?? null;
    if (cursor !== null && typeof cursor !== 'string') {
      throw new AssessmentServiceError('invalid_request', 'history cursor must be null or an opaque string', {});
    }
    const page = await this.store.listAssessmentAttempts({ accountId, status, limit, cursor, order: 'desc' });
    token.throwIfCancelled();
    return {
      accountId,
      status,
      items: page.items.map((attempt) => this.viewOf(attempt)),
      nextCursor: page.nextCursor,
      verification: 'unverified_ai',
    };
  }

  /**
   * Turn every expired reservation into a terminal `uncertain` attempt, keeping its charged slot.
   *
   * Run at startup and inside every reservation transaction, so a reservation orphaned by a restart
   * can never block single-flight forever and is never silently refunded or retried.
   */
  async recoverExpiredReservations(token: CancellationToken): Promise<readonly AssessmentAttemptView[]> {
    requireToken(token);
    this.requireOpen();
    token.throwIfCancelled();
    const at = assertIsoTimestamp('assessment now', this.now());
    const recovered = await this.store.transaction(async () => (await this.recoverExpired(at, token)).recovered);
    return recovered.map((attempt) => this.viewOf(attempt));
  }

  /** Free configuration preview: the configured model, budgets and quota the UI may show. */
  async config(token: CancellationToken): Promise<AssessmentConfigView> {
    requireToken(token);
    token.throwIfCancelled();
    const settings = await this.requireSettings();
    return {
      settingsRevision: settings.revision,
      provider: settings.value.provider,
      model: settings.value.roles.analysisModel,
      maxOutputTokens: settings.value.roles.maxOutputTokens,
      requestTimeoutMs: settings.value.modelLimits.requestTimeoutMs,
      effort: ASSESSMENT_EFFORT,
      quota: {
        maxCallsPer24Hours: settings.value.coaching.maxCallsPer24Hours,
        windowMs: ASSESSMENT_QUOTA_WINDOW_MS,
      },
      maxMethods: MAX_ASSESSMENT_METHODS,
      maxRequestIdChars: MAX_ASSESSMENT_REQUEST_ID_CHARS,
      maxHistoryLimit: MAX_ASSESSMENT_HISTORY_LIMIT,
      disclosure: ASSESSMENT_DISCLOSURE,
    };
  }

  /**
   * Stop admission, cancel every owned model call and wait for each one to settle durably.
   *
   * The store is **not** closed here: the caller closes storage after this resolves. The returned
   * report lists every settlement write that failed, so teardown problems stay observable instead of
   * being swallowed. Repeated calls return the first drain's report.
   */
  async close(): Promise<AssessmentCloseReport> {
    this.closing = true;
    this.closeReport ??= this.drain();
    return this.closeReport;
  }

  // -------------------------------------------------------------------------------------
  // Reservation
  // -------------------------------------------------------------------------------------

  /**
   * The only reservation transaction.
   *
   * Recovery, dedup, the Flash-policy/settings guard, global single-flight, the rolling quota and
   * the charged `reserved` write happen under one store transaction with no provider IO. The
   * caller's token is *thrown* on, never sampled, so a cancellation observed anywhere inside rolls
   * the whole transaction back (recovery writes included) and nothing is charged for a request that
   * was cancelled before dispatch.
   */
  private async reserve(known: AssessmentAttempt, at: string, token: CancellationToken): Promise<ReserveOutcome> {
    return this.store.transaction(async (): Promise<ReserveOutcome> => {
      token.throwIfCancelled();
      const current = await this.store.getAssessmentAttempt(known.id);
      token.throwIfCancelled();
      if (current === null) {
        return {
          kind: 'refused',
          code: 'not_found',
          message: `assessment request ${known.id} disappeared after it was read; prepare it again`,
        };
      }
      if (current.status !== 'prepared') {
        return { kind: 'existing', attempt: current };
      }
      const settings = await this.store.getWorkbenchSettings();
      token.throwIfCancelled();
      if (settings === null) {
        return {
          kind: 'refused',
          code: 'settings',
          message: 'assessment needs stored workbench settings; save them and prepare the assessment again',
        };
      }
      const problem = settingsProblem(current, settings);
      if (problem !== null) {
        return { kind: 'refused', code: 'settings', message: problem };
      }
      const recovery = await this.recoverExpired(at, token);
      token.throwIfCancelled();
      const blocking = recovery.active[0];
      if (blocking !== undefined) {
        return {
          kind: 'refused',
          code: 'busy',
          message: `assessment call ${blocking.id} is reserved until ${blocking.expiresAt}; only one assessment call may be in flight`,
        };
      }
      const since = new Date(Date.parse(at) - ASSESSMENT_QUOTA_WINDOW_MS).toISOString();
      const used = await this.store.countAssessmentAttempts({
        since,
        statuses: ASSESSMENT_ATTEMPT_CHARGED_STATUSES,
      });
      token.throwIfCancelled();
      const max = settings.value.coaching.maxCallsPer24Hours;
      if (used >= max) {
        return {
          kind: 'refused',
          code: 'quota',
          message: `assessment quota: ${used} of ${max} calls were used in the rolling 24 hours ending ${at}`,
        };
      }
      this.requireOpen();
      const recaptured = await this.captureSelection({ requestId: current.id, accountId: current.accountId, methodIds: methodIdsOf(current) }, 'stale', token, 'join');
      if (recaptured.sourceHash !== current.preparation.capture.sourceHash) {
        throw new AssessmentServiceError('stale', 'assessment evidence changed before reservation; prepare it again', {});
      }
      this.requireOpen();
      token.throwIfCancelled();
      const reservation: AssessmentAttempt = {
        ...current,
        status: 'reserved',
        revision: current.revision + 1,
        requestedAt: at,
        expiresAt: new Date(
          Date.parse(at) + settings.value.modelLimits.requestTimeoutMs + ASSESSMENT_LEASE_MARGIN_MS,
        ).toISOString(),
      };
      await this.store.saveAssessmentAttempt(reservation);
      token.throwIfCancelled();
      return { kind: 'reserved', attempt: reservation };
    });
  }

  /**
   * Recover expired reservations and return the still-live ones.
   *
   * A truncated walk is refused instead of counted, because granting quota from an incomplete
   * reservation history would hand out a call that is not actually available.
   */
  private async recoverExpired(at: string, token: CancellationToken): Promise<RecoveryOutcome> {
    const page = await this.store.listAssessmentAttempts({
      status: 'reserved',
      limit: ASSESSMENT_STORE_PAGE_SIZE,
      cursor: null,
    });
    token.throwIfCancelled();
    if (page.nextCursor !== null) {
      throw new AssessmentServiceError(
        'busy',
        `more than ${ASSESSMENT_STORE_PAGE_SIZE} assessment reservations need recovery; refusing to check quota against a truncated reservation history`,
        { bound: ASSESSMENT_STORE_PAGE_SIZE },
      );
    }
    const active: AssessmentAttempt[] = [];
    const recovered: AssessmentAttempt[] = [];
    for (const attempt of page.items) {
      if (Date.parse(attempt.expiresAt) > Date.parse(at)) {
        active.push(attempt);
        continue;
      }
      const next: AssessmentAttempt = {
        ...attempt,
        status: 'uncertain',
        revision: attempt.revision + 1,
        finishedAt: at,
        error: {
          code: 'timeout',
          message: `assessment reservation ${attempt.id} expired at ${attempt.expiresAt} before it settled; the provider outcome is unknown and the call still counts`,
          retryable: false,
        },
      };
      await this.store.saveAssessmentAttempt(next);
      token.throwIfCancelled();
      recovered.push(next);
    }
    return { active, recovered };
  }

  // -------------------------------------------------------------------------------------
  // Owned dispatch and settlement
  // -------------------------------------------------------------------------------------

  /** Start the owned paid call; `run` returns without waiting for the model. */
  private startDispatch(reservation: AssessmentAttempt, settings: WorkbenchSettings): void {
    if (this.jobs.has(reservation.id)) {
      return;
    }
    const source = createCancellationSource();
    if (this.closing) source.cancel('the assessment service is closing');
    const promise = this.dispatch(reservation, settings, source).catch((error: unknown) => {
      // The dispatch body never rejects; this guard keeps an unexpected rejection observable and
      // leaves the charged reservation untouched instead of silently losing a paid call.
      this.recordSettlementFailure(reservation.id, error);
    });
    const job: OwnedDispatch = { requestId: reservation.id, source, promise };
    this.jobs.set(reservation.id, job);
    void promise.then(
      () => this.releaseJob(reservation.id, promise),
      () => this.releaseJob(reservation.id, promise),
    );
  }

  private releaseJob(requestId: string, promise: Promise<void>): void {
    if (this.jobs.get(requestId)?.promise === promise) {
      this.jobs.delete(requestId);
    }
  }

  /** Dispatch exactly one model call, then settle it whatever happens. */
  private async dispatch(
    reservation: AssessmentAttempt,
    settings: WorkbenchSettings,
    source: CancellationSource,
  ): Promise<void> {
    if (source.token.cancelled) {
      // Cancelled between the reservation commit and dispatch: no call was made, so the cost is
      // known to be zero — but the row stays in the charged set, never released for free.
      await this.commitSettlement(reservation, async () => ({
        status: 'settled',
        usage: createModelUsage({ calls: 0 }),
        report: null,
        error: { code: 'cancelled', message: CANCELLED_BEFORE_DISPATCH_MESSAGE, retryable: false },
        hostSessionId: null,
        hostCallId: null,
      }));
      return;
    }
    const request: AssessmentGenerationRequest = {
      provider: reservation.provider,
      model: reservation.model,
      maxOutputTokens: settings.roles.maxOutputTokens,
      requestTimeoutMs: settings.modelLimits.requestTimeoutMs,
      effort: ASSESSMENT_EFFORT,
      attemptId: reservation.id,
      promptVersion: reservation.promptVersion,
      token: source.token,
      evidence: reservation.preparation.capture.prompt,
      guidance: reservation.preparation.capture.snapshot.guidance,
    };
    let result: ModelCallResult<AssessmentGenerationOutcome>;
    try {
      result = await this.generator.generate(request);
    } catch (error) {
      // A thrown generator has an unknown outcome: the call keeps its charged slot as `uncertain`.
      await this.commitSettlement(reservation, async () => {
        const cancelled = source.token.cancelled || (error instanceof DomainError && error.code === 'cancelled');
        return {
          status: 'uncertain',
          usage: null,
          report: null,
          error: cancelled
            ? { code: 'cancelled', message: GENERATION_CANCELLED_MESSAGE, retryable: false }
            : { code: 'provider_error', message: GENERATION_THREW_MESSAGE, retryable: false },
          hostSessionId: null,
          hostCallId: null,
        };
      });
      return;
    }
    await this.commitDispatchOutcome(reservation, result, source.token);
  }

  /**
   * Build and commit the terminal shape of one completed dispatch.
   *
   * Everything runs inside the settlement transaction, which re-reads the row: a reservation that
   * another path already recovered (or settled) is never rewritten. A successful answer is stored
   * only after the settings *and* the source are re-proved; a stale or malformed answer is refused
   * with its actual usage retained. Missing usage becomes `uncertain` — never a fabricated zero.
   */
  private async commitDispatchOutcome(
    reservation: AssessmentAttempt,
    result: ModelCallResult<AssessmentGenerationOutcome>,
    token: CancellationToken,
  ): Promise<void> {
    await this.commitSettlement(reservation, async () => {
      if (!result.ok) {
        const host = hostCorrelationOf(result);
        return result.usage === null
          ? { status: 'uncertain', usage: null, report: null, error: result.error, ...host }
          : { status: 'settled', usage: result.usage, report: null, error: result.error, ...host };
      }
      const usage = knownUsageOf(result.usage);
      const host = hostCorrelationOf(result);
      if (usage === null) {
        return {
          status: 'uncertain',
          usage: null,
          report: null,
          error: { code: 'provider_error', message: MISSING_USAGE_MESSAGE, retryable: false },
          ...host,
        };
      }
      if (token.cancelled) return { status: 'settled', usage, report: null, error: { code: 'cancelled', message: GENERATION_CANCELLED_MESSAGE, retryable: false }, ...host };
      const stale = await this.reportBasisProblem(reservation);
      if (stale !== null) {
        return { status: 'settled', usage, report: null, error: stale, ...host };
      }
      let report: AssessmentReportRecord;
      try {
        report = createAssessmentReportRecord({
          report: result.value.report,
          context: reportContextOf(reservation.preparation.capture),
          evidenceHash: reservation.preparation.capture.evidenceHash,
        });
      } catch {
        // The generator's own strict parser already refuses a malformed answer; this is the
        // service-side backstop, and the usage the provider reported is still retained.
        return {
          status: 'settled',
          usage,
          report: null,
          error: { code: 'invalid_output', message: MALFORMED_REPORT_MESSAGE, retryable: false },
          ...host,
        };
      }
      return { status: 'settled', usage, report, error: null, ...host };
    });
  }

  /**
   * Re-prove, immediately before a report is written, that the answer still describes the current
   * store: same stored settings revision and model, still the approved Flash configuration, and the
   * same opaque `sourceHash` (which already folds in the frozen evidence hash and the method
   * hashes). Any other outcome is a fixed sanitized `provider_error`; the paid usage is retained.
   */
  private async reportBasisProblem(reservation: AssessmentAttempt): Promise<ModelGatewayError | null> {
    try {
      const settings = await this.store.getWorkbenchSettings();
      if (settings === null) {
        return staleReportError('the stored workbench settings disappeared while the assessment call was in flight');
      }
      const problem = settingsProblem(reservation, settings);
      if (problem !== null) {
        return staleReportError('the stored workbench settings changed while the assessment call was in flight');
      }
      const recaptured = await this.capture.captureAssessmentInput(
        {
          accountId: reservation.accountId,
          capturedAt: assertIsoTimestamp('assessment now', this.now()),
          guidanceMethodIds: methodIdsOf(reservation),
        },
        // The settlement is not cancellable: the paid outcome is already in hand and must be
        // recorded, so a cancelled call can never roll back or lose its own accounting.
        NEVER_CANCELLED_TOKEN,
        'join',
      );
      if (recaptured.sourceHash !== reservation.preparation.capture.sourceHash) {
        return staleReportError('the assessment evidence changed while the paid call was in flight');
      }
      return null;
    } catch (error) {
      // The settlement itself must still commit, so a refused re-proof is turned into the fixed
      // sanitized error above rather than rolling the paid usage back.
      return staleReportError(`the assessment could not be re-proved against the store: ${describeError(error)}`);
    }
  }

  /** Commit one settlement draft, keeping the charged reservation durable when the write fails. */
  private async commitSettlement(
    reservation: AssessmentAttempt,
    draft: () => Promise<SettlementDraft>,
  ): Promise<void> {
    try {
      await this.store.transaction(async () => {
        const stored = await this.store.getAssessmentAttempt(reservation.id);
        if (stored === null || stored.status !== 'reserved') {
          // Already recovered or settled elsewhere: a terminal row is immutable, so never rewrite it.
          return;
        }
        const settlement = await draft();
        const finishedAt = latestTimestamp(assertIsoTimestamp('assessment now', this.now()), stored.requestedAt);
        const next: AssessmentAttempt = {
          ...stored,
          status: settlement.status,
          revision: stored.revision + 1,
          finishedAt,
          usage: settlement.usage,
          report: settlement.report,
          error: settlement.error,
          hostSessionId: settlement.hostSessionId,
          hostCallId: settlement.hostCallId,
        };
        await this.store.saveAssessmentAttempt(next);
      });
      this.settlementFailures.delete(reservation.id);
    } catch (error) {
      // The reservation stays charged and is never re-dispatched or marked successful; the
      // sanitized failure is exposed on status() and in the close report.
      this.recordSettlementFailure(reservation.id, error);
    }
  }

  private recordSettlementFailure(requestId: string, _error: unknown): void {
    this.settlementFailures.set(requestId, {
      requestId,
      code: 'settlement_failed',
      message: SETTLEMENT_FAILED_MESSAGE,
    });
  }

  private async drain(): Promise<AssessmentCloseReport> {
    for (const job of this.jobs.values()) job.source.cancel('the assessment service is closing');
    await Promise.allSettled([...this.operations]);
    const jobs = [...this.jobs.values()];
    for (const job of jobs) {
      job.source.cancel('the assessment service is closing');
    }
    const results = await Promise.allSettled(jobs.map((job) => job.promise));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const job = jobs[index];
        if (job !== undefined) {
          this.recordSettlementFailure(job.requestId, result.reason);
        }
      }
    });
    return { failures: [...this.settlementFailures.values()] };
  }

  // -------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------

  /** Read the stored settings and refuse anything that is not the approved Flash configuration. */
  private async requireSettings(): Promise<{ readonly revision: number; readonly value: WorkbenchSettings }> {
    const record = await this.store.getWorkbenchSettings();
    if (record === null) {
      throw new AssessmentServiceError(
        'settings',
        'assessment needs stored workbench settings; save them before preparing an assessment',
        {},
      );
    }
    try {
      requireFlashOnlySettings(record.value);
    } catch (error) {
      throw new AssessmentServiceError(
        'settings',
        `stored workbench settings are not the approved configuration: ${describeError(error)}`,
        { revision: record.revision },
      );
    }
    return record;
  }

  /** Capture one explicit selection; a port refusal becomes the typed code the caller expects. */
  private async captureSelection(
    parsed: { readonly requestId: string; readonly accountId: string; readonly methodIds: readonly string[] },
    code: 'invalid_request' | 'stale',
    token: CancellationToken,
    transactionMode: 'own' | 'join' = 'own',
  ): Promise<AssessmentCapture> {
    try {
      return await this.capture.captureAssessmentInput(
        {
          accountId: parsed.accountId,
          capturedAt: assertIsoTimestamp('assessment now', this.now()),
          guidanceMethodIds: parsed.methodIds,
        },
        token,
        transactionMode,
      );
    } catch (error) {
      // A cancellation is never disguised as a refusal: it stays the domain's typed `cancelled`.
      token.throwIfCancelled();
      throw new AssessmentServiceError(code, `assessment source capture was refused: ${describeError(error)}`, {
        requestId: parsed.requestId,
      });
    }
  }

  /** Register admission synchronously so shutdown cannot miss a preparing or reserving call. */
  private async withOperation<T>(work: () => Promise<T>): Promise<T> {
    this.requireOpen();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    this.operations.add(pending);
    try { return await work(); } finally { this.operations.delete(pending); finish(); }
  }

  private requireOpen(): void {
    if (this.closing) {
      throw new AssessmentServiceError(
        'closing',
        'the assessment service is closing and no longer accepts new work',
        {},
      );
    }
  }

  private viewOf(attempt: AssessmentAttempt): AssessmentAttemptView {
    return {
      requestId: attempt.id,
      accountId: attempt.accountId,
      sourceInstanceId: attempt.sourceInstanceId,
      status: attempt.status,
      requestedAt: attempt.requestedAt,
      expiresAt: attempt.expiresAt,
      finishedAt: attempt.finishedAt,
      provider: attempt.provider,
      model: attempt.model,
      promptVersion: attempt.promptVersion,
      settingsRevision: attempt.settingsRevision,
      methodIds: methodIdsOf(attempt),
      usage: attempt.usage,
      report: attempt.report,
      error: attempt.error === null ? null : { code: attempt.error.code, retryable: attempt.error.retryable },
      settlementFailure: this.settlementFailures.get(attempt.id) ?? null,
      verification: 'unverified_ai',
      attempt,
    };
  }
}

// ---------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------

const NEVER_CANCELLED_TOKEN: CancellationToken = createCancellationSource().token;

const CANCELLED_BEFORE_DISPATCH_MESSAGE =
  'the assessment was cancelled before the paid call was dispatched; the reservation stays charged and no second call is made';

const GENERATION_CANCELLED_MESSAGE =
  'assessment generation was cancelled before it reported an outcome; the provider outcome is unknown and the call still counts';

const GENERATION_THREW_MESSAGE =
  'assessment generation failed before it reported an outcome; the provider outcome is unknown and the call still counts';

const MISSING_USAGE_MESSAGE =
  'the provider did not report usage for the assessment call; the outcome is unknown and the call still counts';

const MALFORMED_REPORT_MESSAGE =
  'the model answer was not a valid assessment report for this capture; the answer was discarded and the call still counts';

const SETTLEMENT_FAILED_MESSAGE =
  'the outcome of the reserved assessment could not be written; the reservation stays charged and the call is never retried automatically';

const PREPARE_REQUEST_KEYS: readonly string[] = ['requestId', 'accountId', 'methodIds'];
const RUN_REQUEST_KEYS: readonly string[] = ['requestId', 'accountId'];
const STATUS_REQUEST_KEYS: readonly string[] = ['requestId', 'accountId'];
const HISTORY_REQUEST_KEYS: readonly string[] = ['accountId', 'status', 'limit', 'cursor'];

/** Build the immutable free preparation one paid run is bound to. */
function preparedAttempt(
  parsed: ParsedPrepare,
  capture: AssessmentCapture,
  settings: { readonly revision: number; readonly value: WorkbenchSettings },
  at: string,
): AssessmentAttempt {
  const methodIds = capture.snapshot.guidance.selectedMethodIds;
  return {
    id: parsed.requestId,
    accountId: capture.accountId,
    sourceInstanceId: capture.sourceInstanceId,
    status: 'prepared',
    requestedAt: at,
    expiresAt: new Date(
      Date.parse(at) + settings.value.modelLimits.requestTimeoutMs + ASSESSMENT_LEASE_MARGIN_MS,
    ).toISOString(),
    finishedAt: null,
    provider: settings.value.provider,
    model: settings.value.roles.analysisModel,
    promptVersion: ASSESSMENT_PROMPT_VERSION,
    settingsRevision: settings.revision,
    inputHash: assessmentInputHash({
      accountId: capture.accountId,
      sourceInstanceId: capture.sourceInstanceId,
      settingsRevision: settings.revision,
      methodIds,
      evidenceHash: capture.evidenceHash,
      sourceHash: capture.sourceHash,
    }),
    revision: 1,
    preparation: { preparedAt: at, capture },
    hostSessionId: null,
    hostCallId: null,
    usage: null,
    report: null,
    error: null,
  };
}

/** Idempotent replay of one request id: same account and same selection, or a typed conflict. */
function replayOf(known: AssessmentAttempt, parsed: ParsedPrepare): AssessmentAttempt {
  if (known.accountId !== parsed.accountId) {
    throw new AssessmentServiceError(
      'conflict',
      `assessment request ${known.id} is already in use; it cannot be bound to another account`,
      { requestId: known.id },
    );
  }
  if (!sameSelection(methodIdsOf(known), parsed.methodIds)) {
    throw new AssessmentServiceError(
      'conflict',
      `assessment request ${known.id} is already bound to a different assessment-method selection`,
      { requestId: known.id },
    );
  }
  return known;
}

/** Why one stored preparation no longer matches the stored settings, or `null` when it does. */
function settingsProblem(
  attempt: AssessmentAttempt,
  settings: { readonly revision: number; readonly value: WorkbenchSettings },
): string | null {
  if (attempt.settingsRevision === null || settings.revision !== attempt.settingsRevision) {
    return `assessment ${attempt.id} was prepared under workbench settings revision ${String(attempt.settingsRevision)}, but the stored settings are at revision ${settings.revision}; prepare the assessment again (nothing was charged)`;
  }
  if (settings.value.provider !== attempt.provider || settings.value.roles.analysisModel !== attempt.model) {
    return `assessment ${attempt.id} was prepared for ${attempt.provider}/${attempt.model}, but the stored settings now select ${settings.value.provider}/${settings.value.roles.analysisModel}; prepare the assessment again (nothing was charged)`;
  }
  try {
    requireFlashOnlySettings(settings.value);
  } catch (error) {
    return `stored workbench settings are not the approved configuration: ${describeError(error)}`;
  }
  return null;
}

/** Frozen method selection of one attempt; the capture is the authority, never a caller guess. */
function methodIdsOf(attempt: AssessmentAttempt): readonly string[] {
  return attempt.preparation.capture.snapshot.guidance.selectedMethodIds;
}

/** The host correlation a completed dispatch reported, normalized to "known or `null`". */
function hostCorrelationOf(result: { readonly callId: string; readonly sessionId?: string | null }): {
  readonly hostSessionId: string | null;
  readonly hostCallId: string | null;
} {
  return {
    hostSessionId: nonEmptyOrNull(result.sessionId ?? null),
    hostCallId: nonEmptyOrNull(result.callId),
  };
}

/** Runtime guard for `usage`; a dishonest success without usage must not become a free call. */
function knownUsageOf(usage: ModelUsage | null | undefined): ModelUsage | null {
  return usage === null || usage === undefined ? null : usage;
}

function staleReportError(detail: string): ModelGatewayError {
  return { code: 'provider_error', message: `${detail}; the report was discarded and the call still counts`, retryable: false };
}

function nonEmptyOrNull(value: string | null): string | null {
  return value !== null && value.trim().length > 0 ? value : null;
}

/** Later of two ISO instants; the storage shape requires `finishedAt >= requestedAt`. */
function latestTimestamp(candidate: string, floor: string): string {
  return Date.parse(candidate) >= Date.parse(floor) ? candidate : floor;
}

function sameSelection(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function parsePrepareRequest(request: AssessmentPrepareRequest): ParsedPrepare {
  if (request === null || typeof request !== 'object') {
    throw new AssessmentServiceError('invalid_request', 'prepare needs a request object', {});
  }
  requireKnownKeys('prepare', request, PREPARE_REQUEST_KEYS);
  return {
    requestId: requireRequestId(request.requestId),
    accountId: requireAccountId(request.accountId, 'prepare'),
    methodIds: requireMethodSelection(request.methodIds),
  };
}

function parseStatusRequest(
  request: AssessmentStatusRequest,
  keys: readonly string[],
  label: string,
): ParsedStatus {
  if (request === null || typeof request !== 'object') {
    throw new AssessmentServiceError('invalid_request', `${label} needs a request object`, {});
  }
  requireKnownKeys(label, request, keys);
  return {
    requestId: requireRequestId(request.requestId),
    accountId: requireAccountId(request.accountId, label),
  };
}

function requireKnownKeys(label: string, value: object, keys: readonly string[]): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    throw new AssessmentServiceError('invalid_request', `${label} has unknown keys: ${unknown.join(', ')}`, {
      unknownKeys: unknown,
    });
  }
}

function requireRequestId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_ASSESSMENT_REQUEST_ID_CHARS) {
    throw new AssessmentServiceError(
      'invalid_request',
      `requestId must be a non-empty string of at most ${MAX_ASSESSMENT_REQUEST_ID_CHARS} characters`,
      { requestId: typeof value === 'string' ? value.slice(0, 64) : value },
    );
  }
  return value;
}

function requireAccountId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AssessmentServiceError('invalid_request', `${label} needs a non-empty accountId`, {
      accountId: value,
    });
  }
  return value;
}

/** 1..{@link MAX_ASSESSMENT_METHODS} distinct, bounded method ids. */
function requireMethodSelection(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ASSESSMENT_METHODS) {
    throw new AssessmentServiceError(
      'invalid_request',
      `methodIds must be an array of 1..${MAX_ASSESSMENT_METHODS} installed assessment method ids`,
      { length: Array.isArray(value) ? value.length : null },
    );
  }
  const seen = new Set<string>();
  return (value as unknown[]).map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0 || entry.length > 200) {
      throw new AssessmentServiceError(
        'invalid_request',
        `methodIds[${index}] must be a non-empty method id of at most 200 characters`,
        { index },
      );
    }
    if (seen.has(entry)) {
      throw new AssessmentServiceError('invalid_request', `methodIds repeats method ${entry}`, { methodId: entry });
    }
    seen.add(entry);
    return entry;
  });
}

function requireStatus(value: unknown): AssessmentAttemptStatus {
  if (!ASSESSMENT_ATTEMPT_STATUSES.includes(value as AssessmentAttemptStatus)) {
    throw new AssessmentServiceError('invalid_request', `unknown assessment status ${String(value)}`, { status: value });
  }
  return value as AssessmentAttemptStatus;
}

function requireHistoryLimit(value: unknown): number {
  if (value === undefined) {
    return MAX_ASSESSMENT_HISTORY_LIMIT;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_ASSESSMENT_HISTORY_LIMIT) {
    throw new AssessmentServiceError(
      'invalid_request',
      `history limit must be an integer within 1..${MAX_ASSESSMENT_HISTORY_LIMIT}`,
      { limit: value },
    );
  }
  return value;
}

function requireToken(token: CancellationToken): void {
  if (
    token === null ||
    typeof token !== 'object' ||
    typeof token.cancelled !== 'boolean' ||
    typeof token.throwIfCancelled !== 'function' ||
    typeof token.onCancel !== 'function'
  ) {
    throw new AssessmentServiceError('invalid_request', 'assessment calls need a cancellation token', {});
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
