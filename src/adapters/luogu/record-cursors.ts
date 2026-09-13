/**
 * Opaque, scope-bound cursors for authenticated Luogu submission history.
 *
 * A cursor is a base64url JSON token, never a bare page number: it binds the source instance,
 * the account (id *and* canonical UID), the inclusive `since` window the page was produced with,
 * the server page and the offset inside it, the cumulative number of delivered records, the last
 * delivered record id and a fingerprint of the source page's record identities, plus a checksum
 * over all of it. Resuming re-fetches exactly that page and refuses to continue when the version,
 * scope, `since`, declared page size/total, boundary record or page fingerprint no longer match,
 * so drift surfaces as an error that requires a restart instead of silently skipping, duplicating
 * or re-attributing records.
 *
 * The page fingerprint deliberately covers **identity only** (`id`, `pid`, `submitTime`), not the
 * verdict: a normal rejudge changes `status` without changing a record's identity, and a rejudge
 * must not invalidate a resumable scan. An insertion, deletion or reorder does change the
 * fingerprint and forces a safe restart.
 *
 * Tokens are never upgraded across versions: a token of an unknown version is refused with a
 * restart request rather than reinterpreted.
 */
import { contentHashOf } from '../../domain/index.js';
import { PlatformError } from '../../application/platform-errors.js';
import { LUOGU_MAX_RECORD_COUNT, LUOGU_MAX_SERVER_PAGE_SIZE, type LuoguRecordPage } from './records.js';
import { LUOGU_UID_PATTERN } from './account.js';

export const LUOGU_RECORD_CURSOR_VERSION = 1 as const;

const MAX_CURSOR_CHARS = 4096;
const MAX_PAGE = 1_000_000;
const MAX_DELIVERED = 1_000_000_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const RECORD_ID = /^[1-9][0-9]{0,19}$/u;

/** The scope a cursor is issued for and validated against. */
export interface LuoguRecordCursorScope {
  readonly sourceInstanceId: string;
  readonly accountId: string;
  /** Canonical Luogu UID of that account. */
  readonly handle: string;
  /** Inclusive lower bound (normalized ISO-8601) or `null` for an unbounded scan. */
  readonly since: string | null;
}

export interface LuoguRecordCursor extends LuoguRecordCursorScope {
  readonly version: typeof LUOGU_RECORD_CURSOR_VERSION;
  /** 1-based server page the cursor stopped on. */
  readonly page: number;
  /** Records of that page already delivered (`0..perPage`); `delivered` counts the whole scan. */
  readonly offset: number;
  /** Declared server page size when known; drives the "short page is the last page" rule. */
  readonly perPage: number | null;
  /** Declared record total when known; a drift signal, never permission to skip records. */
  readonly count: number | null;
  /** Cumulative records delivered from the start of the scan up to this position. */
  readonly delivered: number;
  /** Id of the last record delivered *from this page*; `null` exactly when `offset === 0`. */
  readonly boundaryId: string | null;
  /** {@link luoguRecordPageFingerprint} of server page `page` at issue time. */
  readonly pageFingerprint: string;
  /** Checksum over the cursor metadata; it protects the token, it does not detect server drift. */
  readonly checksum: string;
}

export type LuoguRecordCursorInput = Omit<LuoguRecordCursor, 'version' | 'checksum'>;

/** Checksum over the whole cursor metadata, including the stored page fingerprint. */
export function luoguRecordCursorFingerprint(input: LuoguRecordCursorInput): string {
  return contentHashOf({
    sourceInstanceId: input.sourceInstanceId,
    accountId: input.accountId,
    handle: input.handle,
    since: input.since,
    page: input.page,
    offset: input.offset,
    perPage: input.perPage,
    count: input.count,
    delivered: input.delivered,
    boundaryId: input.boundaryId,
    pageFingerprint: input.pageFingerprint,
  });
}

/**
 * Fingerprint of one parsed server page: the ordered record identities, nothing else.
 *
 * `status`, `language` and any other mutable attribute are excluded on purpose, so a rejudge of
 * an already listed record does not invalidate a cursor whose identity is unchanged.
 */
export function luoguRecordPageFingerprint(pageNumber: number, page: LuoguRecordPage): string {
  return contentHashOf({
    page: pageNumber,
    records: page.records.map((record) => ({
      id: record.id,
      pid: record.pid,
      submitTime: record.submitTimeSeconds,
    })),
  });
}

