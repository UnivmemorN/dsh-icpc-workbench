/**
 * Editorial material: sources (the page/article identity) and solutions (the individual
 * write-ups inside a source).
 *
 * Evidence verification is always resolved against one *specific solution*, never against
 * the whole source page. That distinction is what makes "the excerpt exists in this
 * solution" a checkable claim instead of a keyword search across unrelated text.
 */
import { DomainError, invariant } from './errors.js';
import { assertHttpUrl, assertIdPart, assertIsoTimestamp } from './ids.js';
import { deepFreeze } from './immutable.js';
import { contentHashOf, sha256Hex, utf8Bytes } from './hash.js';

/**
 * Availability discriminant shared by adapters and the domain.
 * `absent` means "the platform answered and has no editorial";
 * every other non-`found` value is an explicit, non-silent failure mode.
 */
export type EditorialAvailability =
  | 'found'
  | 'absent'
  | 'auth_required'
  | 'forbidden'
  | 'rate_limited'
  | 'unavailable'
  | 'changed_response';

export const EDITORIAL_AVAILABILITIES: readonly EditorialAvailability[] = [
  'found',
  'absent',
  'auth_required',
  'forbidden',
  'rate_limited',
  'unavailable',
  'changed_response',
];

export type EditorialSourceKind = 'editorial' | 'solution' | 'discussion' | 'video' | 'other';

/** One addressable editorial page/article. */
export interface EditorialSource {
  /** Stable id within the snapshot (adapter-derived, e.g. `cf-blog-12345`). */
  readonly id: string;
  readonly kind: EditorialSourceKind;
  readonly url: string;
  readonly title: string;
  readonly author: string | null;
  readonly language: string | null;
  readonly publishedAt: string | null;
  readonly retrievedAt: string;
  readonly availability: EditorialAvailability;
  /** Hash of the retrieved body, `null` when nothing was retrieved. */
  readonly contentHash: string | null;
  /** Free-form note (e.g. rate-limit window). Never a substitute for a discriminant. */
  readonly note: string | null;
}

/** One solution write-up inside a source. `text` is the evidence verification target. */
export interface EditorialSolution {
  /** Stable id within the snapshot. */
  readonly solutionId: string;
  /** Owning {@link EditorialSource.id}. */
  readonly sourceId: string;
  /** Order of the write-up inside its source (0-based). */
  readonly ordinal: number;
  readonly title: string;
  /** Canonical body text used for evidence checks and content hashing. */
  readonly text: string;
  readonly contentHash: string;
  readonly language: string | null;
}

export interface CreateEditorialSourceInput {
  readonly id: string;
  readonly kind: EditorialSourceKind;
  readonly url: string;
  readonly title: string;
  readonly availability: EditorialAvailability;
  readonly retrievedAt: string;
  readonly author?: string | null;
  readonly language?: string | null;
  readonly publishedAt?: string | null;
  /** Retrieved body; required when `availability === 'found'`. */
  readonly text?: string | null;
  readonly note?: string | null;
}

/** Build a validated, frozen editorial source; `contentHash` is derived from `text`. */
export function createEditorialSource(input: CreateEditorialSourceInput): EditorialSource {
  assertIdPart('editorial source id', input.id);
  const title = input.title.trim();
  invariant(title.length > 0, 'invalid_input', 'editorial source title must not be empty', { id: input.id });
  const text = input.text ?? null;
  if (input.availability === 'found') {
    invariant(
      typeof text === 'string' && text.trim().length > 0,
      'invalid_input',
      'found editorial source requires retrieved text',
      { id: input.id },
    );
  }
  return deepFreeze({
    id: input.id,
    kind: input.kind,
    url: assertHttpUrl('editorial source url', input.url),
    title,
    author: input.author?.trim() || null,
    language: input.language?.trim() || null,
    publishedAt: input.publishedAt ? assertIsoTimestamp('publishedAt', input.publishedAt) : null,
    retrievedAt: assertIsoTimestamp('retrievedAt', input.retrievedAt),
    availability: input.availability,
    contentHash: text === null ? null : sha256Hex(utf8Bytes(text)),
    note: input.note?.trim() || null,
  });
}

export interface CreateEditorialSolutionInput {
  readonly solutionId: string;
  readonly sourceId: string;
  readonly ordinal: number;
  readonly title: string;
  readonly text: string;
  readonly language?: string | null;
}

