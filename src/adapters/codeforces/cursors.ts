/**
 * Opaque, scope-checked pagination cursors.
 *
 * A cursor is a base64url JSON token, never a bare offset: it carries the cursor version, the
 * source instance, the resource and (when the resource is account-scoped) the account id, so a
 * cursor issued for another instance or another account is rejected instead of silently
 * reading someone else's page. Catalog cursors additionally carry the fingerprint of the
 * catalog snapshot they were issued against, and submission cursors carry the canonical handle,
 * the exact `since` bound the page was produced with and the last delivered boundary id, which
 * is re-checked on resume.
 *
 * Version 2 added the submission `since` binding. An older token is refused outright (a version
 * mismatch is not upgraded), so a caller restarts from the first page instead of resuming a
 * window whose lower bound is unknown.
 */
import { PlatformError } from '../../application/platform-errors.js';

export const CURSOR_VERSION = 2 as const;

export type CursorResource = 'catalog' | 'submissions';

export interface CursorScope {
  readonly sourceInstanceId: string;
  readonly resource: CursorResource;
  readonly accountId: string | null;
}

export interface CatalogCursor extends CursorScope {
  readonly resource: 'catalog';
  readonly version: typeof CURSOR_VERSION;
  /** Stable fingerprint of the catalog the cursor was issued against. */
  readonly fingerprint: string;
  /** Number of already delivered records. */
  readonly offset: number;
}

export interface SubmissionCursor extends CursorScope {
  readonly resource: 'submissions';
  readonly version: typeof CURSOR_VERSION;
  readonly handle: string;
  /** Number of already delivered submissions. */
  readonly returned: number;
  /** External id of the last delivered submission; re-checked before resuming. */
  readonly boundaryId: string | null;
  /** Inclusive lower bound the page was produced with, normalized ISO or `null`. */
  readonly since: string | null;
}

export type AdapterCursor = CatalogCursor | SubmissionCursor;

const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const MAX_CURSOR_CHARS = 4096;
const MAX_CLOCK_MS = 8.64e15;

function cursorError(resource: CursorResource, detail: string): PlatformError {
  return new PlatformError({
    code: 'invalid_input',
    operation: resource === 'catalog' ? 'catalog' : 'submissions',
    retryable: false,
    detail: `cursor rejected: ${detail}`,
  });
}

