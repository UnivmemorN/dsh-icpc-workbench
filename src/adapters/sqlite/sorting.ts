/**
 * Read-only helpers behind the two deterministic SQLite scalar functions of the bank sorts.
 *
 * The adapter registers exactly these two names on the connection:
 *
 * - {@link NATURAL_KEY_FUNCTION} — `natural_sort_key(value)`, the lexicographically sortable form of
 *   a platform external key (`2A` before `10A`). The ordering rule itself is the domain's
 *   {@link naturalSortKey}; this module only supplies the SQLite binding.
 * - {@link RATING_VALUE_FUNCTION} — `rating_value(body, dimension)`, the finite numeric value of one
 *   raw rating dimension read from a stored `problems.body`, or `NULL` when the row has no such
 *   dimension or its value is blank, non-numeric or not finite. `NULL` is what makes "unrated"
 *   sortable last in both directions without inventing a `0`.
 *
 * Everything here is pure and takes only bound values, so a hostile rating dimension is matched as
 * literal data and can never become part of the statement. The parsing code lives in the adapter —
 * not in the domain — because it reads the adapter's own stored row shape; the numeric-string rule
 * it applies is the domain's {@link numericText}, so the two cannot drift.
 */
import { numericText } from '../../domain/index.js';

/** SQLite name of the natural-key scalar function; registered with `deterministic: true`. */
export const NATURAL_KEY_FUNCTION = 'icpc_natural_sort_key';

/** SQLite name of the raw-rating scalar function; registered with `deterministic: true`. */
export const RATING_VALUE_FUNCTION = 'icpc_rating_value';

/**
 * The finite numeric value of `dimension` inside one stored problem body, or `null`.
 *
 * `null` covers every "not comparable" case: a body that is not a JSON object, a missing or
 * non-array `ratings` member, no entry for the dimension, a non-string/non-number value, a blank
 * string, a non-numeric string, and a non-finite number. A numeric string is accepted with
 * surrounding whitespace (`' 1800 '`), because that is the same rating. The comparison itself is
 * case-insensitive on trimmed dimension text, matching the domain's own lookup.
 */
export function ratingValueFromBody(body: unknown, dimension: unknown): number | null {
  if (typeof body !== 'string' || body.length === 0 || typeof dimension !== 'string') {
    return null;
  }
  const wanted = dimension.trim().toLowerCase();
  if (wanted.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // A stored body that is not JSON cannot describe a rating; unknown is the honest answer.
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const ratings = (parsed as { readonly ratings?: unknown }).ratings;
  if (!Array.isArray(ratings)) {
    return null;
  }
  for (const entry of ratings) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const candidate = entry as { readonly dimension?: unknown; readonly value?: unknown };
    if (typeof candidate.dimension !== 'string' || candidate.dimension.trim().toLowerCase() !== wanted) {
      continue;
    }
    const value = candidate.value;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    return typeof value === 'string' ? numericText(value) : null;
  }
  return null;
}
