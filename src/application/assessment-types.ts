/**
 * Durable ability-assessment attempts and their persistence port (Sprint 18d1).
 *
 * One attempt is the audit row of one independently requested ability assessment. It is created
 * `prepared` — the **free** durable preparation holding the whole {@link AssessmentCapture} — and
 * only a later explicit run turns it into a `reserved` row, which is the single in-flight paid call.
 * A reservation moves only forward, and a terminal row is immutable:
 *
 * - `prepared` — free preparation, no provider call happened and none is implied. Not charged.
 * - `reserved` — one paid call is in flight. `requestedAt`/`expiresAt` were rewritten to the real
 *   reservation instant and its lease (the only transition allowed to do that). Charged.
 * - `settled` — terminal, known usage, exactly one of a {@link AssessmentReportRecord} or a typed
 *   error. A cancellation observed after dispatch settles here too (a typed `cancelled` error), so
 *   its cost is never lost.
 * - `cancelled` — terminal, reachable **only** from `prepared`, i.e. before any dispatch: the free
 *   preparation was abandoned and the paid call never happened. Such a row is known-zero
 *   (`usage.calls === 0`) and is deliberately outside the charged set. A cancellation that arrives
 *   after the reservation was written settles through the dispatch path instead, so a paid call can
 *   never be released for free.
 * - `uncertain` — terminal, usage unknown (the provider never reported it, or the reservation
 *   expired before it settled). It keeps its charged slot and is never retried automatically.
 *
 * CAS and immutability, checked by the pure validators below *and* re-checked by the store against
 * the stored row: `revision` starts at 1 and every save must present exactly `stored + 1`, so a
 * stale writer that read an older row is refused instead of overwriting a newer state; the identity
 * fields (id, account, source instance, provider/model/prompt identity, settings revision, input
 * hash, whole preparation) never change; a known usage, error, report or host correlation is never
 * cleared or replaced; and a terminal row cannot be rewritten at all (an identical re-save is the
 * caller's idempotent no-op before this check).
 *
 * Everything here is plain data plus pure validation: ids and timestamps are supplied by the caller,
 * so nothing reads a clock or an environment variable and a replay produces the same records.
 */
import {
  ASSESSMENT_AI_DISCLOSURE,
  DomainError,
  assertIsoTimestamp,
  canonicalJson,
  contentHashOf,
  invariant,
  validateAssessmentReportRecord,
  assessmentAnchorOf,
  type AssessmentAnchorFacts,
  type AssessmentReportContext,
  type AssessmentReportRecord,
  type ModelUsage,
} from '../domain/index.js';
import type { ModelErrorCode, ModelGatewayError, Page } from './ports.js';
import {
  validateAssessmentCapture,
  type AssessmentCapture,
} from './assessment-capture.js';

/** Lifecycle of one assessment attempt; see the module comment for what each status claims. */
export type AssessmentAttemptStatus = 'prepared' | 'reserved' | 'settled' | 'uncertain' | 'cancelled';

export const ASSESSMENT_ATTEMPT_STATUSES: readonly AssessmentAttemptStatus[] = [
  'prepared',
  'reserved',
  'settled',
  'uncertain',
  'cancelled',
];

/**
 * Statuses that stand for a call that was (or may have been) dispatched.
 *
 * These are exactly the rows a rolling-24h assessment quota counts: a `prepared` row is a free
 * preparation and a `cancelled` row reached from `prepared` never dispatched, so neither may
 * consume quota, while an expired reservation (`uncertain`) keeps its slot.
 */
export const ASSESSMENT_ATTEMPT_CHARGED_STATUSES: readonly AssessmentAttemptStatus[] = [
  'reserved',
  'settled',
  'uncertain',
];

/** Maximum accepted `requestId` length; the UI owns the uuid, the service only bounds it. */
export const MAX_ASSESSMENT_REQUEST_ID_CHARS = 200;

/** Lease safety margin added to the configured model timeout of one assessment call. */
export const ASSESSMENT_LEASE_MARGIN_MS = 30_000;

