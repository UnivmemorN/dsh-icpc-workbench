/**
 * Normalised problem metadata.
 *
 * Adapters translate platform payloads into this shape. Raw platform data that the
 * product does not interpret (difficulty dimensions, original tags) is preserved verbatim
 * instead of being coerced, so later stages can display or re-classify it without loss.
 */
import { DomainError, invariant } from './errors.js';
import { assertHttpUrl, assertIsoTimestamp, normalizeKeyPart, problemKey, type ProblemRef } from './ids.js';
import { deepFreeze } from './immutable.js';

/**
 * One raw rating dimension exactly as the platform reports it.
 * Codeforces: `{ dimension: 'rating', value: 2400 }`; Luogu: `{ dimension: 'difficulty', value: 7 }`.
 */
export interface PlatformRating {
  readonly dimension: string;
  readonly value: number | string;
  /** Optional scale bounds the platform documents for this dimension. */
  readonly scale: { readonly min: number; readonly max: number } | null;
  /** Original textual form when the platform reports text as well as a number. */
  readonly raw: string;
}

/** An original platform tag, preserved unchanged for provenance. */
export interface RawTag {
  readonly raw: string;
  /** Trailing/leading whitespace removed; casing preserved as reported. */
  readonly sourceInstanceId: string;
}

/** Normalised problem metadata as stored inside a snapshot. */
export interface NormalizedProblem {
  readonly ref: ProblemRef;
  /** Canonical `sourceInstanceId|domain|externalKey`. */
  readonly key: string;
  readonly title: string;
  /** Absolute http(s) problem URL. */
  readonly url: string;
  /** Complete statement text; null means it has not been retrieved. */
  readonly statement: string | null;
  /** Raw platform ratings; never normalised into a single cross-platform scale. */
  readonly ratings: readonly PlatformRating[];
  /** Original platform tags, deduplicated by trimmed text, order preserved. */
  readonly rawTags: readonly RawTag[];
  /** When the adapter observed this metadata. */
  readonly fetchedAt: string;
}

export interface CreateNormalizedProblemInput {
  readonly ref: ProblemRef;
  readonly title: string;
  readonly url: string;
  /** Complete statement text; null means it has not been retrieved. */
  readonly statement?: string | null;
  readonly fetchedAt: string;
  readonly ratings?: readonly PlatformRating[];
  readonly rawTags?: readonly string[];
}

function normalizeRating(rating: PlatformRating): PlatformRating {
  const dimension = rating.dimension.trim();
  invariant(dimension.length > 0, 'invalid_input', 'rating dimension must not be empty', { rating });
  const value = rating.value;
  if (typeof value === 'number') {
    invariant(Number.isFinite(value), 'invalid_input', 'rating value must be finite', { rating });
  }
  if (rating.scale) {
    invariant(
      Number.isFinite(rating.scale.min) && Number.isFinite(rating.scale.max) && rating.scale.min <= rating.scale.max,
      'invalid_input',
      'rating scale must satisfy min <= max',
      { rating },
    );
  }
  return { dimension, value, scale: rating.scale ? { ...rating.scale } : null, raw: rating.raw };
}

/** Build a validated, frozen normalised problem. */
export function createNormalizedProblem(input: CreateNormalizedProblemInput): NormalizedProblem {
  const title = input.title.trim();
  invariant(title.length > 0, 'invalid_input', 'problem title must not be empty', { ref: input.ref });
  const seen = new Set<string>();
  const rawTags: RawTag[] = [];
  for (const tag of input.rawTags ?? []) {
    const raw = tag.trim();
    if (raw.length === 0) {
      continue;
    }
    const dedupeKey = raw.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    rawTags.push({ raw, sourceInstanceId: input.ref.sourceInstanceId });
  }
  const keyRef: ProblemRef = {
    sourceInstanceId: input.ref.sourceInstanceId,
    domain: input.ref.domain?.trim() || null,
    externalKey: normalizeKeyPart(input.ref.externalKey),
  };
  return deepFreeze({
    ref: keyRef,
    key: problemKey(keyRef),
    title,
    url: assertHttpUrl('problem url', input.url),
    statement: input.statement?.trim() || null,
    ratings: (input.ratings ?? []).map(normalizeRating),
    rawTags,
    fetchedAt: assertIsoTimestamp('fetchedAt', input.fetchedAt),
  });
}

/** Look up one raw rating dimension, or `null` when the platform did not report it. */
export function findRating(problem: NormalizedProblem, dimension: string): PlatformRating | null {
  const wanted = dimension.trim().toLowerCase();
  return problem.ratings.find((rating) => rating.dimension.toLowerCase() === wanted) ?? null;
}

/** Numeric value of a rating dimension, or `null` when absent/non-numeric. */
export function numericRating(problem: NormalizedProblem, dimension: string): number | null {
  const rating = findRating(problem, dimension);
  if (!rating) {
    return null;
  }
  return typeof rating.value === 'number' ? rating.value : Number.isFinite(Number(rating.value)) ? Number(rating.value) : null;
}

/** Assert two problems belong to the same problem identity. */
export function assertSameProblem(left: NormalizedProblem, right: Pick<NormalizedProblem, 'key'>): void {
  if (left.key !== right.key) {
    throw new DomainError('invalid_input', 'problems do not share the same identity', {
      left: left.key,
      right: right.key,
    });
  }
}