/** Encode a cursor as an opaque base64url token: metadata plus its checksum. */
export function encodeLuoguRecordCursor(input: LuoguRecordCursorInput): string {
  const cursor: LuoguRecordCursor = {
    version: LUOGU_RECORD_CURSOR_VERSION,
    ...input,
    checksum: luoguRecordCursorFingerprint(input),
  };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function cursorError(detail: string): PlatformError {
  return new PlatformError({
    code: 'invalid_input',
    operation: 'submissions',
    retryable: false,
    detail: `cursor rejected: ${detail}; restart the submission listing`,
  });
}

function requireCursorInt(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw cursorError(`${label} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function normalizeSince(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw cursorError('the payload has an invalid since bound');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw cursorError('the payload has an unparseable since bound');
  }
  return new Date(parsed).toISOString();
}

/**
 * Decode and fully validate a cursor against the caller's scope.
 *
 * Structural problems, an outdated version, a foreign instance/account/UID, a different `since`
 * window, unsafe numbers, an inconsistent position and a broken checksum are all `invalid_input`:
 * the caller must restart from the first page. The stored page fingerprint is only shape-checked
 * here; the reader compares it against the re-fetched page before it takes or advances anything.
 */
export function decodeLuoguRecordCursor(raw: string, scope: LuoguRecordCursorScope): LuoguRecordCursor {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CURSOR_CHARS || !BASE64URL.test(raw)) {
    throw cursorError('the token is not a base64url cursor');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
  } catch (cause) {
    throw cursorError(`the payload is not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw cursorError('the payload must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== LUOGU_RECORD_CURSOR_VERSION) {
    throw cursorError(`unsupported version ${String(record.version)}`);
  }
  if (record.sourceInstanceId !== scope.sourceInstanceId) {
    throw cursorError('the cursor belongs to another source instance');
  }
  if (record.accountId !== scope.accountId) {
    throw cursorError('the cursor belongs to another account');
  }
  if (record.handle !== scope.handle) {
    throw cursorError('the cursor belongs to another Luogu UID');
  }
  const since = normalizeSince(record.since);
  if (since !== scope.since) {
    throw cursorError('the cursor was issued for a different since bound');
  }
  const page = requireCursorInt(record.page, 'page', 1, MAX_PAGE);
  const perPageValue = record.perPage;
  const perPage =
    perPageValue === null
      ? null
      : requireCursorInt(perPageValue, 'perPage', 1, LUOGU_MAX_SERVER_PAGE_SIZE);
  const countValue = record.count;
  const count = countValue === null ? null : requireCursorInt(countValue, 'count', 0, LUOGU_MAX_RECORD_COUNT);
  const offset = requireCursorInt(record.offset, 'offset', 0, LUOGU_MAX_SERVER_PAGE_SIZE);
  const delivered = requireCursorInt(record.delivered, 'delivered', 0, MAX_DELIVERED);
  if (perPage !== null) {
    if (offset > perPage) {
      throw cursorError('the offset lies past the declared server page size');
    }
    if ((page - 1) * perPage + offset !== delivered) {
      throw cursorError('the delivered count does not match the cursor position');
    }
  } else if (delivered < offset) {
    throw cursorError('the delivered count is smaller than the offset');
  }
  if (count !== null && delivered > count) {
    throw cursorError('the delivered count lies past the declared record total');
  }
  let boundaryId: string | null;
  if (record.boundaryId === null) {
    boundaryId = null;
  } else if (typeof record.boundaryId === 'string' && RECORD_ID.test(record.boundaryId)) {
    boundaryId = record.boundaryId;
  } else {
    throw cursorError('the payload has an invalid boundary record id');
  }
  if ((offset === 0) !== (boundaryId === null)) {
    throw cursorError('the boundary record id does not match the delivered offset');
  }
  if (typeof record.pageFingerprint !== 'string' || !SHA256_HEX.test(record.pageFingerprint)) {
    throw cursorError('the payload has no server page fingerprint');
  }
  if (typeof record.checksum !== 'string' || !SHA256_HEX.test(record.checksum)) {
    throw cursorError('the payload has no checksum');
  }
  const input: LuoguRecordCursorInput = {
    sourceInstanceId: scope.sourceInstanceId,
    accountId: scope.accountId,
    handle: scope.handle,
    since,
    page,
    offset,
    perPage,
    count,
    delivered,
    boundaryId,
    pageFingerprint: record.pageFingerprint,
  };
  if (luoguRecordCursorFingerprint(input) !== record.checksum) {
    throw cursorError('the checksum does not match the payload');
  }
  return { version: LUOGU_RECORD_CURSOR_VERSION, ...input, checksum: record.checksum };
}

/** True when `value` is a canonical Luogu UID spelling (used by cursor scope checks). */
export function isCanonicalLuoguUid(value: unknown): value is string {
  return typeof value === 'string' && LUOGU_UID_PATTERN.test(value);
}
