/**
 * Row codecs for the SQLite store.
 *
 * Two rules shape this file:
 *
 * - **Only declared fields are persisted.** Every entity is projected onto an explicit field
 *   list before it becomes a JSON body, so a caller cannot smuggle an undeclared member
 *   (a cookie, a token, a UI-only hint) into the database. Accounts and source instances are
 *   the important case: a credential has no column and no body field to live in.
 * - **Reading is strict.** A row that lost a column, holds malformed JSON or holds a body
 *   that is not a JSON object raises `corrupt_row` instead of returning `undefined` or a
 *   half-built object. These are structural boundary checks: a parsed object is handed to the
 *   domain as-is, which is where full record validation lives.
 *
 * Immutable records are compared through their canonical JSON body; snapshots additionally
 * have their content hash, id and solution digests re-derived, because a snapshot id is a
 * content identity (`problemKey@hash:v<version>`) and must never be adopted with a body that
 * does not match it.
 */
import {
  DomainError,
  canonicalJson,
  computeSnapshotContentHash,
  invariant,
  parseProblemKey,
  problemKey,
  sha256Hex,
  snapshotIdOf,
  utf8Bytes,
  type AnalysisJobState,
  type ProblemSnapshot,
} from '../../domain/index.js';
import { StorageError } from './errors.js';

/** One SQLite row as `node:sqlite` returns it (column name -> value). */
export type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------------------
// Persisted field lists
// ---------------------------------------------------------------------------------------

export const SOURCE_INSTANCE_FIELDS: readonly string[] = [
  'id',
  'platform',
  'baseUrl',
  'domain',
  'displayName',
];
export const ACCOUNT_FIELDS: readonly string[] = [
  'id',
  'sourceInstanceId',
  'handle',
  'displayName',
  'profileUrl',
];
export const PROBLEM_FIELDS: readonly string[] = [
  'ref',
  'key',
  'title',
  'url',
  'statement',
  'ratings',
  'rawTags',
  'fetchedAt',
];
export const SUBMISSION_FIELDS: readonly string[] = [
  'id',
  'accountId',
  'ref',
  'key',
  'externalId',
  'verdict',
  'submittedAt',
  'language',
  'timeMs',
  'memoryKb',
];
export const SNAPSHOT_FIELDS: readonly string[] = [
  'snapshotId',
  'schemaVersion',
  'version',
  'contentHash',
  'capturedAt',
  'problem',
  'sources',
  'solutions',
];
export const ANALYSIS_FIELDS: readonly string[] = [
  'analysisId',
  'problemKey',
  'snapshotId',
  'snapshotVersion',
  'taxonomyVersion',
  'createdAt',
  'status',
  'suggestions',
  'verifications',
  'reasoningDrafts',
  'usage',
  'failure',
];
export const JOB_FIELDS: readonly string[] = [
  'jobId',
  'problemKey',
  'snapshotId',
  'status',
  'attempts',
  'counters',
  'createdAt',
  'updatedAt',
  'leaseOwner',
  'leaseExpiresAt',
  'analysisId',
  'lastError',
];
export const TAG_DECISION_FIELDS: readonly string[] = [
  'decisionId',
  'problemKey',
  'taxonomyId',
  'status',
  'origin',
  'analysisId',
  'suggestionId',
  'snapshotId',
  'snapshotVersion',
  'decidedAt',
  'reasons',
  'evidence',
];
export const MANUAL_DECISION_FIELDS: readonly string[] = [
  'decisionId',
  'problemKey',
  'taxonomyId',
  'action',
  'decidedAt',
  'note',
  'supersedesAnalysisId',
];
export const RETROSPECTIVE_FIELDS: readonly string[] = [
  'retrospectiveId',
  'problemKey',
  'accountId',
  'mode',
  'taxonomyIds',
  'solutionIds',
  'recordedAt',
  'note',
];
export const PLAN_FIELDS: readonly string[] = [
  'planId',
  'title',
  'source',
  'status',
  'createdAt',
  'adoptedAt',
  'accountId',
  'horizonDays',
  'minutesPerDay',
  'tasks',
  'evidence',
  'unmetMinutes',
];
export const BATCH_FIELDS: readonly string[] = [
  'batchId',
  'jobs',
  'maxJobs',
  'createdAt',
  'status',
  'revision',
  'owner',
  'leaseExpiresAt',
  'limits',
  'counters',
  'updatedAt',
  'lastError',
];
export const MODEL_CALL_ATTEMPT_FIELDS: readonly string[] = [
  'attemptId',
  'batchId',
  'jobId',
  'snapshotId',
  'role',
  'provider',
  'model',
  'promptVersion',
  'requestedAt',
  'finishedAt',
  'status',
  'hostSessionId',
  'hostCallId',
  'usage',
  'error',
  'outcome',
];

