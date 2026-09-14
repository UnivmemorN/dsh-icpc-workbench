/**
 * Durable AI training-plan service (Sprint 11c).
 *
 * One `prepare` is a **free**, durable preparation: it collects the bounded real candidate pool of
 * one account, the aggregate weakness and the identifier-free 11a ability aggregate, hashes that
 * evidence and stores it as a `prepared` attempt keyed by the caller's request id. Nothing is
 * dispatched, nothing is charged, and re-preparing with the same request id and the same request is
 * idempotent (a different account or different plan settings under the same id is a typed
 * conflict).
 *
 * One `run` is one paid model call, and it can only run on an existing preparation of the same
 * account. See {@link PlanningService.run} for the accounting protocol.
 *
 * ## The accounting protocol
 *
 * 1. A `run` of an unknown request id refuses with `preparation_missing` before any write, so a
 *    caller can never spend a call on an id that was never prepared.
 * 2. A `run` of an attempt that is not `prepared` returns that attempt's own audit and never
 *    redispatches: `reserved` reports `pending`, `settled` reports `planned`/`failed`, and
 *    `uncertain`/`cancelled` report their terminal state.
 * 3. Exactly one transaction reserves the call: it re-reads the attempt, recovers expired
 *    reservations as `uncertain`, re-reads the stored settings (revision, provider and model must
 *    still be the ones the preparation was made under), enforces plugin-wide single flight and the
 *    rolling-24h planning quota, re-validates the whole preparation against the store immediately
 *    before dispatch, writes the `reserved` row, and finally re-checks the cancellation token — a
 *    cancellation inside that transaction rolls the reservation back before any dispatch. No
 *    provider IO ever runs inside a database transaction.
 * 4. A cancellation that lands between the reservation commit and dispatch settles the reservation
 *    with known-zero usage and a `cancelled` error: no model call is made and the audit is honest.
 * 5. Every dispatch settles durably, whatever the caller does afterwards. A success is validated
 *    by the pure domain `validateModelPlan` against the *re-validated* candidate pool; a rejected
 *    answer settles with its retained cost and `invalid_output` (never a repaired plan). A plan
 *    whose preparation went stale, or whose stored workbench settings moved, between dispatch and
 *    settlement settles with its retained cost and a typed error and is never stored. Settlement
 *    never throws the caller's token and never hands it to a port or a store: the post-provider
 *    re-validation and the plan write run under an internal non-cancellable token, and the caller's
 *    token is only **sampled** before the plan write and after each charged write. A cancellation
 *    observed at one of those samples aborts the settlement transaction with a private sentinel, so
 *    the plan and any partial settlement roll back together, and a **new** transaction records the
 *    already-known paid usage and host correlation with a `cancelled` error and no plan — a known
 *    cost is never converted into zero or unknown, and a terminal row is never rewritten or
 *    refunded. An unexpected exception from that re-validation or the plan write takes the same
 *    rollback path and settles a fixed sanitized `provider_error`. Unknown usage becomes
 *    `uncertain` (never a free call, never an automatic retry). A generator that threw records a
 *    fixed sanitized `provider_error`; the original value of either unexpected failure only ever
 *    reaches the optional local diagnostic hook.
 * 6. The planning quota is a plugin-wide rolling 24-hour count of the attempts that could have
 *    been dispatched (`reserved`, `settled`, `uncertain`). It is equal to
 *    `coaching.maxCallsPer24Hours` — the planning block borrows the coaching cap, the analysis
 *    role's model, the role output cap and the global model request timeout, and that borrowing is
 *    documented here and in the stage report because 11c deliberately adds no settings field.
 *
 * ## Bounded reads
 *
 * Expired-reservation recovery, the live-reservation check and the settings survey never scan an
 * unbounded history: the service walks status-filtered pages of {@link PLANNING_PAGE_SIZE} and
 * refuses with a typed `history_overflow` once a walk would exceed
 * {@link MAX_PLANNING_HISTORY_SCAN} attempts. Refusing is deliberate — counting a truncated
 * history would hand out quota that is not actually available.
 *
 * ## Errors
 *
 * Malformed arguments and request-id conflicts are thrown as {@link PlanningServiceError} with a
 * stable `code`; every runtime outcome (refused, pending, planned, failed, uncertain, cancelled) is
 * a result object. Storage and provider failures propagate as their own typed errors; nothing is
 * swallowed. A status/cancel read of an attempt that belongs to another account answers exactly
 * like an unknown request id, so account spoofing and status disclosure both fail closed.
 */
import {
  DomainError,
  MAX_GUIDANCE_SELECTION,
  assertIsoTimestamp,
  contentHashOf,
  createCancellationSource,
  createModelUsage,
  deepFreeze,
  invariant,
  parseProblemKey,
  problemKey as canonicalProblemKeyOf,
  validateModelPlan,
  type CancellationToken,
  type GuidanceSnapshot,
  type ModelUsage,
  type TrainingCandidate,
  type TrainingEvidence,
} from '../domain/index.js';
import { defaultWorkbenchSettings, type SettingsStore, type WorkbenchSettings } from './workbench-settings.js';
import {
  PLANNING_PROMPT_VERSION,
  planningGenerationProblem,
  type PlanGenerationDraft,
  type PlanGenerationRequest,
  type PlanningGenerator,
} from './planning-generation.js';
import {
  MAX_PLANNING_CANDIDATES,
  MAX_PLANNING_REQUEST_ID_CHARS,
  PLANNING_DISCLOSURE,
  PLANNING_LEASE_MARGIN_MS,
  PLANNING_QUOTA_WINDOW_MS,
  assertStoredModelPlan,
  isTerminalPlanStatus,
  type PlanAttempt,
  type PlanAttemptCandidate,
  type PlanAttemptExclusions,
  type PlanAttemptPreparation,
  type PlanAttemptSettings,
  type PlanAttemptStatus,
  type PlanAttemptWeakness,
  type PlanRevalidationResult,
  type PlanningDataPort,
  type PlanningStore,
} from './planning-types.js';

export type {
  PlanPreparationBundle,
  PlanPreparationRequest,
  PlanRevalidationResult,
  PlanStaleness,
  PlanStalenessReason,
  PlanningDataPort,
} from './planning-types.js';
import type { ModelCallResult, ModelErrorCode, ModelGatewayError } from './ports.js';

/** Attempts read per store page of the internal walks. */
export const PLANNING_PAGE_SIZE = 500;

/** Hard bound of one internal attempt walk; exceeding it is a typed refusal, never a truncation. */
export const MAX_PLANNING_HISTORY_SCAN = 10_000;

/** Only one planning call may be in flight plugin-wide (the reservation row is the lock). */
export const PLANNING_MAX_CONCURRENT = 1;

/** Approved plan bounds and defaults; they mirror the workbench plan bounds of the rule preview. */
export const PLANNING_MAX_HORIZON_DAYS = 30;
export const PLANNING_MAX_MINUTES_PER_DAY = 480;
export const PLANNING_MAX_ESTIMATED_MINUTES = 480;
export const PLANNING_DEFAULT_HORIZON_DAYS = 7;
export const PLANNING_DEFAULT_MINUTES_PER_DAY = 60;
export const PLANNING_DEFAULT_ESTIMATED_MINUTES = 30;
export const PLANNING_MAX_TASKS_PER_DAY = 3;

/** Largest page one account-scoped attempt-history read may return. */
export const MAX_PLANNING_HISTORY_LIMIT = 50;

/** Default page size of {@link PlanningService.history} when the caller names no limit. */
export const DEFAULT_PLANNING_HISTORY_LIMIT = 20;

/** Stable codes of the errors this service throws for a caller contract violation. */
export type PlanningServiceErrorCode =
  | 'invalid_request'
  | 'request_conflict'
  | 'unknown_request'
  | 'history_overflow'
  | 'storage_inconsistent';

/** Typed, code-bearing error for caller contract violations and saturation guards. */
export class PlanningServiceError extends Error {
  readonly code: PlanningServiceErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: PlanningServiceErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'PlanningServiceError';
    this.code = code;
    this.details = details;
  }
}

/** Refusals decided before any paid call; every one of them leaves the quota untouched. */
export type PlanningRefusalCode =
  | 'preparation_missing'
  | 'preparation_empty'
  | 'settings_changed'
  | 'model_changed'
  | 'stale_preparation'
  | 'planning_quota_exhausted'
  | 'concurrent_call_active'
  | 'cancelled';

/** Stable code of one planning failure: provider vocabulary plus service refusals and staleness. */
export type PlanningErrorCode = ModelErrorCode | PlanningRefusalCode | 'stale_preparation';

