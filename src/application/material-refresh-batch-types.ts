/**
 * Durable bulk platform-material refresh batches (Sprint Contract 34A).
 *
 * One batch is an ordered list of 1..100 selected **stored** problems whose statement and editorial
 * material are refreshed through the accepted single-problem `ImportService.refreshMaterial` path.
 * This module owns the records and their pure rules only: ids, timestamps and boundary values are
 * supplied by the caller, so the application layer reads no clock, environment or OS resource and a
 * replay produces exactly the same records. Persistence is the store port's job; orchestration is
 * {@link import('./material-refresh-batch-service.js').MaterialRefreshBatchService}.
 *
 * Rules that shape every record:
 *
 * - **Platform IO only.** Nothing here — and nothing in the service — can name a model, a budget or
 *   an attempt: a material refresh is a platform read, and a batch never prepares, starts or resumes
 *   a paid tag analysis.
 * - **No secret or body is representable.** An item carries a canonical problem key, an optional
 *   stored account id, an optional caller-supplied official tutorial URL and a statement flag. It
 *   has no field for a statement, a raw tag, an editorial body, a Cookie, a credential reference, an
 *   upstream response body or an exception text; a failure is a stable code plus retry metadata.
 * - **Partial failure is normal.** A failure never becomes a confirmed `absent` editorial: absence is
 *   a successful observation and is recorded as a completed item, while an operational failure
 *   (auth, permission, rate limit, unavailable, changed response, missing reference, stale head) is
 *   an `attention` item that later items do not depend on.
 * - **Honest transitions.** A batch moves `prepared → running → (paused | completed | cancelled)`;
 *   retry-failed returns a batch cancelled **before its first start** to `prepared` and one cancelled
 *   after a start to `paused`, so the state always matches whether a platform read ever happened;
 *   a `completed` batch is terminal and retry-failed never repeats a completed item. The pure
 *   helpers below are the only way the service changes a record, and
 *   {@link validateMaterialRefreshBatchTransition} refuses every illegal step before a store writes.
 * - **Metadata-only projections.** {@link materialRefreshBatchView} is what a caller may see: it
 *   keeps identity, statuses, timestamps, retry metadata, statement/editorial/mirror status, snapshot
 *   id/version/hash/change flag and counts. The stored official tutorial URL becomes a boolean and the
 *   stored account id — which encodes its handle — is dropped, so a response can never become a way
 *   to read a source URL or an account identity.
 */
import {
  assertCredentialFreeHttpUrl,
  assertIsoTimestamp,
  canonicalJson,
  deepFreeze,
  invariant,
  parseAccountId,
  parseProblemKey,
  problemKey,
  type EditorialAvailability,
} from '../domain/index.js';
import type { PlatformError, PlatformErrorCode } from './platform-errors.js';
import type { RefreshMaterialReport } from './import-types.js';

// ---------------------------------------------------------------------------------------
// Bounds and vocabularies
// ---------------------------------------------------------------------------------------

/** Smallest accepted batch: a bulk operation over nothing is a caller mistake, not a no-op. */
export const MIN_MATERIAL_REFRESH_BATCH_ITEMS = 1;

/** Largest accepted batch; the bound is part of the contract, not a tuning knob. */
export const MAX_MATERIAL_REFRESH_BATCH_ITEMS = 100;

/** Default page size of `material.list`. */
export const DEFAULT_MATERIAL_REFRESH_BATCH_LIST_LIMIT = 20;

/** Largest accepted `material.list` page. */
export const MAX_MATERIAL_REFRESH_BATCH_LIST_LIMIT = 50;

/** Stable label of one official tutorial URL, used only to name a refusal. */
const OFFICIAL_TUTORIAL_LABEL = 'officialTutorialUrl';

export const MATERIAL_REFRESH_BATCH_STATUSES: readonly MaterialRefreshBatchStatus[] = [
  'prepared',
  'running',
  'paused',
  'completed',
  'cancelled',
];

export const MATERIAL_REFRESH_ITEM_STATUSES: readonly MaterialRefreshItemStatus[] = [
  'pending',
  'running',
  'completed',
  'attention',
  'cancelled',
];

/**
 * Stable, sanitized reason an item needs attention.
 *
 * The operational codes are the platform vocabulary minus the two caller conditions
 * (`cancelled` is an item *status* here, and an adapter refusal of our own request is folded into
 * `invalid_reference`). `missing_reference`, `stale_head` and `interrupted` are batch-layer findings:
 * a problem or account the store cannot prove, an optimistic snapshot-head refusal, and an in-flight
 * item that a crash, restart or disposal cut short. `unexpected` is an unrecognized failure — it is
 * explicitly **not** an absence and stays retryable so a caller never reads it as "no editorial".
 */
export type MaterialRefreshFailureCode =
  | 'auth_required'
  | 'forbidden'
  | 'rate_limited'
  | 'unavailable'
  | 'changed_response'
  | 'invalid_reference'
  | 'missing_reference'
  | 'stale_head'
  | 'interrupted'
  | 'unexpected';

export const MATERIAL_REFRESH_FAILURE_CODES: readonly MaterialRefreshFailureCode[] = [
  'auth_required',
  'forbidden',
  'rate_limited',
  'unavailable',
  'changed_response',
  'invalid_reference',
  'missing_reference',
  'stale_head',
  'interrupted',
  'unexpected',
];

// ---------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------

/** Lifecycle of one batch. `completed` and `cancelled` are the only end states a caller sees. */
export type MaterialRefreshBatchStatus = 'prepared' | 'running' | 'paused' | 'completed' | 'cancelled';

/**
 * Lifecycle of one item.
 *
 * `attention` is the retryable "this attempt failed" state (a failure is not a permanent verdict);
 * `cancelled` means the caller cancelled the batch before or during this item.
 */
export type MaterialRefreshItemStatus = 'pending' | 'running' | 'completed' | 'attention' | 'cancelled';

/** Whether the statement half of an item was requested and how it ended. */
export type MaterialRefreshStatementStatus = 'not_requested' | 'fetched' | 'failed';

/** Whether the equivalent-Codeforces editorial path was consulted for this item. */
export type MaterialRefreshMirrorStatus = 'skipped' | 'fetched';

/** Sanitized outcome of one failed attempt; never a body, a sample or an exception text. */
export interface MaterialRefreshItemFailure {
  readonly code: MaterialRefreshFailureCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  /** Attempts recorded for this item when the failure was written (>= 1). */
  readonly attempts: number;
}