/** Fields that take part in a snapshot's *identity* (observation timestamps excluded). */
const PROBLEM_IDENTITY_FIELDS: readonly string[] = ['ref', 'key', 'title', 'url', 'statement', 'ratings', 'rawTags'];
const SOURCE_IDENTITY_FIELDS: readonly string[] = [
  'id',
  'kind',
  'url',
  'title',
  'author',
  'language',
  'publishedAt',
  'availability',
  'contentHash',
];
const SOLUTION_IDENTITY_FIELDS: readonly string[] = [
  'solutionId',
  'sourceId',
  'ordinal',
  'title',
  'text',
  'contentHash',
  'language',
];

// ---------------------------------------------------------------------------------------
// Strict column readers
// ---------------------------------------------------------------------------------------

export function column(row: Row, name: string): unknown {
  if (!(name in row)) {
    throw new StorageError('corrupt_row', `stored row is missing column ${name}`, { name, columns: Object.keys(row) });
  }
  return row[name];
}

export function textColumn(row: Row, name: string): string {
  const value = column(row, name);
  if (typeof value !== 'string') {
    throw new StorageError('corrupt_row', `column ${name} must be text`, { name, valueType: typeof value });
  }
  return value;
}

export function nullableTextColumn(row: Row, name: string): string | null {
  const value = column(row, name);
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new StorageError('corrupt_row', `column ${name} must be text or null`, { name, valueType: typeof value });
  }
  return value;
}

export function intColumn(row: Row, name: string): number {
  const value = column(row, name);
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new StorageError('corrupt_row', `column ${name} must be an integer`, { name, value });
  }
  return value;
}

export function nullableIntColumn(row: Row, name: string): number | null {
  const value = column(row, name);
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new StorageError('corrupt_row', `column ${name} must be an integer or null`, { name, value });
  }
  return value;
}

/**
 * Parse one stored JSON body. Malformed JSON is a storage defect, never a silent null.
 *
 * This is only the **structural** boundary: the body must parse and must be a JSON object,
 * so `null`, an array or a bare primitive is rejected as `corrupt_row` instead of being cast
 * to an entity. It deliberately does not claim full domain runtime validation — a body that
 * is a JSON object but not a well-formed domain record is the domain layer's concern.
 */
export function parseBody<T>(label: string, json: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new StorageError('corrupt_row', `stored ${label} is not valid JSON`, { label, cause: String(error) });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StorageError('corrupt_row', `stored ${label} is not a JSON object`, {
      label,
      valueType: parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed,
    });
  }
  return parsed as T;
}

/** Read the entity stored in the `body` column of `row`. */
export function entityFromRow<T>(label: string, row: Row): T {
  return parseBody<T>(label, textColumn(row, 'body'));
}

/** Project onto declared fields and encode deterministically (sorted keys). */
export function project(value: object, fields: readonly string[]): Record<string, unknown> {
  const record = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    const member = record[field];
    if (member === undefined) {
      throw new DomainError('non_serializable_content', `entity is missing required field ${field}`, { field });
    }
    projected[field] = member;
  }
  return projected;
}

/** Canonical JSON body of one entity, limited to its declared fields. */
export function bodyOf(value: object, fields: readonly string[]): string {
  return canonicalJson(project(value, fields));
}

/** Reject a problem key that is not the canonical key of a real problem reference. */
export function requireProblemKey(key: string): string {
  invariant(typeof key === 'string' && key.length > 0, 'invalid_input', 'problemKey is required', { key });
  parseProblemKey(key);
  return key;
}

// ---------------------------------------------------------------------------------------
// Identity checks
// ---------------------------------------------------------------------------------------

/**
 * Re-derive a snapshot's identity from its body.
 *
 * Returns the problem key. Throws `immutable_violation` when the stored/attempted body does
 * not hash to its own `contentHash`, when the snapshot id does not encode that hash and
 * version, or when a solution's digest does not match its text.
 */