/** Rolling window of the plugin-wide assessment quota (equal to the coaching/planning window). */
export const ASSESSMENT_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Fixed disclosure the UI must render next to a stored assessment report.
 *
 * It restates the two facts a reader must never lose: the numbers are a model inference, and the
 * official rating it anchors on is read-only.
 */
export const ASSESSMENT_DISCLOSURE = ASSESSMENT_AI_DISCLOSURE;

/** The immutable preparation a paid assessment call is bound to. */
export interface AssessmentAttemptPreparation {
  readonly preparedAt: string;
  /** The whole free capture: internal snapshot, public prompt payload and both clock-free hashes. */
  readonly capture: AssessmentCapture;
}

/** Durable audit row for one ability assessment. */
export interface AssessmentAttempt {
  /** Caller-supplied bounded request id; the idempotency key of prepare and of the paid run. */
  readonly id: string;
  readonly accountId: string;
  readonly sourceInstanceId: string;
  readonly status: AssessmentAttemptStatus;
  /**
   * Reservation instant of a charged row; the preparation instant while the row is `prepared`.
   *
   * A `prepared` row is not a paid call, so the value is only replaced by the real reservation
   * instant when the reservation is written: the rolling quota must count a call from the moment it
   * was actually reserved, never from an old preparation.
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
  /** Monotonic CAS token: `1` on insert, exactly `stored + 1` on every save. */
  readonly revision: number;
  readonly preparation: AssessmentAttemptPreparation;
  readonly hostSessionId: string | null;
  readonly hostCallId: string | null;
  readonly usage: ModelUsage | null;
  /** The validated, labelled report of a successful attempt; `null` for every other outcome. */
  readonly report: AssessmentReportRecord | null;
  readonly error: ModelGatewayError | null;
}

/**
 * Immutable identity + input of one attempt: changing one is an immutable violation.
 *
 * `requestedAt`/`expiresAt` are deliberately **not** here: the single `prepared → reserved`
 * transition rewrites them to the real reservation instant and lease, and they are immutable after
 * that (enforced separately). `revision` is not identity either — it is the CAS token that must
 * advance by exactly one on every save.
 */
export const ASSESSMENT_ATTEMPT_IDENTITY_FIELDS: readonly (keyof AssessmentAttempt)[] = [
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
  'revision',
  'preparation',
  'hostSessionId',
  'hostCallId',
  'usage',
  'report',
  'error',
] as const;

const PREPARATION_KEYS = ['preparedAt', 'capture'] as const;
const USAGE_KEYS = ['calls', 'promptTokens', 'completionTokens', 'totalTokens'] as const;
const ERROR_KEYS = ['code', 'message', 'retryable'] as const;
const SHA256 = /^[0-9a-f]{64}$/u;

const MODEL_ERROR_CODES: readonly ModelErrorCode[] = [
  'cancelled',
  'timeout',
  'rate_limited',
  'quota_exhausted',
  'invalid_output',
  'provider_error',
  'unsupported',
];

/**
 * Strictly validate one assessment attempt and return a detached, normalized copy.
 *
 * Every declared field must be present (an explicit `null` is data, a missing or `undefined` member
 * is not), undeclared keys are rejected, `expiresAt` must be strictly after `requestedAt`, and
 * `finishedAt` must not precede `requestedAt`. The preparation's capture is re-validated (including
 * both hashes), the capture identity must match the attempt's account/source, a stored report is
 * re-parsed against its own capture's citation set and anchor, and the result shape of the status is
 * enforced as described on {@link AssessmentAttempt}.
 */
