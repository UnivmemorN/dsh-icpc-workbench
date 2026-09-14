/**
 * Virtual-contest performance ledger service (Sprint 18c).
 *
 * One Codeforces account owns one revisioned ledger of **user-entered** virtual-contest results.
 * This service is the only writer: it proves the account exists and belongs to a Codeforces source,
 * validates every field through the domain's strict validator, deduplicates by contest id, and
 * appends exactly the next ledger revision under the store's compare-and-set.
 *
 * The rules that make the ledger trustworthy:
 *
 * - **Full CRUD.** `list` reads, `save` adds a row or replaces an existing `evidenceId`, `delete`
 *   removes one row. A save naming a `contestId` that another row already holds is refused, so a
 *   repeated virtual run of one contest is an explicit update instead of a double count.
 * - **CAS on every mutation.** `expectedRevision` is the revision the caller read (`0` when no
 *   ledger exists yet). A mismatch is refused before any write, and the revision advances on every
 *   save and every delete — including a delete that empties the ledger — so an ABA resurrection is
 *   impossible.
 * - **No clock trust.** `now()` is injected; `participatedAt` must not lie in the future relative to
 *   it, and `updatedAt` is that same instant. The domain stays clock-free.
 * - **Local-only notes.** `note` is stored and returned to its owner, and is deliberately absent
 *   from the identifier-free planning summary.
 *
 * Failures are typed `DomainError`s (`missing_reference`, `duplicate_id`, `invalid_transition`,
 * `invalid_input`/`invalid_url`), so the HTTP boundary maps them to stable codes without inventing
 * prose.
 */
import {
  createVirtualPerformanceLedger,
  invariant,
  validateVirtualPerformanceEvidence,
  type Account,
  type CancellationToken,
  type SourceInstance,
  type VirtualPerformanceCounts,
  type VirtualPerformanceEvidence,
  type VirtualPerformanceIndependence,
  type VirtualPerformanceLedger,
  VIRTUAL_PERFORMANCE_DISCLOSURE,
  MAX_VIRTUAL_PERFORMANCE_EVIDENCE_ID_CHARS,
  MAX_VIRTUAL_PERFORMANCE_METHOD_CHARS,
  MAX_VIRTUAL_PERFORMANCE_NOTE_CHARS,
  MAX_VIRTUAL_PERFORMANCE_ROWS,
  VIRTUAL_PERFORMANCE_INDEPENDENCE,
} from '../domain/index.js';

/** Revision a caller passes when no ledger exists yet. */
export const NO_VIRTUAL_PERFORMANCE_LEDGER_REVISION = 0;

/** Persistence surface the service needs; the SQLite adapter implements all of it. */
export interface VirtualPerformanceStorePort {
  getAccount(id: string): Promise<Account | null>;
  getSourceInstance(id: string): Promise<SourceInstance | null>;
  getVirtualPerformanceLedger(accountId: string): Promise<VirtualPerformanceLedger | null>;
  /** Append exactly the next revision; `expectedRevision` 0 means no prior ledger. */
  saveVirtualPerformanceLedger(record: VirtualPerformanceLedger, expectedRevision: number): Promise<void>;
  transaction<T>(work: () => Promise<T>): Promise<T>;
}

export interface VirtualPerformanceServiceOptions {
  readonly store: VirtualPerformanceStorePort;
  /** Injected clock; every stored instant comes from here. */
  readonly now: () => string;
  /** Injected id source for a new evidence row. */
  readonly uniqueId: () => string;
}

export interface VirtualPerformanceListRequest {
  readonly accountId: string;
}

/** One save: add a row (`evidenceId` omitted) or replace the named row. */
export interface VirtualPerformanceSaveRequest {
  readonly accountId: string;
  /** Ledger revision the caller read; {@link NO_VIRTUAL_PERFORMANCE_LEDGER_REVISION} before the first row. */
  readonly expectedRevision: number;
  /** Existing row to replace; omitted/`null` adds a new row. */
  readonly evidenceId?: string | null;
  readonly contestId: number;
  readonly participatedAt: string;
  readonly performance: number;
  readonly calculationMethod: string;
  readonly sourceUrl: string;
  readonly independence: VirtualPerformanceIndependence;
  readonly priorExposure: boolean;
  readonly rank?: number | null;
  readonly note?: string | null;
}

export interface VirtualPerformanceDeleteRequest {
  readonly accountId: string;
  readonly expectedRevision: number;
  readonly evidenceId: string;
}