/** One typed failure a caller/UI can render without parsing prose. */
export interface PlanningErrorView {
  readonly code: PlanningErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

// ---------------------------------------------------------------------------------------
// Service options
// ---------------------------------------------------------------------------------------

/**
 * Persistence surface the service needs.
 *
 * The intersection is explicit because a planning call needs all three capabilities in one object:
 * the attempt rows, the borrowed workbench settings, and a transaction that covers the reservation
 * and the settlement writes.
 */
export type PlanningServiceStore = PlanningStore & SettingsStore & PlanningTransactionPort;

/** The transaction capability alone, so a store cannot satisfy the port without one. */
export interface PlanningTransactionPort {
  transaction<T>(work: () => Promise<T>): Promise<T>;
}

/** One unexpected paid-step exception, offered to {@link PlanningServiceOptions.onInternalError}. */
export interface PlanningInternalErrorReport {
  readonly attemptId: string;
  /**
   * Which paid step failed unexpectedly: the generator dispatch itself, or the charged settlement
   * (a post-provider re-validation or plan write that threw inside the settlement transaction).
   */
  readonly phase: 'generation' | 'settlement';
  /** Sanitized code the attempt was settled with. */
  readonly code: ModelErrorCode;
  /** The original thrown value; never persisted and never returned in a result. */
  readonly error: unknown;
}

export interface PlanningServiceOptions {
  readonly store: PlanningServiceStore;
  readonly generator: PlanningGenerator;
  readonly preparation: PlanningDataPort;
  /** Injected clock; every timestamp the service persists comes from here. */
  readonly now: () => string;
  /** Bound of one internal attempt walk; defaults to {@link MAX_PLANNING_HISTORY_SCAN}. */
  readonly maxHistoryScan?: number;
  /**
   * Optional local diagnostic sink for an unexpected paid-step exception.
   *
   * Called once per thrown generator call — *after* its `uncertain` settlement is durable — and
   * once per unexpected post-provider settlement step, after its sanitized failure settlement is
   * durable, so a failing hook can never roll back a paid record. This hook is the only place the
   * raw thrown value is handed out; no public result carries it.
   */
  readonly onInternalError?: (report: PlanningInternalErrorReport) => void;
}

// ---------------------------------------------------------------------------------------
// Public request/result views
// ---------------------------------------------------------------------------------------

/** Request of one free AI plan preparation. */
export interface PlanPrepareRequest {
  readonly requestId: string;
  readonly accountId: string;
  /** Plan scheduling settings; omitted members take the approved defaults. */
  readonly settings?: Partial<PlanAttemptSettings> | null;
  /** Distinct real candidates the pool may hold, `1..MAX_PLANNING_CANDIDATES`. */
  readonly candidateLimit?: number | null;
  /**
   * Explicit stored candidate problems, in the caller's order, or omitted/`null` for the bounded
   * automatic unsolved pool.
   *
   * When present, **only** these problems may enter the pool (a selected problem this account
   * already accepted is excluded and counted instead of being replaced by another candidate), so a
   * caller decides the scope instead of accepting whatever the automatic pool happened to hold. An
   * explicit empty list prepares no candidate and is refused as `preparation_empty` — it is never
   * silently turned back into the automatic pool — and a `candidateLimit` below the selection is a
   * typed conflict rather than a truncation.
   */
  readonly candidateProblemKeys?: readonly string[] | null;
  /**
   * Explicit installed training-method selection of this preparation (Sprint 18b), or
   * omitted/`null` for the legacy unguided contract.
   *
   * When present it must hold `1..MAX_GUIDANCE_SELECTION` distinct installed method ids that offer
   * plan guidance: the collaborator captures their exact definitions into the preparation, and the
   * paid run then demands the guided answer shape (`diagnosis` plus a per-task `axis`/`objective`).
   * A missing, replaced or plan-incapable method is a typed refusal before anything is stored —
   * never a silent fallback to an unguided plan. When omitted, the preparation carries no capture at
   * all and keeps the pre-guidance evidence hash.
   */
  readonly guidanceMethodIds?: readonly string[] | null;
  /** Show candidate tags and provisional raw labels in the returned preview. */
  readonly reveal?: boolean;
}

/**
 * Request of one explicit paid planning call.
 *
 * `expectedSettingsRevision` is the revision the caller read; the reservation compares it with the
 * stored record, so a screen that went stale cannot spend a call against a configuration the user
 * no longer sees.
 */
export interface PlanRunRequest {
  readonly requestId: string;
  readonly accountId: string;
  readonly expectedSettingsRevision?: number | null;
}

/** One account-scoped read/cancel of an existing attempt. */
export interface PlanAttemptRequest {
  readonly requestId: string;
  readonly accountId: string;
}

/**
 * One bounded, account-scoped read of recent attempts.
 *
 * The account is required — a planning history is always exactly one account's history — and the
 * page is bounded to {@link MAX_PLANNING_HISTORY_LIMIT}.
 */
export interface PlanHistoryRequest {
  readonly accountId: string;
  /** Page size within `1..MAX_PLANNING_HISTORY_LIMIT`; omitted/`null` takes the default. */
  readonly limit?: number | null;
}

/** One prepared candidate as a public preview shows it (never a statement or an editorial body). */
export interface PlanningCandidatePreview {
  readonly candidateId: string;
  readonly problemKey: string;
  readonly externalKey: string;
  readonly title: string;
  readonly url: string;
  readonly estimatedMinutes: number;
  readonly ratings: readonly { readonly dimension: string; readonly value: number | string; readonly raw: string }[];
  /** Effective taxonomy ids; absent unless the caller asked for spoilers explicitly. */
  readonly taxonomyIds?: readonly string[];
  /** Raw platform labels; absent unless the caller asked for spoilers explicitly. */
  readonly provisionalRawTags?: readonly string[];
}

/** Effective generator budget of one preparation, so the UI can disclose it before paying. */
export interface PlanningGeneratorView {
  readonly provider: string;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly requestTimeoutMs: number;
  readonly effort: 'max';
  readonly maxCallsPer24Hours: number;
  readonly quotaWindowMs: number;
  readonly maxConcurrent: number;
}

/** The free, durable preparation as a caller renders it — no audit body, no account handle. */
export interface PlanningPreparationView {
  readonly requestId: string;
  readonly status: PlanAttemptStatus;
  readonly preparedAt: string;
  readonly expiresAt: string;
  /**
   * Stored workbench-settings revision this preparation was captured under, or `null` when no
   * settings were stored. A caller passes exactly this value as the run's
   * `expectedSettingsRevision`, so a screen can only confirm the revision it actually read
   * instead of inventing the current one.
   */
  readonly settingsRevision: number | null;
  readonly settings: PlanAttemptSettings;
  readonly candidates: readonly PlanningCandidatePreview[];
  readonly exclusions: PlanAttemptExclusions;
  readonly weakness: PlanAttemptWeakness;
  readonly ability: PlanAttemptPreparation['ability'];
  readonly generator: PlanningGeneratorView;
  /**
   * The exact method ids this preparation was built under, or `null` for the legacy unguided
   * contract (Sprint 18b); the same statement as {@link PlanningPreparationView.guidance}, in
   * selector form.
   */
  readonly guidanceMethodIds: readonly string[] | null;
  /**
   * Immutable capture of the selected methods, or `null` when no method was involved.
   *
   * It carries the method text itself — never a pointer at "the currently installed" package — so the
   * preparation stays readable and provably unchanged after a companion package is upgraded or
   * uninstalled, and a later audit can prove what the paid call was shown.
   */
  readonly guidance: GuidanceSnapshot | null;
  readonly virtualPerformance?: PlanAttemptPreparation['virtualPerformance'];
  /** Fixed disclosure text the UI must render before the paid call. */
  readonly disclosure: string;
  readonly spoilersVisible: boolean;
  /** Immutable input hash of this attempt; a later audit can compare it. */
  readonly contentHash: string;
  readonly verification: 'unverified_ai';
}

/** Minimal durable audit of one attempt: identity, state, cost — never a preparation or plan body. */
export interface PlanningAttemptView {
  readonly requestId: string;
  readonly accountId: string;
  readonly status: PlanAttemptStatus;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly finishedAt: string | null;
  readonly usage: ModelUsage | null;
  readonly error: PlanningErrorView | null;
  readonly planId: string | null;
  readonly planHash: string | null;
  readonly candidateCount: number;
  readonly verification: 'unverified_ai';
}

export type PlanPrepareResult =
  | { readonly outcome: 'prepared'; readonly view: PlanningPreparationView }
  | { readonly outcome: 'refused'; readonly error: PlanningErrorView };

/**
 * Result of one paid run.
 *
 * `planned` names the stored model plan by id and content hash; the caller projects it through the
 * existing workbench plan projection (`WorkbenchService.getPlan`) rather than through this service,
 * so spoiler discipline stays in one place.
 */
export interface PlanRunResult {
  readonly outcome: 'planned' | 'failed' | 'uncertain' | 'cancelled' | 'pending' | 'prepared' | 'refused';
  readonly requestId: string;
  readonly accountId: string;
  /** `null` only for `refused`: a refusal never created or advanced a durable attempt. */
  readonly attempt: PlanningAttemptView | null;
  readonly error: PlanningErrorView | null;
  readonly verification: 'unverified_ai';
}

/** Status/cancel result; an attempt of another account answers exactly like an unknown id. */
export type PlanAttemptStatusResult =
  | {
      readonly status: 'unknown';
      readonly requestId: string;
      readonly accountId: string;
      readonly verification: 'unverified_ai';
    }
  | {
      readonly status: 'found';
      readonly requestId: string;
      readonly accountId: string;
      readonly attempt: PlanningAttemptView;
      readonly verification: 'unverified_ai';
    };

/** Effective settings one preparation borrows; documented because 11c adds no settings field. */
interface BorrowedPlanningSettings {
  readonly settings: WorkbenchSettings;
  readonly revision: number | null;
  readonly planSettings: PlanAttemptSettings;
}

type ReserveOutcome =
  | {
      readonly kind: 'reserved';
      readonly attempt: PlanAttempt;
      readonly candidates: readonly TrainingCandidate[];
      readonly settings: BorrowedPlanningSettings;
    }
  | { readonly kind: 'existing'; readonly attempt: PlanAttempt }
  | { readonly kind: 'refused'; readonly error: PlanningErrorView };

interface SettlementPatch {
  readonly status: 'settled' | 'uncertain';
  readonly finishedAt: string;
  readonly usage: ModelUsage | null;
  readonly planId: string | null;
  readonly planHash: string | null;
  readonly error: ModelGatewayError | null;
  readonly hostSessionId: string | null;
  readonly hostCallId: string | null;
}

/**
 * Durable AI training-plan use case. One instance may serve concurrent callers; the durable
 * reservation row (inserted under the store's transaction) is what prevents two paid calls, so
 * sharing the service is safe and no in-process lock is needed.
 */
export class PlanningService {
  private readonly store: PlanningServiceStore;
  private readonly generator: PlanningGenerator;
  private readonly preparation: PlanningDataPort;
  private readonly now: () => string;
  private readonly maxHistoryScan: number;
  private readonly onInternalError: ((report: PlanningInternalErrorReport) => void) | undefined;
  /**
   * Internal token handed to every port call of a charged settlement.
   *
   * It is never cancelled: the provider call is already paid there, so a user cancellation is
   * **sampled** and turned into a durable cancelled settlement instead of being thrown out of a
   * charged write (which would roll the paid record back).
   */
  private readonly settlementToken: CancellationToken;

  constructor(options: PlanningServiceOptions) {
    if (options === null || typeof options !== 'object') {
      throw new PlanningServiceError('invalid_request', 'planning service needs an options object', {});
    }
    if (options.store === null || typeof options.store !== 'object') {
      throw new PlanningServiceError('invalid_request', 'planning service needs a store intersection', {});
    }
    if (options.generator === null || typeof options.generator !== 'object') {
      throw new PlanningServiceError('invalid_request', 'planning service needs a generator', {});
    }
    if (options.preparation === null || typeof options.preparation !== 'object') {
      throw new PlanningServiceError('invalid_request', 'planning service needs a preparation collaborator', {});
    }
    if (typeof options.now !== 'function') {
      throw new PlanningServiceError('invalid_request', 'planning service needs an injected now()', {});
    }
    const maxHistoryScan = options.maxHistoryScan ?? MAX_PLANNING_HISTORY_SCAN;
    if (!Number.isSafeInteger(maxHistoryScan) || maxHistoryScan < 1) {
      throw new PlanningServiceError('invalid_request', 'maxHistoryScan must be a positive integer', {
        maxHistoryScan,
      });
    }
    if (options.onInternalError !== undefined && typeof options.onInternalError !== 'function') {
      throw new PlanningServiceError('invalid_request', 'onInternalError must be a function when present', {});
    }
    this.store = options.store;
    this.generator = options.generator;
    this.preparation = options.preparation;
    this.now = options.now;
    this.maxHistoryScan = maxHistoryScan;
    this.onInternalError = options.onInternalError;
    this.settlementToken = createCancellationSource().token;
  }