/** Encode a cursor as an opaque base64url token. */
export function encodeCursor(cursor: AdapterCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Decode and fully validate a cursor token. Throws `invalid_input` for anything malformed. */
export function decodeCursor(raw: string): AdapterCursor {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CURSOR_CHARS || !BASE64URL.test(raw)) {
    throw cursorError('catalog', 'token is not a base64url cursor');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
  } catch (cause) {
    throw cursorError('catalog', `payload is not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw cursorError('catalog', 'payload must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const resource = record.resource;
  if (resource !== 'catalog' && resource !== 'submissions') {
    throw cursorError('catalog', 'payload has no known resource');
  }
  if (record.version !== CURSOR_VERSION) {
    throw cursorError(resource, `unsupported version ${String(record.version)}`);
  }
  const sourceInstanceId = record.sourceInstanceId;
  if (typeof sourceInstanceId !== 'string' || sourceInstanceId.length === 0) {
    throw cursorError(resource, 'payload has no source instance');
  }
  let accountId: string | null;
  if (record.accountId === null) {
    accountId = null;
  } else if (typeof record.accountId === 'string' && record.accountId.length > 0) {
    accountId = record.accountId;
  } else {
    throw cursorError(resource, 'payload has an invalid account scope');
  }
  if (resource === 'catalog') {
    const fingerprint = record.fingerprint;
    if (typeof fingerprint !== 'string' || !SHA256_HEX.test(fingerprint)) {
      throw cursorError(resource, 'payload has no catalog fingerprint');
    }
    const offset = record.offset;
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
      throw cursorError(resource, 'payload has an invalid offset');
    }
    return { version: CURSOR_VERSION, sourceInstanceId, resource, accountId, fingerprint, offset };
  }
  const handle = record.handle;
  if (typeof handle !== 'string' || handle.length === 0) {
    throw cursorError(resource, 'payload has no handle');
  }
  const returned = record.returned;
  if (typeof returned !== 'number' || !Number.isSafeInteger(returned) || returned <= 0) {
    throw cursorError(resource, 'payload has an invalid delivered count');
  }
  let boundaryId: string | null;
  if (record.boundaryId === null) {
    boundaryId = null;
  } else if (typeof record.boundaryId === 'string' && record.boundaryId.length > 0) {
    boundaryId = record.boundaryId;
  } else {
    throw cursorError(resource, 'payload has an invalid boundary submission');
  }
  if (returned === 0 && boundaryId !== null) {
    throw cursorError(resource, 'a cursor that delivered nothing must not name a boundary');
  }
  if (returned > 0 && boundaryId === null) {
    throw cursorError(resource, 'a resumed cursor must name its boundary submission');
  }
  // A version-2 submissions token must carry the field, because "absent" and "no lower bound"
  // are different pages: silently defaulting to `null` would resume a windowed sync unbounded.
  if (!Object.prototype.hasOwnProperty.call(record, 'since')) {
    throw cursorError(resource, 'payload has no since bound');
  }
  return {
    version: CURSOR_VERSION,
    sourceInstanceId,
    resource,
    accountId,
    handle,
    returned,
    boundaryId,
    since: normalizeSince(record.since, resource),
  };
}

/** Normalize a cursor's `since` field; a parseable timestamp is canonicalized, anything else is refused. */
function normalizeSince(value: unknown, resource: CursorResource): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw cursorError(resource, 'payload has an invalid since bound');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > MAX_CLOCK_MS) {
    throw cursorError(resource, 'payload has an unparseable since bound');
  }
  return new Date(parsed).toISOString();
}

/** Reject a cursor issued for a different instance, resource or account. */
function requireCursorScope(cursor: AdapterCursor, scope: CursorScope): void {
  if (cursor.sourceInstanceId !== scope.sourceInstanceId) {
    throw cursorError(cursor.resource, 'cursor belongs to another source instance');
  }
  if (cursor.resource !== scope.resource) {
    throw cursorError(cursor.resource, `cursor belongs to resource ${cursor.resource}, not ${scope.resource}`);
  }
  if (cursor.accountId !== scope.accountId) {
    throw cursorError(cursor.resource, 'cursor belongs to another account');
  }
}

/** Validate scope and narrow a decoded cursor to a catalog cursor. */
export function requireCatalogCursor(
  cursor: AdapterCursor,
  scope: Omit<CursorScope, 'resource'>,
): CatalogCursor {
  if (cursor.resource !== 'catalog') {
    throw cursorError(cursor.resource, `cursor belongs to resource ${cursor.resource}, not catalog`);
  }
  requireCursorScope(cursor, { sourceInstanceId: scope.sourceInstanceId, resource: 'catalog', accountId: scope.accountId });
  return cursor;
}

/** Validate scope and narrow a decoded cursor to a submission cursor. */
export function requireSubmissionCursor(
  cursor: AdapterCursor,
  scope: Omit<CursorScope, 'resource'>,
): SubmissionCursor {
  if (cursor.resource !== 'submissions') {
    throw cursorError(cursor.resource, `cursor belongs to resource ${cursor.resource}, not submissions`);
  }
  requireCursorScope(cursor, {
    sourceInstanceId: scope.sourceInstanceId,
    resource: 'submissions',
    accountId: scope.accountId,
  });
  return cursor;
}

/** Reject a catalog cursor whose offset is outside the catalog it names. */
export function requireCatalogOffset(cursor: CatalogCursor, total: number): void {
  if (!Number.isInteger(total) || total < 0) {
    throw cursorError('catalog', 'catalog size is not an integer');
  }
  if (cursor.offset > total) {
    throw cursorError('catalog', `offset ${cursor.offset} is outside the current catalog of ${total} records`);
  }
}
