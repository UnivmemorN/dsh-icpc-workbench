/**
 * Durable coaching attempts and their persistence port.
 *
 * One coaching attempt is the audit row of one progressive-hint model call. It is written
 * `reserved` *before* dispatch (with an explicit `expiresAt`, so a restart can tell a live
 * reservation from a dead one without trusting a changed clock), then moves only forward:
 * `reserved → uncertain | settled`, `uncertain → settled`. A settled row is final, `id`,
 * `accountId`, problem/snapshot, level, timestamps and model identity are immutable, and a
 * host correlation that is already known can never be reassigned or cleared.
 *
 * Everything here is plain data plus pure validation: ids and timestamps are supplied by the
 * caller, so nothing reads a clock or an environment variable and a replay produces the same
 * records. Storage projects records onto their declared fields, so an undeclared member cannot
 * be persisted; the nested `usage`/`error` values are validated strictly (keys included)
 * because they are stored as canonical JSON.
 */
import { DomainError, assertIsoTimestamp, invariant, parseProblemKey } from '../domain/index.js';
import type { ModelUsage } from '../domain/index.js';
import type { ModelErrorCode, ModelGatewayError, Page } from './ports.js';

/** Hint level of one coaching call: 1..3 are progressive hints, `full` is the full explanation. */
export type CoachingLevel = 1 | 2 | 3 | 'full';

/** Lifecycle of one coaching call; see the module comment for the allowed transitions. */
export type CoachingStatus = 'reserved' | 'settled' | 'uncertain';

export const COACHING_LEVELS: readonly CoachingLevel[] = [1, 2, 3, 'full'];

export const COACHING_STATUSES: readonly CoachingStatus[] = ['reserved', 'settled', 'uncertain'];

/** Upper bound of one stored answer; a longer response is a defect, not a coaching reply. */
export const MAX_COACHING_RESPONSE_CHARS = 200_000;

/**
 * Durable audit row for one coaching call.
 *
 * A `reserved` attempt carries no result; an `uncertain` attempt has finished with an error
 * but its usage is unknown (so it stays on the quota books until late usage settles it); a
 * `settled` attempt has known usage and either a response or an error, never both.
 */
export interface CoachingAttempt {
  readonly id: string;
  readonly accountId: string | null;
  readonly problemKey: string;
  readonly snapshotId: string;
  readonly level: CoachingLevel;
  readonly requestedAt: string;
  /** Reservation deadline, fixed at insert time; recovery compares it, it never moves. */
  readonly expiresAt: string;
  readonly finishedAt: string | null;
  readonly status: CoachingStatus;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly hostSessionId: string | null;
  readonly hostCallId: string | null;
  readonly usage: ModelUsage | null;
  readonly responseText: string | null;
  readonly error: ModelGatewayError | null;
}

/** Fields that identify an attempt and its request; changing one is an immutable violation. */
export const COACHING_ATTEMPT_IDENTITY_FIELDS: readonly (keyof CoachingAttempt)[] = [
  'id',
  'accountId',
  'problemKey',
  'snapshotId',
  'level',
  'requestedAt',
  'expiresAt',
  'provider',
  'model',
  'promptVersion',
];