  // -------------------------------------------------------------------------------------
  // Prepare (free, durable)
  // -------------------------------------------------------------------------------------

  /**
   * Prepare one account's AI plan input durably and for free.
   *
   * A repeat with the same request id and the same account/settings is idempotent and returns the
   * stored preparation; a different account under the same id is refused as a conflict, and
   * different plan settings under the same id are refused too, so an id can never name two
   * different inputs. An account with no usable candidate refuses with `preparation_empty` and
   * stores nothing — no plan is ever generated from an invented problem.
   */
  async prepare(request: PlanPrepareRequest, token: CancellationToken): Promise<PlanPrepareResult> {
    requireToken(token);
    token.throwIfCancelled();
    const parsed = parsePrepareRequest(request);
    const known = await this.store.getPlanAttempt(parsed.requestId);
    token.throwIfCancelled();
    if (known !== null) {
      assertPrepareIdentity(known, parsed);
      const settings = await this.borrowedSettings();
      token.throwIfCancelled();
      return { outcome: 'prepared', view: preparationView(known, parsed.reveal, settings) };
    }

    const settings = await this.borrowedSettings();
    token.throwIfCancelled();
    const preparedAt = assertIsoTimestamp('planning now', this.now());
    const bundle = await this.preparation.prepare(
      {
        requestId: parsed.requestId,
        accountId: parsed.accountId,
        settings: parsed.settings,
        candidateLimit: parsed.candidateLimit,
        candidateProblemKeys: parsed.candidateProblemKeys,
        guidanceMethodIds: parsed.guidanceMethodIds,
        preparedAt,
      },
      token,
    );
    token.throwIfCancelled();
    const prepared = bundle.preparation;
    if (prepared.candidates.length === 0) {
      return {
        outcome: 'refused',
        error: {
          code: 'preparation_empty',
          message:
            'no unsolved real candidate is available for this account, so no AI plan was prepared; sync more problems or free a candidate instead of generating a plan from invented problems',
          retryable: true,
        },
      };
    }
    const attempt: PlanAttempt = {
      id: parsed.requestId,
      accountId: parsed.accountId,
      sourceInstanceId: prepared.sourceInstanceId,
      status: 'prepared',
      requestedAt: preparedAt,
      expiresAt: new Date(
        Date.parse(preparedAt) + settings.settings.modelLimits.requestTimeoutMs + PLANNING_LEASE_MARGIN_MS,
      ).toISOString(),
      finishedAt: null,
      provider: settings.settings.provider.trim(),
      model: settings.settings.roles.analysisModel.trim(),
      promptVersion: PLANNING_PROMPT_VERSION,
      settingsRevision: settings.revision,
      inputHash: planningInputHash(prepared, settings),
      preparation: prepared,
      hostSessionId: null,
      hostCallId: null,
      usage: null,
      planId: null,
      planHash: null,
      error: null,
    };
    const stored = await this.store.transaction(async (): Promise<PlanAttempt> => {
      token.throwIfCancelled();
      const again = await this.store.getPlanAttempt(parsed.requestId);
      token.throwIfCancelled();
      if (again !== null) {
        assertPrepareIdentity(again, parsed);
        return again;
      }
      // The preparation borrows the stored settings, so a configuration change between the read
      // and this write must refuse instead of recording a revision the preparation was not built
      // under. Nothing was paid, so the caller simply re-prepares.
      const confirmed = await this.borrowedSettings();
      token.throwIfCancelled();
      invariant(
        confirmed.revision === settings.revision,
        'invalid_transition',
        `workbench settings moved to revision ${String(confirmed.revision)} while the AI plan preparation was being built; prepare again`,
        { reason: 'settings_changed', expected: settings.revision, stored: confirmed.revision },
      );
      await this.store.savePlanAttempt(attempt);
      token.throwIfCancelled();
      return attempt;
    });
    return { outcome: 'prepared', view: preparationView(stored, parsed.reveal, settings) };
  }

  // -------------------------------------------------------------------------------------
  // Run (explicit, paid)
  // -------------------------------------------------------------------------------------

  /**
   * Run the one paid planning call of an existing preparation.
   *
   * See the module comment for the accounting protocol. The returned DTO always identifies the
   * request; a repeat of the same request id never pays again, and an attempt that is not
   * `prepared` is returned as its own durable state instead of being redispatched.
   */
  async run(request: PlanRunRequest, token: CancellationToken): Promise<PlanRunResult> {
    requireToken(token);
    const parsed = parseRunRequest(request);
    if (token.cancelled) {
      return refusedResult(parsed, 'cancelled', 'planning request was cancelled before any call was made', false);
    }
    const known = await this.store.getPlanAttempt(parsed.requestId);
    token.throwIfCancelled();
    if (known === null) {
      return refusedResult(
        parsed,
        'preparation_missing',
        `planning request ${parsed.requestId} was never prepared; prepare it first, because a paid call is only made for a durable preparation`,
        true,
      );
    }
    assertAttemptScope(known, parsed.accountId);
    if (known.status !== 'prepared') {
      return this.resultOfAttempt(known);
    }
    if (known.preparation.candidates.length === 0) {
      return refusedResult(parsed, 'preparation_empty', `planning request ${parsed.requestId} prepared no candidate`, false);
    }

    let reserved: ReserveOutcome;
    try {
      reserved = await this.reserve(known, parsed.expectedSettingsRevision, token);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'cancelled') {
        return refusedResult(
          parsed,
          'cancelled',
          'planning request was cancelled before the model call; no call was paid',
          false,
        );
      }
      throw error;
    }
    if (reserved.kind === 'refused') {
      return {
        outcome: 'refused',
        requestId: parsed.requestId,
        accountId: parsed.accountId,
        attempt: null,
        error: reserved.error,
        verification: 'unverified_ai',
      };
    }
    if (reserved.kind === 'existing') {
      return this.resultOfAttempt(reserved.attempt);
    }

    if (token.cancelled) {
      // The reservation is already durable: close it with known-zero usage instead of dispatching.
      return this.resultOfAttempt((await this.settleCancelled(reserved.attempt)).attempt);
    }

    const generation = generationRequestOf(reserved, token);
    const incoherent = planningGenerationProblem(generation);
    invariant(
      incoherent === null,
      'invalid_transition',
      `planning request ${reserved.attempt.id} is not coherent for dispatch: ${String(incoherent)}`,
      { reason: 'incoherent_generation_request', attemptId: reserved.attempt.id },
    );

    let result: ModelCallResult<{ readonly draft: PlanGenerationDraft }>;
    try {
      result = await this.generator.generate(generation);
    } catch (error) {
      // A thrown generator has an unknown outcome: the call stays on the books as uncertain with a
      // sanitized error, and the raw value only ever reaches the local diagnostic hook.
      const settled = await this.settleThrow(reserved.attempt, error, token);
      this.reportInternalError(settled.attempt.id, settled.error?.code ?? 'provider_error', error);
      return this.resultOfAttempt(settled.attempt);
    }
    const settled = await this.settleAfterDispatch(reserved, result, token);
    return this.resultOfAttempt(settled.attempt);
  }

  // -------------------------------------------------------------------------------------
  // Status, cancel, live reservations & recovery
  // -------------------------------------------------------------------------------------

  /**
   * Status of one attempt by request id, scoped to one account.
   *
   * An attempt of another account answers exactly like an unknown id (`status: 'unknown'`), so a
   * caller can neither spoof an account nor learn whether somebody else's request id exists.
   */
  async status(request: PlanAttemptRequest, token: CancellationToken): Promise<PlanAttemptStatusResult> {
    requireToken(token);
    token.throwIfCancelled();
    const parsed = parseAttemptRequest(request);
    const attempt = await this.store.getPlanAttempt(parsed.requestId);
    token.throwIfCancelled();
    if (attempt === null || attempt.accountId !== parsed.accountId) {
      return {
        status: 'unknown',
        requestId: parsed.requestId,
        accountId: parsed.accountId,
        verification: 'unverified_ai',
      };
    }
    return {
      status: 'found',
      requestId: parsed.requestId,
      accountId: parsed.accountId,
      attempt: attemptView(attempt),
      verification: 'unverified_ai',
    };
  }

  /**
   * Abandon a preparation, or acknowledge a cancellation of a dispatched call.
   *
   * A `prepared` attempt becomes terminal `cancelled`: it never dispatched, so its usage is known
   * to be zero and it is excluded from the quota. A `reserved` attempt is **not** rewritten here —
   * this service cannot know whether the provider call already cost something, and fabricating a
   * zero-usage settlement is exactly the dishonesty the contract forbids. The live cancellation is
   * the token the caller passed to `run`: signalling it makes the settlement path record the real
   * usage (or `uncertain` when the provider reported none). A reservation that is never settled
   * expires into `uncertain` and keeps its quota slot.
   */
  async cancel(request: PlanAttemptRequest, token: CancellationToken): Promise<PlanAttemptStatusResult> {
    requireToken(token);
    token.throwIfCancelled();
    const parsed = parseAttemptRequest(request);
    const outcome = await this.store.transaction(async (): Promise<PlanAttemptStatusResult> => {
      token.throwIfCancelled();
      const attempt = await this.store.getPlanAttempt(parsed.requestId);
      token.throwIfCancelled();
      if (attempt === null || attempt.accountId !== parsed.accountId) {
        return {
          status: 'unknown',
          requestId: parsed.requestId,
          accountId: parsed.accountId,
          verification: 'unverified_ai',
        };
      }
      if (attempt.status !== 'prepared') {
        return {
          status: 'found',
          requestId: parsed.requestId,
          accountId: parsed.accountId,
          attempt: attemptView(attempt),
          verification: 'unverified_ai',
        };
      }
      const at = assertIsoTimestamp('planning now', this.now());
      const cancelled: PlanAttempt = {
        ...attempt,
        status: 'cancelled',
        finishedAt: at,
        error: {
          code: 'cancelled',
          message: 'the AI plan preparation was abandoned before any paid call; nothing was dispatched',
          retryable: false,
        },
      };
      await this.store.savePlanAttempt(cancelled);
      token.throwIfCancelled();
      return {
        status: 'found',
        requestId: parsed.requestId,
        accountId: parsed.accountId,
        attempt: attemptView(cancelled),
        verification: 'unverified_ai',
      };
    });
    return outcome;
  }

