/**
 * Durable AI training-plan attempts and their persistence port (Sprint 11c).
 *
 * One planning attempt is the audit row of one AI training-plan request. It is created `prepared`
 * — the **free** durable preparation: the bounded real candidate set, the aggregate account
 * weakness and the identifier-free 11a ability aggregate, together with the input hash and the
 * data signatures the later paid call is bound to. Only a later explicit `run` turns it into a
 * `reserved` row, which is the single in-flight paid call; a reservation moves only forward:
 * `reserved → settled | uncertain`, and a terminal row is immutable.
 *
 * Everything here is plain data plus pure validation: ids and timestamps are supplied by the
 * caller, so nothing reads a clock or an environment variable and a replay produces the same
 * records. Storage projects records onto their declared fields, so an undeclared member cannot be
 * persisted; the nested `usage`/`error`/`preparation` values are validated strictly (keys
 * included) because they are stored as canonical JSON.
 *
 * Statuses and what each one claims:
 *
 * - `prepared` — a durable, free preparation. No provider call happened and none is implied; the
 *   row is deliberately outside every quota count.
 * - `reserved` — one paid call is in flight. `requestedAt`/`expiresAt` were rewritten to the real
 *   reservation instant and its lease, which is what a restart compares to decide liveness.
 * - `settled` — terminal, with known usage, and exactly one of a stored plan (the success case) or
 *   a typed error. A cancelled dispatch settles here too, so its cost is never lost.
 * - `uncertain` — terminal, usage unknown (the provider never reported it) or the reservation
 *   expired before it settled. It stays on the quota books and is never retried automatically.
 * - `cancelled` — terminal, reachable **only** from `prepared`, i.e. before any dispatch: the
 *   preparation was abandoned and the paid call never happened. Such a row is known-zero and is
 *   not counted as a used call; a cancel that arrives after the reservation was written settles
 *   through the dispatch path instead, so a paid call can never be released for free.
 */
import { validateTrainingReference } from '../domain/ability-calibration.js';
import {
  DomainError,
  assertIsoTimestamp,
  canonicalJson,
  contentHashOf,
  invariant,
  parseProblemKey,
  problemKey as canonicalProblemKeyOf,
  type AbilityPlanningAggregate,
  type CancellationToken,
  type TrainingCandidate,
  type TrainingCandidateOrigin,
  type TrainingPlan,
} from '../domain/index.js';
import type { ModelErrorCode, ModelGatewayError, Page } from './ports.js';
import type { ModelUsage } from '../domain/index.js';

/** Lifecycle of one AI planning attempt; see the module comment for what each status claims. */
export type PlanAttemptStatus = 'prepared' | 'reserved' | 'settled' | 'uncertain' | 'cancelled';

export const PLAN_ATTEMPT_STATUSES: readonly PlanAttemptStatus[] = [
  'prepared',
  'reserved',
  'settled',
  'uncertain',
  'cancelled',
];

/**
 * Statuses that stand for a call that was (or may have been) dispatched.
 *
 * These are exactly the rows the rolling-24h planning quota counts: a `prepared` row never
 * dispatched and a `cancelled` row is only reachable before dispatch, so neither may consume
 * quota, while an expired reservation (`uncertain`) keeps its slot forever.
 */
export const PLAN_ATTEMPT_CHARGED_STATUSES: readonly PlanAttemptStatus[] = ['reserved', 'settled', 'uncertain'];

/** Maximum accepted `requestId` length; the UI owns the uuid, the service only bounds it. */
export const MAX_PLANNING_REQUEST_ID_CHARS = 200;

/** Largest candidate pool one preparation may hold; the contract bound is 100 real problems. */
export const MAX_PLANNING_CANDIDATES = 100;

/** Lease safety margin added to the configured model timeout of one planning call. */
export const PLANNING_LEASE_MARGIN_MS = 30_000;

/** Rolling window of the plugin-wide planning quota (equal to the coaching window). */
export const PLANNING_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Fixed disclosure the UI must render next to a prepared AI plan.
 *
 * It states exactly which material the summary carries (aggregate ability statistics and the
 * selected candidate problems) and which it does not (account identifiers, submission detail,
 * retrospective notes).
 */
export const PLANNING_DISCLOSURE =
  '能力统计摘要及所选候选题信息；不含账号标识、提交明细或复盘笔记';

/** One raw platform rating of a prepared candidate, preserved exactly as the platform reported it. */
export interface PlanAttemptRating {
  readonly dimension: string;
  readonly value: number | string;
  readonly scale: { readonly min: number; readonly max: number } | null;
  readonly raw: string;
}

/**
 * One real prepared candidate.
 *
 * Titles, native ratings and the public problem link are the only public material a candidate
 * carries. An effective taxonomy id set and the source-aware raw platform labels travel with it so
 * a later revalidation can prove the model chose from **this** evidence; the raw labels are
 * explicitly provisional and are never presented as accepted tags.
 */
export interface PlanAttemptCandidate {
  readonly candidateId: string;
  readonly problemKey: string;
  readonly externalKey: string;
  readonly title: string;
  readonly url: string;
  readonly estimatedMinutes: number;
  readonly effectiveTaxonomyIds: readonly string[];
  /** Original platform labels; provisional provenance, never an accepted taxonomy tag. */
  readonly provisionalRawTags: readonly string[];
  readonly ratings: readonly PlanAttemptRating[];
  readonly origin: TrainingCandidateOrigin;
}

/** How the candidate pool was bounded and what it deliberately excluded. */
export interface PlanAttemptExclusions {
  /** Own native accepted problems excluded from the pool (the default). */
  readonly nativeSolvedExcluded: number;
  /** Canonical duplicate identities collapsed into one candidate. */
  readonly duplicateExcluded: number;
  /** Rows that were not part of the selected account's own source instance. */
  readonly foreignExcluded: number;
  /** The applied candidate bound and the number of distinct problems considered. */
  readonly candidateLimit: number;
  readonly considered: number;
}

/** One sufficient-sample weak tag of the account, as the planner sees it. */
export interface PlanAttemptWeakTag {
  readonly taxonomyId: string;
  readonly solveRate: number;
}

/**
 * Aggregate account weakness of one preparation.
 *
 * Counts and tag ids only: no problem key, no submission id, no retrospective note, so the
 * aggregate can travel to a model without becoming a submission dump.
 */
export interface PlanAttemptWeakness {
  readonly attemptedDistinctTotal: number;
  readonly sufficientTagIds: readonly string[];
  readonly ranking: readonly PlanAttemptWeakTag[];
}

/** Plan scheduling settings of one attempt; the paid call may not run under different ones. */
export interface PlanAttemptSettings {
  readonly horizonDays: number;
  readonly minutesPerDay: number;
  readonly maxTasksPerDay: number;
  readonly estimatedMinutes: number;
}

/**
 * The immutable preparation a paid planning call is bound to.
 *
 * `evidenceHash` is a hash over the **semantic** evidence only (candidates, weakness aggregate,
 * ability aggregate, settings, source instance): observation instants such as `preparedAt` or the
 * ability report's `computedAt` are deliberately excluded, so re-preparing unchanged evidence
 * yields the same hash instead of a "changed" verdict caused by the clock.
 */