/** One account's ledger as its owner reads it; `official` is always the literal `false`. */
export interface VirtualPerformanceLedgerView {
  readonly accountId: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly source: 'user_import';
  readonly entries: readonly VirtualPerformanceEvidence[];
  readonly counts: VirtualPerformanceCounts;
  /** Always false: this evidence is user-entered and is never an official score. */
  readonly official: false;
  readonly disclosure: string;
}

const SAVE_REQUEST_KEYS: readonly string[] = [
  'accountId',
  'expectedRevision',
  'evidenceId',
  'contestId',
  'participatedAt',
  'performance',
  'calculationMethod',
  'sourceUrl',
  'independence',
  'priorExposure',
  'rank',
  'note',
];
const LIST_REQUEST_KEYS: readonly string[] = ['accountId'];
const DELETE_REQUEST_KEYS: readonly string[] = ['accountId', 'expectedRevision', 'evidenceId'];

/** One account's user-entered virtual-contest performance ledger. */
export class VirtualPerformanceService {
  private readonly store: VirtualPerformanceStorePort;
  private readonly now: () => string;
  private readonly uniqueId: () => string;

  constructor(options: VirtualPerformanceServiceOptions) {
    invariant(
      options !== null && typeof options === 'object',
      'unfilled_settings',
      'virtual performance service needs an options object',
      {},
    );
    invariant(
      options.store !== null && typeof options.store === 'object',
      'unfilled_settings',
      'virtual performance service needs a store',
      {},
    );
    invariant(
      typeof options.now === 'function' && typeof options.uniqueId === 'function',
      'unfilled_settings',
      'virtual performance service needs injected now() and uniqueId()',
      {},
    );
    this.store = options.store;
    this.now = options.now;
    this.uniqueId = options.uniqueId;
  }

  /** One account's ledger; an untouched account reads an explicit empty view, never a zero score. */
  async list(request: VirtualPerformanceListRequest, token: CancellationToken): Promise<VirtualPerformanceLedgerView> {
    requireToken(token);
    token.throwIfCancelled();
    const accountId = requestField(LIST_REQUEST_KEYS, 'list', request, 'accountId');
    const account = await this.requireCodeforcesAccount(accountId, token);
    const ledger = await this.store.getVirtualPerformanceLedger(account.id);
    token.throwIfCancelled();
    return viewOf(account.id, ledger);
  }

  /**
   * Add or replace one evidence row under CAS.
   *
   * Replacing names the existing `evidenceId`; adding names none. Either way the new row must not
   * introduce a second row for a `contestId` the ledger already holds.
   */
  async save(request: VirtualPerformanceSaveRequest, token: CancellationToken): Promise<VirtualPerformanceLedgerView> {
    requireToken(token);
    token.throwIfCancelled();
    const parsed = parseSaveRequest(request);
    return this.store.transaction(async (): Promise<VirtualPerformanceLedgerView> => {
      token.throwIfCancelled();
      const account = await this.requireCodeforcesAccount(parsed.accountId, token);
      const current = await this.store.getVirtualPerformanceLedger(account.id);
      token.throwIfCancelled();
      const storedRevision = current?.revision ?? NO_VIRTUAL_PERFORMANCE_LEDGER_REVISION;
      requireCurrentRevision(parsed.expectedRevision, storedRevision, account.id);
      const at = this.now();
      const evidence = validateVirtualPerformanceEvidence({
        evidenceId: parsed.evidenceId ?? this.mintEvidenceId(),
        contestId: parsed.contestId,
        participatedAt: parsed.participatedAt,
        performance: parsed.performance,
        calculationMethod: parsed.calculationMethod,
        sourceUrl: parsed.sourceUrl,
        independence: parsed.independence,
        priorExposure: parsed.priorExposure,
        rank: parsed.rank,
        note: parsed.note,
      });
      invariant(
        Date.parse(evidence.participatedAt) <= Date.parse(at),
        'invalid_input',
        'virtual performance participatedAt must not be in the future',
        { reason: 'future_participation', participatedAt: evidence.participatedAt, now: at },
      );
      const entries = current?.entries ?? [];
      const existing = parsed.evidenceId === null ? null : entries.find((row) => row.evidenceId === parsed.evidenceId) ?? null;
      if (parsed.evidenceId !== null) {
        invariant(
          existing !== null,
          'missing_reference',
          `virtual performance evidence ${parsed.evidenceId} is not stored for account ${account.id}`,
          { reason: 'unknown_evidence', evidenceId: parsed.evidenceId, accountId: account.id },
        );
      }
      const clash = entries.find(
        (row) => row.contestId === evidence.contestId && row.evidenceId !== existing?.evidenceId,
      );
      invariant(
        clash === undefined,
        'duplicate_id',
        `virtual performance contest ${evidence.contestId} is already recorded as ${String(clash?.evidenceId)}; replace that row instead of adding a second one`,
        {
          reason: 'duplicate_contest',
          contestId: evidence.contestId,
          existingEvidenceId: clash?.evidenceId ?? null,
          accountId: account.id,
        },
      );
      const next = createVirtualPerformanceLedger({
        accountId: account.id,
        revision: storedRevision + 1,
        updatedAt: at,
        entries: [...entries.filter((row) => row.evidenceId !== evidence.evidenceId), evidence],
      });
      await this.store.saveVirtualPerformanceLedger(next, storedRevision);
      token.throwIfCancelled();
      return viewOf(account.id, next);
    });
  }