export function validateAssessmentAttempt(value: unknown): AssessmentAttempt {
  const record = requireObject('assessment attempt', value);
  requireExactKeys('assessment attempt', record, ATTEMPT_KEYS);

  const id = requireText('assessment attempt id', record['id'], MAX_ASSESSMENT_REQUEST_ID_CHARS);
  const accountId = requireText('assessment attempt accountId', record['accountId'], 512);
  const sourceInstanceId = requireText('assessment attempt sourceInstanceId', record['sourceInstanceId'], 512);
  const status = record['status'];
  invariant(
    ASSESSMENT_ATTEMPT_STATUSES.includes(status as AssessmentAttemptStatus),
    'invalid_input',
    `unknown assessment status ${String(status)}`,
    { status },
  );
  const requestedAt = requireTimestamp('assessment attempt requestedAt', record['requestedAt']);
  const expiresAt = requireTimestamp('assessment attempt expiresAt', record['expiresAt']);
  invariant(
    Date.parse(expiresAt) > Date.parse(requestedAt),
    'invalid_input',
    `assessment attempt ${id} expiresAt must be after requestedAt`,
    { id, requestedAt, expiresAt },
  );
  const finishedAt =
    record['finishedAt'] === null ? null : requireTimestamp('assessment attempt finishedAt', record['finishedAt']);
  invariant(
    finishedAt === null || Date.parse(finishedAt) >= Date.parse(requestedAt),
    'invalid_input',
    `assessment attempt ${id} finishedAt must not precede requestedAt`,
    { id, requestedAt, finishedAt },
  );
  const provider = requireText('assessment attempt provider', record['provider'], 200);
  const model = requireText('assessment attempt model', record['model'], 200);
  const promptVersion = requireText('assessment attempt promptVersion', record['promptVersion'], 200);
  const settingsRevision = requireNullableRevision('assessment attempt settingsRevision', record['settingsRevision']);
  const inputHash = requireHash('assessment attempt inputHash', record['inputHash']);
  const revision = requireRevision(record['revision']);
  const preparation = requirePreparation(record['preparation']);
  invariant(
    preparation.capture.accountId === accountId,
    'invalid_input',
    `assessment attempt ${id} preparation belongs to another account`,
    { id, reason: 'preparation_account_mismatch' },
  );
  invariant(
    preparation.capture.sourceInstanceId === sourceInstanceId,
    'invalid_input',
    `assessment attempt ${id} preparation belongs to ${preparation.capture.sourceInstanceId}, not to ${sourceInstanceId}`,
    { id, sourceInstanceId, preparationSource: preparation.capture.sourceInstanceId },
  );
  const hostSessionId = requireNullableText('assessment attempt hostSessionId', record['hostSessionId'], 200);
  const hostCallId = requireNullableText('assessment attempt hostCallId', record['hostCallId'], 200);
  const usage = record['usage'] === null ? null : requireUsage(record['usage']);
  const context = reportContextOf(preparation.capture);
  const report =
    record['report'] === null ? null : validateAssessmentReportRecord(record['report'], context);
  if (report !== null) {
    invariant(
      report.evidenceHash === preparation.capture.evidenceHash,
      'invalid_input',
      `assessment attempt ${id} report was not validated against this preparation's capture`,
      { id, reason: 'report_capture_mismatch' },
    );
  }
  const error = record['error'] === null ? null : requireError(record['error']);

  const attempt: AssessmentAttempt = {
    id,
    accountId,
    sourceInstanceId,
    status: status as AssessmentAttemptStatus,
    requestedAt,
    expiresAt,
    finishedAt,
    provider,
    model,
    promptVersion,
    settingsRevision,
    inputHash,
    revision,
    preparation,
    hostSessionId,
    hostCallId,
    usage,
    report,
    error,
  };
  validateAssessmentAttemptShape(attempt);
  return attempt;
}

/**
 * Validate one save of an existing attempt.
 *
 * Identity and the whole preparation are fixed; the CAS token must advance by exactly one; a known
 * host correlation, usage, report or error may neither be reassigned nor cleared; a terminal row is
 * immutable entirely (an identical re-save is the caller's idempotent no-op before this check); the
 * lifecycle only moves forward — `prepared → reserved | cancelled`, `reserved → settled | uncertain`
 * — and `requestedAt`/`expiresAt` may only be rewritten by that single `prepared → reserved`
 * transition, so a later save cannot extend its own lease.
 */