export interface PlanAttemptPreparation {
  readonly preparedAt: string;
  /** The one account this preparation describes; it is never part of a model payload. */
  readonly accountId: string;
  readonly sourceInstanceId: string;
  /**
   * The caller's explicit candidate selection, in the caller's order, or `null` for the bounded
   * automatic pool.
   *
   * A non-null list is the **requested scope** of this preparation: only those stored problems of
   * the same source instance could enter the pool, and a selected problem this account had already
   * accepted is excluded and counted in {@link PlanAttemptExclusions.nativeSolvedExcluded} instead.
   * The list may be empty — an explicit "select nothing" produces no candidate and is refused as
   * `preparation_empty`, never silently replaced by the automatic pool. `null` means the
   * preparation used the automatic unsolved pool.
   */
  readonly requestedCandidateKeys: readonly string[] | null;
  readonly settings: PlanAttemptSettings;
  readonly candidates: readonly PlanAttemptCandidate[];
  readonly exclusions: PlanAttemptExclusions;
  readonly weakness: PlanAttemptWeakness;
  /** The 11a assessment reduced to its identifier-free aggregate. */
  readonly ability: AbilityPlanningAggregate;
  /** Stable hash over the semantic evidence above (see the interface comment). */
  readonly evidenceHash: string;
}

/** Durable audit row for one AI planning request. */
export interface PlanAttempt {
  /** Caller-supplied bounded request id; the idempotency key of prepare and of the paid run. */
  readonly id: string;
  readonly accountId: string;
  readonly sourceInstanceId: string;
  readonly status: PlanAttemptStatus;
  /**
   * Reservation instant of a charged row; the preparation instant while the row is `prepared`.
   *
   * A `prepared` row is not a paid call, so the value is only replaced by the real reservation
   * instant when the reservation is written: the rolling quota must count a call from the moment
   * it was actually reserved, never from an old preparation.
   */
  readonly requestedAt: string;
  /** Reservation deadline, fixed at reservation time; recovery compares it, it never moves. */
  readonly expiresAt: string;
  readonly finishedAt: string | null;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  /** Stored workbench-settings revision this attempt was prepared under, or `null` when none. */
  readonly settingsRevision: number | null;
  /** Immutable hash of the request/input identity of this attempt. */
  readonly inputHash: string;
  readonly preparation: PlanAttemptPreparation;
  readonly hostSessionId: string | null;
  readonly hostCallId: string | null;
  readonly usage: ModelUsage | null;
  /** Stored validated model plan of a successful attempt; `null` for every other outcome. */
  readonly planId: string | null;
  /** Full sha256 content hash of that stored plan, so a later read can prove it is unchanged. */
  readonly planHash: string | null;
  readonly error: ModelGatewayError | null;
}

/**
 * Immutable identity + input of one attempt: changing one is an immutable violation.
 *
 * `requestedAt`/`expiresAt` are deliberately **not** here: the single `prepared → reserved`
 * transition rewrites them to the real reservation instant and lease. Their own rule is enforced
 * separately, and after that transition they are immutable like everything else.
 */
export const PLAN_ATTEMPT_IDENTITY_FIELDS: readonly (keyof PlanAttempt)[] = [
  'id',
  'accountId',
  'sourceInstanceId',
  'provider',
  'model',
  'promptVersion',
  'settingsRevision',
  'inputHash',
  'preparation',
];

const ATTEMPT_KEYS = [
  'id',
  'accountId',
  'sourceInstanceId',
  'status',
  'requestedAt',
  'expiresAt',
  'finishedAt',
  'provider',
  'model',
  'promptVersion',
  'settingsRevision',
  'inputHash',
  'preparation',
  'hostSessionId',
  'hostCallId',
  'usage',
  'planId',
  'planHash',
  'error',
] as const;

const PREPARATION_KEYS = [
  'preparedAt',
  'accountId',
  'sourceInstanceId',
  'requestedCandidateKeys',
  'settings',
  'candidates',
  'exclusions',
  'weakness',
  'ability',
  'evidenceHash',
] as const;
const SETTINGS_KEYS = ['horizonDays', 'minutesPerDay', 'maxTasksPerDay', 'estimatedMinutes'] as const;
const CANDIDATE_KEYS = [
  'candidateId',
  'problemKey',
  'externalKey',
  'title',
  'url',
  'estimatedMinutes',
  'effectiveTaxonomyIds',
  'provisionalRawTags',
  'ratings',
  'origin',
] as const;
const RATING_KEYS = ['dimension', 'value', 'scale', 'raw'] as const;
const SCALE_KEYS = ['min', 'max'] as const;
const EXCLUSION_KEYS = [
  'nativeSolvedExcluded',
  'duplicateExcluded',
  'foreignExcluded',
  'candidateLimit',
  'considered',
] as const;
const WEAKNESS_KEYS = ['attemptedDistinctTotal', 'sufficientTagIds', 'ranking'] as const;
const WEAK_TAG_KEYS = ['taxonomyId', 'solveRate'] as const;
const ABILITY_KEYS = [
  'version',
  'platform',
  'estimateStatus',
  'estimateBasis',
  'heuristicVersion',
  'confidence',
  'sampleSize',
  'minimumSampleSize',
  'baselineTrainingLevel',
  'quartileBand',
  'baselinePool',
  'stretchPool',
  'counts',
  'last90Days',
  'completionModesAllTime',
  'completionModesLast90Days',
  'excludedFromEstimate',
  'nativeDifficulty',
  'coverage',
  'reasonCodes',
  'caveats',
] as const;
const USAGE_KEYS = ['calls', 'promptTokens', 'completionTokens', 'totalTokens'] as const;
const ERROR_KEYS = ['code', 'message', 'retryable'] as const;

const MODEL_ERROR_CODES: readonly ModelErrorCode[] = [
  'cancelled',
  'timeout',
  'rate_limited',
  'quota_exhausted',
  'invalid_output',
  'provider_error',
  'unsupported',
];

const CANDIDATE_ORIGINS: readonly TrainingCandidateOrigin[] = ['weakness', 'unsolved_pool', 'manual', 'beginner'];

const SHA256 = /^[0-9a-f]{64}$/u;

/** Probe keys of the two candidate-origin unions this build accepts (`source=model` is not one). */
const ESTIMATE_STATUSES = ['estimated', 'unknown'] as const;
const ESTIMATE_BASES = ['recent_independent', 'recent_observed', 'historical'] as const;
const CONFIDENCES = ['low', 'medium'] as const;
const SOURCE_PLATFORMS = ['codeforces', 'luogu', 'hydro', 'manual'] as const;
const ABILITY_COUNT_KEYS = ['attemptedDistinct', 'solvedDistinct', 'unsolvedDistinct'] as const;
const ABILITY_WINDOW_KEYS = ['attemptedDistinct', 'newSolvedDistinct', 'repeatedAcDistinct'] as const;
const ABILITY_MODE_KEYS = ['independent', 'assisted', 'solutionUsed', 'unknown', 'total'] as const;
const ABILITY_EXCLUDED_KEYS = ['assistedDistinct', 'solutionUsedDistinct', 'total'] as const;
const ABILITY_RANGE_KEYS = ['min', 'max'] as const;
const ABILITY_NATIVE_KEYS = ['dimension', 'count', 'missing', 'median'] as const;
const ABILITY_COVERAGE_KEYS = [
  'metadataMissing',
  'solvedWithoutNativeValue',
  'futureSubmissionsExcluded',
] as const;

