/**
 * Manual platform adapter: serves one parsed manual document as an offline platform.
 *
 * The document is the whole data source, so this adapter performs no IO and has no rate limit.
 * Everything it returns is an owned, frozen clone: mutating a returned page, a problem or the
 * original parse input can never change what a later call sees.
 *
 * Honest behaviour:
 * - capabilities advertise an `implemented`, paged, unauthenticated source and say in `notes`
 *   that the data is an explicit offline/manual import;
 * - an imported Codeforces/Luogu/Hydro problem keeps the source instance identity it was
 *   imported under — the adapter never rewrites it into a manual identity;
 * - editorial answers are exactly the document's: `found` for a declared record, `absent` only
 *   for an explicit user declaration, `unavailable` when no record was supplied;
 * - a missing problem or an unknown account rejects with a typed `invalid_input`/`unavailable`
 *   error instead of an empty success;
 * - cancellation is observed before any cached array is read, and cursors are opaque tokens
 *   bound to the document content hash, resource, source, account and `since` bound.
 */
import {
  accountIdOf,
  contentHashOf,
  deepFreeze,
  problemKey,
  type Account,
  type NormalizedProblem,
  type ProblemRef,
  type SourceInstance,
  type Submission,
} from '../../domain/index.js';
import type {
  EditorialFetchResult,
  FetchEditorialRequest,
  FetchProblemRequest,
  ListProblemsRequest,
  ListSubmissionsRequest,
  Page,
  PlatformAdapter,
  PlatformCapabilities,
} from '../../application/ports.js';
import { PlatformError, type PlatformOperation } from '../../application/platform-errors.js';
import { manualAttributionUrl, normalizeManualTimestamp } from './parse.js';
import {
  MANUAL_MAX_PAGE_LIMIT,
  MANUAL_MAX_ROWS,
  type ManualDocument,
  type ManualEditorialEntry,
  type ManualProblemMaterial,
} from './types.js';

/** Cursor payload version of the manual adapter's opaque tokens. */
export const MANUAL_CURSOR_VERSION = 1 as const;

const MAX_CURSOR_CHARS = 4096;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

type ManualResource = 'problems' | 'submissions';

interface CursorScope {
  readonly resource: ManualResource;
  readonly account: string | null;
  readonly since: string | null;
}

interface CursorPayload {
  readonly v: typeof MANUAL_CURSOR_VERSION;
  readonly hash: string;
  readonly resource: ManualResource;
  readonly source: string;
  readonly account: string | null;
  readonly since: string | null;
  readonly offset: number;
}

