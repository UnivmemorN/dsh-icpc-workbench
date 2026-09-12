/**
 * Stable identity helpers.
 *
 * Every durable entity gets a deterministic string id derived from its owning scope, never
 * from insertion order or randomness. That is what lets a restarted process recognise the
 * same problem, submission or snapshot and refuse to double-count it.
 *
 * ## Identity shape (architecture)
 *
 * A *reference* is `sourceInstanceId | domain | externalKey`; a submission adds the
 * `accountId`. Scopes therefore never collapse: a self-hosted Hydro instance may host many
 * domains, the same external problem id may exist in two domains, and the same handle may
 * exist on two instances — all of which must stay distinct.
 *
 * ## Escaping
 *
 * The separators (`|` between scopes, `:` between platform and domain inside an instance
 * id, `@` before a snapshot hash, `:` before a snapshot version) are structural, so the
 * standard `encodeURIComponent` escapes every component a platform may legally put in a
 * handle, domain or external key, and `decodeURIComponent` is its exact inverse. Composition is nested: an instance id is
 * itself `platform:domain` and an account id is `instance|handle`; both are opaque strings
 * at problem/submission level and are escaped again when embedded, so a nested `|`, `:` or
 * `@` can never be mistaken for a separator.
 *
 * Parsers verify that every component re-encodes to exactly the text they read, so a key
 * that is not canonically escaped is rejected instead of being re-read as different
 * scopes. Escaped parts are ASCII, which keeps them usable as object keys and file names.
 */
import { DomainError, invariant } from './errors.js';

/** Source platforms known to the product. Hydro is designed for, not implemented in v1. */
export type SourcePlatform = 'codeforces' | 'luogu' | 'hydro' | 'manual';

export const SOURCE_PLATFORMS: readonly SourcePlatform[] = ['codeforces', 'luogu', 'hydro', 'manual'];

/** Separator between the scopes of a compound id (`account | instance | domain | key`). */
const ID_SEPARATOR = '|';
/** Separator inside a source instance id (`platform:domain`). Also used by `source.ts`. */
export const INSTANCE_SEPARATOR = ':';
/** Separator between a problem key and its content hash. */
const HASH_SEPARATOR = '@';
/** Separator between a snapshot content hash and its version (`…#hash:v3`). */
const VERSION_SEPARATOR = ':';

/** Characters that never reach an id: they would corrupt logs, files and terminal output. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
/**
 * Canonical shape of an *encoded* part: exactly what `encodeURIComponent` emits for
 * non-empty text (`%XX` escapes plus the RFC 3986 unreserved-ish marks it leaves alone).
 * Structural separators are absent by construction, which is what makes splitting safe.
 */