/** Build a validated, frozen editorial solution. */
export function createEditorialSolution(input: CreateEditorialSolutionInput): EditorialSolution {
  assertIdPart('solutionId', input.solutionId);
  assertIdPart('sourceId', input.sourceId);
  invariant(Number.isInteger(input.ordinal) && input.ordinal >= 0, 'invalid_input', 'ordinal must be >= 0', {
    ordinal: input.ordinal,
  });
  const text = input.text;
  invariant(typeof text === 'string' && text.trim().length > 0, 'invalid_input', 'solution text must not be empty', {
    solutionId: input.solutionId,
  });
  return deepFreeze({
    solutionId: input.solutionId,
    sourceId: input.sourceId,
    ordinal: input.ordinal,
    title: input.title.trim() || `solution ${input.ordinal + 1}`,
    text,
    contentHash: sha256Hex(utf8Bytes(text)),
    language: input.language?.trim() || null,
  });
}

/** Whitespace/case-insensitive normalisation used for evidence excerpt matching. */
export function normalizeEvidenceText(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

/** Minimum excerpt length accepted as evidence (guards against trivially forged matches). */
export const MIN_EVIDENCE_EXCERPT_CHARS = 12;

export type EvidenceExcerptFailure = 'empty_excerpt' | 'excerpt_too_short' | 'not_in_solution';

export interface EvidenceExcerptCheck {
  readonly ok: boolean;
  readonly reason: EvidenceExcerptFailure | null;
  readonly normalizedExcerpt: string;
}

/**
 * Check that `excerpt` really occurs inside this specific solution's text.
 * Matching is whitespace/case-insensitive but otherwise literal.
 */
export function verifyExcerptInSolution(
  solution: Pick<EditorialSolution, 'text'>,
  excerpt: string,
  minExcerptChars: number = MIN_EVIDENCE_EXCERPT_CHARS,
): EvidenceExcerptCheck {
  const normalizedExcerpt = normalizeEvidenceText(excerpt);
  if (normalizedExcerpt.length === 0) {
    return { ok: false, reason: 'empty_excerpt', normalizedExcerpt };
  }
  if (normalizedExcerpt.length < minExcerptChars) {
    return { ok: false, reason: 'excerpt_too_short', normalizedExcerpt };
  }
  const haystack = normalizeEvidenceText(solution.text);
  if (!haystack.includes(normalizedExcerpt)) {
    return { ok: false, reason: 'not_in_solution', normalizedExcerpt };
  }
  return { ok: true, reason: null, normalizedExcerpt };
}

/**
 * A model's claim that one *specific solution* supports one tag.
 *
 * The pair `(sourceId, solutionId)` exists so that "the excerpt is in the solution the
 * model named" is checkable: an excerpt that only occurs somewhere else on the source page
 * does not count as evidence for this solution.
 */
export interface EvidenceRef {
  /** Owning {@link EditorialSource.id}. */
  readonly sourceId: string;
  /** The exact solution the excerpt was taken from. */
  readonly solutionId: string;
  /** Verbatim quote from `solutionId`'s text. */
  readonly excerpt: string;
  readonly note?: string | null;
}

/**
 * Validate and freeze an evidence reference.
 *
 * Ids are *encoded id parts* (see `./ids.js`), so a missing separator can never turn into a
 * silently different reference; the excerpt stays verbatim because it is later matched
 * against the solution text.
 */
export function createEvidenceRef(input: EvidenceRef): EvidenceRef {
  assertIdPart('evidence sourceId', input.sourceId);
  assertIdPart('evidence solutionId', input.solutionId);
  invariant(typeof input.excerpt === 'string', 'invalid_input', 'evidence excerpt must be a string', {
    solutionId: input.solutionId,
  });
  return deepFreeze({
    sourceId: input.sourceId,
    solutionId: input.solutionId,
    excerpt: input.excerpt,
    note: input.note?.trim() || null,
  });
}

/** Content hash of a source+solution set, used inside snapshot hashing. */
export function hashEditorialContent(
  sources: readonly EditorialSource[],
  solutions: readonly EditorialSolution[],
): string {
  return contentHashOf({
    sources: sources.map((source) => ({ ...source })),
    solutions: solutions.map((solution) => ({ ...solution })),
  });
}

/** Assert a solution belongs to a source that exists in the same collection. */
export function assertSolutionSource(
  solution: Pick<EditorialSolution, 'solutionId' | 'sourceId'>,
  sourceIds: ReadonlySet<string>,
): void {
  if (!sourceIds.has(solution.sourceId)) {
    throw new DomainError('missing_reference', `solution ${solution.solutionId} references unknown source`, {
      solutionId: solution.solutionId,
      sourceId: solution.sourceId,
    });
  }
}