  /**
   * Delete one evidence row under CAS.
   *
   * The ledger row itself is kept with an empty `entries` array and the revision still advances, so
   * "the user deleted everything" stays distinguishable from "the account never had evidence" and a
   * stale screen cannot re-add a row against the revision it read.
   */
  async delete(request: VirtualPerformanceDeleteRequest, token: CancellationToken): Promise<VirtualPerformanceLedgerView> {
    requireToken(token);
    token.throwIfCancelled();
    const parsed = parseDeleteRequest(request);
    return this.store.transaction(async (): Promise<VirtualPerformanceLedgerView> => {
      token.throwIfCancelled();
      const account = await this.requireCodeforcesAccount(parsed.accountId, token);
      const current = await this.store.getVirtualPerformanceLedger(account.id);
      token.throwIfCancelled();
      const storedRevision = current?.revision ?? NO_VIRTUAL_PERFORMANCE_LEDGER_REVISION;
      requireCurrentRevision(parsed.expectedRevision, storedRevision, account.id);
      const entries = current?.entries ?? [];
      invariant(
        entries.some((row) => row.evidenceId === parsed.evidenceId),
        'missing_reference',
        `virtual performance evidence ${parsed.evidenceId} is not stored for account ${account.id}`,
        { reason: 'unknown_evidence', evidenceId: parsed.evidenceId, accountId: account.id },
      );
      const next = createVirtualPerformanceLedger({
        accountId: account.id,
        revision: storedRevision + 1,
        updatedAt: this.now(),
        entries: entries.filter((row) => row.evidenceId !== parsed.evidenceId),
      });
      await this.store.saveVirtualPerformanceLedger(next, storedRevision);
      token.throwIfCancelled();
      return viewOf(account.id, next);
    });
  }

  /** Mint one stable evidence id; the ledger is the only owner of the value. */
  private mintEvidenceId(): string {
    const value = this.uniqueId();
    invariant(
      typeof value === 'string' && value.trim().length > 0 && value.trim().length <= MAX_VIRTUAL_PERFORMANCE_EVIDENCE_ID_CHARS,
      'invalid_input',
      `uniqueId() must return 1..${MAX_VIRTUAL_PERFORMANCE_EVIDENCE_ID_CHARS} characters`,
      { value },
    );
    return value.trim();
  }

  /**
   * Prove the account exists on a Codeforces source.
   *
   * Virtual performance is a Codeforces-only concept in this product (other platforms are not
   * converted into CF rating), so a Luogu or manual account is refused instead of accepting a row
   * whose scale would be meaningless.
   */
  private async requireCodeforcesAccount(accountId: string, token: CancellationToken): Promise<Account> {
    const account = await this.store.getAccount(accountId);
    token.throwIfCancelled();
    invariant(account !== null, 'missing_reference', `account ${accountId} is not stored`, { accountId });
    const source = await this.store.getSourceInstance(account.sourceInstanceId);
    token.throwIfCancelled();
    invariant(
      source !== null,
      'missing_reference',
      `source instance ${account.sourceInstanceId} of account ${account.id} is not stored`,
      { accountId: account.id, sourceInstanceId: account.sourceInstanceId },
    );
    invariant(
      source.platform === 'codeforces',
      'invalid_input',
      'virtual-contest performance evidence is Codeforces-only; this account belongs to another platform',
      { reason: 'not_codeforces', accountId: account.id, platform: source.platform },
    );
    return account;
  }
}

