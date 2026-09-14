/**
 * Pure Luogu session-cookie normalization (Stage 19a).
 *
 * A Luogu session is carried by exactly two cookies: `__client_id` (the opaque session identifier)
 * and `_uid` (the numeric account UID). This workbench normalizes its authenticated `/record/list`
 * request to those two names and sends none of the others. That normalization is **not** a way
 * around platform verification: it only discards cookies this workbench does not use, and the
 * platform may still refuse the request (for example with an anti-bot challenge) even when the
 * pasted session is valid. This module is the single pure rule that turns whatever the user pasted
 * into that canonical pair, so the browser half, the connect route, the connection adapter and the
 * authenticated reader cannot disagree about what a session is.
 *
 * ## What it accepts
 *
 * - a bare `name=value; name=value` header value,
 * - an optional leading `Cookie:` header name in any case, with outer **spaces** allowed around the
 *   whole value, so pasting a whole request-header line works,
 * - any number of unrelated cookies, which are **discarded** instead of stored or sent,
 * - the two required pairs in either order.
 *
 * ## What it refuses
 *
 * - anything that is not bounded single-line text: a non-string, an empty/blank value, more than
 *   {@link MAX_LUOGU_COOKIE_INPUT_BYTES} UTF-8 bytes, or CR/LF, TAB, NUL or any other control
 *   character *anywhere* in the raw input — including at either end (header injection; only outer
 *   spaces are removed, and they are removed *after* the control check),
 * - a missing, empty, repeated or syntactically unusable `__client_id`/`_uid` value,
 * - a `_uid` that is not the canonical UID of the selected account.
 *
 * ## What it never does
 *
 * It reads no storage, opens no socket and touches no model; it never trims or rewrites the content
 * of a required value (the UID is compared as an opaque canonical string, the client id is only
 * checked for shape), and every failure carries a fixed sentence that contains no part of the
 * input. The canonical string a successful call returns is the only session material a caller may
 * store or send.
 */
import { utf8Bytes } from './hash.js';

/** Cookie name of the opaque Luogu session identifier. */
export const LUOGU_CLIENT_ID_COOKIE_NAME = '__client_id';
/** Cookie name of the numeric Luogu account UID. */
export const LUOGU_UID_COOKIE_NAME = '_uid';

/**
 * Hard bound of the raw pasted header text, in UTF-8 bytes.
 *
 * It applies to the *input* only: unrelated cookies are discarded, so a whole browser Cookie header
 * far larger than the OS credential blob still normalizes to the same two-cookie session. The bound
 * exists so an abusive paste cannot make the normalizer do unbounded work.
 */
export const MAX_LUOGU_COOKIE_INPUT_BYTES = 16 * 1024;

/**
 * Canonical Luogu UID: a positive decimal of at most 20 digits.
 *
 * This mirrors `LUOGU_UID_PATTERN` of the Luogu adapter on purpose — the domain layer may not import
 * an adapter — and `tests/platform/luogu-session.test.ts` asserts the two stay identical, so a
 * change on either side is caught instead of silently accepting a second spelling of one account.
 */
export const LUOGU_SESSION_UID_PATTERN = /^[1-9][0-9]{0,19}$/u;

/**
 * A syntactically safe opaque `__client_id`: printable, bounded, and free of `;`, `=`, whitespace and
 * control characters, so it can be a cookie value without changing a header's structure. Its content
 * is deliberately unconstrained: Luogu's `__client_id` is a session identifier, not a UID.
 */
export const LUOGU_SESSION_CLIENT_ID_PATTERN = /^[A-Za-z0-9._~+/:-]{1,256}$/u;

/** Stable, secret-free reason a raw session value was refused. */
export type LuoguCookieProblem =
  | 'not_text'
  | 'empty'
  | 'too_long'
  | 'unsafe_characters'
  | 'missing_client_id'
  | 'missing_uid'
  | 'duplicate_client_id'
  | 'duplicate_uid'
  | 'unusable_client_id'
  | 'unusable_uid'
  | 'uid_not_canonical'
  | 'foreign_uid';

/** A refusal: `problem` is the discriminant to branch on, `detail` a fixed sentence with no input. */
export interface LuoguCookieFailure {
  readonly ok: false;
  readonly problem: LuoguCookieProblem;
  readonly detail: string;
}