function messageOf(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.length <= 300 ? message : `${message.slice(0, 300)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidInput(operation: PlatformOperation, detail: string): PlatformError {
  return new PlatformError({ code: 'invalid_input', operation, retryable: false, detail });
}

function unavailable(operation: PlatformOperation, detail: string): PlatformError {
  return new PlatformError({ code: 'unavailable', operation, retryable: false, detail });
}

function requireLimit(limit: number, operation: PlatformOperation): number {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MANUAL_MAX_PAGE_LIMIT) {
    throw invalidInput(operation, `limit must be an integer in [1, ${MANUAL_MAX_PAGE_LIMIT}]`);
  }
  return limit;
}

// ---------------------------------------------------------------------------------------
// Owned clones
// ---------------------------------------------------------------------------------------

function cloneProblem(problem: NormalizedProblem): NormalizedProblem {
  return deepFreeze({
    ref: { ...problem.ref },
    key: problem.key,
    title: problem.title,
    url: problem.url,
    statement: problem.statement,
    ratings: problem.ratings.map((rating) => ({
      dimension: rating.dimension,
      value: rating.value,
      raw: rating.raw,
      scale: rating.scale === null ? null : { ...rating.scale },
    })),
    rawTags: problem.rawTags.map((tag) => ({ ...tag })),
    fetchedAt: problem.fetchedAt,
  });
}

function cloneSubmission(submission: Submission): Submission {
  return deepFreeze({ ...submission, ref: { ...submission.ref } });
}

function cloneEditorialResult(result: EditorialFetchResult): EditorialFetchResult {
  switch (result.status) {
    case 'found':
      return deepFreeze({
        status: 'found',
        sources: result.sources.map((source) => ({ ...source })),
        solutions: result.solutions.map((solution) => ({ ...solution })),
        retrievedAt: result.retrievedAt,
      });
    case 'absent':
      return { status: 'absent', detail: result.detail };
    case 'auth_required':
      return { status: 'auth_required', detail: result.detail };
    case 'forbidden':
      return { status: 'forbidden', detail: result.detail };
    case 'rate_limited':
      return { status: 'rate_limited', detail: result.detail, retryAfterMs: result.retryAfterMs };
    case 'unavailable':
      return { status: 'unavailable', detail: result.detail, retryable: result.retryable };
    case 'changed_response':
      return { status: 'changed_response', detail: result.detail, sample: result.sample };
  }
}

function cloneEditorialEntry(entry: ManualEditorialEntry): ManualEditorialEntry {
  return deepFreeze({
    problemKey: entry.problemKey,
    ref: { ...entry.ref },
    status: entry.status,
    url: entry.url,
    title: entry.title,
    note: entry.note,
    result: cloneEditorialResult(entry.result),
  });
}

// ---------------------------------------------------------------------------------------
// Document ownership and indexes
// ---------------------------------------------------------------------------------------

/** Validate the document's framing, then own a deep copy so caller mutations stay invisible. */
function ownDocument(value: unknown): ManualDocument {
  if (!isRecord(value)) {
    throw invalidInput('problem', 'the manual adapter requires a parsed manual document');
  }
  const source = value.source;
  if (
    !isRecord(source) ||
    typeof source.id !== 'string' ||
    typeof source.platform !== 'string' ||
    typeof source.baseUrl !== 'string' ||
    typeof source.displayName !== 'string' ||
    (source.domain !== null && typeof source.domain !== 'string')
  ) {
    throw invalidInput('problem', 'the manual document has no valid source instance');
  }
  for (const key of ['accounts', 'problems', 'submissions', 'editorials']) {
    if (!Array.isArray(value[key])) {
      throw invalidInput('problem', `the manual document has no valid ${key} array`);
    }
  }
  if (typeof value.contentHash !== 'string' || !SHA256_HEX.test(value.contentHash)) {
    throw invalidInput('problem', 'the manual document has no content hash');
  }
  if (typeof value.importedAt !== 'string' || normalizeManualTimestamp(value.importedAt) === null) {
    throw invalidInput('problem', 'the manual document has no valid importedAt timestamp');
  }
  let cloned: unknown;
  try {
    cloned = structuredClone(value);
  } catch (cause) {
    throw invalidInput('problem', `the manual document could not be copied: ${messageOf(cause)}`);
  }
  return deepFreeze(cloned) as ManualDocument;
}

function compareSubmissions(left: Submission, right: Submission): number {
  const leftAt = Date.parse(left.submittedAt);
  const rightAt = Date.parse(right.submittedAt);
  if (leftAt !== rightAt) {
    return leftAt - rightAt;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [value]);
  } else {
    list.push(value);
  }
}

// ---------------------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------------------

/**
 * One manual import served as a {@link PlatformAdapter}. Build it with
 * {@link createManualPlatformAdapter}; the constructor copies and freezes the document.
 */
export class ManualPlatformAdapter implements PlatformAdapter {
  readonly sourceInstance: SourceInstance;
  /** The owned, frozen document this adapter answers from. */
  readonly document: ManualDocument;
  private readonly problemList: readonly NormalizedProblem[];
  private readonly problemByKey: ReadonlyMap<string, NormalizedProblem>;
  private readonly editorialByKey: ReadonlyMap<string, ManualEditorialEntry>;
  private readonly accountIds: ReadonlySet<string>;
  private readonly submissionsByAccount: ReadonlyMap<string, readonly Submission[]>;
  private readonly submissionsByProblem: ReadonlyMap<string, readonly Submission[]>;

  constructor(document: ManualDocument) {
    const owned = ownDocument(document);
    this.document = owned;
    this.sourceInstance = owned.source;

    const problems: NormalizedProblem[] = [];
    const problemByKey = new Map<string, NormalizedProblem>();
    for (const problem of owned.problems) {
      if (!isRecord(problem) || typeof problem.key !== 'string' || !isRecord(problem.ref)) {
        throw invalidInput('catalog', 'the manual document contains an invalid problem record');
      }
      problems.push(problem);
      problemByKey.set(problem.key, problem);
    }
    const editorialByKey = new Map<string, ManualEditorialEntry>();
    for (const entry of owned.editorials) {
      if (!isRecord(entry) || typeof entry.problemKey !== 'string' || !isRecord(entry.result)) {
        throw invalidInput('editorial', 'the manual document contains an invalid editorial record');
      }
      editorialByKey.set(entry.problemKey, entry);
    }
    const accountIds = new Set<string>();
    for (const account of owned.accounts) {
      if (!isRecord(account) || typeof account.id !== 'string') {
        throw invalidInput('submissions', 'the manual document contains an invalid account record');
      }
      accountIds.add(account.id);
    }
    const byAccount = new Map<string, Submission[]>();
    const byProblem = new Map<string, Submission[]>();
    for (const submission of owned.submissions) {
      if (
        !isRecord(submission) ||
        typeof submission.id !== 'string' ||
        typeof submission.accountId !== 'string' ||
        typeof submission.key !== 'string' ||
        typeof submission.submittedAt !== 'string'
      ) {
        throw invalidInput('submissions', 'the manual document contains an invalid submission record');
      }
      push(byAccount, submission.accountId, submission);
      push(byProblem, submission.key, submission);
    }
    for (const list of byAccount.values()) {
      list.sort(compareSubmissions);
    }
    this.problemList = problems;
    this.problemByKey = problemByKey;
    this.editorialByKey = editorialByKey;
    this.accountIds = accountIds;
    this.submissionsByAccount = byAccount;
    this.submissionsByProblem = byProblem;
  }

  capabilities(): PlatformCapabilities {
    const found = this.document.preview.editorialsFound;
    const absent = this.document.preview.editorialsAbsent;
    const missing = this.document.preview.editorialsUnavailable;
    return {
      platform: this.sourceInstance.platform,
      implemented: true,
      problems: true,
      submissions: true,
      editorial: true,
      pagedProblems: true,
      pagedSubmissions: true,
      requiresAuth: false,
      supportsAccountHistory: true,
      minRequestIntervalMs: null,
      notes: [
        'offline manual import: every answer comes from the parsed document and no request is issued',
        `imported identities are preserved (source ${this.sourceInstance.id}); the adapter never relabels them as manual`,
        `editorials from the document: ${found} found, ${absent} explicitly absent, ${missing} unavailable (no record supplied)`,
        'statements and solution texts are plain text returned verbatim; nothing is fetched or rendered as HTML',
      ],
    };
  }

  async listProblems(request: ListProblemsRequest): Promise<Page<NormalizedProblem>> {
    request.token.throwIfCancelled();
    const limit = requireLimit(request.limit, 'catalog');
    const account = request.account ?? null;
    const accountId = account === null ? null : this.requireAccount(account, 'catalog').id;
    const scope: CursorScope = { resource: 'problems', account: accountId, since: null };
    const offset =
      request.cursor === null ? 0 : this.decodeCursor(request.cursor, scope, 'catalog', this.problemList.length);
    request.token.throwIfCancelled();
    const items = this.problemList.slice(offset, offset + limit).map(cloneProblem);
    const next = offset + items.length;
    return deepFreeze({
      items,
      nextCursor: next < this.problemList.length ? this.encodeCursor({ ...scope, offset: next }) : null,
      fetchedAt: this.document.importedAt,
    });
  }

  async listSubmissions(request: ListSubmissionsRequest): Promise<Page<Submission>> {
    request.token.throwIfCancelled();
    const limit = requireLimit(request.limit, 'submissions');
    const account = this.requireAccount(request.account, 'submissions');
    const since = requireSince(request.since ?? null);
    const all = (this.submissionsByAccount.get(account.id) ?? []).filter(
      (submission) => since === null || Date.parse(submission.submittedAt) >= Date.parse(since),
    );
    const scope: CursorScope = { resource: 'submissions', account: account.id, since };
    const offset = request.cursor === null ? 0 : this.decodeCursor(request.cursor, scope, 'submissions', all.length);
    request.token.throwIfCancelled();
    const items = all.slice(offset, offset + limit).map(cloneSubmission);
    const next = offset + items.length;
    return deepFreeze({
      items,
      nextCursor: next < all.length ? this.encodeCursor({ ...scope, offset: next }) : null,
      fetchedAt: this.document.importedAt,
    });
  }

  async fetchProblem(request: FetchProblemRequest): Promise<NormalizedProblem> {
    request.token.throwIfCancelled();
    const key = this.requireRefKey(request.problemRef, 'problem');
    const problem = this.problemByKey.get(key);
    if (problem === undefined) {
      throw unavailable('problem', `the manual document has no problem ${key}`);
    }
    return cloneProblem(problem);
  }

  async fetchEditorial(request: FetchEditorialRequest): Promise<EditorialFetchResult> {
    request.token.throwIfCancelled();
    const key = this.requireRefKey(request.problemRef, 'editorial');
    if (request.officialTutorialUrl !== undefined && request.officialTutorialUrl !== null) {
      // Attribution only: the URL is validated for shape and never requested.
      if (manualAttributionUrl(request.officialTutorialUrl) === null) {
        throw invalidInput('editorial', 'officialTutorialUrl must be an absolute http(s) URL without credentials');
      }
    }
    const entry = this.editorialByKey.get(key);
    if (entry === undefined) {
      throw unavailable('editorial', `the manual document has no problem ${key}`);
    }
    request.token.throwIfCancelled();
    return cloneEditorialResult(entry.result);
  }

  /**
   * Per-problem material for a later import application service (nothing is persisted here):
   * the problem, its editorial entry and its submissions, all owned clones. `null` when the
   * reference is malformed or names a problem this document does not contain.
   */
  materialFor(ref: ProblemRef): ManualProblemMaterial | null {
    const key = this.safeRefKey(ref);
    if (key === null) {
      return null;
    }
    const problem = this.problemByKey.get(key);
    const editorial = this.editorialByKey.get(key);
    if (problem === undefined || editorial === undefined) {
      return null;
    }
    return deepFreeze({
      problem: cloneProblem(problem),
      editorial: cloneEditorialEntry(editorial),
      submissions: (this.submissionsByProblem.get(key) ?? []).map(cloneSubmission),
    });
  }

  /** Every problem's material, in document order. */
  listMaterials(): readonly ManualProblemMaterial[] {
    const materials: ManualProblemMaterial[] = [];
    for (const problem of this.problemList) {
      const material = this.materialFor(problem.ref);
      if (material !== null) {
        materials.push(material);
      }
    }
    return deepFreeze(materials);
  }

  // -------------------------------------------------------------------------------------
  // Cursor helpers
  // -------------------------------------------------------------------------------------

  private encodeCursor(scope: CursorScope & { readonly offset: number }): string {
    const payload: CursorPayload = {
      v: MANUAL_CURSOR_VERSION,
      hash: this.document.contentHash,
      resource: scope.resource,
      source: this.sourceInstance.id,
      account: scope.account,
      since: scope.since,
      offset: scope.offset,
    };
    return Buffer.from(JSON.stringify({ ...payload, checksum: contentHashOf(payload) }), 'utf8').toString('base64url');
  }

  /** Decode and scope-check a cursor, returning its validated offset. */
  private decodeCursor(
    raw: string,
    scope: CursorScope,
    operation: PlatformOperation,
    total: number,
  ): number {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CURSOR_CHARS || !BASE64URL.test(raw)) {
      throw this.cursorError('the token is not a base64url cursor', operation);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    } catch (cause) {
      throw this.cursorError(`the payload is not valid JSON (${messageOf(cause)})`, operation);
    }
    if (!isRecord(parsed)) {
      throw this.cursorError('the payload must be an object', operation);
    }
    if (parsed.v !== MANUAL_CURSOR_VERSION) {
      throw this.cursorError(`unsupported version ${String(parsed.v)}; restart the listing`, operation);
    }
    if (typeof parsed.hash !== 'string' || !SHA256_HEX.test(parsed.hash) || parsed.hash !== this.document.contentHash) {
      throw this.cursorError('the cursor belongs to different document content; restart the listing', operation);
    }
    if (parsed.resource !== scope.resource) {
      throw this.cursorError('the cursor belongs to another resource', operation);
    }
    if (parsed.source !== this.sourceInstance.id) {
      throw this.cursorError('the cursor belongs to another source instance', operation);
    }
    if (parsed.account !== null && typeof parsed.account !== 'string') {
      throw this.cursorError('the payload has an invalid account scope', operation);
    }
    if (parsed.account !== scope.account) {
      throw this.cursorError('the cursor belongs to another account', operation);
    }
    if (parsed.since !== null && typeof parsed.since !== 'string') {
      throw this.cursorError('the payload has an invalid since bound', operation);
    }
    if (parsed.since !== scope.since) {
      throw this.cursorError('the since bound changed; restart the listing', operation);
    }
    const offset = parsed.offset;
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > MANUAL_MAX_ROWS) {
      throw this.cursorError(`the offset must be an integer in [0, ${MANUAL_MAX_ROWS}]`, operation);
    }
    const payload: CursorPayload = {
      v: MANUAL_CURSOR_VERSION,
      hash: parsed.hash,
      resource: scope.resource,
      source: this.sourceInstance.id,
      account: scope.account,
      since: scope.since,
      offset,
    };
    if (parsed.checksum !== contentHashOf(payload)) {
      throw this.cursorError('the checksum does not match the payload; restart the listing', operation);
    }
    if (offset > total) {
      throw this.cursorError('the position lies past the end of the listing', operation);
    }
    return offset;
  }

  private cursorError(detail: string, operation: PlatformOperation): PlatformError {
    return invalidInput(operation, `cursor rejected: ${detail}`);
  }

  // -------------------------------------------------------------------------------------
  // Reference and account coherence
  // -------------------------------------------------------------------------------------

  private requireAccount(account: Account | null | undefined, operation: PlatformOperation): Account {
    if (!isRecord(account)) {
      throw invalidInput(operation, 'an account is required');
    }
    if (account.sourceInstanceId !== this.sourceInstance.id) {
      throw invalidInput(operation, 'the account belongs to another source instance');
    }
    if (typeof account.handle !== 'string' || account.handle.trim().length === 0) {
      throw invalidInput(operation, 'the account handle is not usable');
    }
    let expected: string;
    try {
      expected = accountIdOf(this.sourceInstance.id, account.handle);
    } catch (cause) {
      throw invalidInput(operation, `the account id is malformed: ${messageOf(cause)}`);
    }
    if (account.id !== expected) {
      throw invalidInput(operation, 'the account id does not match its source instance and handle');
    }
    if (!this.accountIds.has(expected)) {
      throw invalidInput(operation, `the manual document has no account ${expected}`);
    }
    return account;
  }

  private requireRefKey(ref: ProblemRef, operation: PlatformOperation): string {
    const key = this.safeRefKey(ref);
    if (key === null) {
      throw invalidInput(operation, 'the problem reference is malformed or belongs to another source instance');
    }
    return key;
  }

  private safeRefKey(ref: ProblemRef): string | null {
    if (!isRecord(ref) || ref.sourceInstanceId !== this.sourceInstance.id) {
      return null;
    }
    if (typeof ref.externalKey !== 'string' || ref.externalKey.trim().length === 0) {
      return null;
    }
    if (ref.domain !== null && ref.domain !== undefined && typeof ref.domain !== 'string') {
      return null;
    }
    const domain = typeof ref.domain === 'string' ? ref.domain.trim() || null : null;
    try {
      return problemKey({ sourceInstanceId: this.sourceInstance.id, domain, externalKey: ref.externalKey });
    } catch {
      return null; // a non-canonical reference is not addressable in this document
    }
  }
}

function requireSince(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const normalized = normalizeManualTimestamp(value);
  if (normalized === null) {
    throw invalidInput('submissions', 'since must be an ISO-8601 timestamp with a timezone');
  }
  return normalized;
}

/** Build the offline adapter for one parsed manual document. */
export function createManualPlatformAdapter(document: ManualDocument): ManualPlatformAdapter {
  return new ManualPlatformAdapter(document);
}