/** One account's ledger as its owner sees it; an absent ledger is an explicit empty view. */
function viewOf(accountId: string, ledger: VirtualPerformanceLedger | null): VirtualPerformanceLedgerView {
  const entries = ledger?.entries ?? [];
  return {
    accountId,
    revision: ledger?.revision ?? NO_VIRTUAL_PERFORMANCE_LEDGER_REVISION,
    updatedAt: ledger?.updatedAt ?? '',
    source: 'user_import',
    entries,
    counts: virtualPerformanceCountsOf(entries),
    official: false,
    disclosure: VIRTUAL_PERFORMANCE_DISCLOSURE,
  };
}

/** Local re-export so the view stays a pure projection of the domain counter. */
function virtualPerformanceCountsOf(entries: readonly VirtualPerformanceEvidence[]): VirtualPerformanceCounts {
  let eligibleIndependent = 0;
  let assisted = 0;
  let unknownIndependence = 0;
  let priorExposed = 0;
  for (const entry of entries) {
    if (entry.independence === 'assisted') {
      assisted += 1;
    } else if (entry.independence === 'unknown') {
      unknownIndependence += 1;
    }
    if (entry.priorExposure) {
      priorExposed += 1;
    }
    if (entry.independence === 'independent' && !entry.priorExposure) {
      eligibleIndependent += 1;
    }
  }
  return { total: entries.length, eligibleIndependent, assisted, unknownIndependence, priorExposed };
}

function requireToken(token: CancellationToken): void {
  invariant(
    token !== null && token !== undefined && typeof token.throwIfCancelled === 'function',
    'unfilled_settings',
    'a cancellation token is required',
    {},
  );
}

function requireCurrentRevision(expected: number, stored: number, accountId: string): void {
  invariant(
    expected === stored,
    'invalid_transition',
    `virtual performance ledger of account ${accountId} is at revision ${stored}, not ${expected}; re-read before saving`,
    { reason: 'stale_revision', accountId, expectedRevision: expected, storedRevision: stored },
  );
}

/** One object field of a request; an undeclared key or a non-object is refused. */
function requestField(keys: readonly string[], operation: string, request: unknown, field: string): string {
  invariant(
    request !== null && typeof request === 'object' && !Array.isArray(request),
    'invalid_input',
    `virtual performance ${operation} needs a request object`,
    { operation },
  );
  const record = request as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !keys.includes(key));
  invariant(
    unknownKeys.length === 0,
    'invalid_input',
    `virtual performance ${operation} has unknown keys: ${unknownKeys.join(', ')}`,
    { operation, unknownKeys },
  );
  const value = record[field];
  invariant(
    typeof value === 'string' && value.trim().length > 0,
    'invalid_input',
    `virtual performance ${operation} ${field} must be a non-empty string`,
    { operation, field },
  );
  return value;
}

interface ParsedSave extends Omit<VirtualPerformanceSaveRequest, 'evidenceId' | 'rank' | 'note'> {
  readonly evidenceId: string | null;
  readonly rank: number | null;
  readonly note: string | null;
}

