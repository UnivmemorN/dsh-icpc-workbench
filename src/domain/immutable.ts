/**
 * Structural immutability helpers.
 *
 * Snapshots, analysis results and plans are shared between the UI, the persistence layer
 * and background jobs. Freezing them at creation time turns "someone mutated shared state"
 * into an immediate, loud failure instead of a silent stale-data bug.
 */

/** Recursively freeze a JSON-like value (arrays and plain objects). Returns the same reference. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** True when the value (and every nested object/array) is frozen. */
export function isDeeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return true;
  }
  if (!Object.isFrozen(value)) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every(isDeeplyFrozen);
}