/** Snapshot head metadata one item committed; ids, hashes and flags only. */
export interface MaterialRefreshItemSnapshot {
  readonly snapshotId: string;
  readonly version: number;
  readonly contentHash: string;
  /**
   * `false` when the semantic content did not change and the stored snapshot was reused, so a
   * caller can tell that this item did not stale an earlier analysis.
   */
  readonly changed: boolean;
}

/** What an item attempt observed; counts and statuses only. */
export interface MaterialRefreshItemResult {
  readonly statement: MaterialRefreshStatementStatus;
  /** Availability of the editorial answer, or `null` when no editorial request was made. */
  readonly editorial: EditorialAvailability | null;
  /** `null` when no editorial decision was made (the item failed or was cancelled). */
  readonly mirror: MaterialRefreshMirrorStatus | null;
  readonly sourceCount: number;
  readonly solutionCount: number;
  readonly snapshot: MaterialRefreshItemSnapshot | null;
}

/** One requested item, before or after it was prepared. */
export interface MaterialRefreshBatchItemInput {
  /** Canonical problem key of a **stored** problem. */
  readonly problemKey: string;
  /** Stored account the read may authenticate as; `null`/absent reads anonymously. */
  readonly accountId?: string | null;
  /** Official tutorial URL the adapter validates against its own origin; `null`/absent for none. */
  readonly officialTutorialUrl?: string | null;
  /** Whether to fetch the full statement as well; defaults to `true`. */
  readonly fetchStatement?: boolean;
}