  /**
   * `true` while any planning call is reserved and its lease has not expired.
   *
   * Read-only on purpose: a cross-start check must not write, and a reservation from a previous
   * process still counts as live until its own deadline passes. 11d uses this for the reciprocal
   * batch/coaching/settings exclusion it owns.
   */
  async hasLiveReservation(token: CancellationToken): Promise<boolean> {
    requireToken(token);
    token.throwIfCancelled();
    const live = await this.liveReservations(token);
    return live.length > 0;
  }

  /** The still-live reservations, for a cross-start check that must report what is blocking. */
  async liveReservations(token: CancellationToken): Promise<readonly PlanningAttemptView[]> {
    requireToken(token);
    token.throwIfCancelled();
    const at = assertIsoTimestamp('planning now', this.now());
    const rows = await this.walkAttempts({ status: 'reserved' });
    return rows.filter((row) => Date.parse(row.expiresAt) > Date.parse(at)).map((row) => attemptView(row));
  }

  /**
   * Recent attempts of one account, newest first, as metadata-only audit views.
   *
   * This is the read a refreshed page uses to recover the attempts it no longer has in memory:
   * rows are account scoped, ordered by `requestedAt` **descending** through the store's indexed
   * ordering, and bounded to {@link MAX_PLANNING_HISTORY_LIMIT}. A {@link PlanningAttemptView}
   * carries no input hash, no preparation (candidates, effective tags, weakness/ability evidence)
   * and no error body beyond its typed code/message, so a history read cannot become a spoiler or
   * submission dump.
   */
  async history(request: PlanHistoryRequest, token: CancellationToken): Promise<readonly PlanningAttemptView[]> {
    requireToken(token);
    token.throwIfCancelled();
    if (request === null || typeof request !== 'object') {
      throw new PlanningServiceError('invalid_request', 'planning history needs a request object', {});
    }
    const accountId = requireAccountId(request.accountId);
    const limit = parseHistoryLimit(request.limit);
    const page = await this.store.listPlanAttempts({ accountId, order: 'desc', limit, cursor: null });
    token.throwIfCancelled();
    return page.items.map((attempt) => attemptView(attempt));
  }

  /**
   * Turn every expired `reserved` attempt into `uncertain` and return how many were recovered.
   *
   * Recovery is what makes a restart safe: a reservation whose process died keeps its quota slot
   * and never becomes an automatic retry, so a crash can neither hand out free quota nor dispatch
   * twice. The walk is status-filtered and bounded; an overflowing walk throws `history_overflow`
   * and writes nothing. The returned number counts exactly the rows converted to `uncertain` — the
   * still-live reservations are left untouched and are not counted as recovered.
   */
  async recoverExpiredReservations(token: CancellationToken): Promise<number> {
    requireToken(token);
    token.throwIfCancelled();
    return this.store.transaction(async (): Promise<number> => {
      token.throwIfCancelled();
      const at = assertIsoTimestamp('planning now', this.now());
      const outcome = await this.recoverExpired(at, token);
      token.throwIfCancelled();
      return outcome.recovered.length;
    });
  }

  // -------------------------------------------------------------------------------------
  // Reservation
  // -------------------------------------------------------------------------------------

  /**
   * The only reservation transaction.
   *
   * Recovery, dedup, settings/lease guards, single flight, quota, the immediate pre-dispatch
   * re-validation and the reservation write all happen under one store transaction with no provider
   * IO. Every token check here is a *throw* — at the entry, after each awaited recovery write and
   * before each early return — so a cancellation observed anywhere inside rolls the whole
   * transaction back and nothing is charged for a request cancelled before dispatch. Charged
   * settlement is the opposite: there the token is sampled, never thrown.
   */
  private async reserve(
    attempt: PlanAttempt,
    expectedSettingsRevision: number | null,
    token: CancellationToken,
  ): Promise<ReserveOutcome> {
    return this.store.transaction(async (): Promise<ReserveOutcome> => {
      token.throwIfCancelled();
      const at = assertIsoTimestamp('planning now', this.now());
      const { live } = await this.recoverExpired(at, token);

      const existing = await this.store.getPlanAttempt(attempt.id);
      token.throwIfCancelled();
      if (existing === null) {
        return {
          kind: 'refused',
          error: {
            code: 'preparation_missing',
            message: `planning request ${attempt.id} disappeared before it could be reserved`,
            retryable: true,
          },
        };
      }
      if (existing.status !== 'prepared') {
        return { kind: 'existing', attempt: existing };
      }

      const settings = await this.borrowedSettings();
      token.throwIfCancelled();
      if (expectedSettingsRevision !== null) {
        if (settings.revision === null) {
          return {
            kind: 'refused',
            error: {
              code: 'settings_changed',
              message: `no workbench settings are stored, so expected revision ${expectedSettingsRevision} cannot be current; save the settings and reload them`,
              retryable: true,
            },
          };
        }
        if (settings.revision !== expectedSettingsRevision) {
          return {
            kind: 'refused',
            error: {
              code: 'settings_changed',
              message: `workbench settings are at revision ${settings.revision}, not ${expectedSettingsRevision}; reload the settings and prepare again`,
              retryable: true,
            },
          };
        }
      }
      if (settings.revision !== existing.settingsRevision) {
        return {
          kind: 'refused',
          error: {
            code: 'settings_changed',
            message: `planning request ${existing.id} was prepared under settings revision ${String(existing.settingsRevision)}, but the stored settings are at revision ${String(settings.revision)}; prepare the plan again`,
            retryable: true,
          },
        };
      }
      if (
        settings.settings.provider.trim() !== existing.provider ||
        settings.settings.roles.analysisModel.trim() !== existing.model
      ) {
        return {
          kind: 'refused',
          error: {
            code: 'model_changed',
            message: `planning request ${existing.id} was prepared for ${existing.provider}/${existing.model}, but the configured analysis model is now ${settings.settings.provider}/${settings.settings.roles.analysisModel}; prepare the plan again instead of dispatching a different model`,
            retryable: true,
          },
        };
      }

      const blocking = live[0];
      if (blocking !== undefined && live.length >= PLANNING_MAX_CONCURRENT) {
        return {
          kind: 'refused',
          error: {
            code: 'concurrent_call_active',
            message: `planning call ${blocking.id} is reserved until ${blocking.expiresAt}; only ${PLANNING_MAX_CONCURRENT} planning call(s) may be in flight`,
            retryable: true,
          },
        };
      }
      const since = new Date(Date.parse(at) - PLANNING_QUOTA_WINDOW_MS).toISOString();
      const used = await this.store.countPlanAttempts({ since, statuses: ['reserved', 'settled', 'uncertain'] });
      token.throwIfCancelled();
      if (used >= settings.settings.coaching.maxCallsPer24Hours) {
        return {
          kind: 'refused',
          error: {
            code: 'planning_quota_exhausted',
            message: `planning quota: ${used} of ${settings.settings.coaching.maxCallsPer24Hours} calls were used in the rolling 24 hours ending ${at}`,
            retryable: true,
          },
        };
      }

      // Re-validated immediately before dispatch: a concurrent sync, manual review, source or
      // metadata change turns into a typed stale refusal here instead of a plan built on evidence
      // the user never saw.
      const fresh = await this.preparation.revalidate(existing.preparation, token);
      token.throwIfCancelled();
      if (!fresh.ok) {
        return {
          kind: 'refused',
          error: {
            code: 'stale_preparation',
            message: `planning request ${existing.id} no longer matches the store (${fresh.staleness.reason}): ${fresh.staleness.detail}`,
            retryable: true,
          },
        };
      }

      const reservation: PlanAttempt = {
        ...existing,
        status: 'reserved',
        requestedAt: at,
        expiresAt: new Date(
          Date.parse(at) + settings.settings.modelLimits.requestTimeoutMs + PLANNING_LEASE_MARGIN_MS,
        ).toISOString(),
      };
      await this.store.savePlanAttempt(reservation);
      token.throwIfCancelled();
      return { kind: 'reserved', attempt: reservation, candidates: fresh.candidates, settings };
    });
  }

  /**
   * Turn every expired `reserved` attempt into `uncertain` and report both outcomes.
   *
   * `recovered` are exactly the rows this call converted (they keep their quota slot and record a
   * timeout error because the provider outcome is unknown); `live` are the reservations whose own
   * deadline has not passed yet, and they are returned untouched so the single-flight check of the
   * reservation transaction can see them. The caller's token is re-checked after the walk and after
   * every recovery write, so a cancellation that lands during recovery rolls the recovery back
   * together with the rest of the transaction. Quota is never refunded.
   */
  private async recoverExpired(
    at: string,
    token: CancellationToken,
  ): Promise<{ readonly recovered: readonly PlanAttempt[]; readonly live: readonly PlanAttempt[] }> {
    const reserved = await this.walkAttempts({ status: 'reserved' });
    token.throwIfCancelled();
    const live: PlanAttempt[] = [];
    const recovered: PlanAttempt[] = [];
    for (const attempt of reserved) {
      if (Date.parse(attempt.expiresAt) > Date.parse(at)) {
        live.push(attempt);
        continue;
      }
      const uncertain: PlanAttempt = {
        ...attempt,
        status: 'uncertain',
        finishedAt: at,
        error: {
          code: 'timeout',
          message: `planning reservation ${attempt.id} expired at ${attempt.expiresAt} before it settled; the provider outcome is unknown and the call still counts`,
          retryable: false,
        },
      };
      await this.store.savePlanAttempt(uncertain);
      recovered.push(uncertain);
      // A cancellation observed here throws: the transaction rolls back, so the expired row
      // returns to `reserved` instead of being silently recovered for a cancelled request.
      token.throwIfCancelled();
    }
    return { recovered, live };
  }

  // -------------------------------------------------------------------------------------
  // Settlement
  // -------------------------------------------------------------------------------------

