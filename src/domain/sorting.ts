/**
 * Pure ordering rules of the problem bank: natural external keys and strict numeric ratings.
 *
 * These helpers exist in the domain — not in the UI and not in the SQLite adapter — because the
 * order of two bank rows is a product rule, not a rendering detail: the same rule has to decide the
 * SQLite `ORDER BY`, the unit tests and any later consumer. They perform no IO, hold no state and
 * read no clock.
 *
 * ## Natural external-key order
 *
 * A platform external key is an opaque label such as `2A`, `10A`, `P2`, `P10` or `E1`. Plain text
 * order puts `10A` before `2A` (the character `1` sorts before `2`), which reads as wrong to anyone
 * looking at a problem list, so {@link naturalSortKey} encodes a key into ONE collision-safe,
 * lexicographically sortable string:
 *
 * - a maximal ASCII digit run becomes the six-hex code point of ASCII `0` (`000030`), then a
 *   fixed-width 16-decimal significant length, then the run without its leading zeros;
 * - every other Unicode code point becomes its own six-hex code point.
 *
 * Comparing two encodings with a plain `<` — exactly what SQLite's BINARY collation does — therefore
 * reproduces the natural rule: digit runs compare as integers whatever their length (`2A` before
 * `10A`, `P2` before `P10`, a 40-digit run without losing precision), a digit run keeps the text
 * position of `0` relative to punctuation (`A#` before `A2`), a key that is a prefix sorts first
 * (`2` before `2A`), non-digit text keeps Unicode code point order and the empty key sorts first.
 * Leading zeros are insignificant for ordering (`007` ties `7`) but never lost from the stored key;
 * such a tie is resolved by the caller's canonical-key tie break, so the final order stays total and
 * deterministic.
 *
 * ## Numeric rating values
 *
 * {@link numericRatingValue} reads one raw platform rating dimension as a finite number, or `null`
 * when the dimension is missing, blank, non-numeric or not finite. A numeric string is accepted with
 * surrounding whitespace (`' 1800 '`), and the stored raw value is never rewritten. `null` is the
 * honest answer and callers place it last in BOTH directions: a problem without a comparable rating
 * is not "the easiest one", and inventing `0` for it would silently reorder the bank.
 */
import type { PlatformRating } from './problem.js';

/** Marker of a digit run: the code point of ASCII `0`, where a run's first character sits. */
const DIGIT_RUN_MARKER = '000030';

/** Width of the significant-length field; 16 decimal digits cover any run a key can hold. */
const LENGTH_WIDTH = 16;

/** A maximal ASCII digit run (non-global, so `.test` is stateless). */
const DIGIT_RUN = /^[0-9]+$/u;

/**
 * A canonical, lexicographically sortable encoding of one key.
 *
 * Two different keys produce the same encoding only when the natural rule calls them equal
 * (identical text, or digit runs that differ in leading zeros alone), so a SQLite `ORDER BY` on this
 * value is deterministic and the caller's canonical-key tie break is enough to make it total.
 */
export function naturalSortKey(value: string): string {
  if (typeof value !== 'string') {
    return '';
  }
  let out = '';
  for (const part of value.match(/[0-9]+|[^0-9]+/gu) ?? []) {
    if (DIGIT_RUN.test(part)) {
      const significant = part.replace(/^0+/u, '') || '0';
      out += DIGIT_RUN_MARKER + String(significant.length).padStart(LENGTH_WIDTH, '0') + significant;
      continue;
    }
    for (const character of part) {
      out += (character.codePointAt(0) as number).toString(16).padStart(6, '0');
    }
  }
  return out;
}

/**
 * Compare two keys in natural order: `-1` when `left` sorts first, `1` when `right` does, `0` when
 * they are equal under this rule (identical text, or digit runs that differ in leading zeros alone).
 */
export function compareNaturalKeys(left: string, right: string): number {
  const leftKey = naturalSortKey(left);
  const rightKey = naturalSortKey(right);
  if (leftKey === rightKey) {
    return 0;
  }
  return leftKey < rightKey ? -1 : 1;
}

/**
 * The numeric value of one rating dimension, or `null` when it cannot be compared.
 *
 * Accepted values are a finite `number` and a finite numeric string; `'1800'` and `' 1800 '` are the
 * same rating, so surrounding whitespace is ignored. A blank string, a non-numeric string
 * (`'unrated'`), `NaN` and a non-finite number are all `null`: coercing a blank value to `0` would
 * place an unrated problem at the bottom of a difficulty sort, which is a different claim than "this
 * problem has no such rating". The dimension is matched case-insensitively on trimmed text, so the
 * platform's own spelling is irrelevant while the stored raw rating itself is never rewritten.
 */
export function numericRatingValue(
  ratings: readonly PlatformRating[] | null | undefined,
  dimension: string,
): number | null {
  if (!Array.isArray(ratings) || typeof dimension !== 'string') {
    return null;
  }
  const wanted = dimension.trim().toLowerCase();
  if (wanted.length === 0) {
    return null;
  }
  for (const rating of ratings) {
    if (rating === null || typeof rating !== 'object' || typeof rating.dimension !== 'string') {
      continue;
    }
    if (rating.dimension.trim().toLowerCase() !== wanted) {
      continue;
    }
    const value = rating.value;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
      return numericText(value);
    }
    return null;
  }
  return null;
}

/**
 * The same strict rule for one already-extracted textual value.
 *
 * Split out so the SQLite adapter evaluates exactly one implementation: its native function reads
 * the rating entry out of the stored JSON body and then defers to this predicate, instead of
 * maintaining a second parser that could drift from the domain.
 */
export function numericText(value: string): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}