/** One durable item: identity, per-item selection, attempts and the sanitized outcome. */
export interface MaterialRefreshBatchItem {
  readonly problemKey: string;
  readonly accountId: string | null;
  readonly officialTutorialUrl: string | null;
  readonly fetchStatement: boolean;
  readonly status: MaterialRefreshItemStatus;
  readonly attempts: number;
  readonly failure: MaterialRefreshItemFailure | null;
  readonly result: MaterialRefreshItemResult | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/** Durable state of one bulk material-refresh batch. */
export interface MaterialRefreshBatch {
  readonly batchId: string;
  /** Items in caller order; the order is preserved by every projection. */
  readonly items: readonly MaterialRefreshBatchItem[];
  readonly status: MaterialRefreshBatchStatus;
  /** Optimistic-concurrency token assigned by the store (0 before the first save). */
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** When the batch last entered `running`; `null` while it was only prepared. */
  readonly startedAt: string | null;
  /** When the batch reached `completed`; `null` otherwise. */
  readonly finishedAt: string | null;
  /** When the caller cancelled the batch; `null` otherwise. */
  readonly cancelledAt: string | null;
}

/**
 * Public projection of one item: the durable record without the stored tutorial URL **and without
 * the stored account id**.
 *
 * An `AccountId` encodes its handle (`sourceInstanceId|handle`), so exposing it would disclose
 * exactly the account identity this stage keeps out of every response; there is deliberately no
 * substitute identifier derived from it either. A caller still sees whether a statement was
 * requested, what the attempt observed and whether an official tutorial was attached, and learns
 * nothing about which session performed the read.
 */
export type MaterialRefreshBatchItemView = Omit<
  MaterialRefreshBatchItem,
  'officialTutorialUrl' | 'accountId'
> & {
  /** True when the caller supplied an official tutorial URL for this item. */
  readonly hasOfficialTutorial: boolean;
};

/** Public projection of one batch. */
export interface MaterialRefreshBatchView {
  readonly batchId: string;
  readonly status: MaterialRefreshBatchStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly cancelledAt: string | null;
  readonly itemCount: number;
  readonly counts: MaterialRefreshBatchCounts;
  readonly items: readonly MaterialRefreshBatchItemView[];
}

/** Per-status item totals of one projection. */
export interface MaterialRefreshBatchCounts {
  readonly pending: number;
  readonly running: number;
  readonly completed: number;
  readonly attention: number;
  readonly cancelled: number;
  /** Completed items whose committed snapshot actually changed (the rest reused their snapshot). */
  readonly changedSnapshots: number;
}

/** One row of `material.list`: the same metadata without the item list. */
export interface MaterialRefreshBatchSummaryView {
  readonly batchId: string;
  readonly status: MaterialRefreshBatchStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  readonly cancelledAt: string | null;
  readonly itemCount: number;
  readonly counts: MaterialRefreshBatchCounts;
}

/** Page of batch summaries. */
export interface MaterialRefreshBatchListView {
  readonly batches: readonly MaterialRefreshBatchSummaryView[];
  /** Total stored batches matching the filter, before the page slice. */
  readonly total: number;
  readonly limit: number;
}

/** Fields of a batch that are fixed by its first save; changing one is an immutable violation. */
export const MATERIAL_REFRESH_BATCH_IDENTITY_FIELDS: readonly (keyof MaterialRefreshBatch)[] = [
  'batchId',
  'items',
  'createdAt',
];

// ---------------------------------------------------------------------------------------
// Construction and validation
// ---------------------------------------------------------------------------------------

/**
 * Exactly the declared members of one durable record.
 *
 * The record is a **closed** shape: every declared field must be present and no undeclared one may
 * be. That is what makes `validateMaterialRefreshBatch` a canonical-JSON check rather than a
 * best-effort field probe — a hand-edited row carrying an extra `cookie`, `credential` or `statement`
 * member is refused as malformed instead of being accepted and (through a projection spread) served
 * to a caller.
 */
const MATERIAL_BATCH_FIELDS: readonly string[] = [
  'batchId',
  'items',
  'status',
  'revision',
  'createdAt',
  'updatedAt',
  'startedAt',
  'finishedAt',
  'cancelledAt',
];

const MATERIAL_BATCH_ITEM_FIELDS: readonly string[] = [
  'problemKey',
  'accountId',
  'officialTutorialUrl',
  'fetchStatement',
  'status',
  'attempts',
  'failure',
  'result',
  'startedAt',
  'finishedAt',
];

const MATERIAL_BATCH_FAILURE_FIELDS: readonly string[] = ['code', 'retryable', 'retryAfterMs', 'attempts'];

const MATERIAL_BATCH_RESULT_FIELDS: readonly string[] = [
  'statement',
  'editorial',
  'mirror',
  'sourceCount',
  'solutionCount',
  'snapshot',
];

const MATERIAL_BATCH_SNAPSHOT_FIELDS: readonly string[] = ['snapshotId', 'version', 'contentHash', 'changed'];

export interface CreateMaterialRefreshBatchInput {
  readonly batchId: string;
  /** Requested items in caller order; 1..{@link MAX_MATERIAL_REFRESH_BATCH_ITEMS} unique keys. */
  readonly items: readonly MaterialRefreshBatchItemInput[];
  readonly createdAt: string;
}

/**
 * Build a validated, frozen batch.
 *
 * A new batch is `prepared` at revision 0 with every item `pending`, so nothing is running and no
 * platform request is implied by creating it. Duplicate canonical problem keys, an unknown extra
 * field, a non-canonical account id, a non-http tutorial URL and a tutorial URL carrying embedded
 * credentials are all refused here, before the store sees anything. Whether the named problems and
 * accounts are really stored is proven by the service, which owns store access.
 */
export function createMaterialRefreshBatch(input: CreateMaterialRefreshBatchInput): MaterialRefreshBatch {
  const createdAt = assertIsoTimestamp('batch createdAt', input.createdAt);
  const batch: MaterialRefreshBatch = {
    batchId: input.batchId,
    items: (input.items ?? []).map((item) => preparedItem(item)),
    status: 'prepared',
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    finishedAt: null,
    cancelledAt: null,
  };
  validateMaterialRefreshBatch(batch);
  return deepFreeze(batch);
}

/** Validate one requested item and normalize it into a `pending` record. */
function preparedItem(input: MaterialRefreshBatchItemInput): MaterialRefreshBatchItem {
  invariant(
    input !== null && typeof input === 'object' && !Array.isArray(input),
    'invalid_input',
    'material batch item must be an object',
    { valueType: typeof input },
  );
  const key = canonicalKeyOf('material batch item problemKey', input.problemKey);
  const accountId = input.accountId === undefined || input.accountId === null ? null : canonicalAccountOf(input.accountId);
  const officialTutorialUrl =
    input.officialTutorialUrl === undefined || input.officialTutorialUrl === null
      ? null
      : assertCredentialFreeHttpUrl(OFFICIAL_TUTORIAL_LABEL, input.officialTutorialUrl);
  invariant(
    input.fetchStatement === undefined || typeof input.fetchStatement === 'boolean',
    'invalid_input',
    'material batch item fetchStatement must be a boolean when supplied',
    { problemKey: key },
  );
  return {
    problemKey: key,
    accountId,
    officialTutorialUrl,
    fetchStatement: input.fetchStatement ?? true,
    status: 'pending',
    attempts: 0,
    failure: null,
    result: null,
    startedAt: null,
    finishedAt: null,
  };
}

/**
 * Validate every boundary of one batch before a store writes or accepts it.
 *
 * The rules are deliberately total: item count and uniqueness, canonical identities, the exact
 * status vocabularies, attempt/time ordering and the failure shape. A row that cannot satisfy them
 * cannot be read back either, so a malformed body is refused instead of being repaired.
 */
export function validateMaterialRefreshBatch(batch: MaterialRefreshBatch): void {
  invariant(
    batch !== null && typeof batch === 'object' && !Array.isArray(batch),
    'invalid_input',
    'material refresh batch must be an object',
    { valueType: typeof batch },
  );
  requireExactFields('material refresh batch', batch, MATERIAL_BATCH_FIELDS);
  requireText('batch id', batch.batchId);
  invariant(Array.isArray(batch.items), 'invalid_input', 'material batch items must be an array', {
    batchId: batch.batchId,
  });
  invariant(
    batch.items.length >= MIN_MATERIAL_REFRESH_BATCH_ITEMS,
    'invalid_input',
    `a material batch needs at least ${MIN_MATERIAL_REFRESH_BATCH_ITEMS} item`,
    { batchId: batch.batchId, items: batch.items.length },
  );
  invariant(
    batch.items.length <= MAX_MATERIAL_REFRESH_BATCH_ITEMS,
    'invalid_input',
    `a material batch holds at most ${MAX_MATERIAL_REFRESH_BATCH_ITEMS} items`,
    { batchId: batch.batchId, items: batch.items.length },
  );
  invariant(
    MATERIAL_REFRESH_BATCH_STATUSES.includes(batch.status),
    'invalid_input',
    `unknown material batch status ${String(batch.status)}`,
    { batchId: batch.batchId, status: batch.status },
  );
  requireCount('batch revision', batch.revision, 0);
  const createdAt = assertIsoTimestamp('batch createdAt', batch.createdAt);
  const updatedAt = assertIsoTimestamp('batch updatedAt', batch.updatedAt);
  invariant(
    instant(updatedAt) >= instant(createdAt),
    'invalid_input',
    `material batch ${batch.batchId} updatedAt must not precede createdAt`,
    { batchId: batch.batchId, createdAt, updatedAt },
  );
  if (batch.startedAt !== null) {
    assertIsoTimestamp('batch startedAt', batch.startedAt);
  }
  if (batch.finishedAt !== null) {
    assertIsoTimestamp('batch finishedAt', batch.finishedAt);
  }
  if (batch.cancelledAt !== null) {
    assertIsoTimestamp('batch cancelledAt', batch.cancelledAt);
  }
  // A batch that never ran has no start time, and one that ran has one. `cancelled` is the
  // exception on purpose: cancel is legal before the first start (no instant to record) and during a
  // run (the start instant is preserved), so both shapes are truthful.
  invariant(
    batch.status === 'cancelled' || (batch.status === 'prepared') === (batch.startedAt === null),
    'invalid_input',
    `material batch ${batch.batchId} records startedAt exactly when it entered a run`,
    { batchId: batch.batchId, status: batch.status, startedAt: batch.startedAt },
  );
  invariant(
    (batch.status === 'completed') === (batch.finishedAt !== null),
    'invalid_input',
    `material batch ${batch.batchId} records finishedAt exactly when it completed`,
    { batchId: batch.batchId, status: batch.status, finishedAt: batch.finishedAt },
  );
  invariant(
    (batch.status === 'cancelled') === (batch.cancelledAt !== null),
    'invalid_input',
    `material batch ${batch.batchId} records cancelledAt exactly while it is cancelled`,
    { batchId: batch.batchId, status: batch.status, cancelledAt: batch.cancelledAt },
  );
  const keys = new Set<string>();
  for (const item of batch.items) {
    validateItem(batch, item, keys);
  }
  if (batch.status === 'running') {
    invariant(
      batch.items.some((item) => item.status === 'running' || item.status === 'pending'),
      'invalid_input',
      `running material batch ${batch.batchId} has no work left; settle it instead`,
      { batchId: batch.batchId },
    );
  }
  if (batch.status === 'completed') {
    invariant(
      batch.items.every((item) => item.status === 'completed'),
      'invalid_input',
      `completed material batch ${batch.batchId} still holds an unfinished item`,
      { batchId: batch.batchId },
    );
  }
}

function validateItem(batch: MaterialRefreshBatch, item: MaterialRefreshBatchItem, keys: Set<string>): void {
  invariant(
    item !== null && typeof item === 'object' && !Array.isArray(item),
    'invalid_input',
    'material batch item must be an object',
    { batchId: batch.batchId },
  );
  requireExactFields('material batch item', item, MATERIAL_BATCH_ITEM_FIELDS);
  const key = canonicalKeyOf('material batch item problemKey', item.problemKey);
  invariant(
    !keys.has(key),
    'duplicate_id',
    `material batch ${batch.batchId} lists problem ${key} more than once`,
    { batchId: batch.batchId, problemKey: key },
  );
  keys.add(key);
  if (item.accountId !== null) {
    canonicalAccountOf(item.accountId);
  }
  if (item.officialTutorialUrl !== null) {
    // The row validator applies the same credential-free rule as construction, so a hand-edited body
    // that smuggled `https://alice:secret@...` into storage is refused instead of being served or
    // handed to an adapter.
    assertCredentialFreeHttpUrl(OFFICIAL_TUTORIAL_LABEL, item.officialTutorialUrl);
  }
  invariant(typeof item.fetchStatement === 'boolean', 'invalid_input', 'item fetchStatement must be a boolean', {
    problemKey: key,
  });
  invariant(
    MATERIAL_REFRESH_ITEM_STATUSES.includes(item.status),
    'invalid_input',
    `unknown material batch item status ${String(item.status)}`,
    { problemKey: key, status: item.status },
  );
  requireCount('item attempts', item.attempts, 0);
  if (item.startedAt !== null) {
    assertIsoTimestamp('item startedAt', item.startedAt);
  }
  if (item.finishedAt !== null) {
    assertIsoTimestamp('item finishedAt', item.finishedAt);
  }
  invariant(
    item.status === 'pending' || item.status === 'cancelled' || item.startedAt !== null,
    'invalid_input',
    `material batch item ${key} is ${item.status} without a start time`,
    { problemKey: key, status: item.status },
  );
  const terminal = item.status === 'completed' || item.status === 'attention';
  // `completed`/`attention` always record when their attempt ended and `pending`/`running` never do.
  // A `cancelled` item may carry either: it was cancelled before it ever started (no instant) or
  // while it was in flight (the instant it stopped), and neither shape may look like a completion.
  invariant(
    item.status === 'cancelled' || terminal === (item.finishedAt !== null),
    'invalid_input',
    `material batch item ${key} records finishedAt exactly when its attempt ended`,
    { problemKey: key, status: item.status, finishedAt: item.finishedAt },
  );
  if (item.failure !== null) {
    validateFailure(key, item.failure);
  }
  invariant(
    item.status !== 'attention' || item.failure !== null,
    'invalid_input',
    `material batch item ${key} needs attention without a recorded failure`,
    { problemKey: key },
  );
  invariant(
    item.status !== 'completed' || item.failure === null,
    'invalid_input',
    `completed material batch item ${key} must not carry a failure`,
    { problemKey: key },
  );
  if (item.result !== null) {
    validateResult(key, item.result);
  }
  invariant(
    item.attempts >= 1 || (item.startedAt === null && item.finishedAt === null && item.failure === null),
    'invalid_input',
    `material batch item ${key} advanced without recording an attempt`,
    { problemKey: key },
  );
}

function validateFailure(key: string, failure: MaterialRefreshItemFailure): void {
  requireExactFields('material batch item failure', failure, MATERIAL_BATCH_FAILURE_FIELDS);
  invariant(
    MATERIAL_REFRESH_FAILURE_CODES.includes(failure.code),
    'invalid_input',
    `unknown material batch failure code ${String(failure.code)}`,
    { problemKey: key, code: failure.code },
  );
  invariant(typeof failure.retryable === 'boolean', 'invalid_input', 'item failure retryable must be boolean', {
    problemKey: key,
  });
  invariant(
    failure.retryAfterMs === null || (Number.isInteger(failure.retryAfterMs) && failure.retryAfterMs >= 0),
    'invalid_input',
    'item failure retryAfterMs must be a non-negative integer or null',
    { problemKey: key, retryAfterMs: failure.retryAfterMs },
  );
  requireCount('item failure attempts', failure.attempts, 1);
}

function validateResult(key: string, result: MaterialRefreshItemResult): void {
  requireExactFields('material batch item result', result, MATERIAL_BATCH_RESULT_FIELDS);
  invariant(
    result.statement === 'not_requested' || result.statement === 'fetched' || result.statement === 'failed',
    'invalid_input',
    `unknown item statement status ${String(result.statement)}`,
    { problemKey: key, statement: result.statement },
  );
  invariant(
    result.mirror === null || result.mirror === 'skipped' || result.mirror === 'fetched',
    'invalid_input',
    `unknown item mirror status ${String(result.mirror)}`,
    { problemKey: key, mirror: result.mirror },
  );
  if (result.editorial !== null) {
    invariant(
      EDITORIAL_AVAILABILITY.includes(result.editorial),
      'invalid_input',
      `unknown item editorial availability ${String(result.editorial)}`,
      { problemKey: key, editorial: result.editorial },
    );
  }
  requireCount('item sourceCount', result.sourceCount, 0);
  requireCount('item solutionCount', result.solutionCount, 0);
  if (result.snapshot !== null) {
    requireExactFields('material batch item snapshot', result.snapshot, MATERIAL_BATCH_SNAPSHOT_FIELDS);
    requireText('item snapshotId', result.snapshot.snapshotId);
    requireCount('item snapshot version', result.snapshot.version, 1);
    invariant(
      typeof result.snapshot.contentHash === 'string' && /^[0-9a-f]{64}$/u.test(result.snapshot.contentHash),
      'invalid_input',
      'item snapshot content hash must be a sha256 hex digest',
      { problemKey: key },
    );
    invariant(
      typeof result.snapshot.changed === 'boolean',
      'invalid_input',
      'item snapshot changed flag must be a boolean',
      { problemKey: key },
    );
  }
}

const EDITORIAL_AVAILABILITY: readonly EditorialAvailability[] = [
  'found',
  'absent',
  'auth_required',
  'forbidden',
  'rate_limited',
  'unavailable',
  'changed_response',
];

// ---------------------------------------------------------------------------------------
// Transitions (pure; the service applies them, the store enforces them)
// ---------------------------------------------------------------------------------------

/**
 * Begin (or resume) a run: `prepared`/`paused` become `running`.
 *
 * Starting never resets an item: `completed` items stay completed and pending work stays pending, so
 * a resume can never repeat finished platform work.
 */
export function startMaterialRefreshBatch(batch: MaterialRefreshBatch, at: string): MaterialRefreshBatch {
  const timestamp = assertIsoTimestamp('batch transition at', at);
  invariant(
    batch.status === 'prepared' || batch.status === 'paused',
    'invalid_transition',
    `material batch ${batch.batchId} is ${batch.status} and cannot be started`,
    { batchId: batch.batchId, status: batch.status },
  );
  return frozen({
    ...batch,
    status: 'running',
    startedAt: batch.startedAt ?? timestamp,
    cancelledAt: null,
    updatedAt: timestamp,
  });
}

/** Mark one pending (or interrupted) item as the attempt now in flight; attempts increase by one. */
export function beginMaterialRefreshItem(
  batch: MaterialRefreshBatch,
  index: number,
  at: string,
): MaterialRefreshBatch {
  const timestamp = assertIsoTimestamp('item transition at', at);
  invariant(batch.status === 'running', 'invalid_transition', 'items can only start inside a running batch', {
    batchId: batch.batchId,
    status: batch.status,
  });
  const item = itemAt(batch, index);
  invariant(
    item.status === 'pending',
    'invalid_transition',
    `material batch item ${item.problemKey} is ${item.status} and cannot start`,
    { problemKey: item.problemKey, status: item.status },
  );
  return replaceItem(batch, index, {
    ...item,
    status: 'running',
    attempts: item.attempts + 1,
    failure: null,
    result: null,
    startedAt: timestamp,
    finishedAt: null,
  }, timestamp, false);
}

/**
 * Record a completed attempt: the platform answered, and the item carries the sanitized outcome.
 *
 * When this was the last piece of work of the run the batch settles in the **same** write (see
 * {@link replaceItemAndSettle}), so no persisted `running` batch is ever left without a pending or
 * running item.
 */
export function completeMaterialRefreshItem(
  batch: MaterialRefreshBatch,
  index: number,
  result: MaterialRefreshItemResult,
  at: string,
): MaterialRefreshBatch {
  const timestamp = assertIsoTimestamp('item transition at', at);
  const item = itemAt(batch, index);
  invariant(
    item.status === 'running',
    'invalid_transition',
    `material batch item ${item.problemKey} is ${item.status} and cannot complete`,
    { problemKey: item.problemKey, status: item.status },
  );
  return replaceItemAndSettle(
    batch,
    index,
    { ...item, status: 'completed', failure: null, result, finishedAt: timestamp },
    timestamp,
  );
}

/**
 * Restore one item a cancel transition marked `cancelled` to its already committed `completed`
 * outcome.
 *
 * Cancel and an in-flight platform read race: `ImportService.refreshMaterial` writes the snapshot
 * inside its commit transaction and only then returns the report, so a cancel that lands in between
 * stops an item whose material really exists. The committed success is the truth — otherwise a retry
 * would repeat platform IO whose result is already stored — so the item becomes `completed` and every
 * pending sibling stays exactly as the cancel recorded it. Only an item the cancel actually stopped
 * can be restored; the batch keeps its `cancelled` status and every other item.
 */
export function completeCancelledMaterialRefreshItem(
  batch: MaterialRefreshBatch,
  index: number,
  result: MaterialRefreshItemResult,
  at: string,
): MaterialRefreshBatch {
  const timestamp = assertIsoTimestamp('item transition at', at);
  invariant(
    batch.status === 'cancelled',
    'invalid_transition',
    `material batch ${batch.batchId} is ${batch.status}; only a cancelled batch can restore a committed success`,
    { batchId: batch.batchId, status: batch.status },
  );
  const item = itemAt(batch, index);
  invariant(
    item.status === 'cancelled',
    'invalid_transition',
    `material batch item ${item.problemKey} is ${item.status} and was not stopped by a cancel`,
    { problemKey: item.problemKey, status: item.status },
  );
  const items = [...batch.items];
  items[index] = { ...item, status: 'completed', failure: null, result, finishedAt: timestamp };
  return frozen({ ...batch, items, updatedAt: timestamp });
}

/**
 * Record a failed attempt: retryable attention that keeps every completed sibling untouched.
 *
 * Like {@link completeMaterialRefreshItem}, recording the last outcome also settles the run — as
 * `paused`, so the failure stays retryable and explicit.
 */
export function failMaterialRefreshItem(
  batch: MaterialRefreshBatch,
  index: number,
  failure: MaterialRefreshItemFailure,
  at: string,
  result: MaterialRefreshItemResult | null = null,
): MaterialRefreshBatch {
  const timestamp = assertIsoTimestamp('item transition at', at);
  const item = itemAt(batch, index);
  invariant(
    item.status === 'running',
    'invalid_transition',
    `material batch item ${item.problemKey} is ${item.status} and cannot fail`,
    { problemKey: item.problemKey, status: item.status },
  );
  return replaceItemAndSettle(
    batch,
    index,
    { ...item, status: 'attention', failure: { ...failure, attempts: item.attempts }, result, finishedAt: timestamp },
    timestamp,
  );
}

/**
 * Settle a run: `completed` when every item is done, otherwise `paused` so retry is explicit.
 *
 * The item transitions already settle a run whose last outcome they record, so this helper is the
 * explicit step for a `running` batch that still has work left to account for; it stays the single
 * definition of what settling means.
 */
export function settleMaterialRefreshBatchRun(batch: MaterialRefreshBatch, at: string): MaterialRefreshBatch {
  const timestamp = assertIsoTimestamp('batch transition at', at);
  invariant(batch.status === 'running', 'invalid_transition', 'only a running batch can settle', {
    batchId: batch.batchId,
    status: batch.status,
  });
  const done = batch.items.every((item) => item.status === 'completed');
  return frozen({
    ...batch,
    status: done ? 'completed' : 'paused',
    finishedAt: done ? timestamp : null,
    updatedAt: timestamp,
  });
}

/**
 * Cancel a batch: every item that is not completed becomes `cancelled` and no pending item may start.
 *
 * Idempotent by construction: a cancelled or completed batch comes back unchanged, so a repeated
 * cancel never advances the revision or rewrites a preserved completed sibling.
 */
export function cancelMaterialRefreshBatch(batch: MaterialRefreshBatch, at: string): MaterialRefreshBatch {
  const timestamp = assertIsoTimestamp('batch transition at', at);
  invariant(
    batch.status !== 'completed',
    'invalid_transition',
    `material batch ${batch.batchId} is completed and cannot be cancelled`,
    { batchId: batch.batchId, status: batch.status },
  );
  if (batch.status === 'cancelled') {
    return batch;
  }
  const items = batch.items.map((item) =>
    item.status === 'completed'
      ? item
      : {
          ...item,
          status: 'cancelled' as const,
          // An item that never started has no finish instant; one caught in flight records when it
          // stopped, so a stopped attempt stays distinguishable from one that ran to completion.
          finishedAt: item.status === 'pending' ? null : item.finishedAt ?? timestamp,
        },
  );
  return frozen({
    ...batch,
    items,
    status: 'cancelled',
    finishedAt: null,
    cancelledAt: timestamp,
    updatedAt: timestamp,
  });
}

/**
 * Reset exactly the non-completed attention/cancelled items to `pending`.
 *
 * A completed item is never repeated, and a `completed` batch is terminal, so this helper cannot
 * resurrect finished platform work. The batch returns to the state that truthfully describes it:
 * a batch cancelled **before its first start** (`startedAt === null`) becomes `prepared`, because no
 * platform read ever happened; one cancelled after a start becomes `paused`, keeping its start time.
 * Either way the following start is an explicit caller decision rather than an automatic resume. A
 * batch with nothing to retry — a freshly prepared one, or a paused one whose remaining items are
 * merely pending — is returned unchanged instead of being moved to a state the caller never asked
 * for.
 */
export function retryFailedMaterialRefreshBatch(batch: MaterialRefreshBatch, at: string): MaterialRefreshBatch {
  const timestamp = assertIsoTimestamp('batch transition at', at);
  invariant(
    batch.status !== 'running',
    'invalid_transition',
    `material batch ${batch.batchId} is running; cancel or wait before retrying failures`,
    { batchId: batch.batchId, status: batch.status },
  );
  if (batch.status === 'completed') {
    // Terminal: a fully completed batch has nothing to retry and is returned unchanged.
    return batch;
  }
  if (!batch.items.some((item) => item.status === 'attention' || item.status === 'cancelled')) {
    // Nothing failed and nothing was cancelled, so there is no retry to record.
    return batch;
  }
  const items = batch.items.map((item) =>
    item.status === 'completed' || item.status === 'running'
      ? item
      : {
          ...item,
          status: 'pending' as const,
          failure: null,
          result: null,
          finishedAt: null,
        },
  );
  // A cancel before the first start leaves `startedAt` null, so `prepared` is the only honest
  // destination; pretending such a batch was paused would claim a run that never happened.
  const status: MaterialRefreshBatchStatus =
    batch.status === 'cancelled' && batch.startedAt === null ? 'prepared' : 'paused';
  return frozen({
    ...batch,
    items,
    status,
    finishedAt: null,
    cancelledAt: null,
    updatedAt: timestamp,
  });
}

/**
 * Recovery transition: a batch left `running` by a dead process becomes `paused`, and its in-flight
 * item becomes retryable `attention`.
 *
 * Nothing here performs network work — recovery only makes the durable state truthful, and the
 * caller must explicitly resume or retry.
 */
export function interruptMaterialRefreshBatch(batch: MaterialRefreshBatch, at: string): MaterialRefreshBatch {
  const timestamp = assertIsoTimestamp('recovery at', at);
  invariant(
    batch.status === 'running',
    'invalid_transition',
    `material batch ${batch.batchId} is ${batch.status} and was not interrupted`,
    { batchId: batch.batchId, status: batch.status },
  );
  const items = batch.items.map((item) =>
    item.status === 'running'
      ? {
          ...item,
          status: 'attention' as const,
          failure: interruptedFailure(item.attempts),
          finishedAt: timestamp,
        }
      : item,
  );
  return frozen({ ...batch, items, status: 'paused', finishedAt: null, updatedAt: timestamp });
}

/** The failure recorded when a crash, restart or disposal cut an in-flight attempt short. */
export function interruptedFailure(attempts: number): MaterialRefreshItemFailure {
  return {
    code: 'interrupted',
    retryable: true,
    retryAfterMs: null,
    attempts: Math.max(1, attempts),
  };
}

/**
 * Validate one save against the stored record.
 *
 * Identity is fixed, attempts only move forward, a completed item is immutable (its committed
 * snapshot is never rewritten) and only the declared status transitions are legal. A stale caller
 * cannot use this to resurrect work: the store's revision compare-and-set runs first.
 */
export function validateMaterialRefreshBatchTransition(
  previous: MaterialRefreshBatch,
  next: MaterialRefreshBatch,
): void {
  validateMaterialRefreshBatch(previous);
  validateMaterialRefreshBatch(next);
  invariant(
    previous.batchId === next.batchId &&
      previous.createdAt === next.createdAt &&
      previous.items.length === next.items.length,
    'immutable_violation',
    `material batch ${previous.batchId} already exists with a different identity`,
    { batchId: previous.batchId },
  );
  invariant(
    instant(next.updatedAt) >= instant(previous.updatedAt),
    'invalid_transition',
    `material batch ${previous.batchId} would move updatedAt backwards`,
    { batchId: previous.batchId, previous: previous.updatedAt, next: next.updatedAt },
  );
  invariant(
    BATCH_STATUS_TRANSITIONS[previous.status].includes(next.status),
    'invalid_transition',
    `material batch ${previous.batchId} cannot move from ${previous.status} to ${next.status}`,
    { batchId: previous.batchId, previousStatus: previous.status, status: next.status },
  );
  for (const [index, before] of previous.items.entries()) {
    const after = next.items[index];
    invariant(after !== undefined, 'immutable_violation', 'material batch items are fixed at creation', {
      batchId: previous.batchId,
    });
    invariant(
      before.problemKey === after.problemKey &&
        before.accountId === after.accountId &&
        before.officialTutorialUrl === after.officialTutorialUrl &&
        before.fetchStatement === after.fetchStatement,
      'immutable_violation',
      `material batch item ${before.problemKey} already exists with a different selection`,
      { batchId: previous.batchId, problemKey: before.problemKey },
    );
    invariant(
      after.attempts >= before.attempts,
      'invalid_transition',
      `material batch item ${before.problemKey} would lose recorded attempts`,
      { problemKey: before.problemKey, previous: before.attempts, next: after.attempts },
    );
    invariant(
      ITEM_STATUS_TRANSITIONS[before.status].includes(after.status),
      'invalid_transition',
      `material batch item ${before.problemKey} cannot move from ${before.status} to ${after.status}`,
      { problemKey: before.problemKey, previousStatus: before.status, status: after.status },
    );
    if (before.status === 'completed') {
      invariant(
        canonicalJson(before) === canonicalJson(after),
        'immutable_violation',
        `completed material batch item ${before.problemKey} cannot be rewritten`,
        { problemKey: before.problemKey },
      );
    }
  }
}

const BATCH_STATUS_TRANSITIONS: Readonly<Record<MaterialRefreshBatchStatus, readonly MaterialRefreshBatchStatus[]>> = {
  prepared: ['prepared', 'running', 'cancelled'],
  running: ['running', 'paused', 'completed', 'cancelled'],
  paused: ['paused', 'running', 'cancelled'],
  // Retry places a cancelled batch back where it truthfully belongs: `prepared` when it was cancelled
  // before its first start (no start instant), `paused` when a run had already happened.
  cancelled: ['cancelled', 'prepared', 'paused'],
  completed: ['completed'],
};

const ITEM_STATUS_TRANSITIONS: Readonly<Record<MaterialRefreshItemStatus, readonly MaterialRefreshItemStatus[]>> = {
  pending: ['pending', 'running', 'cancelled'],
  running: ['running', 'completed', 'attention', 'cancelled'],
  attention: ['attention', 'pending', 'cancelled'],
  // A cancelled item may be reset for an explicit retry, or restored to `completed` when the attempt
  // cancelled under it had already committed its snapshot (`completeCancelledMaterialRefreshItem`):
  // the committed material is the truth, and a retry would otherwise repeat platform IO whose result
  // already exists. A `completed` item stays immutable either way.
  cancelled: ['cancelled', 'pending', 'completed'],
  completed: ['completed'],
};

// ---------------------------------------------------------------------------------------
// Report classification
// ---------------------------------------------------------------------------------------

/**
 * Whether one refresh report is a completed item, and if not, the sanitized failure to record.
 *
 * The rule the whole stage rests on: an operational failure is never an absence. `found` and
 * `absent` are both completed observations, while a failed editorial, a failed requested statement
 * or a refresh that persisted nothing (no stored metadata) becomes a retryable attention item.
 */
export type MaterialRefreshItemOutcome =
  | { readonly kind: 'completed'; readonly result: MaterialRefreshItemResult }
  | { readonly kind: 'failed'; readonly failure: MaterialRefreshItemFailure; readonly result: MaterialRefreshItemResult | null };

export function classifyMaterialRefreshReport(report: RefreshMaterialReport): MaterialRefreshItemOutcome {
  const statement: MaterialRefreshStatementStatus =
    report.statement.status === 'fetched' ? 'fetched' : report.statement.status === 'failed' ? 'failed' : 'not_requested';
  const editorialResult = report.editorial.result;
  const found = editorialResult !== null && editorialResult.status === 'found' ? editorialResult : null;
  const mirror: MaterialRefreshMirrorStatus | null =
    report.editorial.attempted || report.mirror.status === 'fetched'
      ? report.mirror.status === 'fetched'
        ? 'fetched'
        : 'skipped'
      : null;
  const result: MaterialRefreshItemResult = {
    statement,
    editorial: editorialResult === null ? null : editorialResult.status,
    mirror,
    sourceCount: found === null ? 0 : found.sources.length,
    solutionCount: found === null ? 0 : found.solutions.length,
    snapshot:
      report.snapshot === null
        ? null
        : {
            snapshotId: report.snapshot.snapshotId,
            version: report.snapshot.version,
            contentHash: report.snapshot.contentHash,
            changed: report.snapshot.changed,
          },
  };

  if (report.problem === null) {
    // No stored metadata and no fetched metadata: nothing could be persisted, and inventing a body
    // is forbidden. Recorded as a missing reference so a later sync can repair it.
    return { kind: 'failed', failure: failureOf('missing_reference', true, null, 1), result };
  }

  const editorialFailure = editorialFailureOf(report);
  if (editorialFailure !== null) {
    return { kind: 'failed', failure: editorialFailure, result };
  }
  if (report.statement.status === 'failed' && report.statement.error !== null) {
    // The statement half failed while the material half may have succeeded: the item is retryable
    // attention, and the stored material stays exactly as the successful merge left it.
    return { kind: 'failed', failure: fromPlatformError(report.statement.error), result };
  }
  return { kind: 'completed', result };
}

/** Failure of the editorial half of one report, or `null` when the material answered. */
function editorialFailureOf(report: RefreshMaterialReport): MaterialRefreshItemFailure | null {
  if (report.editorial.error !== null) {
    return fromPlatformError(report.editorial.error);
  }
  const result = report.editorial.result;
  if (result === null || result.status === 'found' || result.status === 'absent') {
    return null;
  }
  if (result.status === 'rate_limited') {
    return failureOf('rate_limited', true, result.retryAfterMs, 1);
  }
  if (result.status === 'unavailable') {
    // A temporary outage may declare Retry-After too; the item keeps the provider's own deadline so a
    // caller can schedule the retry instead of guessing, and `null` still means "no declaration".
    return failureOf('unavailable', result.retryable, result.retryAfterMs ?? null, 1);
  }
  return failureOf(result.status, false, null, 1);
}

/** Sanitized failure of one typed platform error; cancellation is a status, never a failure code. */
export function fromPlatformError(error: PlatformError): MaterialRefreshItemFailure {
  const code = platformFailureCode(error.code);
  return failureOf(code, error.retryable, error.retryAfterMs, error.attempts);
}

/** Map one platform code onto this module's failure vocabulary. */
export function platformFailureCode(code: PlatformErrorCode): MaterialRefreshFailureCode {
  switch (code) {
    case 'auth_required':
    case 'forbidden':
    case 'rate_limited':
    case 'unavailable':
    case 'changed_response':
      return code;
    case 'invalid_input':
      // The adapter refused the stored reference (a bad key or tutorial URL): retryable only after
      // the reference itself is corrected, never as a transient platform condition.
      return 'invalid_reference';
    case 'cancelled':
      return 'interrupted';
  }
}

/** Build one validated failure record. */
export function failureOf(
  code: MaterialRefreshFailureCode,
  retryable: boolean,
  retryAfterMs: number | null,
  attempts: number,
): MaterialRefreshItemFailure {
  return {
    code,
    retryable,
    retryAfterMs: retryAfterMs !== null && Number.isInteger(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : null,
    attempts: Math.max(1, Math.trunc(attempts)),
  };
}

// ---------------------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------------------

/**
 * Public, order-preserving projection of one batch.
 *
 * It is metadata only: item identity and status, attempts, retry metadata, statement/editorial/mirror
 * status, snapshot id/version/hash/changed flag and counts. The stored official tutorial URL is
 * replaced by a boolean, the stored account id (which encodes its handle) is dropped entirely, and no
 * field exists for a problem title, a statement, an editorial body, a raw tag or a provider error
 * text.
 */
export function materialRefreshBatchView(batch: MaterialRefreshBatch): MaterialRefreshBatchView {
  return {
    batchId: batch.batchId,
    status: batch.status,
    revision: batch.revision,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    startedAt: batch.startedAt,
    finishedAt: batch.finishedAt,
    cancelledAt: batch.cancelledAt,
    itemCount: batch.items.length,
    counts: countsOf(batch),
    items: batch.items.map((item) => ({
      problemKey: item.problemKey,
      fetchStatement: item.fetchStatement,
      hasOfficialTutorial: item.officialTutorialUrl !== null,
      status: item.status,
      attempts: item.attempts,
      failure:
        item.failure === null
          ? null
          : {
              code: item.failure.code,
              retryable: item.failure.retryable,
              retryAfterMs: item.failure.retryAfterMs,
              attempts: item.failure.attempts,
            },
      result:
        item.result === null
          ? null
          : {
              statement: item.result.statement,
              editorial: item.result.editorial,
              mirror: item.result.mirror,
              sourceCount: item.result.sourceCount,
              solutionCount: item.result.solutionCount,
              snapshot:
                item.result.snapshot === null
                  ? null
                  : {
                      snapshotId: item.result.snapshot.snapshotId,
                      version: item.result.snapshot.version,
                      contentHash: item.result.snapshot.contentHash,
                      changed: item.result.snapshot.changed,
                    },
            },
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
    })),
  };
}

/** Public projection of one batch without its item list, for the bounded list read. */
export function materialRefreshBatchSummaryView(batch: MaterialRefreshBatch): MaterialRefreshBatchSummaryView {
  return {
    batchId: batch.batchId,
    status: batch.status,
    revision: batch.revision,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    finishedAt: batch.finishedAt,
    cancelledAt: batch.cancelledAt,
    itemCount: batch.items.length,
    counts: countsOf(batch),
  };
}

/** Per-status totals of one batch, computed from the items so they can never drift. */
export function countsOf(batch: MaterialRefreshBatch): MaterialRefreshBatchCounts {
  const counts = { pending: 0, running: 0, completed: 0, attention: 0, cancelled: 0, changedSnapshots: 0 };
  for (const item of batch.items) {
    counts[item.status] += 1;
    if (item.status === 'completed' && item.result?.snapshot?.changed === true) {
      counts.changedSnapshots += 1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------------------
// Shared field checks
// ---------------------------------------------------------------------------------------

/** Epoch milliseconds of an already-validated ISO timestamp, for ordering checks. */
function instant(value: string): number {
  return Date.parse(value);
}

/** The canonical key of a stored problem reference, re-derived through the domain's own parser. */
function canonicalKeyOf(label: string, value: unknown): string {
  invariant(typeof value === 'string' && value.length > 0, 'invalid_input', `${label} is required`, { label });
  return problemKey(parseProblemKey(value));
}

/** A canonical account id; a foreign or invented spelling is refused before any store lookup. */
function canonicalAccountOf(value: unknown): string {
  invariant(typeof value === 'string' && value.length > 0, 'invalid_input', 'item accountId must be a string', {
    valueType: typeof value,
  });
  parseAccountId(value);
  return value;
}

function requireText(label: string, value: unknown): string {
  invariant(
    typeof value === 'string' && value.trim().length > 0,
    'invalid_input',
    `${label} is required`,
    { label, value },
  );
  return value;
}

function requireCount(label: string, value: unknown, min: number): number {
  invariant(
    typeof value === 'number' && Number.isInteger(value) && value >= min,
    'invalid_input',
    `${label} must be an integer >= ${min}`,
    { label, value },
  );
  return value;
}

/**
 * A closed record: every declared field present, no undeclared one accepted.
 *
 * Used on every nested record as well, so an extra member cannot hide inside a failure, a result or a
 * snapshot descriptor. The check is deliberately structural (own keys), because the body it judges
 * comes from `JSON.parse` and therefore can only carry own enumerable members.
 */
function requireExactFields(
  label: string,
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  invariant(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid_input',
    `${label} must be an object`,
    { label, valueType: typeof value },
  );
  const record = value as Record<string, unknown>;
  const undeclared = Object.keys(record).filter((key) => !fields.includes(key));
  invariant(
    undeclared.length === 0,
    'invalid_input',
    `${label} carries undeclared field(s): ${undeclared.join(', ')}`,
    { label, fields: undeclared },
  );
  const missing = fields.filter((field) => !Object.prototype.hasOwnProperty.call(record, field));
  invariant(
    missing.length === 0,
    'invalid_input',
    `${label} is missing field(s): ${missing.join(', ')}`,
    { label, fields: missing },
  );
  return record;
}

function itemAt(batch: MaterialRefreshBatch, index: number): MaterialRefreshBatchItem {
  invariant(
    Number.isInteger(index) && index >= 0 && index < batch.items.length,
    'invalid_input',
    'material batch item index is out of range',
    { batchId: batch.batchId, index },
  );
  const item = batch.items[index];
  invariant(item !== undefined, 'missing_reference', 'material batch item is missing', {
    batchId: batch.batchId,
    index,
  });
  return item;
}

function replaceItem(
  batch: MaterialRefreshBatch,
  index: number,
  item: MaterialRefreshBatchItem,
  at: string,
  touchCancelledAt: boolean,
): MaterialRefreshBatch {
  const items = [...batch.items];
  items[index] = item;
  return frozen({
    ...batch,
    items,
    updatedAt: at,
    ...(touchCancelledAt ? { cancelledAt: batch.cancelledAt } : {}),
  });
}

/**
 * Record one item outcome and settle the run in the **same** write when it was the last work.
 *
 * A persisted `running` batch must always have a pending or running item: a running record with no
 * work left could neither be settled by a later step (a crash between the two writes would leave a
 * state that recovery pauses and that `startMaterialRefreshBatch` can never legally resume) nor be
 * read back as valid at all, because {@link validateMaterialRefreshBatch} refuses it. So the last
 * outcome of a run settles it atomically — `completed` when every item completed, otherwise `paused`
 * so retry stays explicit — producing exactly the record {@link settleMaterialRefreshBatchRun} would
 * have produced on the next step, without ever representing the impossible intermediate state.
 */
function replaceItemAndSettle(
  batch: MaterialRefreshBatch,
  index: number,
  item: MaterialRefreshBatchItem,
  at: string,
): MaterialRefreshBatch {
  const items = [...batch.items];
  items[index] = item;
  const workLeft = items.some((entry) => entry.status === 'pending' || entry.status === 'running');
  const completed = items.every((entry) => entry.status === 'completed');
  return frozen({
    ...batch,
    items,
    updatedAt: at,
    ...(batch.status === 'running' && !workLeft
      ? { status: completed ? ('completed' as const) : ('paused' as const), finishedAt: completed ? at : null }
      : {}),
  });
}

function frozen(batch: MaterialRefreshBatch): MaterialRefreshBatch {
  validateMaterialRefreshBatch(batch);
  return deepFreeze(batch);
}