  /**
   * Persist the outcome of one completed dispatch.
   *
   * The provider call is already paid here, so the caller's token is only ever **sampled**, never
   * thrown, and every port call of the settlement receives {@link PlanningService.settlementToken}
   * (a token that cannot cancel). A cancellation observed before the plan write, while the plan is
   * written, or after the settled row is written aborts this transaction with a private sentinel,
   * so the plan and any partial settlement roll back together; a **new** transaction then records
   * the same reported usage and host correlation with a `cancelled` error and no plan, which is
   * what keeps a paid record from being lost and a cancelled plan from being stored. Staleness and
   * a moved workbench settings revision are decided first because they describe the stored data,
   * and an unknown-usage result always becomes `uncertain` (never a free call, never an automatic
   * retry). An unexpected exception from the post-provider re-validation or the plan write takes
   * the same rollback path and is settled with a fixed sanitized `provider_error`; a storage
   * failure propagates instead of being reported as a persisted record.
   */
  private async settleAfterDispatch(
    reserved: Extract<ReserveOutcome, { kind: 'reserved' }>,
    result: ModelCallResult<{ readonly draft: PlanGenerationDraft }>,
    token: CancellationToken,
  ): Promise<{ readonly attempt: PlanAttempt; readonly error: ModelGatewayError | null }> {
    const reservation = reserved.attempt;
    const hostSessionId = result.sessionId ?? null;
    const hostCallId = result.callId;
    try {
      return await this.store.transaction(async () => {
        const at = assertIsoTimestamp('planning now', this.now());
        if (!result.ok) {
          const error = token.cancelled
            ? cancelledError('planning request was cancelled by the user; the provider outcome was discarded')
            : result.error;
          const attempt = await this.saveSettlement(reservation, {
            status: result.usage === null ? 'uncertain' : 'settled',
            finishedAt: at,
            usage: result.usage,
            planId: null,
            planHash: null,
            error,
            hostSessionId,
            hostCallId,
          });
          return { attempt, error };
        }
        const settings = reservation.preparation.settings;
        // The reservation's stored method capture — never the model answer — decides whether the
        // answer is guided: a guided attempt must carry a diagnosis and a per-task axis/objective,
        // and an unguided one must not invent them. No agnostic default exists.
        const validated = validateModelPlan({
          raw: draftToRaw(result.value.draft),
          candidates: reserved.candidates,
          settings: {
            horizonDays: settings.horizonDays,
            minutesPerDay: settings.minutesPerDay,
            maxTasksPerDay: settings.maxTasksPerDay,
          },
          now: at,
          accountId: reservation.accountId,
          guided: reservation.preparation.guidanceSnapshot !== undefined,
        });
        if (!validated.ok || validated.plan === null) {
          const codes = validated.errors.map((entry) => entry.code).join(', ');
          const error: ModelGatewayError = {
            code: 'invalid_output',
            message: `the model plan was refused by validation (${codes}); the paid call is retained and the answer is not repaired`,
            retryable: false,
          };
          const attempt = await this.saveSettlement(reservation, {
            status: 'settled',
            finishedAt: at,
            usage: result.usage,
            planId: null,
            planHash: null,
            error,
            hostSessionId,
            hostCallId,
          });
          return { attempt, error };
        }
        // Structural model validation cannot know the player's history. Attach the frozen
        // preparation evidence here; never infer a zero-count history from the validator default.
        const weak = reservation.preparation.weakness;
        const reasons: TrainingEvidence['reasons'][number][] = [];
        if (weak.attemptedDistinctTotal === 0) reasons.push('no_submission_records');
        if (weak.sufficientTagIds.length === 0) reasons.push('no_sufficient_tag_samples');
        const evidence: TrainingEvidence = {
          level: weak.attemptedDistinctTotal > 0 ? 'personal_history' : 'insufficient_history',
          reasons,
          attemptedDistinctTotal: weak.attemptedDistinctTotal,
          sufficientTagIds: [...weak.sufficientTagIds],
        };
        const planWithEvidence = deepFreeze({ ...validated.plan, evidence, ...(reservation.preparation.guidanceSnapshot === undefined ? {} : { guidanceSnapshot: reservation.preparation.guidanceSnapshot }) });
        assertStoredModelPlan(planWithEvidence, reservation.accountId, reservation.id);
        // Second re-validation under the non-cancellable settlement token: between dispatch and
        // this write the account, the candidate metadata, an AC, the effective tags or the ability
        // evidence may have moved, and a plan built on the previous evidence must not be stored as
        // if it were current. A user cancellation must not throw out of this charged transaction,
        // so it is sampled at the commit boundaries below instead.
        let fresh: PlanRevalidationResult;
        try {
          fresh = await this.preparation.revalidate(reservation.preparation, this.settlementToken);
        } catch (error) {
          throw new SettlementStepFailure(error);
        }
        if (!fresh.ok) {
          const error: ModelGatewayError = {
            code: 'provider_error',
            message: `planning request ${reservation.id} went stale while the model was answering (${fresh.staleness.reason}): ${fresh.staleness.detail}; the paid call is retained and no plan was stored`,
            retryable: false,
          };
          const attempt = await this.saveSettlement(reservation, {
            status: 'settled',
            finishedAt: at,
            usage: result.usage,
            planId: null,
            planHash: null,
            error,
            hostSessionId,
            hostCallId,
          });
          return { attempt, error };
        }
        // Post-dispatch settings guard: the plan is bound to the settings revision, provider and
        // analysis model this call was reserved under, so a configuration that moved while the
        // model was answering withholds the plan instead of storing it as if it were current.
        const currentSettings = await this.borrowedSettings();
        if (settingsMovedAfterDispatch(reservation, currentSettings)) {
          const error: ModelGatewayError = {
            code: 'provider_error',
            message: settingsMovedMessage(reservation, currentSettings),
            retryable: false,
          };
          const attempt = await this.saveSettlement(reservation, {
            status: 'settled',
            finishedAt: at,
            usage: result.usage,
            planId: null,
            planHash: null,
            error,
            hostSessionId,
            hostCallId,
          });
          return { attempt, error };
        }
        // Last instant before the plan write: a cancellation observed during any of the awaits
        // above withholds the plan without writing it at all.
        abortIfCancelled(token);
        let saved: { readonly planId: string; readonly planHash: string };
        try {
          saved = await this.preparation.savePlan(planWithEvidence, reservation.id, this.settlementToken);
        } catch (error) {
          throw new SettlementStepFailure(error);
        }
        // The plan write is the point of no return: sample again so a cancellation that landed
        // while the plan was written rolls the plan back instead of committing it.
        abortIfCancelled(token);
        const attempt = await this.saveSettlement(reservation, {
          status: 'settled',
          finishedAt: at,
          usage: result.usage,
          planId: saved.planId,
          planHash: saved.planHash,
          error: null,
          hostSessionId,
          hostCallId,
        });
        // A cancellation that landed while the settled row was written rolls that row (and the
        // plan with it) back; the new transaction below re-settles the known paid outcome.
        abortIfCancelled(token);
        return { attempt, error: null };
      });
    } catch (error) {
      if (error instanceof SettlementCancelledAbort) {
        return this.settleAfterAbort(
          reservation,
          result.usage,
          hostSessionId,
          hostCallId,
          cancelledError('planning request was cancelled by the user; the paid plan was withheld and never stored'),
        );
      }
      if (error instanceof SettlementStepFailure) {
        const settled = await this.settleAfterAbort(
          reservation,
          result.usage,
          hostSessionId,
          hostCallId,
          { code: 'provider_error', message: settlementStepFailedMessage(reservation.id), retryable: false },
        );
        this.reportInternalError(reservation.id, 'provider_error', error.original, 'settlement');
        return settled;
      }
      throw error;
    }
  }

  /**
   * Record the outcome of a charged dispatch whose first settlement transaction rolled back, in a
   * new transaction that never consults the caller's cancellation token.
   *
   * The reported usage is kept exactly as reported: a known cost stays `settled` and is never
   * converted into a zero or an unknown one. The current durable attempt is re-read first, because
   * only that row can make a late settlement idempotent: a terminal row is the audit and is
   * returned unchanged instead of being overwritten with a different body, while a vanished or
   * non-reserved row is a typed storage inconsistency — never a fabricated record — so an
   * unavailable store surfaces its own failure and the reservation stays visible instead of being
   * claimed as settled.
   */
  private async settleAfterAbort(
    reservation: PlanAttempt,
    usage: ModelUsage | null,
    hostSessionId: string | null,
    hostCallId: string | null,
    error: ModelGatewayError,
  ): Promise<{ readonly attempt: PlanAttempt; readonly error: ModelGatewayError | null }> {
    return this.store.transaction(async () => {
      const at = assertIsoTimestamp('planning now', this.now());
      const current = await this.store.getPlanAttempt(reservation.id);
      if (current === null) {
        throw new PlanningServiceError(
          'storage_inconsistent',
          `planning attempt ${reservation.id} disappeared before its paid outcome could be recorded; the reservation is not persisted and the paid call is not claimed as stored`,
          { attemptId: reservation.id, reason: 'attempt_missing' },
        );
      }
      if (isTerminalPlanStatus(current.status)) {
        return { attempt: current, error: current.error };
      }
      if (current.status !== 'reserved') {
        throw new PlanningServiceError(
          'storage_inconsistent',
          `planning attempt ${reservation.id} is ${current.status}, not reserved, so its paid outcome cannot be recorded`,
          { attemptId: reservation.id, reason: 'not_reserved', status: current.status },
        );
      }
      const attempt = await this.saveSettlement(reservation, {
        status: usage === null ? 'uncertain' : 'settled',
        finishedAt: at,
        usage,
        planId: null,
        planHash: null,
        error,
        hostSessionId,
        hostCallId,
      });
      return { attempt, error };
    });
  }

  /**
   * A generator that threw produced an unknown outcome; no call id is known.
   *
   * The thrown value is arbitrary provider/internal text, so it is never copied into the durable
   * error or into any public result: only fixed sanitized messages are recorded. The status stays
   * `uncertain` with `null` usage (the call keeps its quota slot), and the host correlation stays
   * exactly as it was — nothing is invented for a call that never reported one.
   */
  private async settleThrow(
    reservation: PlanAttempt,
    error: unknown,
    token: CancellationToken,
  ): Promise<{ readonly attempt: PlanAttempt; readonly error: ModelGatewayError | null }> {
    return this.store.transaction(async () => {
      const at = assertIsoTimestamp('planning now', this.now());
      const cancelled = token.cancelled || (error instanceof DomainError && error.code === 'cancelled');
      const gatewayError: ModelGatewayError = cancelled
        ? cancelledError(GENERATION_CANCELLED_MESSAGE)
        : { code: 'provider_error', message: GENERATION_THREW_MESSAGE, retryable: false };
      const attempt = await this.saveSettlement(reservation, {
        status: 'uncertain',
        finishedAt: at,
        usage: null,
        planId: null,
        planHash: null,
        error: gatewayError,
        hostSessionId: null,
        hostCallId: null,
      });
      return { attempt, error: gatewayError };
    });
  }