/**
 * Strictly validate one planning attempt and return a detached, normalized copy.
 *
 * Every declared field must be present (an explicit `null` is data, a missing or `undefined`
 * member is not), undeclared top-level keys are rejected, `expiresAt` must be strictly after
 * `requestedAt` and `finishedAt` must not precede `requestedAt`. The status shape is enforced as
 * described on {@link PlanAttempt}.
 */
export function validatePlanAttempt(value: unknown): PlanAttempt {
  const record = requireObject('planning attempt', value);
  requireExactKeys('planning attempt', record, ATTEMPT_KEYS);

  const id = requireText('planning attempt id', record['id']);
  const accountId = requireText('planning attempt accountId', record['accountId']);
  const sourceInstanceId = requireText('planning attempt sourceInstanceId', record['sourceInstanceId']);
  const status = record['status'];
  invariant(
    PLAN_ATTEMPT_STATUSES.includes(status as PlanAttemptStatus),
    'invalid_input',
    `unknown planning status ${String(status)}`,
    { status },
  );
  const requestedAt = requireTimestamp('planning attempt requestedAt', record['requestedAt']);
  const expiresAt = requireTimestamp('planning attempt expiresAt', record['expiresAt']);
  invariant(
    Date.parse(expiresAt) > Date.parse(requestedAt),
    'invalid_input',
    `planning attempt ${id} expiresAt must be after requestedAt`,
    { id, requestedAt, expiresAt },
  );
  const finishedAt =
    record['finishedAt'] === null ? null : requireTimestamp('planning attempt finishedAt', record['finishedAt']);
  if (finishedAt !== null) {
    invariant(
      Date.parse(finishedAt) >= Date.parse(requestedAt),
      'invalid_input',
      `planning attempt ${id} finishedAt must not precede requestedAt`,
      { id, requestedAt, finishedAt },
    );
  }
  const provider = requireText('planning attempt provider', record['provider']);
  const model = requireText('planning attempt model', record['model']);
  const promptVersion = requireText('planning attempt promptVersion', record['promptVersion']);
  const settingsRevision = requireNullableRevision('planning attempt settingsRevision', record['settingsRevision']);
  const inputHash = requireHash('planning attempt inputHash', record['inputHash']);
  const preparation = requirePreparation(record['preparation']);
  invariant(
    preparation.accountId === accountId,
    'invalid_input',
    `planning attempt ${id} preparation belongs to another account`,
    { id, reason: 'preparation_account_mismatch' },
  );
  invariant(
    preparation.sourceInstanceId === sourceInstanceId,
    'invalid_input',
    `planning attempt ${id} preparation belongs to ${preparation.sourceInstanceId}, not to ${sourceInstanceId}`,
    { id, sourceInstanceId, preparationSource: preparation.sourceInstanceId },
  );
  const hostSessionId = requireNullableText('planning attempt hostSessionId', record['hostSessionId']);
  const hostCallId = requireNullableText('planning attempt hostCallId', record['hostCallId']);
  const usage = record['usage'] === null ? null : requireUsage(record['usage']);
  const planId = requireNullableText('planning attempt planId', record['planId']);
  const planHash =
    record['planHash'] === null ? null : requireHash('planning attempt planHash', record['planHash']);
  const error = record['error'] === null ? null : requireError(record['error']);

  const attempt: PlanAttempt = {
    id,
    accountId,
    sourceInstanceId,
    status: status as PlanAttemptStatus,
    requestedAt,
    expiresAt,
    finishedAt,
    provider,
    model,
    promptVersion,
    settingsRevision,
    inputHash,
    preparation,
    hostSessionId,
    hostCallId,
    usage,
    planId,
    planHash,
    error,
  };
  validatePlanAttemptShape(attempt);
  return attempt;
}

/**
 * Validate one save of an existing attempt.
 *
 * Identity and the whole preparation are fixed; a known host correlation may neither be
 * reassigned nor cleared; a terminal row is immutable entirely (an identical re-save is the
 * caller's idempotent no-op before this check); the lifecycle only moves forward — `prepared` may
 * become `reserved` or `cancelled`, a `reserved` attempt may only become `settled` or `uncertain`
 * — and `requestedAt`/`expiresAt` may only be rewritten by that single `prepared → reserved`
 * transition, so a later save cannot extend its own lease.
 */
export function validatePlanAttemptTransition(previous: PlanAttempt, next: PlanAttempt): void {
  const stored = validatePlanAttempt(previous);
  const incoming = validatePlanAttempt(next);
  // The identity comparison is by **value**, never by reference: the immutable preparation is a
  // nested object, so a fresh (structurally identical) preparation must compare equal instead of
  // being reported as an identity conflict.
  const changed = PLAN_ATTEMPT_IDENTITY_FIELDS.filter(
    (field) => canonicalJson(stored[field]) !== canonicalJson(incoming[field]),
  );
  invariant(
    changed.length === 0,
    'immutable_violation',
    `planning attempt ${stored.id} already exists with a different ${changed.join(', ')}`,
    { id: stored.id, conflicts: changed },
  );
  for (const field of ['hostSessionId', 'hostCallId'] as const) {
    const known = stored[field];
    invariant(
      known === null || incoming[field] === known,
      'immutable_violation',
      `planning attempt ${stored.id} already records ${field} ${known}; a known host correlation cannot be reassigned or cleared`,
      { id: stored.id, field, previous: known, next: incoming[field], reason: 'host_correlation' },
    );
  }
  invariant(
    !isTerminalPlanStatus(stored.status),
    'immutable_violation',
    `terminal planning attempt ${stored.id} (${stored.status}) cannot be rewritten`,
    { id: stored.id, status: stored.status },
  );
  const allowed: readonly PlanAttemptStatus[] =
    stored.status === 'prepared' ? ['reserved', 'cancelled'] : ['settled', 'uncertain'];
  invariant(
    allowed.includes(incoming.status),
    'invalid_transition',
    `planning attempt ${stored.id} cannot move from ${stored.status} to ${incoming.status}`,
    { id: stored.id, previousStatus: stored.status, status: incoming.status },
  );
  if (stored.status === 'reserved') {
    invariant(
      incoming.requestedAt === stored.requestedAt && incoming.expiresAt === stored.expiresAt,
      'immutable_violation',
      `planning attempt ${stored.id} lease is fixed once reserved`,
      { id: stored.id, reason: 'lease', previous: stored.expiresAt, next: incoming.expiresAt },
    );
  }
}

/** `true` for a status no later save may leave: settled, uncertain or cancelled. */
export function isTerminalPlanStatus(status: PlanAttemptStatus): boolean {
  return status === 'settled' || status === 'uncertain' || status === 'cancelled';
}

/**
 * Enforce the result shape that belongs to one status.
 *
 * `cancelled` is only reachable before dispatch, so it records no usage and no plan: the call is
 * known to be zero, which is exactly why the row is excluded from the quota count.
 */
