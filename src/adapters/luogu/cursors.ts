/**
 * Opaque, scope-checked problem-list cursors.
 *
 * Luogu pages in fixed server pages (`perPage`) while callers ask for an exact `limit`, so a
 * cursor records the server page it stopped on, how many of its entries were already delivered,
 * the server's `perPage`/`count` at issue time, the pid of the last delivered problem and a
 * fingerprint of the parsed source page itself. Resuming re-fetches exactly that page and refuses
 * to continue when the version, source instance, account, page size, total count, boundary pid or
 * server-page fingerprint no longer match: drift surfaces as an error that requires a restart
 * instead of silently skipping or duplicating problems. Stopping on the last visited server page
 * (even at `offset === perPage`) is what lets the next call re-read and verify that page before
 * it advances. Tokens are never upgraded across versions: a version 1 token carries no server
 * fingerprint and is rejected with a restart request.
 */
import { contentHashOf } from '../../domain/index.js';
import { PlatformError } from '../../application/platform-errors.js';
import { LUOGU_PID_PATTERN, type LuoguProblemPage } from './parsers.js';

export const LUOGU_CURSOR_VERSION = 2 as const;
const MAX_CURSOR_CHARS = 4096;
const MAX_PAGE = 1_000_000;
const MAX_PER_PAGE = 5_000;
const MAX_COUNT = 1_000_000_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

export interface LuoguCursorScope {
  readonly sourceInstanceId: string;
  /** Account the cursor was issued for, or `null` for anonymous listings. */
  readonly accountId: string | null;
}

export interface LuoguListCursor {
  readonly version: typeof LUOGU_CURSOR_VERSION;
  readonly sourceInstanceId: string;
  readonly accountId: string | null;
  /** 1-based server page the cursor stopped on; the next undelivered entry is at `offset`. */
  readonly page: number;
  /** Entries of that server page already delivered (0..perPage); `perPage` means it is exhausted. */
  readonly offset: number;
  readonly perPage: number;
  readonly count: number;
  /** Last pid delivered *from this page*; `null` exactly when nothing of this page was delivered. */
  readonly lastPid: string | null;
  /** {@link luoguServerPageFingerprint} of parsed server page `page` at issue time. */
  readonly pageFingerprint: string;
  /** Checksum over the cursor metadata; it protects the token, it does not detect server drift. */
  readonly checksum: string;
}

export type LuoguListCursorInput = Omit<LuoguListCursor, 'version' | 'checksum'>;

/**
 * Checksum over the cursor metadata only.
 *
 * This is deliberately *not* a fingerprint of server data: it binds the scope and pagination
 * fields (including the stored {@link LuoguListCursorInput.pageFingerprint}) so a tampered or
 * re-labelled token is refused. Detecting changed source content is the job of
 * {@link luoguServerPageFingerprint}.
 */
export function luoguCursorFingerprint(input: LuoguListCursorInput): string {
  return contentHashOf({
    sourceInstanceId: input.sourceInstanceId,
    accountId: input.accountId,
    page: input.page,
    offset: input.offset,
    perPage: input.perPage,
    count: input.count,
    lastPid: input.lastPid,
    pageFingerprint: input.pageFingerprint,
  });
}

/**
 * Fingerprint of one parsed server page.
 *
 * It covers the page number, the declared pagination shape and every parsed summary in order, so
 * a same-count insertion, deletion, reorder or in-page edit changes the value even when `count`,
 * `perPage` and the delivered boundary pid stay the same.
 */
export function luoguServerPageFingerprint(pageNumber: number, page: LuoguProblemPage): string {
  return contentHashOf({
    page: pageNumber,
    perPage: page.perPage,
    count: page.count,
    items: page.items.map((item) => ({
      pid: item.pid,
      title: item.title,
      difficulty: item.difficulty,
      tagIds: [...item.tagIds],
    })),
  });
}

/** Encode a cursor as an opaque base64url token: metadata plus its checksum. */
export function encodeLuoguListCursor(input: LuoguListCursorInput): string {
  const cursor: LuoguListCursor = {
    version: LUOGU_CURSOR_VERSION,
    ...input,
    checksum: luoguCursorFingerprint(input),
  };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function cursorError(detail: string): PlatformError {
  return new PlatformError({
    code: 'invalid_input',
    operation: 'catalog',
    retryable: false,
    detail: `cursor rejected: ${detail}`,
  });
}

function requireCursorInt(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw cursorError(`${label} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

/**
 * Decode and fully validate a cursor token against the caller's scope.
 *
 * Structural problems, an outdated version, a foreign instance/account, unsafe numbers and a
 * broken checksum are `invalid_input` (the caller must restart from the first page). The stored
 * `pageFingerprint` is only shape-checked here; the adapter compares it against the re-fetched
 * server page before it takes or advances anything.
 */
export function decodeLuoguListCursor(raw: string, scope: LuoguCursorScope): LuoguListCursor {
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
  if (record.version !== LUOGU_CURSOR_VERSION) {
    throw cursorError(`unsupported version ${String(record.version)}; restart the listing`);
  }
  if (record.sourceInstanceId !== scope.sourceInstanceId) {
    throw cursorError('the cursor belongs to another source instance');
  }
  let accountId: string | null;
  if (record.accountId === null) {
    accountId = null;
  } else if (typeof record.accountId === 'string' && record.accountId.length > 0) {
    accountId = record.accountId;
  } else {
    throw cursorError('the payload has an invalid account scope');
  }
  if (accountId !== scope.accountId) {
    throw cursorError('the cursor belongs to another account');
  }
  const page = requireCursorInt(record.page, 'page', 1, MAX_PAGE);
  const perPage = requireCursorInt(record.perPage, 'perPage', 1, MAX_PER_PAGE);
  const count = requireCursorInt(record.count, 'count', 0, MAX_COUNT);
  const offset = requireCursorInt(record.offset, 'offset', 0, perPage);
  let lastPid: string | null;
  if (record.lastPid === null) {
    lastPid = null;
  } else if (typeof record.lastPid === 'string' && LUOGU_PID_PATTERN.test(record.lastPid)) {
    lastPid = record.lastPid;
  } else {
    throw cursorError('the payload has an invalid boundary problem id');
  }
  if ((offset === 0) !== (lastPid === null)) {
    throw cursorError('the boundary problem id does not match the delivered offset');
  }
  if (typeof record.pageFingerprint !== 'string' || !SHA256_HEX.test(record.pageFingerprint)) {
    throw cursorError('the payload has no server page fingerprint');
  }
  if (typeof record.checksum !== 'string' || !SHA256_HEX.test(record.checksum)) {
    throw cursorError('the payload has no checksum');
  }
  const input: LuoguListCursorInput = {
    sourceInstanceId: scope.sourceInstanceId,
    accountId,
    page,
    offset,
    perPage,
    count,
    lastPid,
    pageFingerprint: record.pageFingerprint,
  };
  if (luoguCursorFingerprint(input) !== record.checksum) {
    throw cursorError('the checksum does not match the payload; restart the listing');
  }
  return { version: LUOGU_CURSOR_VERSION, ...input, checksum: record.checksum };
}