  /** A cancellation observed after the reservation commit, before dispatch: zero paid usage. */
  private async settleCancelled(
    reservation: PlanAttempt,
  ): Promise<{ readonly attempt: PlanAttempt; readonly error: ModelGatewayError | null }> {
    return this.store.transaction(async () => {
      const at = assertIsoTimestamp('planning now', this.now());
      const error = cancelledError(
        'planning request was cancelled before the model call; the reservation was closed without a paid call',
      );
      const attempt = await this.saveSettlement(reservation, {
        status: 'settled',
        finishedAt: at,
        usage: createModelUsage(),
        planId: null,
        planHash: null,
        error,
        hostSessionId: null,
        hostCallId: null,
      });
      return { attempt, error };
    });
  }

  /** Write the terminal state of a reservation, keeping every immutable identity field. */
  private async saveSettlement(reservation: PlanAttempt, patch: SettlementPatch): Promise<PlanAttempt> {
    const next: PlanAttempt = {
      id: reservation.id,
      accountId: reservation.accountId,
      sourceInstanceId: reservation.sourceInstanceId,
      status: patch.status,
      requestedAt: reservation.requestedAt,
      expiresAt: reservation.expiresAt,
      finishedAt: patch.finishedAt,
      provider: reservation.provider,
      model: reservation.model,
      promptVersion: reservation.promptVersion,
      settingsRevision: reservation.settingsRevision,
      inputHash: reservation.inputHash,
      preparation: reservation.preparation,
      hostSessionId: patch.hostSessionId,
      hostCallId: patch.hostCallId,
      usage: patch.usage,
      planId: patch.planId,
      planHash: patch.planHash,
      error: patch.error,
    };
    await this.store.savePlanAttempt(next);
    return next;
  }

  // -------------------------------------------------------------------------------------
  // Result mapping
  // -------------------------------------------------------------------------------------

  /** Map one durable attempt onto the public run result without ever redispatcing it. */
  private resultOfAttempt(attempt: PlanAttempt): PlanRunResult {
    const view = attemptView(attempt);
    const error = view.error;
    const outcome: PlanRunResult['outcome'] =
      attempt.status === 'reserved'
        ? 'pending'
        : attempt.status === 'prepared'
          ? 'prepared'
          : attempt.status === 'uncertain'
            ? 'uncertain'
            : attempt.status === 'cancelled'
              ? 'cancelled'
              : attempt.planId !== null
                ? 'planned'
                : 'failed';
    return {
      outcome,
      requestId: attempt.id,
      accountId: attempt.accountId,
      attempt: view,
      error,
      verification: 'unverified_ai',
    };
  }

  /**
   * Hand one unexpected paid-step exception to the optional local diagnostic hook.
   *
   * Called only after the corresponding paid settlement is durable, so a hook failure cannot roll
   * back a paid record. `error` is the original thrown value and is never persisted.
   */
  private reportInternalError(
    attemptId: string,
    code: ModelErrorCode,
    error: unknown,
    phase: PlanningInternalErrorReport['phase'] = 'generation',
  ): void {
    if (this.onInternalError === undefined) {
      return;
    }
    this.onInternalError({ attemptId, phase, code, error });
  }

  /** The settings this service borrows; see the module comment on the borrowed planning block. */
  private async borrowedSettings(): Promise<BorrowedPlanningSettings> {
    const record = await this.store.getWorkbenchSettings();
    const settings = record?.value ?? defaultWorkbenchSettings();
    return {
      settings,
      revision: record?.revision ?? null,
      planSettings: {
        horizonDays: PLANNING_DEFAULT_HORIZON_DAYS,
        minutesPerDay: PLANNING_DEFAULT_MINUTES_PER_DAY,
        estimatedMinutes: PLANNING_DEFAULT_ESTIMATED_MINUTES,
        maxTasksPerDay: PLANNING_MAX_TASKS_PER_DAY,
      },
    };
  }

  /** One bounded status-filtered walk; see the module comment on bounded reads. */
  private async walkAttempts(
    query: Omit<Parameters<PlanningStore['listPlanAttempts']>[0], 'limit' | 'cursor'>,
  ): Promise<readonly PlanAttempt[]> {
    const collected: PlanAttempt[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await this.store.listPlanAttempts({ ...query, limit: PLANNING_PAGE_SIZE, cursor });
      collected.push(...page.items);
      if (collected.length > this.maxHistoryScan) {
        throw new PlanningServiceError(
          'history_overflow',
          `planning history walk exceeded ${this.maxHistoryScan} attempts; narrow the account, status or time window instead of counting a truncated history`,
          { bound: this.maxHistoryScan, scanned: collected.length },
        );
      }
      cursor = page.nextCursor;
      if (cursor === null) {
        return collected;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------

/** Sanitized message of a generator that was cancelled before it reported an outcome. */
const GENERATION_CANCELLED_MESSAGE =
  'planning generation was cancelled before it reported an outcome; the provider outcome is unknown and the call still counts';

/** Sanitized message of an unexpected generator exception; see {@link GENERATION_CANCELLED_MESSAGE}. */
const GENERATION_THREW_MESSAGE =
  'planning generation failed before it reported an outcome; the provider outcome is unknown and the call still counts';

/**
 * Private sentinel that aborts one charged settlement transaction after a cancellation was sampled.
 *
 * It is deliberately not a `DomainError('cancelled')`: the settlement catch must distinguish "the
 * user cancelled, so keep the already-known paid usage in a new transaction" from every other
 * failure, and the caller's cancellation must never surface as a thrown error out of a charged
 * write (which would roll the paid record back).
 */
class SettlementCancelledAbort extends Error {
  constructor() {
    super('planning settlement aborted after a cancellation was sampled');
    this.name = 'SettlementCancelledAbort';
  }
}

/**
 * Private sentinel for a post-provider step that threw inside the charged settlement transaction.
 *
 * The transaction rolls back and the paid outcome is re-settled with a fixed sanitized
 * `provider_error`; `original` is the raw thrown value and only ever reaches the local diagnostic
 * hook, never a durable row or a public result.
 */
class SettlementStepFailure extends Error {
  readonly original: unknown;

  constructor(original: unknown) {
    super('planning settlement step failed');
    this.name = 'SettlementStepFailure';
    this.original = original;
  }
}

/**
 * Sample the caller's token inside a charged settlement and abort the transaction when cancelled.
 *
 * The abort is a private sentinel, not the caller's cancellation error: the settlement catch turns
 * it into a new transaction that keeps the paid usage and host correlation, so a cancellation can
 * never roll a paid record away.
 */
function abortIfCancelled(token: CancellationToken): void {
  if (token.cancelled) {
    throw new SettlementCancelledAbort();
  }
}

/** Fixed sanitized message of a charged dispatch whose post-provider settlement step failed. */
function settlementStepFailedMessage(attemptId: string): string {
  return `planning request ${attemptId} could not be written after the model answered because a local planning step failed; prepare the plan again, because the paid call is retained and no plan was stored`;
}

/** Fixed sanitized message of a paid dispatch whose workbench settings moved before the plan write. */
function settingsMovedMessage(reservation: PlanAttempt, current: BorrowedPlanningSettings): string {
  return `planning request ${reservation.id} was dispatched under ${reservation.provider}/${reservation.model} at settings revision ${String(reservation.settingsRevision)}, but the stored workbench settings are now ${current.settings.provider.trim()}/${current.settings.roles.analysisModel.trim()} at revision ${String(current.revision)}; prepare the plan again, because the paid call is retained and no plan was stored`;
}

/** `true` when the settings a paid dispatch was reserved under are no longer the stored ones. */
function settingsMovedAfterDispatch(reservation: PlanAttempt, current: BorrowedPlanningSettings): boolean {
  return (
    current.revision !== reservation.settingsRevision ||
    current.settings.provider.trim() !== reservation.provider ||
    current.settings.roles.analysisModel.trim() !== reservation.model
  );
}

const PREPARE_REQUEST_KEYS: readonly string[] = [
  'requestId',
  'accountId',
  'settings',
  'candidateLimit',
  'candidateProblemKeys',
  'guidanceMethodIds',
  'reveal',
];
const RUN_REQUEST_KEYS: readonly string[] = ['requestId', 'accountId', 'expectedSettingsRevision'];
const ATTEMPT_REQUEST_KEYS: readonly string[] = ['requestId', 'accountId'];
const SETTINGS_KEYS: readonly string[] = ['horizonDays', 'minutesPerDay', 'estimatedMinutes', 'maxTasksPerDay'];

interface ParsedPrepare {
  readonly requestId: string;
  readonly accountId: string;
  readonly settings: PlanAttemptSettings;
  readonly candidateLimit: number;
  /** `null` means the automatic pool; a list is the caller's explicit stored selection. */
  readonly candidateProblemKeys: readonly string[] | null;
  /** `null` means the legacy unguided contract; a list is the caller's explicit method selection. */
  readonly guidanceMethodIds: readonly string[] | null;
  readonly reveal: boolean;
}

interface ParsedRun {
  readonly requestId: string;
  readonly accountId: string;
  readonly expectedSettingsRevision: number | null;
}

interface ParsedAttempt {
  readonly requestId: string;
  readonly accountId: string;
}

/**
 * Immutable input hash of one attempt.
 *
 * It covers the request identity (provider/model/prompt version and the settings revision) and the
 * semantic evidence hash of the preparation, so a later audit can prove the paid call ran on
 * exactly the material the user confirmed — never on a wallclock-only difference.
 */
function planningInputHash(preparation: PlanAttemptPreparation, settings: BorrowedPlanningSettings): string {
  return contentHashOf({
    promptVersion: PLANNING_PROMPT_VERSION,
    provider: settings.settings.provider,
    model: settings.settings.roles.analysisModel,
    settingsRevision: settings.revision,
    planSettings: preparation.settings,
    evidenceHash: preparation.evidenceHash,
  });
}

function parsePrepareRequest(request: PlanPrepareRequest): ParsedPrepare {
  if (request === null || typeof request !== 'object') {
    throw new PlanningServiceError('invalid_request', 'prepare needs a request object', {});
  }
  const unknownKeys = Object.keys(request).filter((key) => !PREPARE_REQUEST_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    throw new PlanningServiceError('invalid_request', `prepare has unknown keys: ${unknownKeys.join(', ')}`, {
      unknownKeys,
    });
  }
  const requestId = requireRequestId(request.requestId);
  const accountId = requireAccountId(request.accountId);
  const rawSettings = request.settings ?? null;
  if (rawSettings !== null && (typeof rawSettings !== 'object' || Array.isArray(rawSettings))) {
    throw new PlanningServiceError('invalid_request', 'prepare settings must be an object when present', {});
  }
  const settingsRecord = (rawSettings ?? {}) as Record<string, unknown>;
  const unknownSettings = Object.keys(settingsRecord).filter((key) => !SETTINGS_KEYS.includes(key));
  if (unknownSettings.length > 0) {
    throw new PlanningServiceError(
      'invalid_request',
      `prepare settings has unknown keys: ${unknownSettings.join(', ')}`,
      { unknownSettings },
    );
  }
  const settings: PlanAttemptSettings = {
    horizonDays: boundedSetting(
      'horizonDays',
      settingsRecord['horizonDays'],
      PLANNING_DEFAULT_HORIZON_DAYS,
      PLANNING_MAX_HORIZON_DAYS,
    ),
    minutesPerDay: boundedSetting(
      'minutesPerDay',
      settingsRecord['minutesPerDay'],
      PLANNING_DEFAULT_MINUTES_PER_DAY,
      PLANNING_MAX_MINUTES_PER_DAY,
    ),
    estimatedMinutes: boundedSetting(
      'estimatedMinutes',
      settingsRecord['estimatedMinutes'],
      PLANNING_DEFAULT_ESTIMATED_MINUTES,
      PLANNING_MAX_ESTIMATED_MINUTES,
    ),
    maxTasksPerDay: boundedSetting('maxTasksPerDay', settingsRecord['maxTasksPerDay'], PLANNING_MAX_TASKS_PER_DAY, PLANNING_MAX_TASKS_PER_DAY),
  };
  const limit = request.candidateLimit;
  if (limit !== undefined && limit !== null) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PLANNING_CANDIDATES) {
      throw new PlanningServiceError(
        'invalid_request',
        `candidateLimit must be an integer within 1..${MAX_PLANNING_CANDIDATES}`,
        { candidateLimit: limit },
      );
    }
  }
  if (request.reveal !== undefined && typeof request.reveal !== 'boolean') {
    throw new PlanningServiceError('invalid_request', 'prepare reveal must be boolean when present', {});
  }
  const candidateProblemKeys = parseCandidateSelection(request.candidateProblemKeys);
  const guidanceMethodIds = parseGuidanceSelection(request.guidanceMethodIds);
  if (
    candidateProblemKeys !== null &&
    limit !== undefined &&
    limit !== null &&
    limit < candidateProblemKeys.length
  ) {
    // An explicit selection is a statement about the pool, never a hint: silently keeping only the
    // first `candidateLimit` keys would prepare a plan from problems the caller did not confirm.
    throw new PlanningServiceError(
      'invalid_request',
      `candidateLimit ${limit} is below the explicit selection of ${candidateProblemKeys.length} candidate problems; an explicit selection is never truncated`,
      {
        reason: 'candidate_limit_below_selection',
        candidateLimit: limit,
        selection: candidateProblemKeys.length,
      },
    );
  }
  return {
    requestId,
    accountId,
    settings,
    candidateLimit:
      limit === undefined || limit === null
        ? candidateProblemKeys === null
          ? MAX_PLANNING_CANDIDATES
          : Math.max(1, candidateProblemKeys.length)
        : limit,
    candidateProblemKeys,
    guidanceMethodIds,
    reveal: request.reveal === true,
  };
}

function parseRunRequest(request: PlanRunRequest): ParsedRun {
  if (request === null || typeof request !== 'object') {
    throw new PlanningServiceError('invalid_request', 'run needs a request object', {});
  }
  const unknownKeys = Object.keys(request).filter((key) => !RUN_REQUEST_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    throw new PlanningServiceError('invalid_request', `run has unknown keys: ${unknownKeys.join(', ')}`, {
      unknownKeys,
    });
  }
  const revision = request.expectedSettingsRevision;
  if (revision !== undefined && revision !== null) {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new PlanningServiceError(
        'invalid_request',
        'expectedSettingsRevision must be a positive integer when present',
        { expectedSettingsRevision: revision },
      );
    }
  }
  return {
    requestId: requireRequestId(request.requestId),
    accountId: requireAccountId(request.accountId),
    expectedSettingsRevision: revision === undefined || revision === null ? null : revision,
  };
}

function parseAttemptRequest(request: PlanAttemptRequest): ParsedAttempt {
  if (request === null || typeof request !== 'object') {
    throw new PlanningServiceError('invalid_request', 'a planning attempt read needs a request object', {});
  }
  const unknownKeys = Object.keys(request).filter((key) => !ATTEMPT_REQUEST_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    throw new PlanningServiceError('invalid_request', `planning attempt read has unknown keys: ${unknownKeys.join(', ')}`, {
      unknownKeys,
    });
  }
  return { requestId: requireRequestId(request.requestId), accountId: requireAccountId(request.accountId) };
}

function requireRequestId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_PLANNING_REQUEST_ID_CHARS) {
    throw new PlanningServiceError(
      'invalid_request',
      `requestId must be a non-empty string of at most ${MAX_PLANNING_REQUEST_ID_CHARS} characters`,
      { requestId: typeof value === 'string' ? value.slice(0, 64) : value },
    );
  }
  return value;
}