export function requireValidSnapshot(snapshot: ProblemSnapshot): string {
  const key = problemKey(snapshot.problem.ref);
  if (key !== snapshot.problem.key) {
    throw new DomainError('invalid_input', 'snapshot problem key does not match its reference', {
      declared: snapshot.problem.key,
      derived: key,
    });
  }
  const expectedHash = computeSnapshotContentHash(snapshot.problem, snapshot.sources, snapshot.solutions);
  if (expectedHash !== snapshot.contentHash) {
    throw new DomainError('immutable_violation', 'snapshot content hash does not match its body', {
      snapshotId: snapshot.snapshotId,
      declared: snapshot.contentHash,
      derived: expectedHash,
    });
  }
  const expectedId = snapshotIdOf(snapshot.problem.ref, snapshot.contentHash, snapshot.version);
  if (expectedId !== snapshot.snapshotId) {
    throw new DomainError('immutable_violation', 'snapshot id does not match its content hash and version', {
      snapshotId: snapshot.snapshotId,
      derived: expectedId,
    });
  }
  for (const solution of snapshot.solutions) {
    const digest = sha256Hex(utf8Bytes(solution.text));
    if (digest !== solution.contentHash) {
      throw new DomainError('immutable_violation', 'solution content hash does not match its text', {
        snapshotId: snapshot.snapshotId,
        solutionId: solution.solutionId,
      });
    }
  }
  return key;
}

/**
 * Identity projection of a snapshot: everything the domain hashes plus the version.
 * Observation-only fields (`capturedAt`, `problem.fetchedAt`, `source.retrievedAt`) are
 * excluded because the domain excludes them from `contentHash` too: refetching unchanged
 * material must stay the same snapshot instead of becoming a conflicting record.
 */
export function snapshotIdentity(snapshot: ProblemSnapshot): unknown {
  return {
    schemaVersion: snapshot.schemaVersion,
    version: snapshot.version,
    contentHash: snapshot.contentHash,
    problem: project(snapshot.problem, PROBLEM_IDENTITY_FIELDS),
    sources: snapshot.sources.map((source) => project(source, SOURCE_IDENTITY_FIELDS)),
    solutions: snapshot.solutions.map((solution) => project(solution, SOLUTION_IDENTITY_FIELDS)),
  };
}

/** Reject an attempt to replace an immutable record with a different body. */
export function requireSameBody(label: string, id: string, storedBody: string, incomingBody: string): void {
  if (storedBody !== incomingBody) {
    throw new DomainError('immutable_violation', `${label} ${id} already exists with different content`, {
      id,
      label,
    });
  }
}

/** Monotonic counters read back from a job row. */
export interface JobCounterRow {
  readonly attempts: number;
  readonly analysisCalls: number;
  readonly reasoningCalls: number;
  readonly retries: number;
}

export function jobCounterRow(row: Row): JobCounterRow {
  return {
    attempts: intColumn(row, 'attempts'),
    analysisCalls: intColumn(row, 'analysis_calls'),
    reasoningCalls: intColumn(row, 'reasoning_calls'),
    retries: intColumn(row, 'retries'),
  };
}

export function jobCounters(state: Pick<AnalysisJobState, 'attempts' | 'counters'>): JobCounterRow {
  return {
    attempts: state.attempts,
    analysisCalls: state.counters.analysisCalls,
    reasoningCalls: state.counters.reasoningCalls,
    retries: state.counters.retries,
  };
}

// ---------------------------------------------------------------------------------------
// Cursor codec
// ---------------------------------------------------------------------------------------

export type CursorKind = 'problem' | 'submission';

const CURSOR_PAYLOAD = /^[A-Za-z0-9_-]+$/u;

/** Encode the last returned identity as an opaque, single-part cursor. */
export function encodeCursor(kind: CursorKind, value: string): string {
  return `${kind}:${Buffer.from(value, 'utf8').toString('base64url')}`;
}

/** Decode a cursor produced by {@link encodeCursor}; anything else is rejected. */
export function decodeCursor(kind: CursorKind, cursor: string): string {
  invariant(typeof cursor === 'string', 'invalid_input', 'cursor must be a string', { cursor });
  const separator = cursor.indexOf(':');
  const prefix = separator < 0 ? '' : cursor.slice(0, separator);
  const payload = separator < 0 ? '' : cursor.slice(separator + 1);
  invariant(
    prefix === kind && CURSOR_PAYLOAD.test(payload),
    'invalid_input',
    `cursor is not a valid ${kind} cursor`,
    { cursor },
  );
  const decoded = Buffer.from(payload, 'base64url').toString('utf8');
  invariant(decoded.length > 0, 'invalid_input', 'cursor decodes to an empty value', { cursor });
  return decoded;
}