function validatePlanAttemptShape(attempt: PlanAttempt): void {
  if (attempt.status === 'prepared' || attempt.status === 'reserved') {
    invariant(
      attempt.finishedAt === null &&
        attempt.usage === null &&
        attempt.planId === null &&
        attempt.planHash === null &&
        attempt.error === null &&
        attempt.hostSessionId === null &&
        attempt.hostCallId === null,
      'invalid_input',
      `${attempt.status} planning attempt ${attempt.id} must not carry a result`,
      { id: attempt.id, status: attempt.status },
    );
    return;
  }
  invariant(
    attempt.finishedAt !== null,
    'invalid_input',
    `${attempt.status} planning attempt ${attempt.id} requires finishedAt`,
    { id: attempt.id },
  );
  if (attempt.status === 'cancelled') {
    invariant(
      attempt.usage === null && attempt.planId === null && attempt.planHash === null && attempt.error !== null,
      'invalid_input',
      `cancelled planning attempt ${attempt.id} must record only its cancellation error`,
      { id: attempt.id },
    );
    return;
  }
  if (attempt.status === 'uncertain') {
    invariant(
      attempt.usage === null && attempt.planId === null && attempt.planHash === null,
      'invalid_input',
      `uncertain planning attempt ${attempt.id} must not carry usage or a plan`,
      { id: attempt.id },
    );
    invariant(
      attempt.error !== null,
      'invalid_input',
      `uncertain planning attempt ${attempt.id} requires an error`,
      { id: attempt.id },
    );
    return;
  }
  invariant(
    attempt.usage !== null,
    'invalid_input',
    `settled planning attempt ${attempt.id} requires known usage`,
    { id: attempt.id },
  );
  const storedPlan = attempt.planId !== null || attempt.planHash !== null;
  invariant(
    (attempt.planId === null) === (attempt.planHash === null),
    'invalid_input',
    `settled planning attempt ${attempt.id} must record planId and planHash together`,
    { id: attempt.id },
  );
  invariant(
    storedPlan !== (attempt.error !== null),
    'invalid_input',
    `settled planning attempt ${attempt.id} must record exactly one of a stored plan or an error`,
    { id: attempt.id, hasPlan: storedPlan, hasError: attempt.error !== null },
  );
}

/**
 * Stable hash of one preparation's semantic evidence.
 *
 * Observation instants are excluded on purpose: two preparations built from unchanged evidence
 * must hash the same even when a clock moved, so a revalidation can distinguish a real data change
 * from a wallclock-only difference.
 */
export function planPreparationEvidenceHash(input: {
  readonly accountId: string;
  readonly sourceInstanceId: string;
  /** Requested candidate scope: `null` is the automatic pool, a list is the explicit selection. */
  readonly requestedCandidateKeys: readonly string[] | null;
  readonly settings: PlanAttemptSettings;
  readonly candidates: readonly PlanAttemptCandidate[];
  readonly weakness: PlanAttemptWeakness;
  readonly ability: AbilityPlanningAggregate;
}): string {
  return contentHashOf({
    accountId: input.accountId,
    sourceInstanceId: input.sourceInstanceId,
    requestedCandidateKeys: input.requestedCandidateKeys,
    settings: input.settings,
    candidates: input.candidates,
    weakness: input.weakness,
    ability: input.ability,
  });
}

/**
 * Which planning attempts to read back.
 *
 * `accountId` omitted/`null` means "no account restriction" (used by the global recovery and quota
 * walks only); a string reads that account alone. `since` is an **inclusive** lower bound on
 * `requestedAt`. `limit` must be `1..500` and a cursor is only valid for the filter set that
 * produced it, so a page can never be continued as a different query.
 */
export interface PlanAttemptQuery {
  readonly accountId?: string | null;
  readonly status?: PlanAttemptStatus | null;
  readonly since?: string | null;
  /**
   * Ordering of the requested page: omitted/`null` keeps the historical ascending
   * `requestedAt, id` order every quota/recovery walk relies on, while `desc` answers the
   * "latest attempt first" history read. The ordering is part of the cursor binding, so a page
   * can never be continued under a different order.
   */
  readonly order?: 'asc' | 'desc' | null;
  readonly limit: number;
  readonly cursor: string | null;
}

/** Which planning attempts to count for the plugin-wide rolling quota. */
export interface PlanAttemptCountQuery {
  readonly since?: string | null;
  readonly statuses?: readonly PlanAttemptStatus[] | null;
}

/**
 * Persistence port for planning attempts.
 *
 * Separate from the main training port so a store is not forced to implement unrelated operations;
 * the SQLite adapter implements both. Reads are bounded and cursored, the count is global, and
 * every method joins the caller's transaction when one is open without opening a nested one.
 */
export interface PlanningStore {
  getPlanAttempt(id: string): Promise<PlanAttempt | null>;
  /**
   * Insert a `prepared` attempt, or advance an existing one
   * (`prepared → reserved | cancelled`, `reserved → settled | uncertain`; nothing returns to an
   * earlier state and no new row may be inserted as `reserved`).
   *
   * A terminal attempt is immutable and an identical re-save is a no-op; a different body is
   * rejected, so a charged attempt can never be overwritten by a duplicate id.
   */
  savePlanAttempt(attempt: PlanAttempt): Promise<void>;
  /** One page in deterministic `requestedAt, id` order, with a cursor bound to the filter set. */
  listPlanAttempts(query: PlanAttemptQuery): Promise<Page<PlanAttempt>>;
  /** Number of attempts matching the filters, across every account (global quota). */
  countPlanAttempts(query: PlanAttemptCountQuery): Promise<number>;
}

// ---------------------------------------------------------------------------------------
// The injectable candidate/ability data collaborator
// ---------------------------------------------------------------------------------------

/** What one free preparation is asked for. */
export interface PlanPreparationRequest {
  readonly requestId: string;
  readonly accountId: string;
  readonly settings: PlanAttemptSettings;
  readonly candidateLimit: number;
  /**
   * Explicit stored candidate problems, in the caller's order (`candidateLimit` or fewer), or
   * omitted/`null` for the bounded automatic unsolved pool.
   *
   * The collaborator selects exactly these problems of the account's own source instance, rejects
   * an unknown or foreign key instead of dropping it, excludes the ones this account already
   * accepted (counted in the exclusions), and never truncates the list.
   */
  readonly candidateProblemKeys?: readonly string[] | null;
  /** The instant the preparation was requested; it is the ability assessment's observation time. */
  readonly preparedAt: string;
}

/** One prepared bundle: the persisted preparation plus the live candidate data it describes. */
export interface PlanPreparationBundle {
  readonly preparation: PlanAttemptPreparation;
  /** The validated candidates of this preparation, rebuilt through the domain factory. */
  readonly candidates: readonly TrainingCandidate[];
}

/** Why a stored preparation no longer describes the store; every reason is a typed stale failure. */
export type PlanStalenessReason =
  | 'account_missing'
  | 'account_changed'
  | 'source_missing'
  | 'settings_changed'
  | 'candidate_missing'
  | 'candidate_metadata_changed'
  | 'candidate_solved'
  | 'candidate_tags_changed'
  | 'weakness_changed'
  | 'ability_changed'
  | 'scope_changed';

/** One typed staleness finding, with the concrete problem it was found on when there is one. */
export interface PlanStaleness {
  readonly reason: PlanStalenessReason;
  readonly detail: string;
  readonly problemKey: string | null;
}