function requireAccountId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PlanningServiceError(
      'invalid_request',
      'accountId must be a non-empty stored account id; an AI plan is always one account\'s plan',
      { accountId: value },
    );
  }
  return value;
}

function boundedSetting(name: string, value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new PlanningServiceError('invalid_request', `${name} must be an integer within 1..${max}`, {
      name,
      value,
    });
  }
  return value as number;
}

function requireToken(token: CancellationToken): void {
  if (
    token === null ||
    typeof token !== 'object' ||
    typeof token.cancelled !== 'boolean' ||
    typeof token.throwIfCancelled !== 'function' ||
    typeof token.onCancel !== 'function'
  ) {
    throw new PlanningServiceError('invalid_request', 'planning calls need a cancellation token', {});
  }
}

/** The immutable request identity of one attempt must agree with the stored row. */
function assertPrepareIdentity(attempt: PlanAttempt, parsed: ParsedPrepare): void {
  if (attempt.accountId !== parsed.accountId) {
    // No account of the stored row is named: a guessed request id must not disclose whose it is.
    throw new PlanningServiceError(
      'request_conflict',
      `requestId ${parsed.requestId} is already in use; generate a new request id instead of reusing one`,
      { requestId: parsed.requestId, reason: 'request_id_taken' },
    );
  }
  if (canonicalSettings(attempt.preparation.settings) !== canonicalSettings(parsed.settings)) {
    throw new PlanningServiceError(
      'request_conflict',
      `requestId ${parsed.requestId} was prepared with different plan settings; generate a new request id instead of reusing one`,
      {
        requestId: parsed.requestId,
        reason: 'request_payload_conflict',
        stored: attempt.preparation.settings,
        requested: parsed.settings,
      },
    );
  }
  if (canonicalSelection(attempt.preparation.requestedCandidateKeys) !== canonicalSelection(parsed.candidateProblemKeys)) {
    throw new PlanningServiceError(
      'request_conflict',
      `requestId ${parsed.requestId} was prepared with a different candidate selection; generate a new request id instead of reusing one`,
      {
        requestId: parsed.requestId,
        reason: 'request_selection_conflict',
        stored: attempt.preparation.requestedCandidateKeys,
        requested: parsed.candidateProblemKeys,
      },
    );
  }
  const storedGuidance = attempt.preparation.guidanceSnapshot;
  const storedGuidanceIds = storedGuidance === undefined ? null : [...storedGuidance.selectedMethodIds];
  if (canonicalGuidance(storedGuidanceIds) !== canonicalGuidance(parsed.guidanceMethodIds)) {
    throw new PlanningServiceError(
      'request_conflict',
      `requestId ${parsed.requestId} was prepared with a different training-method selection; generate a new request id instead of reusing one`,
      {
        requestId: parsed.requestId,
        reason: 'request_guidance_conflict',
        stored: storedGuidanceIds,
        requested: parsed.guidanceMethodIds,
      },
    );
  }
}

/** A stored attempt is only ever read/written for its own account. */
function assertAttemptScope(attempt: PlanAttempt, accountId: string): void {
  if (attempt.accountId !== accountId) {
    throw new PlanningServiceError('unknown_request', `planning request ${attempt.id} is not known for this account`, {
      requestId: attempt.id,
      reason: 'unknown_request',
    });
  }
}

function canonicalSettings(settings: PlanAttemptSettings): string {
  return contentHashOf(settings);
}

/**
 * Canonical form of a requested candidate selection.
 *
 * `null` (the automatic pool) is hashed as its own scope marker so it can never compare equal to
 * an explicit empty selection, and the explicit list stays **order-sensitive**: the caller's order
 * is the pool order the model sees, so re-preparing the same id with the same problems in another
 * order is a different request.
 */
function canonicalSelection(selection: readonly string[] | null): string {
  return contentHashOf(selection === null ? { scope: 'automatic' } : { scope: 'explicit', keys: selection });
}

/**
 * Canonical form of a requested training-method selection.
 *
 * `null` is the legacy unguided contract and hashes as its own scope marker, so it can never compare
 * equal to an explicit selection. The explicit list stays **order-sensitive**, because a method's own
 * training steps are ordered and the caller's order is the order the model is shown.
 */
function canonicalGuidance(selection: readonly string[] | null): string {
  return contentHashOf(selection === null ? { scope: 'legacy_unguided' } : { scope: 'methods', ids: selection });
}

/**
 * Validate one explicit candidate selection: array of canonical, unique, bounded stored keys.
 *
 * `undefined`/`null` means "automatic pool". An explicit empty list is accepted as a real caller
 * statement ("select nothing"): the preparation then holds no candidate and is refused as
 * `preparation_empty`, never silently replaced by the automatic pool.
 */