export function validateAssessmentAttemptTransition(previous: AssessmentAttempt, next: AssessmentAttempt): void {
  const stored = validateAssessmentAttempt(previous);
  const incoming = validateAssessmentAttempt(next);
  // Identity is compared by value, never by reference: the immutable preparation holds nested
  // objects, so a fresh structural copy must compare equal instead of being a conflict.
  const changed = ASSESSMENT_ATTEMPT_IDENTITY_FIELDS.filter(
    (field) => canonicalJson(stored[field]) !== canonicalJson(incoming[field]),
  );
  invariant(
    changed.length === 0,
    'immutable_violation',
    `assessment attempt ${stored.id} already exists with a different ${changed.join(', ')}`,
    { id: stored.id, conflicts: changed },
  );
  invariant(
    incoming.revision === stored.revision + 1,
    'invalid_transition',
    `assessment attempt ${stored.id} is at revision ${stored.revision}; a save must present revision ${stored.revision + 1}`,
    { id: stored.id, reason: 'stale_revision', stored: stored.revision, incoming: incoming.revision },
  );
  for (const field of ['hostSessionId', 'hostCallId'] as const) {
    const known = stored[field];
    invariant(
      known === null || incoming[field] === known,
      'immutable_violation',
      `assessment attempt ${stored.id} already records ${field} ${known}; a known host correlation cannot be reassigned or cleared`,
      { id: stored.id, field, previous: known, next: incoming[field], reason: 'host_correlation' },
    );
  }
  for (const field of ['usage', 'report', 'error'] as const) {
    invariant(
      stored[field] === null || canonicalJson(stored[field]) === canonicalJson(incoming[field]),
      'immutable_violation',
      `assessment attempt ${stored.id} already records ${field}; a known outcome can never be cleared or replaced`,
      { id: stored.id, field, reason: 'outcome_immutable' },
    );
  }
  invariant(
    !isTerminalAssessmentStatus(stored.status),
    'immutable_violation',
    `terminal assessment attempt ${stored.id} (${stored.status}) cannot be rewritten`,
    { id: stored.id, status: stored.status },
  );
  const allowed: readonly AssessmentAttemptStatus[] =
    stored.status === 'prepared' ? ['reserved', 'cancelled'] : ['settled', 'uncertain'];
  invariant(
    allowed.includes(incoming.status),
    'invalid_transition',
    `assessment attempt ${stored.id} cannot move from ${stored.status} to ${incoming.status}`,
    { id: stored.id, previousStatus: stored.status, status: incoming.status },
  );
  if (stored.status === 'reserved') {
    invariant(
      incoming.requestedAt === stored.requestedAt && incoming.expiresAt === stored.expiresAt,
      'immutable_violation',
      `assessment attempt ${stored.id} lease is fixed once reserved`,
      { id: stored.id, reason: 'lease', previous: stored.expiresAt, next: incoming.expiresAt },
    );
  }
}

/** `true` for a status no later save may leave: settled, uncertain or cancelled. */
export function isTerminalAssessmentStatus(status: AssessmentAttemptStatus): boolean {
  return status === 'settled' || status === 'uncertain' || status === 'cancelled';
}

/** Stable hash of the request identity of one attempt; the same request id with changed inputs conflicts. */
export function assessmentInputHash(input: {
  readonly accountId: string;
  readonly sourceInstanceId: string;
  readonly settingsRevision: number | null;
  /** The exact selected method ids of the capture, in order. */
  readonly methodIds: readonly string[];
  readonly evidenceHash: string;
  readonly sourceHash: string;
}): string {
  return contentHashOf({
    accountId: input.accountId,
    sourceInstanceId: input.sourceInstanceId,
    settingsRevision: input.settingsRevision,
    methodIds: [...input.methodIds],
    evidenceHash: input.evidenceHash,
    sourceHash: input.sourceHash,
  });
}

/** The closed citation set and anchor one stored report is validated against. */
export function reportContextOf(capture: AssessmentCapture): AssessmentReportContext {
  return {
    evidenceRefs: capture.prompt.evidence.map((entry) => entry.evidenceRef),
    anchor: assessmentAnchorOf({
      officialRating: capture.snapshot.officialRating,
      virtualPerformance: capture.snapshot.virtualPerformance,
    }),
  };
}

