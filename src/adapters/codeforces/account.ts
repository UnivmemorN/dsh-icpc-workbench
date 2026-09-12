/**
 * Codeforces account identity.
 *
 * Codeforces handles are case-insensitive in the API and in URLs, so two spellings of the same
 * handle must not become two accounts. The adapter owns one explicit factory that trims,
 * validates and lowercase-canonicalizes the handle (keeping the user's spelling as the display
 * name), and one coherence check that refuses an {@link Account} that was not built that way or
 * that belongs to another instance.
 */
import { createAccount, parseAccountId, type Account, type SourceInstance } from '../../domain/index.js';
import { PlatformError } from '../../application/platform-errors.js';

/** Codeforces accepts 3–24 characters from this set. */
export const CODEFORCES_HANDLE_PATTERN = /^[A-Za-z0-9_.-]{3,24}$/u;

function invalidHandle(detail: string): PlatformError {
  return new PlatformError({ code: 'invalid_input', operation: 'submissions', retryable: false, detail });
}

/** Lowercase canonical form used for identity and API requests. */
export function canonicalCodeforcesHandle(handle: string): string {
  if (typeof handle !== 'string') {
    throw invalidHandle('handle must be a string');
  }
  const trimmed = handle.trim();
  if (!CODEFORCES_HANDLE_PATTERN.test(trimmed)) {
    throw invalidHandle('handle must be 3-24 characters of letters, digits, "_", "." or "-"');
  }
  return trimmed.toLowerCase();
}

/** Build the canonical account for one Codeforces handle. */
export function createCodeforcesAccount(instance: SourceInstance, handle: string, displayName?: string | null): Account {
  const canonical = canonicalCodeforcesHandle(handle);
  const providedName = displayName?.trim() ?? '';
  const original = handle.trim();
  return createAccount({
    sourceInstanceId: instance.id,
    handle: canonical,
    displayName: providedName.length > 0 ? providedName : original === canonical ? null : original,
    profileUrl: new URL(`/profile/${canonical}`, instance.baseUrl).toString(),
  });
}

/**
 * Validate an account used for a Codeforces request and return its canonical handle.
 *
 * Rejects an account of another source instance, an id that does not match its own instance
 * and handle, and a handle that was not canonicalized through {@link createCodeforcesAccount}.
 */
export function requireCodeforcesHandle(instance: SourceInstance, account: Account): string {
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
  if (account.handle !== canonicalCodeforcesHandle(account.handle)) {
    throw invalidHandle('account handle is not canonical; build accounts with createCodeforcesAccount');
  }
  return account.handle;
}