function parseCandidateSelection(value: readonly string[] | null | undefined): readonly string[] | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new PlanningServiceError(
      'invalid_request',
      'candidateProblemKeys must be an array of stored problem keys when present',
      {},
    );
  }
  if (value.length > MAX_PLANNING_CANDIDATES) {
    throw new PlanningServiceError(
      'invalid_request',
      `candidateProblemKeys must hold at most ${MAX_PLANNING_CANDIDATES} keys`,
      { reason: 'too_many_candidates', length: value.length, bound: MAX_PLANNING_CANDIDATES },
    );
  }
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new PlanningServiceError(
        'invalid_request',
        'every candidateProblemKeys entry must be a non-empty stored problem key',
        { entry },
      );
    }
    const key = entry.trim();
    let canonical: string;
    try {
      canonical = canonicalProblemKeyOf(parseProblemKey(key));
    } catch (error) {
      throw new PlanningServiceError(
        'invalid_request',
        `candidate key ${key} is not a canonical problem key`,
        { reason: 'malformed_candidate_key', problemKey: key, cause: String(error) },
      );
    }
    if (canonical !== key) {
      throw new PlanningServiceError(
        'invalid_request',
        `candidate key ${key} is not a canonical problem key`,
        { reason: 'malformed_candidate_key', problemKey: key, canonicalKey: canonical },
      );
    }
    if (seen.has(key)) {
      throw new PlanningServiceError('invalid_request', `candidateProblemKeys repeats ${key}`, {
        reason: 'duplicate_candidate_key',
        problemKey: key,
      });
    }
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/**
 * Validate one explicit training-method selection: distinct non-empty ids, bounded like the domain
 * capture.
 *
 * `undefined`/`null` is the legacy unguided contract and is preserved as `null`. An explicit empty
 * list is refused instead of being read as "no method": the AI planning path either follows an
 * installed method capture or runs the legacy contract, and a silently unguided paid plan is exactly
 * what that rule forbids.
 */
function parseGuidanceSelection(value: readonly string[] | null | undefined): readonly string[] | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new PlanningServiceError(
      'invalid_request',
      'guidanceMethodIds must be an array of installed method ids when present',
      {},
    );
  }
  if (value.length === 0) {
    throw new PlanningServiceError(
      'invalid_request',
      'an explicit guidanceMethodIds list needs at least one installed training method; omit the field for the legacy unguided preparation',
      { reason: 'missing_method' },
    );
  }
  if (value.length > MAX_GUIDANCE_SELECTION) {
    throw new PlanningServiceError(
      'invalid_request',
      `guidanceMethodIds holds at most ${MAX_GUIDANCE_SELECTION} methods`,
      { reason: 'selection_too_long', length: value.length, bound: MAX_GUIDANCE_SELECTION },
    );
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new PlanningServiceError(
        'invalid_request',
        'every guidanceMethodIds entry must be a non-empty installed method id',
        { entry },
      );
    }
    const id = entry.trim();
    if (seen.has(id)) {
      throw new PlanningServiceError('invalid_request', `guidanceMethodIds repeats ${id}`, {
        reason: 'duplicate_selection',
        methodId: id,
      });
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Page size of one account-scoped history read: bounded to the approved maximum. */
function parseHistoryLimit(value: number | null | undefined): number {
  if (value === undefined || value === null) {
    return DEFAULT_PLANNING_HISTORY_LIMIT;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PLANNING_HISTORY_LIMIT) {
    throw new PlanningServiceError(
      'invalid_request',
      `history limit must be an integer within 1..${MAX_PLANNING_HISTORY_LIMIT}`,
      { limit: value },
    );
  }
  return value;
}

function cancelledError(message: string): ModelGatewayError {
  return { code: 'cancelled', message, retryable: false };
}

function refusedResult(
  parsed: ParsedRun,
  code: PlanningRefusalCode,
  message: string,
  retryable: boolean,
): PlanRunResult {
  return {
    outcome: 'refused',
    requestId: parsed.requestId,
    accountId: parsed.accountId,
    attempt: null,
    error: { code, message, retryable },
    verification: 'unverified_ai',
  };
}

/** The exact task data one planning call sends: untrusted data only, never an account identifier. */
function generationRequestOf(
  reserved: Extract<ReserveOutcome, { kind: 'reserved' }>,
  token: CancellationToken,
): PlanGenerationRequest {
  const preparation = reserved.attempt.preparation;
  return {
    provider: reserved.attempt.provider,
    model: reserved.attempt.model,
    maxOutputTokens: reserved.settings.settings.roles.maxOutputTokens,
    requestTimeoutMs: reserved.settings.settings.modelLimits.requestTimeoutMs,
    effort: 'max',
    attemptId: reserved.attempt.id,
    promptVersion: reserved.attempt.promptVersion,
    token,
    settings: preparation.settings,
    ability: preparation.ability,
    candidates: preparation.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      title: candidate.title,
      url: candidate.url,
      estimatedMinutes: candidate.estimatedMinutes,
      taxonomyIds: [...candidate.effectiveTaxonomyIds],
      ratings: candidate.ratings.map((rating) => ({
        dimension: rating.dimension,
        value: rating.value,
        raw: rating.raw,
      })),
      provisionalRawTags: [...candidate.provisionalRawTags],
    })),
    weakTags: preparation.weakness.ranking.map((tag) => ({ ...tag })),
    attemptedDistinctTotal: preparation.weakness.attemptedDistinctTotal,
    // `null` for the legacy unguided contract; a guided call carries the exact stored capture, so the
    // adapter can inject the selected methods' plan guidance and demand the guided answer shape.
    guidance: preparation.guidanceSnapshot ?? null,
    // The identifier-free virtual-contest capture, or `null` when the preparation predates Sprint
    // 18c. It carries no account id, contest id, note, URL, rank or exact timestamp.
    virtualPerformance: preparation.virtualPerformance ?? null,
  };
}

/** The normalized draft as the domain's untrusted boundary parser reads it. */
function draftToRaw(draft: PlanGenerationDraft): unknown {
  return {
    ...(draft.title === null ? {} : { title: draft.title }),
    // The guided fields are handed to the domain parser whenever the answer carries them, including
    // for an unguided attempt: the validator decides from the reservation whether they were required
    // or forbidden, so nothing is dropped here and silently forgiven.
    ...(draft.diagnosis === null || draft.diagnosis === undefined ? {} : { diagnosis: draft.diagnosis }),
    tasks: draft.tasks.map((task) => ({
      candidateId: task.candidateId,
      day: task.day,
      ...(task.minutes === null ? {} : { minutes: task.minutes }),
      ...(task.kind === null ? {} : { kind: task.kind }),
      ...(task.axis === null || task.axis === undefined ? {} : { axis: task.axis }),
      ...(task.objective === null || task.objective === undefined ? {} : { objective: task.objective }),
    })),
  };
}

function attemptView(attempt: PlanAttempt): PlanningAttemptView {
  return {
    requestId: attempt.id,
    accountId: attempt.accountId,
    status: attempt.status,
    requestedAt: attempt.requestedAt,
    expiresAt: attempt.expiresAt,
    finishedAt: attempt.finishedAt,
    usage: attempt.usage,
    error:
      attempt.error === null
        ? null
        : { code: attempt.error.code, message: attempt.error.message, retryable: attempt.error.retryable },
    planId: attempt.planId,
    planHash: attempt.planHash,
    candidateCount: attempt.preparation.candidates.length,
    verification: 'unverified_ai',
  };
}

/**
 * The public preparation view.
 *
 * Candidate tags and provisional raw labels stay **absent** own properties unless the caller asked
 * for spoilers explicitly, exactly like the bank projections; the aggregate weakness and the
 * identifier-free ability summary are aggregate statements and stay visible. The training-method
 * capture is public instructional text and is returned in full; `null` states the legacy unguided
 * contract and is never a substituted method.
 */
function preparationView(
  attempt: PlanAttempt,
  reveal: boolean,
  settings: BorrowedPlanningSettings,
): PlanningPreparationView {
  const preparation = attempt.preparation;
  const candidates: readonly PlanningCandidatePreview[] = preparation.candidates.map((candidate) =>
    candidatePreview(candidate, reveal),
  );
  return {
    requestId: attempt.id,
    status: attempt.status,
    preparedAt: preparation.preparedAt,
    expiresAt: attempt.expiresAt,
    settingsRevision: attempt.settingsRevision,
    settings: preparation.settings,
    candidates,
    exclusions: preparation.exclusions,
    weakness: preparation.weakness,
    ability: preparation.ability,
    generator: {
      provider: attempt.provider,
      model: attempt.model,
      maxOutputTokens: settings.settings.roles.maxOutputTokens,
      requestTimeoutMs: settings.settings.modelLimits.requestTimeoutMs,
      effort: 'max',
      maxCallsPer24Hours: settings.settings.coaching.maxCallsPer24Hours,
      quotaWindowMs: PLANNING_QUOTA_WINDOW_MS,
      maxConcurrent: PLANNING_MAX_CONCURRENT,
    },
    guidanceMethodIds:
      preparation.guidanceSnapshot === undefined ? null : [...preparation.guidanceSnapshot.selectedMethodIds],
    guidance: preparation.guidanceSnapshot ?? null,
    ...(preparation.virtualPerformance === undefined ? {} : {virtualPerformance:preparation.virtualPerformance}),
    disclosure: PLANNING_DISCLOSURE,
    spoilersVisible: reveal,
    contentHash: attempt.inputHash,
    verification: 'unverified_ai',
  };
}

function candidatePreview(candidate: PlanAttemptCandidate, reveal: boolean): PlanningCandidatePreview {
  const view: PlanningCandidatePreview = {
    candidateId: candidate.candidateId,
    problemKey: candidate.problemKey,
    externalKey: candidate.externalKey,
    title: candidate.title,
    url: candidate.url,
    estimatedMinutes: candidate.estimatedMinutes,
    ratings: candidate.ratings.map((rating) => ({
      dimension: rating.dimension,
      value: rating.value,
      raw: rating.raw,
    })),
  };
  if (!reveal) {
    // A withheld tag list is an absent property, never an empty array: `[]` would read as "this
    // candidate has no tags" instead of "not shown".
    return view;
  }
  return {
    ...view,
    taxonomyIds: [...candidate.effectiveTaxonomyIds],
    provisionalRawTags: [...candidate.provisionalRawTags],
  };
}

/** `true` when this status is terminal; re-exported for callers that render a status badge. */
export function planningStatusIsTerminal(status: PlanAttemptStatus): boolean {
  return isTerminalPlanStatus(status);
}
