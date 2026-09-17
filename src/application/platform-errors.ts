/**
 * Operational platform errors.
 *
 * Platform IO fails in ways the product must tell apart: cancellation, an authentication or
 * permission wall, a rate limit, a temporary outage, a response whose shape the adapter no
 * longer understands, and a caller mistake. None of those may be disguised as "no editorial"
 * or as an empty page, so adapters raise this one typed error and callers branch on `code`
 * without string matching.
 *
 * Retry metadata is deliberately body-free: `detail` is a short sanitized reason, `sample` is
 * an optional truncated snippet used only by `changed_response`, and response bodies, cookies,
 * credentials and query strings never enter an error.
 */
import { DomainError } from '../domain/index.js';
import type { EditorialFetchResult } from './ports.js';

export type PlatformErrorCode =
  | 'cancelled'
  | 'auth_required'
  | 'forbidden'
  | 'rate_limited'
  | 'unavailable'
  | 'changed_response'
  | 'invalid_input';

export const PLATFORM_ERROR_CODES: readonly PlatformErrorCode[] = [
  'cancelled',
  'auth_required',
  'forbidden',
  'rate_limited',
  'unavailable',
  'changed_response',
  'invalid_input',
];

/** Which adapter operation failed. Diagnostic context only, never control flow. */
export type PlatformOperation =
  | 'catalog'
  | 'problem'
  | 'statement'
  | 'submissions'
  | 'editorial'
  | 'rating'
  | 'profile';

/**
 * Closed, body-free diagnostic reason of a platform failure.
 *
 * The vocabulary exists so the layers above can tell *apart* the failure modes that share
 * `changed_response` — an HTML/CAPTCHA page, malformed JSON, a JSON payload that is not the
 * documented shape, and a valid payload whose statement is legitimately incomplete — without
 * matching on a parser message, an exception text or a response body. Every value names a
 * diagnosis, never content: no reason can carry a body, a sample, a cookie or a credential, so a
 * reason is safe to persist in durable per-key diagnostics.
 */
export type PlatformErrorReason = 'missing_statement' | 'html_response' | 'invalid_json' | 'invalid_payload';

export const PLATFORM_ERROR_REASONS: readonly PlatformErrorReason[] = [
  'missing_statement',
  'html_response',
  'invalid_json',
  'invalid_payload',
];

export interface PlatformErrorInput {
  readonly code: PlatformErrorCode;
  readonly operation: PlatformOperation;
  /** Short human-readable reason. Sanitized and truncated; never a response body. */
  readonly detail: string;
  /** Defaults to `true` for `rate_limited`/`unavailable`, `false` for every other code. */
  readonly retryable?: boolean;
  /** Server-requested delay in milliseconds, preserved as declared; the transport decides whether it can be honoured. */
  readonly retryAfterMs?: number | null;
  /** How many HTTP attempts were made before this failure. */
  readonly attempts?: number;
  /** Short response snippet for `changed_response`; never a full body. */
  readonly sample?: string | null;
  /**
   * Optional closed diagnostic reason; an unknown value is dropped instead of being stored.
   *
   * Deliberately optional: a failure whose mode this build cannot name carries no reason at all,
   * which is honest ("unknown") rather than a guessed classification.
   */
  readonly reason?: PlatformErrorReason | null;
}

const MAX_DETAIL_CHARS = 300;
const MAX_SAMPLE_CHARS = 240;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const WHITESPACE_RUN = /\s+/gu;

/** Codes that are retryable unless the caller says otherwise. */
const RETRYABLE_BY_DEFAULT: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>(['rate_limited', 'unavailable']);