/** Structural validation of one save; the domain validator owns the semantic bounds. */
function parseSaveRequest(request: VirtualPerformanceSaveRequest): ParsedSave {
  invariant(
    request !== null && typeof request === 'object' && !Array.isArray(request),
    'invalid_input',
    'virtual performance save needs a request object',
    {},
  );
  const record = request as unknown as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !SAVE_REQUEST_KEYS.includes(key));
  invariant(
    unknownKeys.length === 0,
    'invalid_input',
    `virtual performance save has unknown keys: ${unknownKeys.join(', ')}`,
    { unknownKeys },
  );
  const accountId = requestField(SAVE_REQUEST_KEYS, 'save', request, 'accountId');
  const expectedRevision = record['expectedRevision'];
  invariant(
    typeof expectedRevision === 'number' && Number.isSafeInteger(expectedRevision) && expectedRevision >= 0,
    'invalid_input',
    'virtual performance save expectedRevision must be an integer >= 0',
    { expectedRevision },
  );
  invariant(
    typeof record['contestId'] === 'number',
    'invalid_input',
    'virtual performance save contestId must be a number',
    { contestId: record['contestId'] },
  );
  invariant(
    typeof record['participatedAt'] === 'string',
    'invalid_input',
    'virtual performance save participatedAt must be a string',
    { participatedAt: record['participatedAt'] },
  );
  invariant(
    typeof record['performance'] === 'number',
    'invalid_input',
    'virtual performance save performance must be a number',
    { performance: record['performance'] },
  );
  invariant(
    typeof record['calculationMethod'] === 'string' &&
      record['calculationMethod'].trim().length > 0 &&
      record['calculationMethod'].trim().length <= MAX_VIRTUAL_PERFORMANCE_METHOD_CHARS,
    'invalid_input',
    `virtual performance save calculationMethod must be 1..${MAX_VIRTUAL_PERFORMANCE_METHOD_CHARS} characters`,
    {},
  );
  invariant(
    typeof record['sourceUrl'] === 'string',
    'invalid_input',
    'virtual performance save sourceUrl must be a string',
    {},
  );
  invariant(
    VIRTUAL_PERFORMANCE_INDEPENDENCE.includes(record['independence'] as VirtualPerformanceIndependence),
    'invalid_input',
    `virtual performance save independence must be one of: ${VIRTUAL_PERFORMANCE_INDEPENDENCE.join(', ')}`,
    { independence: record['independence'] },
  );
  invariant(
    typeof record['priorExposure'] === 'boolean',
    'invalid_input',
    'virtual performance save priorExposure must be boolean',
    {},
  );
  const evidenceId = record['evidenceId'];
  invariant(
    evidenceId === undefined || evidenceId === null || (typeof evidenceId === 'string' && evidenceId.trim().length > 0),
    'invalid_input',
    'virtual performance save evidenceId must be a non-empty string or null',
    { evidenceId },
  );
  const rank = record['rank'];
  invariant(
    rank === undefined || rank === null || (typeof rank === 'number' && Number.isSafeInteger(rank)),
    'invalid_input',
    'virtual performance save rank must be an integer or null',
    { rank },
  );
  const note = record['note'];
  invariant(
    note === undefined ||
      note === null ||
      (typeof note === 'string' && note.trim().length <= MAX_VIRTUAL_PERFORMANCE_NOTE_CHARS),
    'invalid_input',
    `virtual performance save note must be at most ${MAX_VIRTUAL_PERFORMANCE_NOTE_CHARS} characters`,
    {},
  );
  return {
    accountId,
    expectedRevision,
    evidenceId: evidenceId === undefined || evidenceId === null ? null : (evidenceId as string).trim(),
    contestId: record['contestId'] as number,
    participatedAt: record['participatedAt'] as string,
    performance: record['performance'] as number,
    calculationMethod: (record['calculationMethod'] as string).trim(),
    sourceUrl: record['sourceUrl'] as string,
    independence: record['independence'] as VirtualPerformanceIndependence,
    priorExposure: record['priorExposure'],
    rank: rank === undefined || rank === null ? null : (rank as number),
    note: note === undefined || note === null ? null : (note as string).trim(),
  };
}

function parseDeleteRequest(request: VirtualPerformanceDeleteRequest): VirtualPerformanceDeleteRequest {
  invariant(
    request !== null && typeof request === 'object' && !Array.isArray(request),
    'invalid_input',
    'virtual performance delete needs a request object',
    {},
  );
  const record = request as unknown as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !DELETE_REQUEST_KEYS.includes(key));
  invariant(
    unknownKeys.length === 0,
    'invalid_input',
    `virtual performance delete has unknown keys: ${unknownKeys.join(', ')}`,
    { unknownKeys },
  );
  const expectedRevision = record['expectedRevision'];
  invariant(
    typeof expectedRevision === 'number' && Number.isSafeInteger(expectedRevision) && expectedRevision >= 0,
    'invalid_input',
    'virtual performance delete expectedRevision must be an integer >= 0',
    { expectedRevision },
  );
  const evidenceId = record['evidenceId'];
  invariant(
    typeof evidenceId === 'string' && evidenceId.trim().length > 0,
    'invalid_input',
    'virtual performance delete evidenceId must be a non-empty string',
    { evidenceId },
  );
  return {
    accountId: requestField(DELETE_REQUEST_KEYS, 'delete', request, 'accountId'),
    expectedRevision,
    evidenceId: evidenceId.trim(),
  };
}

/** `MAX_VIRTUAL_PERFORMANCE_ROWS` is re-exported so a UI can bound a list without importing domain. */
export { MAX_VIRTUAL_PERFORMANCE_ROWS };