/** The canonical `__client_id=…; _uid=…` session value; the only form a caller may store or send. */
export interface LuoguCookieSuccess {
  readonly ok: true;
  readonly cookie: string;
}

export type LuoguCookieResult = LuoguCookieSuccess | LuoguCookieFailure;

/** Fixed English detail per problem; never contains any part of the caller's input. */
const LUOGU_COOKIE_DETAILS: Readonly<Record<LuoguCookieProblem, string>> = {
  not_text: 'the Luogu session cookie value must be text',
  empty: 'the Luogu session cookie value is empty',
  too_long: `the Luogu session cookie value exceeds ${MAX_LUOGU_COOKIE_INPUT_BYTES} UTF-8 bytes`,
  unsafe_characters: 'the Luogu session cookie value contains control characters',
  missing_client_id: 'the Luogu session cookie carries no __client_id',
  missing_uid: 'the Luogu session cookie carries no _uid',
  duplicate_client_id: 'the Luogu session cookie repeats __client_id',
  duplicate_uid: 'the Luogu session cookie repeats _uid',
  unusable_client_id: 'the Luogu session cookie __client_id is not a syntactically safe opaque value',
  unusable_uid: 'the Luogu session cookie _uid is not a canonical positive decimal UID',
  uid_not_canonical: 'the selected account UID is not a canonical Luogu UID',
  foreign_uid: 'the Luogu session cookie _uid does not match the selected account',
};

function failure(problem: LuoguCookieProblem): LuoguCookieFailure {
  return { ok: false, problem, detail: LUOGU_COOKIE_DETAILS[problem] };
}

/** Canonical session value of one validated pair; the field order is fixed here and nowhere else. */
function canonicalCookie(clientId: string, uid: string): string {
  return `${LUOGU_CLIENT_ID_COOKIE_NAME}=${clientId}; ${LUOGU_UID_COOKIE_NAME}=${uid}`;
}

/** An optional `Cookie:` header name, as copying the whole request-header line produces it. */
const COOKIE_HEADER_PREFIX = /^cookie\s*:/iu;
/** Control characters (including CR/LF) may never enter a header value. */
const UNSAFE_COOKIE_TEXT = /[\u0000-\u001f\u007f]/u;

/**
 * Bound and unwrap the raw text: refuse any control character on the **original** input first, then
 * strip an optional `Cookie:` prefix and outer spaces. Checking before trimming is deliberate — a
 * pasted header line often ends in CRLF, and `trim()` would otherwise make that injection-shaped
 * input silently disappear instead of being refused. Nothing inside the text is rewritten.
 */
function boundedCookieText(raw: unknown): { readonly ok: true; readonly text: string } | LuoguCookieFailure {
  if (typeof raw !== 'string') {
    return failure('not_text');
  }
  if (utf8Bytes(raw).length > MAX_LUOGU_COOKIE_INPUT_BYTES) {
    return failure('too_long');
  }
  if (UNSAFE_COOKIE_TEXT.test(raw)) {
    return failure('unsafe_characters');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return failure('empty');
  }
  const stripped = text.replace(COOKIE_HEADER_PREFIX, '').trim();
  return { ok: true, text: stripped.length === 0 ? text : stripped };
}

/** The two required values of one header, already shape-checked. */
interface LuoguCookiePairs {
  readonly ok: true;
  readonly clientId: string;
  readonly uid: string;
}

/**
 * Read the two required pairs out of one header text.
 *
 * A segment whose (trimmed) name is neither required name is discarded — that is the whole point of
 * normalization, and it is why a full browser Cookie header is accepted. A required name must be a
 * well-formed, non-empty, single-valued pair; a repeated required name is refused as ambiguous
 * instead of letting one value silently win.
 */