/** The anchor facts of one attempt's capture; used by a later service to label a stored report. */
export function attemptAnchorFacts(attempt: AssessmentAttempt): AssessmentAnchorFacts {
  return assessmentAnchorOf({
    officialRating: attempt.preparation.capture.snapshot.officialRating,
    virtualPerformance: attempt.preparation.capture.snapshot.virtualPerformance,
  });
}

/** Enforce the result shape that belongs to one status. */
function validateAssessmentAttemptShape(attempt: AssessmentAttempt): void {
  if (attempt.status === 'prepared' || attempt.status === 'reserved') {
    invariant(
      attempt.finishedAt === null &&
        attempt.usage === null &&
        attempt.report === null &&
        attempt.error === null &&
        attempt.hostSessionId === null &&
        attempt.hostCallId === null,
      'invalid_input',
      `${attempt.status} assessment attempt ${attempt.id} must not carry a result`,
      { id: attempt.id, status: attempt.status },
    );
    return;
  }
  invariant(
    attempt.finishedAt !== null,
    'invalid_input',
    `${attempt.status} assessment attempt ${attempt.id} requires finishedAt`,
    { id: attempt.id },
  );
  if (attempt.status === 'uncertain') {
    // Unknown usage is the whole point of this status: it keeps its charged slot instead of
    // pretending the call was free.
    invariant(
      attempt.usage === null && attempt.report === null,
      'invalid_input',
      `uncertain assessment attempt ${attempt.id} must not carry usage or a report`,
      { id: attempt.id },
    );
    invariant(
      attempt.error !== null,
      'invalid_input',
      `uncertain assessment attempt ${attempt.id} requires an error`,
      { id: attempt.id },
    );
    return;
  }
  invariant(
    attempt.usage !== null,
    'invalid_input',
    `${attempt.status} assessment attempt ${attempt.id} requires known usage`,
    { id: attempt.id },
  );
  if (attempt.status === 'cancelled') {
    invariant(
      attempt.report === null && attempt.error !== null && attempt.usage.calls === 0,
      'invalid_input',
      `cancelled assessment attempt ${attempt.id} was cancelled before dispatch, so it must record only a zero-usage cancellation error`,
      { id: attempt.id, reason: 'cancel_usage', usage: attempt.usage },
    );
    return;
  }
  invariant(
    (attempt.report === null) !== (attempt.error === null),
    'invalid_input',
    `settled assessment attempt ${attempt.id} must record exactly one of a report or an error`,
    { id: attempt.id, hasReport: attempt.report !== null, hasError: attempt.error !== null },
  );
}

/**
 * Which assessment attempts to read back.
 *
 * `accountId` omitted/`null` means "no account restriction" (used by the global recovery and quota
 * walks only); a string reads that account alone. `since` is an **inclusive** lower bound on
 * `requestedAt`. `limit` must be `1..500` and a cursor is only valid for the filter set that
 * produced it, so a page can never be continued as a different query.
 */
export interface AssessmentAttemptQuery {
  readonly accountId?: string | null;
  readonly status?: AssessmentAttemptStatus | null;
  readonly since?: string | null;
  /** Ordering of the requested page; omitted/`null` keeps the ascending `requestedAt, id` order. */
  readonly order?: 'asc' | 'desc' | null;
  readonly limit: number;
  readonly cursor: string | null;
}

/** Which assessment attempts to count for the plugin-wide rolling quota. */
export interface AssessmentAttemptCountQuery {
  readonly since?: string | null;
  readonly statuses?: readonly AssessmentAttemptStatus[] | null;
}

/**
 * Persistence port for assessment attempts, implemented on the v8 `ability_evaluation_attempts`
 * table.
 *
 * Separate from the main training port so a store is not forced to implement unrelated operations;
 * the SQLite adapter implements both. Reads are bounded and cursored, the count is global, and every
 * method joins the caller's transaction when one is open without opening a nested one.
 */