const ATTEMPT_KEYS = [
  'id',
  'accountId',
  'problemKey',
  'snapshotId',
  'level',
  'requestedAt',
  'expiresAt',
  'finishedAt',
  'status',
  'provider',
  'model',
  'promptVersion',
  'hostSessionId',
  'hostCallId',
  'usage',
  'responseText',
  'error',
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

/** Canonical snapshot id: `<problemKey>@<sha256 hex>:v<version>` (see `snapshotIdOf`). */
const SNAPSHOT_ID = /^(.+)@([0-9a-f]{64}):v([1-9][0-9]*)$/u;

/**
 * Strictly validate one coaching attempt and return a detached, normalized copy.
 *
 * Every declared field must be present (an explicit `null` is data, a missing or `undefined`
 * member is not), undeclared top-level keys are rejected, the problem key and snapshot id must
 * be canonical and belong to each other, `expiresAt` must be strictly after `requestedAt`
 * (positive lease) and `finishedAt` must not precede `requestedAt`. The status shape is
 * enforced as described on {@link CoachingAttempt}.
 */
export function validateCoachingAttempt(value: unknown): CoachingAttempt {
  const record = requireObject('coaching attempt', value);
  requireExactKeys('coaching attempt', record, ATTEMPT_KEYS);

  const id = requireText('coaching attempt id', record['id']);
  const accountId = requireNullableText('coaching attempt accountId', record['accountId']);
  const problemKeyValue = requireProblemKeyValue('coaching attempt problemKey', record['problemKey']);
  const snapshotId = requireSnapshotForProblem('coaching attempt snapshotId', problemKeyValue, record['snapshotId']);
  const level = record['level'];
  invariant(
    COACHING_LEVELS.includes(level as CoachingLevel),
    'invalid_input',
    `unknown coaching level ${String(level)}`,
    { level },
  );
  const requestedAt = requireTimestamp('coaching attempt requestedAt', record['requestedAt']);
  const expiresAt = requireTimestamp('coaching attempt expiresAt', record['expiresAt']);
  invariant(
    Date.parse(expiresAt) > Date.parse(requestedAt),
    'invalid_input',
    `coaching attempt ${id} expiresAt must be after requestedAt`,
    { id, requestedAt, expiresAt },
  );
  const finishedAt = record['finishedAt'] === null ? null : requireTimestamp('coaching attempt finishedAt', record['finishedAt']);
  if (finishedAt !== null) {
    invariant(
      Date.parse(finishedAt) >= Date.parse(requestedAt),
      'invalid_input',
      `coaching attempt ${id} finishedAt must not precede requestedAt`,
      { id, requestedAt, finishedAt },
    );
  }
  const status = record['status'];
  invariant(
    COACHING_STATUSES.includes(status as CoachingStatus),
    'invalid_input',
    `unknown coaching status ${String(status)}`,
    { status },
  );
  const provider = requireText('coaching attempt provider', record['provider']);
  const model = requireText('coaching attempt model', record['model']);
  const promptVersion = requireText('coaching attempt promptVersion', record['promptVersion']);
  const hostSessionId = requireNullableText('coaching attempt hostSessionId', record['hostSessionId']);
  const hostCallId = requireNullableText('coaching attempt hostCallId', record['hostCallId']);
  const usage = record['usage'] === null ? null : requireUsage(record['usage']);
  const responseText = requireResponseText(record['responseText']);
  const error = record['error'] === null ? null : requireError(record['error']);

  const attempt: CoachingAttempt = {
    id,
    accountId,
    problemKey: problemKeyValue,
    snapshotId,
    level: level as CoachingLevel,
    requestedAt,
    expiresAt,
    finishedAt,
    status: status as CoachingStatus,
    provider,
    model,
    promptVersion,
    hostSessionId,
    hostCallId,
    usage,
    responseText,
    error,
  };
  validateCoachingAttemptShape(attempt);
  return attempt;
}

/**
 * Validate one save of an existing attempt.
 *
 * Identity is fixed; a known host correlation is a recorded fact that a later save may neither
 * reassign nor clear; a settled row is immutable entirely (an identical re-save is the caller's
 * idempotent no-op before this check); and the lifecycle only moves forward — `reserved` may
 * become `uncertain` or `settled`, an `uncertain` attempt may only become `settled`, and
 * nothing returns to `reserved`.
 */
export function validateCoachingAttemptTransition(previous: CoachingAttempt, next: CoachingAttempt): void {
  const stored = validateCoachingAttempt(previous);
  const incoming = validateCoachingAttempt(next);
  const changed = COACHING_ATTEMPT_IDENTITY_FIELDS.filter((field) => stored[field] !== incoming[field]);
  invariant(
    changed.length === 0,
    'immutable_violation',
    `coaching attempt ${stored.id} already exists with a different ${changed.join(', ')}`,
    { id: stored.id, conflicts: changed },
  );
  for (const field of ['hostSessionId', 'hostCallId'] as const) {
    const known = stored[field];
    invariant(
      known === null || incoming[field] === known,
      'immutable_violation',
      `coaching attempt ${stored.id} already records ${field} ${known}; a known host correlation cannot be reassigned or cleared`,
      { id: stored.id, field, previous: known, next: incoming[field], reason: 'host_correlation' },
    );
  }
  invariant(
    stored.status !== 'settled',
    'immutable_violation',
    `settled coaching attempt ${stored.id} cannot be rewritten`,
    { id: stored.id },
  );
  const allowed: readonly CoachingStatus[] = stored.status === 'reserved' ? ['uncertain', 'settled'] : ['settled'];
  invariant(
    allowed.includes(incoming.status),
    'invalid_transition',
    `coaching attempt ${stored.id} cannot move from ${stored.status} to ${incoming.status}`,
    { id: stored.id, previousStatus: stored.status, status: incoming.status },
  );
}

/** Enforce the result shape that belongs to one status. */
function validateCoachingAttemptShape(attempt: CoachingAttempt): void {
  if (attempt.status === 'reserved') {
    invariant(
      attempt.finishedAt === null && attempt.usage === null && attempt.responseText === null && attempt.error === null,
      'invalid_input',
      `reserved coaching attempt ${attempt.id} must not carry a result`,
      { id: attempt.id },
    );
    return;
  }
  invariant(
    attempt.finishedAt !== null,
    'invalid_input',
    `${attempt.status} coaching attempt ${attempt.id} requires finishedAt`,
    { id: attempt.id },
  );
  if (attempt.status === 'uncertain') {
    invariant(
      attempt.usage === null && attempt.responseText === null,
      'invalid_input',
      `uncertain coaching attempt ${attempt.id} must not carry usage or a response`,
      { id: attempt.id },
    );
    invariant(
      attempt.error !== null,
      'invalid_input',
      `uncertain coaching attempt ${attempt.id} requires an error`,
      { id: attempt.id },
    );
    return;
  }
  invariant(
    attempt.usage !== null,
    'invalid_input',
    `settled coaching attempt ${attempt.id} requires known usage`,
    { id: attempt.id },
  );
  invariant(
    (attempt.responseText === null) !== (attempt.error === null),
    'invalid_input',
    `settled coaching attempt ${attempt.id} must record exactly one of responseText or error`,
    { id: attempt.id, hasResponse: attempt.responseText !== null, hasError: attempt.error !== null },
  );
}

/**
 * Which coaching attempts to read back.
 *
 * `accountId` is a three-valued scope, never a plain "no restriction": an omitted
 * (`undefined`) member reads **every account**, an explicit `null` reads **anonymous attempts
 * only** (rows that recorded no account), and a string reads that account alone. The other
 * filters (`problemKey`/`since`/`status`) are independent, and an omitted or `null` value there
 * means "no restriction". `since` is an **inclusive** lower bound on `requestedAt`. `limit` must
 * be `1..500` and a cursor returned by a previous page is only valid for the filter set that
 * produced it, so an anonymous page can never be continued as an account or unfiltered page.
 */
export interface CoachingAttemptQuery {
  /** Omitted: every account. `null`: anonymous attempts only. String: that account. */
  readonly accountId?: string | null;
  readonly problemKey?: string | null;
  readonly since?: string | null;
  readonly status?: CoachingStatus | null;
  readonly limit: number;
  readonly cursor: string | null;
}

/**
 * Which coaching attempts to count for the global quota.
 *
 * Deliberately has no account scope: the coaching budget is a plugin-wide limit, so switching
 * accounts must never hand out a fresh allowance. `since` is inclusive; `null`/omitted means
 * "no restriction".
 */
export interface CoachingAttemptCountQuery {
  readonly since?: string | null;
  readonly status?: CoachingStatus | null;
}

/**
 * Persistence port for coaching attempts.
 *
 * Separate from the main training port so a store is not forced to implement unrelated
 * operations; the SQLite adapter implements both. Reads are bounded and cursored, the count is
 * global, and every method joins the caller's transaction when one is open (the service
 * reserves and quota-checks in one outer transaction) without opening a nested one.
 */
export interface CoachingStore {
  getCoachingAttempt(id: string): Promise<CoachingAttempt | null>;
  /**
   * Insert a `reserved` attempt before dispatch, or advance an existing one
   * (`reserved → uncertain | settled`, `uncertain → settled`; nothing returns to `reserved`).
   *
   * A settled attempt is immutable and an identical re-save is a no-op; a different body is
   * rejected, so a charged attempt can never be overwritten by a duplicate id. Once
   * `hostSessionId`/`hostCallId` are known they are never reassigned or cleared.
   */
  saveCoachingAttempt(attempt: CoachingAttempt): Promise<void>;
  /**
   * One page of attempts in deterministic `requestedAt, id` order, with an opaque cursor bound
   * to the effective filter set, including the three-valued account scope
   * (see {@link CoachingAttemptQuery}).
   */
  listCoachingAttempts(query: CoachingAttemptQuery): Promise<Page<CoachingAttempt>>;
  /** Number of attempts matching the filters, across every account (global quota). */
  countCoachingAttempts(query: CoachingAttemptCountQuery): Promise<number>;
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

function requireProblemKeyValue(label: string, value: unknown): string {
  const key = requireText(label, value);
  try {
    parseProblemKey(key);
  } catch (cause) {
    throw new DomainError('invalid_input', `${label} is not a canonical problem key`, {
      label,
      key,
      cause: String(cause),
    });
  }
  return key;
}

function requireSnapshotForProblem(label: string, problemKeyValue: string, value: unknown): string {
  const snapshotId = requireText(label, value);
  const match = SNAPSHOT_ID.exec(snapshotId);
  invariant(match !== null, 'invalid_input', `${label} must be a canonical snapshot id`, { label, snapshotId });
  const owner = match[1] as string;
  invariant(
    owner === problemKeyValue,
    'invalid_input',
    `${label} does not belong to problemKey ${problemKeyValue}`,
    { label, snapshotId, problemKey: problemKeyValue, owner },
  );
  return snapshotId;
}

function requireResponseText(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  invariant(
    typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_COACHING_RESPONSE_CHARS,
    'invalid_input',
    `coaching attempt responseText must be a non-empty string of at most ${MAX_COACHING_RESPONSE_CHARS} characters`,
    { valueType: typeof value, length: typeof value === 'string' ? value.length : null },
  );
  return value;
}

function requireUsage(value: unknown): ModelUsage {
  const usage = requireObject('coaching attempt usage', value);
  requireExactKeys('coaching attempt usage', usage, USAGE_KEYS);
  return {
    calls: requireCount('usage.calls', usage['calls']),
    promptTokens: requireCount('usage.promptTokens', usage['promptTokens']),
    completionTokens: requireCount('usage.completionTokens', usage['completionTokens']),
    totalTokens: requireCount('usage.totalTokens', usage['totalTokens']),
  };
}

function requireError(value: unknown): ModelGatewayError {
  const error = requireObject('coaching attempt error', value);
  requireExactKeys('coaching attempt error', error, ERROR_KEYS);
  const code = error['code'];
  invariant(
    MODEL_ERROR_CODES.includes(code as ModelErrorCode),
    'invalid_input',
    `unknown coaching attempt error code ${String(code)}`,
    { code },
  );
  invariant(
    typeof error['retryable'] === 'boolean',
    'invalid_input',
    'coaching attempt error retryable must be boolean',
    { retryable: error['retryable'] },
  );
  return {
    code: code as ModelErrorCode,
    message: requireText('coaching attempt error message', error['message']),
    retryable: error['retryable'],
  };
}

/**
 * One usage counter: a non-negative **safe** integer. `Number.isInteger` alone admits values
 * beyond `Number.MAX_SAFE_INTEGER`, where a token or call count is no longer exact.
 */
function requireCount(label: string, value: unknown): number {
  invariant(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    'invalid_input',
    `${label} must be a safe integer >= 0`,
    { label, value },
  );
  return value;
}