function sanitize(value: string, maxChars: number): string {
  const cleaned = value.replace(UNSAFE_CONTROL, ' ').replace(WHITESPACE_RUN, ' ').trim();
  return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, maxChars)}...`;
}

function normalizeRetryAfter(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/**
 * One operational platform failure.
 *
 * Construction sanitizes every textual field and validates the retry numbers, so an error can
 * never carry a raw body, a cookie or a control character into logs or the UI.
 */
export class PlatformError extends Error {
  readonly code: PlatformErrorCode;
  readonly operation: PlatformOperation;
  /** Sanitized short reason; never a response body, cookie or credential. */
  readonly detail: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly attempts: number;
  readonly sample: string | null;
  /** Closed diagnostic reason of this failure, or `null` when this build cannot name one. */
  readonly reason: PlatformErrorReason | null;

  constructor(input: PlatformErrorInput) {
    const detail = sanitize(typeof input.detail === 'string' ? input.detail : '', MAX_DETAIL_CHARS);
    super(detail.length > 0 ? detail : `platform ${input.code} failure`);
    this.name = 'PlatformError';
    this.code = input.code;
    this.operation = input.operation;
    this.detail = detail.length > 0 ? detail : `platform ${input.code} failure`;
    this.retryable = input.retryable ?? RETRYABLE_BY_DEFAULT.has(input.code);
    this.retryAfterMs = normalizeRetryAfter(input.retryAfterMs);
    this.attempts =
      typeof input.attempts === 'number' && Number.isInteger(input.attempts) && input.attempts >= 0 ? input.attempts : 1;
    this.sample =
      typeof input.sample === 'string' && input.sample.trim().length > 0 ? sanitize(input.sample, MAX_SAMPLE_CHARS) : null;
    this.reason = normalizeReason(input.reason);
  }
}

/**
 * Accept only a declared reason; anything else — including `undefined` — becomes `null`.
 *
 * The check is by allowlist membership, so a caller cannot smuggle free text through the field and
 * a future reason added to the vocabulary is still a one-line change here.
 */
function normalizeReason(value: PlatformErrorReason | null | undefined): PlatformErrorReason | null {
  return typeof value === 'string' && PLATFORM_ERROR_REASONS.includes(value) ? value : null;
}

/** Build a sanitized {@link PlatformError}. */
export function platformError(input: PlatformErrorInput): PlatformError {
  return new PlatformError(input);
}

/** Narrow an unknown rejection reason to a {@link PlatformError}. */
export function isPlatformError(value: unknown): value is PlatformError {
  return value instanceof PlatformError;
}

/**
 * Convert an arbitrary rejection reason into a {@link PlatformError}.
 *
 * Cancellation keeps its own code so callers can still treat it as cancellation; anything else
 * becomes a non-retryable `unavailable`, because an unrecognized failure must never be
 * presented as a successful empty result.
 */
export function describePlatformError(error: unknown, operation: PlatformOperation): PlatformError {
  if (isPlatformError(error)) {
    return error;
  }
  if (error instanceof DomainError && error.code === 'cancelled') {
    return new PlatformError({ code: 'cancelled', operation, retryable: false, detail: error.message });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new PlatformError({
    code: 'unavailable',
    operation,
    retryable: false,
    detail: `unexpected platform failure: ${message}`,
  });
}

/**
 * Map an operational error onto the editorial result contract.
 *
 * `invalid_input` and `cancelled` are not converted: they are caller/control-flow conditions
 * and are rethrown so a pipeline cannot mistake them for a platform answer. No code maps to
 * `absent` — proving that an editorial does not exist is a different, explicit finding.
 */
export function editorialFailureFromPlatformError(
  error: PlatformError,
): Exclude<EditorialFetchResult, { status: 'found' }> {
  switch (error.code) {
    case 'auth_required':
      return { status: 'auth_required', detail: error.detail };
    case 'forbidden':
      return { status: 'forbidden', detail: error.detail };
    case 'rate_limited':
      return { status: 'rate_limited', detail: error.detail, retryAfterMs: error.retryAfterMs };
    case 'unavailable':
      // A 503 (or any other temporary outage) may declare Retry-After too; dropping it here would
      // lose the provider's own deadline before the source gate could retain it.
      return { status: 'unavailable', detail: error.detail, retryable: error.retryable, retryAfterMs: error.retryAfterMs };
    case 'changed_response':
      return { status: 'changed_response', detail: error.detail, sample: error.sample };
    case 'invalid_input':
    case 'cancelled':
      throw error;
  }
}