function readRequiredCookies(text: string): LuoguCookiePairs | LuoguCookieFailure {
  let clientId: string | null = null;
  let uid: string | null = null;
  for (const segment of text.split(';')) {
    const piece = segment.trim();
    if (piece.length === 0) {
      continue;
    }
    const separator = piece.indexOf('=');
    const name = (separator < 0 ? piece : piece.slice(0, separator)).trim();
    if (name !== LUOGU_CLIENT_ID_COOKIE_NAME && name !== LUOGU_UID_COOKIE_NAME) {
      continue;
    }
    const wantsClientId = name === LUOGU_CLIENT_ID_COOKIE_NAME;
    if (separator <= 0) {
      return failure(wantsClientId ? 'missing_client_id' : 'missing_uid');
    }
    const value = piece.slice(separator + 1);
    if (value.length === 0) {
      return failure(wantsClientId ? 'missing_client_id' : 'missing_uid');
    }
    if (wantsClientId) {
      if (clientId !== null) {
        return failure('duplicate_client_id');
      }
      if (!LUOGU_SESSION_CLIENT_ID_PATTERN.test(value)) {
        return failure('unusable_client_id');
      }
      clientId = value;
    } else {
      if (uid !== null) {
        return failure('duplicate_uid');
      }
      if (!LUOGU_SESSION_UID_PATTERN.test(value)) {
        return failure('unusable_uid');
      }
      uid = value;
    }
  }
  if (clientId === null) {
    return failure('missing_client_id');
  }
  if (uid === null) {
    return failure('missing_uid');
  }
  return { ok: true, clientId, uid };
}

/**
 * Validate one raw pasted header value and canonicalize its two required cookies.
 *
 * The `_uid` is **not** compared with an account here: use this for the pre-account validation step
 * of a request, and {@link normalizeLuoguSessionCookie} once the selected account is known.
 */
export function inspectLuoguSessionCookie(raw: unknown): LuoguCookieResult {
  const bounded = boundedCookieText(raw);
  if (!bounded.ok) {
    return bounded;
  }
  const pairs = readRequiredCookies(bounded.text);
  if (!pairs.ok) {
    return pairs;
  }
  return { ok: true, cookie: canonicalCookie(pairs.clientId, pairs.uid) };
}

/**
 * Normalize one raw pasted header value against the selected account.
 *
 * Accepts a bare pair list, a whole `Cookie:` header line, or a full browser Cookie header; always
 * resolves to the canonical two-cookie value. The required `_uid` must be exactly the canonical UID
 * of the selected account — it is compared as an opaque string and never trimmed, guessed or
 * rewritten, so a session of another account can never be bound to this one.
 */
export function normalizeLuoguSessionCookie(raw: unknown, selectedUid: unknown): LuoguCookieResult {
  const bounded = boundedCookieText(raw);
  if (!bounded.ok) {
    return bounded;
  }
  if (typeof selectedUid !== 'string' || !LUOGU_SESSION_UID_PATTERN.test(selectedUid)) {
    return failure('uid_not_canonical');
  }
  const pairs = readRequiredCookies(bounded.text);
  if (!pairs.ok) {
    return pairs;
  }
  if (pairs.uid !== selectedUid) {
    return failure('foreign_uid');
  }
  return { ok: true, cookie: canonicalCookie(pairs.clientId, pairs.uid) };
}

/**
 * Build the canonical session value from the `__client_id` **value** field of the panel.
 *
 * This is the two-field mode: the `_uid` comes from the selected account, never from user input, and
 * the client id is taken verbatim from the pasted value (no trimming, no unquoting), so a value that
 * carries extra characters is refused instead of silently repaired.
 */
export function luoguSessionCookieFromClientId(clientId: unknown, selectedUid: unknown): LuoguCookieResult {
  if (typeof selectedUid !== 'string' || !LUOGU_SESSION_UID_PATTERN.test(selectedUid)) {
    return failure('uid_not_canonical');
  }
  if (typeof clientId !== 'string') {
    return failure('not_text');
  }
  if (clientId.length === 0) {
    return failure('missing_client_id');
  }
  if (utf8Bytes(clientId).length > MAX_LUOGU_COOKIE_INPUT_BYTES) {
    return failure('too_long');
  }
  if (UNSAFE_COOKIE_TEXT.test(clientId)) {
    return failure('unsafe_characters');
  }
  if (!LUOGU_SESSION_CLIENT_ID_PATTERN.test(clientId)) {
    return failure('unusable_client_id');
  }
  return { ok: true, cookie: canonicalCookie(clientId, selectedUid) };
}