export interface AssessmentStore {
  getAssessmentAttempt(id: string): Promise<AssessmentAttempt | null>;
  /**
   * Insert a `prepared` attempt, or advance an existing one
   * (`prepared → reserved | cancelled`, `reserved → settled | uncertain`; nothing returns to an
   * earlier state and no new row may be inserted as anything but `prepared`).
   *
   * A terminal attempt is immutable and an identical re-save is a no-op; a different body must
   * present the next revision, so a charged attempt can never be overwritten by a duplicate id.
   */
  saveAssessmentAttempt(attempt: AssessmentAttempt): Promise<void>;
  /** One page in deterministic `requestedAt, id` order, with a cursor bound to the filter set. */
  listAssessmentAttempts(query: AssessmentAttemptQuery): Promise<Page<AssessmentAttempt>>;
  /** Number of attempts matching the filters, across every account (global quota). */
  countAssessmentAttempts(query: AssessmentAttemptCountQuery): Promise<number>;
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

function requireText(label: string, value: unknown, bound: number): string {
  invariant(
    typeof value === 'string' && value.trim().length > 0,
    'invalid_input',
    `${label} must be a non-empty string`,
    { label },
  );
  const text = (value as string).trim();
  invariant(text.length <= bound, 'invalid_input', `${label} is ${text.length} characters, above ${bound}`, {
    label,
    bound,
  });
  return text;
}

function requireNullableText(label: string, value: unknown, bound: number): string | null {
  return value === null ? null : requireText(label, value, bound);
}

function requireTimestamp(label: string, value: unknown): string {
  return assertIsoTimestamp(label, requireText(label, value, 100));
}

function requireHash(label: string, value: unknown): string {
  invariant(typeof value === 'string' && SHA256.test(value), 'invalid_input', `${label} must be a sha256 digest`, {
    label,
  });
  return value;
}

function requireRevision(value: unknown): number {
  invariant(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1,
    'invalid_input',
    'assessment attempt revision must be a positive safe integer',
    { revision: value },
  );
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

function requireCount(label: string, value: unknown): number {
  invariant(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    'invalid_input',
    `${label} must be a safe integer >= 0`,
    { label, value },
  );
  return value;
}

function requirePreparation(value: unknown): AssessmentAttemptPreparation {
  const record = requireObject('assessment preparation', value);
  requireExactKeys('assessment preparation', record, PREPARATION_KEYS);
  return {
    preparedAt: requireTimestamp('assessment preparation preparedAt', record['preparedAt']),
    capture: validateAssessmentCapture(record['capture']),
  };
}

function requireUsage(value: unknown): ModelUsage {
  const usage = requireObject('assessment attempt usage', value);
  requireExactKeys('assessment attempt usage', usage, USAGE_KEYS);
  return {
    calls: requireCount('usage.calls', usage['calls']),
    promptTokens: requireCount('usage.promptTokens', usage['promptTokens']),
    completionTokens: requireCount('usage.completionTokens', usage['completionTokens']),
    totalTokens: requireCount('usage.totalTokens', usage['totalTokens']),
  };
}

function requireError(value: unknown): ModelGatewayError {
  const error = requireObject('assessment attempt error', value);
  requireExactKeys('assessment attempt error', error, ERROR_KEYS);
  const code = error['code'];
  invariant(
    MODEL_ERROR_CODES.includes(code as ModelErrorCode),
    'invalid_input',
    `unknown assessment attempt error code ${String(code)}`,
    { code },
  );
  invariant(
    typeof error['retryable'] === 'boolean',
    'invalid_input',
    'assessment attempt error retryable must be boolean',
    { retryable: error['retryable'] },
  );
  return {
    code: code as ModelErrorCode,
    message: requireText('assessment attempt error message', error['message'], 500),
    retryable: error['retryable'],
  };
}

/** Typed refusal of a caller contract violation, raised instead of a silently different result. */
export function assessmentAttemptConflict(message: string, details: Record<string, unknown> = {}): DomainError {
  return new DomainError('invalid_input', message, { reason: 'assessment_attempt_conflict', ...details });
}
