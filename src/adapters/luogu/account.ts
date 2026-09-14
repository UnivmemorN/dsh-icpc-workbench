/**
 * Luogu account identity.
 *
 * A Luogu account is addressed by its numeric user id (UID). The UID is an opaque decimal string
 * for identity purposes, but it must be *canonical*: an accepting parser that tolerates `+123`,
 * `00123` or `" 123 "` would let one person's account exist twice under different ids, so the
 * factory below refuses every non-canonical spelling instead of normalizing it. The canonical form
 * is exactly `[1-9][0-9]{0,19}` — a positive decimal without a sign and without leading zeros; the
 * 20-digit bound is an opaque format limit, not a claim about the numeric range behind the id.
 *
 * The profile URL is derived from the instance's own base URL, so a mirror or a future official
 * move keeps working. The display name starts as `null` and stays optional: the numeric UID is the
 * account's identity, while the platform nickname is a separate label refreshed from the public
 * profile endpoint (`LuoguAdapter.fetchAccountProfile`), never derived from the number.
 */
import { createAccount, parseAccountId, type Account, type SourceInstance } from '../../domain/index.js';
import { PlatformError } from '../../application/platform-errors.js';

/** Canonical Luogu UID: a positive decimal of at most 20 digits. */
export const LUOGU_UID_PATTERN = /^[1-9][0-9]{0,19}$/u;

function invalidHandle(detail: string): PlatformError {
  return new PlatformError({ code: 'invalid_input', operation: 'submissions', retryable: false, detail });
}

/**
 * Canonical UID of one Luogu account.
 *
 * Rejects a non-string, a blank string, a signed number, a leading zero, a non-decimal character
 * and a value beyond 20 digits; nothing is trimmed into shape, because `"123 "` and `"123"` are
 * different inputs to the platform's own URL space.
 */
export function canonicalLuoguUid(handle: string): string {
  if (typeof handle !== 'string') {
    throw invalidHandle('Luogu handle must be a string');
  }
  if (!LUOGU_UID_PATTERN.test(handle)) {
    throw invalidHandle('Luogu handle must be a canonical positive decimal UID of at most 20 digits');
  }
  return handle;
}

/** Build the canonical account for one Luogu UID. */
export function createLuoguAccount(instance: SourceInstance, handle: string, displayName?: string | null): Account {
  const canonical = canonicalLuoguUid(handle);
  const providedName = displayName?.trim() ?? '';
  return createAccount({
    sourceInstanceId: instance.id,
    handle: canonical,
    displayName: providedName.length > 0 ? providedName : null,
    profileUrl: new URL(`/user/${canonical}`, instance.baseUrl).toString(),
  });
}

/**
 * Validate an account used for a Luogu request and return its canonical UID.
 *
 * Rejects an account of another source instance, an id that does not match its own instance and
 * handle, and a handle that was not canonicalized through {@link createLuoguAccount}.
 */
export function requireLuoguUid(instance: SourceInstance, account: Account): string {
  if (account.sourceInstanceId !== instance.id) {
    throw invalidHandle(`account belongs to ${account.sourceInstanceId}, not ${instance.id}`);
  }
  let parsed: { sourceInstanceId: string; handle: string };
  try {
    parsed = parseAccountId(account.id);
  } catch (cause) {
    throw invalidHandle(`account id is malformed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (parsed.sourceInstanceId !== account.sourceInstanceId || parsed.handle !== account.handle) {
    throw invalidHandle('account id does not match its source instance and handle');
  }
  if (account.handle !== canonicalLuoguUid(account.handle)) {
    throw invalidHandle('account handle is not canonical; build accounts with createLuoguAccount');
  }
  return account.handle;
}