export type PlanRevalidationResult =
  | { readonly ok: true; readonly candidates: readonly TrainingCandidate[] }
  | { readonly ok: false; readonly staleness: PlanStaleness };

/**
 * Candidate/ability data collaborator, implemented by the workbench service.
 *
 * The contract is deliberately narrow:
 *
 * - `prepare` builds the bounded preparation and its live candidates. It may open its own
 *   transaction (the service calls it outside any transaction).
 * - `revalidate` re-reads account, source, candidates, effective tags, own AC state, weakness and
 *   ability and proves they still match the stored preparation; it is called **inside** the
 *   service's reservation and settlement transactions, so it must be read-only and must never open
 *   a transaction of its own (the SQLite adapter rejects a nested one).
 * - `savePlan` persists one already-validated `source: 'model'` plan and returns its id and full
 *   content hash. It joins the caller's transaction for the same reason.
 */
export interface PlanningDataPort {
  prepare(request: PlanPreparationRequest, token: CancellationToken): Promise<PlanPreparationBundle>;
  revalidate(preparation: PlanAttemptPreparation, token: CancellationToken): Promise<PlanRevalidationResult>;
  savePlan(
    plan: TrainingPlan,
    attemptId: string,
    token: CancellationToken,
  ): Promise<{ readonly planId: string; readonly planHash: string }>;
}

// ---------------------------------------------------------------------------------------
// Field checks
// ---------------------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function requireObject(label: string, value: unknown): JsonObject {
  invariant(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid_input',
    `${label} must be a JSON object`,
    { label, valueType: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value },
  );
  return value as JsonObject;
}

/** Strict shape check: an undeclared key and a missing declared key are both rejected. */
function requireExactKeys(label: string, value: JsonObject, keys: readonly string[]): void {
  const unknownKeys = Object.keys(value).filter((key) => !keys.includes(key));
  invariant(unknownKeys.length === 0, 'invalid_input', `${label} has unknown keys: ${unknownKeys.join(', ')}`, {
    label,
    unknownKeys,
  });
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  invariant(missing.length === 0, 'invalid_input', `${label} is missing keys: ${missing.join(', ')}`, {
    label,
    missing,
  });
}

function requireText(label: string, value: unknown): string {
  invariant(
    typeof value === 'string' && value.trim().length > 0,
    'invalid_input',
    `${label} must be a non-empty string`,
    { label, valueType: typeof value },
  );
  return value;
}

function requireNullableText(label: string, value: unknown): string | null {
  return value === null ? null : requireText(label, value);
}

function requireTimestamp(label: string, value: unknown): string {
  return assertIsoTimestamp(label, requireText(label, value));
}

function requireHash(label: string, value: unknown): string {
  invariant(typeof value === 'string' && SHA256.test(value), 'invalid_input', `${label} must be a sha256 digest`, {
    label,
  });
  return value;
}

function requireNullableRevision(label: string, value: unknown): number | null {
  if (value === null) {
    return null;
  }
  invariant(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1,
    'invalid_input',
    `${label} must be a positive integer or null`,
    { label, value },
  );
  return value;
}

/** One usage counter: a non-negative **safe** integer (a count beyond it is not exact). */
function requireCount(label: string, value: unknown): number {
  invariant(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    'invalid_input',
    `${label} must be a safe integer >= 0`,
    { label, value },
  );
  return value;
}

function requireBoundedInt(label: string, value: unknown, min: number, max: number): number {
  invariant(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max,
    'invalid_input',
    `${label} must be an integer within ${min}..${max}`,
    { label, value, min, max },
  );
  return value;
}

function requireFiniteNumber(label: string, value: unknown): number {
  invariant(typeof value === 'number' && Number.isFinite(value), 'invalid_input', `${label} must be a finite number`, {
    label,
    value,
  });
  return value;
}

function requireStringList(label: string, value: unknown, bound: number): readonly string[] {
  invariant(Array.isArray(value), 'invalid_input', `${label} must be an array`, { label });
  invariant(value.length <= bound, 'invalid_input', `${label} holds at most ${bound} entries`, {
    label,
    length: value.length,
    bound,
  });
  return value.map((entry) => requireText(`${label} entry`, entry));
}

/**
 * Validate one persisted explicit candidate selection.
 *
 * `null` is the automatic pool. A list is bound to `0..MAX_PLANNING_CANDIDATES` entries, every
 * entry must be a **canonical** problem key and no key may repeat: a stored non-canonical or
 * duplicated selection would describe a different pool than the one the model actually saw, so it
 * is refused here instead of being silently normalized.
 */
function requireRequestedCandidateKeys(value: unknown): readonly string[] | null {
  if (value === null) {
    return null;
  }
  invariant(
    Array.isArray(value),
    'invalid_input',
    'planning preparation requestedCandidateKeys must be an array or null',
    {},
  );
  invariant(
    value.length <= MAX_PLANNING_CANDIDATES,
    'invalid_input',
    `planning preparation selects at most ${MAX_PLANNING_CANDIDATES} candidate problems`,
    { length: value.length, bound: MAX_PLANNING_CANDIDATES },
  );
  const seen = new Set<string>();
  return value.map((entry) => {
    const key = requireText('planning preparation requestedCandidateKeys entry', entry);
    let canonical: string;
    try {
      canonical = canonicalProblemKeyOf(parseProblemKey(key));
    } catch (error) {
      throw new DomainError('invalid_input', `selected candidate key ${key} is not a canonical problem key`, {
        reason: 'malformed_candidate_key',
        problemKey: key,
        cause: String(error),
      });
    }
    invariant(canonical === key, 'invalid_input', `selected candidate key ${key} is not a canonical problem key`, {
      reason: 'malformed_candidate_key',
      problemKey: key,
      canonicalKey: canonical,
    });
    invariant(!seen.has(key), 'invalid_input', `planning preparation selects candidate ${key} twice`, {
      reason: 'duplicate_candidate_key',
      problemKey: key,
    });
    seen.add(key);
    return key;
  });
}

function requireUsage(value: unknown): ModelUsage {
  const usage = requireObject('planning attempt usage', value);
  requireExactKeys('planning attempt usage', usage, USAGE_KEYS);
  return {
    calls: requireCount('usage.calls', usage['calls']),
    promptTokens: requireCount('usage.promptTokens', usage['promptTokens']),
    completionTokens: requireCount('usage.completionTokens', usage['completionTokens']),
    totalTokens: requireCount('usage.totalTokens', usage['totalTokens']),
  };
}

function requireError(value: unknown): ModelGatewayError {
  const error = requireObject('planning attempt error', value);
  requireExactKeys('planning attempt error', error, ERROR_KEYS);
  const code = error['code'];
  invariant(
    MODEL_ERROR_CODES.includes(code as ModelErrorCode),
    'invalid_input',
    `unknown planning attempt error code ${String(code)}`,
    { code },
  );
  invariant(
    typeof error['retryable'] === 'boolean',
    'invalid_input',
    'planning attempt error retryable must be boolean',
    { retryable: error['retryable'] },
  );
  return {
    code: code as ModelErrorCode,
    message: requireText('planning attempt error message', error['message']),
    retryable: error['retryable'],
  };
}