const ENCODED_PART = /^[A-Za-z0-9._!~*'()%-]+$/;

/**
 * Escape one component as a single id part using the platform's standard URL encoder.
 *
 * Throws `invalid_id_part` for a non-string, empty text, control characters or text that
 * cannot be UTF-8 encoded (a lone surrogate), so an id never silently loses information.
 */
export function encodeIdPart(value: string): string {
  invariant(typeof value === 'string', 'invalid_id_part', 'id part must be a string', { value });
  const normalized = value.normalize('NFC');
  invariant(normalized.length > 0, 'invalid_id_part', 'id part must not be empty', { value });
  invariant(!CONTROL_CHARS.test(normalized), 'invalid_id_part', 'id part must not contain control characters', {
    value,
  });
  try {
    return encodeURIComponent(normalized);
  } catch (cause) {
    throw new DomainError('invalid_id_part', 'id part cannot be UTF-8 encoded', { value, cause: String(cause) });
  }
}

/**
 * Inverse of {@link encodeIdPart}. Throws `invalid_id_part` for malformed percent-encoding,
 * a decoded empty value or decoded control characters.
 *
 * The result is NFC-normalised, so it is exactly the text {@link encodeIdPart} accepted
 * whenever the input was canonical.
 */
export function decodeIdPart(value: string): string {
  invariant(typeof value === 'string', 'invalid_id_part', 'id part must be a string', { value });
  invariant(value.length > 0, 'invalid_id_part', 'id part must not be empty', { value });
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch (cause) {
    throw new DomainError('invalid_id_part', `malformed percent-encoding in id part ${JSON.stringify(value)}`, {
      value,
      cause: String(cause),
    });
  }
  invariant(decoded.length > 0, 'invalid_id_part', 'id part decodes to an empty string', { value });
  invariant(!CONTROL_CHARS.test(decoded), 'invalid_id_part', 'id part decodes to a control character', { value });
  return decoded.normalize('NFC');
}

/** Decode a part and require that it is exactly its own canonical encoding. */
function decodeCanonicalPart(label: string, value: string): string {
  const decoded = decodeIdPart(value);
  invariant(
    encodeIdPart(decoded) === value,
    'invalid_id_part',
    `${label} is not canonically encoded (got ${JSON.stringify(value)})`,
    { label, value },
  );
  return decoded;
}

/** Trim + NFC-normalise one opaque component, then escape it canonically. */
function encodedPart(label: string, value: string): string {
  invariant(typeof value === 'string', 'invalid_id_part', `${label} must be a string`, { label, value });
  const normalized = value.trim().normalize('NFC');
  invariant(normalized.length > 0, 'invalid_id_part', `${label} must not be empty`, { label, value });
  invariant(!CONTROL_CHARS.test(normalized), 'invalid_id_part', `${label} must not contain control characters`, {
    label,
    value,
  });
  return encodeIdPart(normalized);
}

/**
 * Validate and return one *atomic* id part: a single canonical, already-escaped scope
 * element with no separator. This is the check for values that will be joined or compared
 * as one component.
 */
export function assertIdPart(label: string, value: string): string {
  invariant(typeof value === 'string', 'invalid_id_part', `${label} must be a string`, { label, value });
  invariant(
    ENCODED_PART.test(value),
    'invalid_id_part',
    `${label} must match ${ENCODED_PART.source} (got ${JSON.stringify(value)})`,
    { label, value },
  );
  invariant(
    encodeIdPart(decodeIdPart(value)) === value,
    'invalid_id_part',
    `${label} is not canonically encoded (got ${JSON.stringify(value)})`,
    { label, value },
  );
  return value;
}

/**
 * Validate a *compound* id: encoded parts joined by the structural separators
 * (`|`, `:`, `@`). Used for references (account, submission, instance, snapshot) that are
 * legitimately composed of several scopes, and for the derived ids built from them.
 */
export function assertCompoundId(label: string, value: string): string {
  invariant(typeof value === 'string', 'invalid_id_part', `${label} must be a string`, { label, value });
  invariant(value.length > 0, 'invalid_id_part', `${label} must not be empty`, { label, value });
  for (const part of value.split(/[|:@]/u)) {
    assertIdPart(label, part);
  }
  return value;
}

/**
 * Trim and NFC-normalise an opaque platform/external key: case and every other character
 * are preserved exactly, because platform keys are opaque. Escaping happens when a key is
 * composed ({@link problemKey}, {@link submissionKey}), never here.
 */
export function normalizeKeyPart(value: string): string {
  invariant(typeof value === 'string', 'invalid_id_part', 'key part must be a string', { value });
  const normalized = value.trim().normalize('NFC');
  invariant(normalized.length > 0, 'invalid_id_part', 'key part must not be empty', { value });
  invariant(!CONTROL_CHARS.test(normalized), 'invalid_id_part', 'key part must not contain control characters', {
    value,
  });
  return normalized;
}

/** Reference to a problem: source instance + optional domain + platform external key. */
export interface ProblemRef {
  readonly sourceInstanceId: string;
  readonly domain: string | null;
  readonly externalKey: string;
}

/** Reference to a submission: a problem reference plus the submitting account. */
export interface SubmissionRef extends ProblemRef {
  readonly accountId: string;
}

/**
 * Canonical `sourceInstanceId|domain|externalKey` problem key.
 *
 * `sourceInstanceId` is an opaque nested id (`platform:domain`) and is escaped as a whole,
 * so it always occupies exactly one part no matter what it contains.
 */
export function problemKey(ref: ProblemRef): string {
  assertCompoundId('sourceInstanceId', ref.sourceInstanceId);
  const domain = ref.domain === null ? '' : ref.domain.trim();
  return [
    encodedPart('sourceInstanceId', ref.sourceInstanceId),
    domain === '' ? '' : encodedPart('domain', domain),
    encodedPart('externalKey', ref.externalKey),
  ].join(ID_SEPARATOR);
}

/**
 * Inverse of {@link problemKey}.
 *
 * Throws `invalid_id_part` when the key is not in canonical shape: wrong arity, an empty
 * external key, non-canonical escaping or an instance id that is not a valid instance.
 */
export function parseProblemKey(key: string): ProblemRef {
  invariant(typeof key === 'string', 'invalid_id_part', 'problem key must be a string', { key });
  const parts = key.split(ID_SEPARATOR);
  invariant(parts.length === 3, 'invalid_id_part', `problem key must have 3 parts (got ${parts.length})`, { key });
  const [instancePart, domainPart, keyPart] = parts as [string, string, string];
  const sourceInstanceId = decodeCanonicalPart('sourceInstanceId', instancePart);
  assertCompoundId('sourceInstanceId', sourceInstanceId);
  const domain = domainPart === '' ? null : decodeCanonicalPart('domain', domainPart);
  const externalKey = decodeCanonicalPart('externalKey', keyPart);
  return { sourceInstanceId, domain, externalKey };
}

/**
 * Canonical `accountId|problemKey` key for one submission.
 *
 * The account id is a nested compound id of its own, so it is escaped as one opaque part;
 * composing through {@link accountIdOf} plus this function keeps handles, domains and
 * external keys containing `|`, `:`, `@` or non-ASCII characters unambiguous.
 */
export function submissionKey(ref: SubmissionRef): string {
  assertCompoundId('accountId', ref.accountId);
  return [encodedPart('accountId', ref.accountId), problemKey(ref)].join(ID_SEPARATOR);
}

/**
 * Canonical `sourceInstanceId|handle` account id.
 *
 * Both components are escaped; an instance id (`platform:domain`, possibly `host:port`) is
 * opaque here. The handle keeps its platform spelling (trimmed and NFC-normalised only)
 * because CF and Luogu both display and address handles case-sensitively in URLs;
 * comparison must go through the adapter's own normalisation, not through a lossy
 * lowercase here.
 */
export function accountIdOf(sourceInstanceId: string, handle: string): string {
  assertCompoundId('sourceInstanceId', sourceInstanceId);
  invariant(typeof handle === 'string', 'invalid_id_part', 'handle must be a string', { handle });
  return [encodedPart('sourceInstanceId', sourceInstanceId), encodedPart('handle', handle)].join(ID_SEPARATOR);
}

/** Inverse of {@link accountIdOf}. Throws `invalid_id_part` for a malformed account id. */
export function parseAccountId(accountId: string): { sourceInstanceId: string; handle: string } {
  invariant(typeof accountId === 'string', 'invalid_id_part', 'account id must be a string', { accountId });
  const parts = accountId.split(ID_SEPARATOR);
  invariant(parts.length === 2, 'invalid_id_part', `account id must have 2 parts (got ${parts.length})`, {
    accountId,
  });
  const [instancePart, handlePart] = parts as [string, string];
  const sourceInstanceId = decodeCanonicalPart('sourceInstanceId', instancePart);
  assertCompoundId('sourceInstanceId', sourceInstanceId);
  return { sourceInstanceId, handle: decodeCanonicalPart('handle', handlePart) };
}

/**
 * Snapshot id = `problemKey@contentHash:v<version>`.
 *
 * The version is part of the identity, not decoration. An `A -> B -> A` re-fetch produces
 * the same content hash as the first `A` but a *different* snapshot (version 3 versus 1);
 * persistence keys immutable snapshots by this id and derives the analysis job id from it,
 * so leaving the version out would let `getSnapshot(id)` return the superseded body and
 * reuse an old job for the new version. Refetching genuinely unchanged content keeps the
 * previous version, so it still yields exactly the previous id and stays idempotent.
 */
export function snapshotIdOf(ref: ProblemRef, contentHash: string, version: number): string {
  invariant(/^[0-9a-f]{64}$/.test(contentHash), 'invalid_input', 'contentHash must be a sha256 hex digest', {
    contentHash,
  });
  invariant(
    Number.isInteger(version) && version >= 1,
    'invalid_input',
    'snapshot version must be an integer >= 1',
    { version },
  );
  return `${problemKey(ref)}${HASH_SEPARATOR}${contentHash}${VERSION_SEPARATOR}v${version}`;
}

/** ISO-8601 UTC timestamp validation (adapters must pass normalised timestamps). */
export function assertIsoTimestamp(label: string, value: string): string {
  invariant(typeof value === 'string' && value.length > 0, 'invalid_timestamp', `${label} is required`, { label });
  const parsed = Date.parse(value);
  invariant(Number.isFinite(parsed), 'invalid_timestamp', `${label} must be a parseable timestamp`, { label, value });
  return new Date(parsed).toISOString();
}

/** Throw unless `value` is an absolute http(s) URL suitable for a user-facing link. */
export function assertHttpUrl(label: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new DomainError('invalid_url', `${label} must be an absolute URL`, { label, value, cause: String(cause) });
  }
  invariant(
    parsed.protocol === 'http:' || parsed.protocol === 'https:',
    'invalid_url',
    `${label} must use http(s)`,
    { label, value, protocol: parsed.protocol },
  );
  return parsed.toString();
}

/** Compare two ids for equality without throwing on malformed input. */
export function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  return typeof left === 'string' && typeof right === 'string' && left === right;
}