function requirePreparation(value: unknown): PlanAttemptPreparation {
  const record = requireObject('planning preparation', value);
  requireExactKeys('planning preparation', record, PREPARATION_KEYS);
  const preparedAt = requireTimestamp('planning preparation preparedAt', record['preparedAt']);
  const accountId = requireText('planning preparation accountId', record['accountId']);
  const sourceInstanceId = requireText('planning preparation sourceInstanceId', record['sourceInstanceId']);

  const settings = requireObject('planning preparation settings', record['settings']);
  requireExactKeys('planning preparation settings', settings, SETTINGS_KEYS);
  const settingsValue: PlanAttemptSettings = {
    horizonDays: requireBoundedInt('planning preparation settings.horizonDays', settings['horizonDays'], 1, 365),
    minutesPerDay: requireBoundedInt('planning preparation settings.minutesPerDay', settings['minutesPerDay'], 1, 1440),
    maxTasksPerDay: requireBoundedInt('planning preparation settings.maxTasksPerDay', settings['maxTasksPerDay'], 1, 10),
    estimatedMinutes: requireBoundedInt(
      'planning preparation settings.estimatedMinutes',
      settings['estimatedMinutes'],
      1,
      1440,
    ),
  };

  invariant(
    Array.isArray(record['candidates']),
    'invalid_input',
    'planning preparation candidates must be an array',
    {},
  );
  const rawCandidates = record['candidates'] as readonly unknown[];
  invariant(
    rawCandidates.length <= MAX_PLANNING_CANDIDATES,
    'invalid_input',
    `planning preparation holds at most ${MAX_PLANNING_CANDIDATES} candidates`,
    { length: rawCandidates.length, bound: MAX_PLANNING_CANDIDATES },
  );
  const candidates = rawCandidates.map((entry) => requireCandidate(entry));
  const seenCandidates = new Set<string>();
  for (const candidate of candidates) {
    invariant(
      !seenCandidates.has(candidate.candidateId),
      'invalid_input',
      `planning preparation repeats candidate ${candidate.candidateId}`,
      { candidateId: candidate.candidateId },
    );
    seenCandidates.add(candidate.candidateId);
  }

  const exclusions = requireObject('planning preparation exclusions', record['exclusions']);
  requireExactKeys('planning preparation exclusions', exclusions, EXCLUSION_KEYS);
  const exclusionsValue: PlanAttemptExclusions = {
    nativeSolvedExcluded: requireCount('exclusions.nativeSolvedExcluded', exclusions['nativeSolvedExcluded']),
    duplicateExcluded: requireCount('exclusions.duplicateExcluded', exclusions['duplicateExcluded']),
    foreignExcluded: requireCount('exclusions.foreignExcluded', exclusions['foreignExcluded']),
    candidateLimit: requireBoundedInt(
      'exclusions.candidateLimit',
      exclusions['candidateLimit'],
      1,
      MAX_PLANNING_CANDIDATES,
    ),
    considered: requireCount('exclusions.considered', exclusions['considered']),
  };

  const weakness = requireObject('planning preparation weakness', record['weakness']);
  requireExactKeys('planning preparation weakness', weakness, WEAKNESS_KEYS);
  invariant(Array.isArray(weakness['ranking']), 'invalid_input', 'weakness.ranking must be an array', {});
  const ranking = (weakness['ranking'] as readonly unknown[]).map((entry) => {
    const row = requireObject('weakness ranking entry', entry);
    requireExactKeys('weakness ranking entry', row, WEAK_TAG_KEYS);
    return {
      taxonomyId: requireText('weakness ranking taxonomyId', row['taxonomyId']),
      solveRate: requireFiniteNumber('weakness ranking solveRate', row['solveRate']),
    };
  });
  const weaknessValue: PlanAttemptWeakness = {
    attemptedDistinctTotal: requireCount('weakness.attemptedDistinctTotal', weakness['attemptedDistinctTotal']),
    sufficientTagIds: requireStringList('weakness.sufficientTagIds', weakness['sufficientTagIds'], 1000),
    ranking,
  };

  const ability = requireAbilityAggregate(record['ability']);
  const requestedCandidateKeys = requireRequestedCandidateKeys(record['requestedCandidateKeys']);
  const evidenceHash = requireHash('planning preparation evidenceHash', record['evidenceHash']);
  const expected = planPreparationEvidenceHash({
    accountId,
    sourceInstanceId,
    requestedCandidateKeys,
    settings: settingsValue,
    candidates,
    weakness: weaknessValue,
    ability,
  });
  invariant(
    expected === evidenceHash,
    'invalid_input',
    'planning preparation evidenceHash does not match its own content',
    { declared: evidenceHash, derived: expected },
  );

  return {
    preparedAt,
    accountId,
    sourceInstanceId,
    requestedCandidateKeys,
    settings: settingsValue,
    candidates,
    exclusions: exclusionsValue,
    weakness: weaknessValue,
    ability,
    evidenceHash,
  };
}

function requireCandidate(value: unknown): PlanAttemptCandidate {
  const record = requireObject('planning candidate', value);
  requireExactKeys('planning candidate', record, CANDIDATE_KEYS);
  const ratings = requireRatings(record['ratings']);
  const origin = record['origin'];
  invariant(
    CANDIDATE_ORIGINS.includes(origin as TrainingCandidateOrigin),
    'invalid_input',
    `unknown planning candidate origin ${String(origin)}`,
    { origin },
  );
  return {
    candidateId: requireText('planning candidate candidateId', record['candidateId']),
    problemKey: requireText('planning candidate problemKey', record['problemKey']),
    externalKey: requireText('planning candidate externalKey', record['externalKey']),
    title: requireText('planning candidate title', record['title']),
    url: requireText('planning candidate url', record['url']),
    estimatedMinutes: requireBoundedInt('planning candidate estimatedMinutes', record['estimatedMinutes'], 1, 1440),
    effectiveTaxonomyIds: dedupeIds(
      requireStringList('planning candidate effectiveTaxonomyIds', record['effectiveTaxonomyIds'], 200),
    ),
    provisionalRawTags: dedupeIds(
      requireStringList('planning candidate provisionalRawTags', record['provisionalRawTags'], 200),
    ),
    ratings,
    origin: origin as TrainingCandidateOrigin,
  };
}

function requireRatings(value: unknown): readonly PlanAttemptRating[] {
  invariant(Array.isArray(value), 'invalid_input', 'planning candidate ratings must be an array', {});
  invariant(value.length <= 50, 'invalid_input', 'planning candidate reports at most 50 ratings', {
    length: value.length,
  });
  return value.map((entry) => {
    const record = requireObject('planning candidate rating', entry);
    requireExactKeys('planning candidate rating', record, RATING_KEYS);
    const rawValue = record['value'];
    invariant(
      (typeof rawValue === 'number' && Number.isFinite(rawValue)) ||
        (typeof rawValue === 'string' && rawValue.trim().length > 0),
      'invalid_input',
      'planning candidate rating value must be a finite number or a non-empty string',
      { value: rawValue },
    );
    let scale: { readonly min: number; readonly max: number } | null = null;
    if (record['scale'] !== null) {
      const rawScale = requireObject('planning candidate rating scale', record['scale']);
      requireExactKeys('planning candidate rating scale', rawScale, SCALE_KEYS);
      scale = {
        min: requireFiniteNumber('planning candidate rating scale.min', rawScale['min']),
        max: requireFiniteNumber('planning candidate rating scale.max', rawScale['max']),
      };
    }
    return {
      dimension: requireText('planning candidate rating dimension', record['dimension']),
      value: rawValue as number | string,
      scale,
      raw: requireText('planning candidate rating raw', record['raw']),
    };
  });
}

/** Deduplicate an id/label list while preserving its order (identity is the exact string). */
function dedupeIds(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/**
 * Validate the identifier-free 11a aggregate carried by one preparation.
 *
 * The aggregate is re-validated structurally rather than trusted: it is persisted JSON, and a
 * malformed body must be `invalid_input` here instead of reaching a model prompt. It deliberately
 * has no account id, handle, source instance id, problem key or note field to validate — the shape
 * is closed, so a later caller cannot forward raw rows through it.
 */
function requireAbilityAggregate(value: unknown): AbilityPlanningAggregate {
  const record = requireObject('planning preparation ability', value);
  requireExactKeys('planning preparation ability', record,
    [...ABILITY_KEYS, ...(Object.hasOwn(record, 'history') ? ['history'] : []), ...(Object.hasOwn(record, 'trainingReference') ? ['trainingReference'] : [])]);
  const platform = record['platform'];
  invariant(
    SOURCE_PLATFORMS.includes(platform as (typeof SOURCE_PLATFORMS)[number]),
    'invalid_input',
    `unknown planning ability platform ${String(platform)}`,
    { platform },
  );
  const estimateStatus = record['estimateStatus'];
  invariant(
    ESTIMATE_STATUSES.includes(estimateStatus as (typeof ESTIMATE_STATUSES)[number]),
    'invalid_input',
    `unknown planning ability estimateStatus ${String(estimateStatus)}`,
    { estimateStatus },
  );
  const estimateBasis =
    record['estimateBasis'] === null
      ? null
      : requireEnum('planning ability estimateBasis', record['estimateBasis'], ESTIMATE_BASES);
  const confidence =
    record['confidence'] === null ? null : requireEnum('planning ability confidence', record['confidence'], CONFIDENCES);

  const counts = requireExactObject('planning ability counts', record['counts'], ABILITY_COUNT_KEYS);
  const last90Days = requireExactObject('planning ability last90Days', record['last90Days'], ABILITY_WINDOW_KEYS);
  const excluded = requireExactObject(
    'planning ability excludedFromEstimate',
    record['excludedFromEstimate'],
    ABILITY_EXCLUDED_KEYS,
  );
  const coverage = requireExactObject('planning ability coverage', record['coverage'], ABILITY_COVERAGE_KEYS);
  invariant(Array.isArray(record['nativeDifficulty']), 'invalid_input', 'ability nativeDifficulty must be an array', {});
  const nativeDifficulty = (record['nativeDifficulty'] as readonly unknown[]).map((entry) => {
    const row = requireExactObject('planning ability nativeDifficulty entry', entry, ABILITY_NATIVE_KEYS);
    return {
      dimension: requireText('ability nativeDifficulty dimension', row['dimension']),
      count: requireCount('ability nativeDifficulty count', row['count']),
      missing: requireCount('ability nativeDifficulty missing', row['missing']),
      median: row['median'] === null ? null : requireFiniteNumber('ability nativeDifficulty median', row['median']),
    };
  });

  return {
    ...(Object.hasOwn(record, 'history') ? { history: requireAbilityHistory(record['history']) } : {}),
    ...(Object.hasOwn(record, 'trainingReference') ? { trainingReference: validateTrainingReference(record['trainingReference']) } : {}),
    version: requireText('planning ability version', record['version']),
    platform: platform as AbilityPlanningAggregate['platform'],
    estimateStatus: estimateStatus as AbilityPlanningAggregate['estimateStatus'],
    estimateBasis,
    heuristicVersion: requireText('planning ability heuristicVersion', record['heuristicVersion']),
    confidence,
    sampleSize: requireCount('planning ability sampleSize', record['sampleSize']),
    minimumSampleSize: requireCount('planning ability minimumSampleSize', record['minimumSampleSize']),
    baselineTrainingLevel: requireNullableNumber('planning ability baselineTrainingLevel', record['baselineTrainingLevel']),
    quartileBand: requireNullableRange('planning ability quartileBand', record['quartileBand']),
    baselinePool: requireNullableRange('planning ability baselinePool', record['baselinePool']),
    stretchPool: requireNullableRange('planning ability stretchPool', record['stretchPool']),
    counts: {
      attemptedDistinct: requireCount('ability counts.attemptedDistinct', counts['attemptedDistinct']),
      solvedDistinct: requireCount('ability counts.solvedDistinct', counts['solvedDistinct']),
      unsolvedDistinct: requireCount('ability counts.unsolvedDistinct', counts['unsolvedDistinct']),
    },
    last90Days: {
      attemptedDistinct: requireCount('ability last90Days.attemptedDistinct', last90Days['attemptedDistinct']),
      newSolvedDistinct: requireCount('ability last90Days.newSolvedDistinct', last90Days['newSolvedDistinct']),
      repeatedAcDistinct: requireCount('ability last90Days.repeatedAcDistinct', last90Days['repeatedAcDistinct']),
    },
    completionModesAllTime: requireModeCounts('planning ability completionModesAllTime', record['completionModesAllTime']),
    completionModesLast90Days: requireModeCounts(
      'planning ability completionModesLast90Days',
      record['completionModesLast90Days'],
    ),
    excludedFromEstimate: {
      assistedDistinct: requireCount('ability excluded.assistedDistinct', excluded['assistedDistinct']),
      solutionUsedDistinct: requireCount('ability excluded.solutionUsedDistinct', excluded['solutionUsedDistinct']),
      total: requireCount('ability excluded.total', excluded['total']),
    },
    nativeDifficulty,
    coverage: {
      metadataMissing: requireCount('ability coverage.metadataMissing', coverage['metadataMissing']),
      solvedWithoutNativeValue: requireCount(
        'ability coverage.solvedWithoutNativeValue',
        coverage['solvedWithoutNativeValue'],
      ),
      futureSubmissionsExcluded: requireCount(
        'ability coverage.futureSubmissionsExcluded',
        coverage['futureSubmissionsExcluded'],
      ),
    },
    reasonCodes: requireStringList('planning ability reasonCodes', record['reasonCodes'], 64) as AbilityPlanningAggregate['reasonCodes'],
    caveats: requireStringList('planning ability caveats', record['caveats'], 64),
  };
}


/** Closed additive history shape. Legacy preparations omit it and round-trip without rewriting. */
function requireAbilityHistory(value: unknown): NonNullable<AbilityPlanningAggregate['history']> {
  const root = requireExactObject('ability history', value, ['recentWindowDays', 'periods']);
  const recentWindowDays = requireCount('history window days', root['recentWindowDays']);
  invariant(recentWindowDays > 0, 'invalid_input', 'history window must be positive', {});
  invariant(Array.isArray(root['periods']) && root['periods'].length === 3, 'invalid_input', 'history needs three periods', {});
  const names = ['all_time', 'recent', 'earlier'] as const;
  const periods = (root['periods'] as unknown[]).map((value, i) => {
    const row = requireExactObject('ability history period', value, [
      'period', 'solvedDistinct', 'excludedDistinct', 'missingOrInvalidRatingDistinct', 'eligibleDistinct',
      'independentEligibleDistinct', 'completionModes', 'minimumSampleSize', 'estimateStatus',
      'baselineTrainingLevel', 'quartileBand', 'independentlyConfirmed', 'confidence', 'includesEarlierSolves', 'nativeDifficulty',
    ]);
    const period = requireEnum('ability history period', row['period'], names);
    invariant(period === names[i], 'invalid_input', 'history period order or identity mismatch', {});
    const solvedDistinct = requireCount('history solved', row['solvedDistinct']);
    const excludedDistinct = requireCount('history excluded', row['excludedDistinct']);
    const missingOrInvalidRatingDistinct = requireCount('history missing rating', row['missingOrInvalidRatingDistinct']);
    const eligibleDistinct = requireCount('history eligible', row['eligibleDistinct']);
    const independentEligibleDistinct = requireCount('history independent eligible', row['independentEligibleDistinct']);
    const minimumSampleSize = requireCount('history minimum sample', row['minimumSampleSize']);
    const completionModes = requireModeCounts('history completion modes', row['completionModes']);
    invariant(solvedDistinct === excludedDistinct + missingOrInvalidRatingDistinct + eligibleDistinct &&
      independentEligibleDistinct <= eligibleDistinct && minimumSampleSize > 0 &&
      completionModes.total === solvedDistinct &&
      completionModes.independent + completionModes.assisted + completionModes.solutionUsed + completionModes.unknown === solvedDistinct &&
      excludedDistinct === completionModes.assisted + completionModes.solutionUsed,
      'invalid_input', 'history evidence counts do not reconcile', {});
    invariant(typeof row['independentlyConfirmed'] === 'boolean' && typeof row['includesEarlierSolves'] === 'boolean',
      'invalid_input', 'history evidence flags must be boolean', {});
    const independentlyConfirmed = row['independentlyConfirmed'] as boolean;
    const includesEarlierSolves = row['includesEarlierSolves'] as boolean;
    invariant(independentlyConfirmed === (eligibleDistinct > 0 && independentEligibleDistinct === eligibleDistinct) &&
      (period !== 'recent' || !includesEarlierSolves), 'invalid_input', 'history evidence flags disagree with counts', {});
    const estimateStatus = requireEnum('history status', row['estimateStatus'], ESTIMATE_STATUSES);
    const confidence = row['confidence'] === null ? null : requireEnum('history confidence', row['confidence'], CONFIDENCES);
    const baselineTrainingLevel = requireNullableNumber('history baseline', row['baselineTrainingLevel']);
    const quartileBand = requireNullableRange('history quartiles', row['quartileBand']);
    invariant(estimateStatus === 'estimated'
      ? eligibleDistinct >= minimumSampleSize && baselineTrainingLevel !== null && quartileBand !== null && confidence !== null
      : baselineTrainingLevel === null && quartileBand === null && confidence === null,
      'invalid_input', 'history estimate disagrees with sample gate', {});
    invariant(Array.isArray(row['nativeDifficulty']), 'invalid_input', 'history native difficulty must be an array', {});
    const nativeDifficulty = (row['nativeDifficulty'] as unknown[]).map(value => {
      const native = requireExactObject('history native dimension', value, ['dimension', 'count', 'missing', 'median', 'p25', 'p75']);
      const count = requireCount('history native count', native['count']), missing = requireCount('history native missing', native['missing']);
      invariant(count + missing === solvedDistinct, 'invalid_input', 'native counts must cover solved history', {});
      return { dimension: requireText('history native dimension', native['dimension']), count, missing,
        median: requireNullableNumber('history native median', native['median']),
        p25: requireNullableNumber('history native p25', native['p25']), p75: requireNullableNumber('history native p75', native['p75']) };
    });
    return { period, solvedDistinct, excludedDistinct, missingOrInvalidRatingDistinct, eligibleDistinct,
      independentEligibleDistinct, completionModes, minimumSampleSize, estimateStatus, baselineTrainingLevel,
      quartileBand, independentlyConfirmed, confidence, includesEarlierSolves, nativeDifficulty };
  });
  const [all, recent, earlier] = periods;
  invariant(all!.solvedDistinct === recent!.solvedDistinct + earlier!.solvedDistinct &&
    all!.eligibleDistinct === recent!.eligibleDistinct + earlier!.eligibleDistinct,
    'invalid_input', 'history periods must partition all-time evidence', {});
  return { recentWindowDays, periods };
}

function requireEnum<T extends string>(label: string, value: unknown, allowed: readonly T[]): T {
  invariant(allowed.includes(value as T), 'invalid_input', `unknown ${label} ${String(value)}`, { label, value });
  return value as T;
}

function requireExactObject(label: string, value: unknown, keys: readonly string[]): JsonObject {
  const record = requireObject(label, value);
  requireExactKeys(label, record, keys);
  return record;
}

function requireNullableNumber(label: string, value: unknown): number | null {
  return value === null ? null : requireFiniteNumber(label, value);
}

function requireNullableRange(
  label: string,
  value: unknown,
): { readonly min: number; readonly max: number } | null {
  if (value === null) {
    return null;
  }
  const record = requireExactObject(label, value, ABILITY_RANGE_KEYS);
  return {
    min: requireFiniteNumber(`${label}.min`, record['min']),
    max: requireFiniteNumber(`${label}.max`, record['max']),
  };
}

function requireModeCounts(
  label: string,
  value: unknown,
): AbilityPlanningAggregate['completionModesAllTime'] {
  const record = requireExactObject(label, value, ABILITY_MODE_KEYS);
  return {
    independent: requireCount(`${label}.independent`, record['independent']),
    assisted: requireCount(`${label}.assisted`, record['assisted']),
    solutionUsed: requireCount(`${label}.solutionUsed`, record['solutionUsed']),
    unknown: requireCount(`${label}.unknown`, record['unknown']),
    total: requireCount(`${label}.total`, record['total']),
  };
}

/** One stored plan as a durable attempt names it (identity + hash, never the plan body). */
export type PlanAttemptPlanRef = Pick<TrainingPlan, 'planId'> & { readonly contentHash: string };

/**
 * Guard used by the service before it records a stored plan on a settled attempt: the plan it
 * names must be a `model`-sourced plan of the same account.
 */
export function assertStoredModelPlan(plan: TrainingPlan, accountId: string, attemptId: string): void {
  invariant(
    plan.source === 'model',
    'invalid_input',
    `planning attempt ${attemptId} can only settle with a model-sourced plan`,
    { attemptId, planId: plan.planId, source: plan.source },
  );
  invariant(
    plan.accountId === accountId,
    'invalid_input',
    `planning attempt ${attemptId} cannot settle with a plan of account ${String(plan.accountId)}`,
    { attemptId, accountId, planAccountId: plan.accountId },
  );
}

/** Typed refusal of a caller contract violation, raised instead of a silently different result. */
export function planAttemptConflict(message: string, details: Record<string, unknown>): DomainError {
  return new DomainError('invalid_input', message, { reason: 'plan_attempt_conflict', ...details });
}
