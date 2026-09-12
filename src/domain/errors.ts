/**
 * Domain-level error type.
 *
 * Domain code never performs IO, so every failure is either a caller contract violation
 * (invalid input) or an explicitly modelled state transition. Errors carry a stable
 * machine-readable `code` so adapters/UI can map them without string matching.
 */
export type DomainErrorCode =
  | 'invalid_input'
  | 'invalid_id_part'
  | 'invalid_url'
  | 'invalid_timestamp'
  | 'duplicate_id'
  | 'missing_reference'
  | 'unknown_taxonomy_id'
  | 'non_serializable_content'
  | 'immutable_violation'
  | 'invalid_transition'
  | 'cancelled'
  | 'unfilled_settings';

export interface DomainErrorDetails {
  readonly [key: string]: unknown;
}

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: DomainErrorDetails;

  constructor(code: DomainErrorCode, message: string, details: DomainErrorDetails = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

/** Throw a {@link DomainError} unless `condition` holds. */
export function invariant(
  condition: unknown,
  code: DomainErrorCode,
  message: string,
  details: DomainErrorDetails = {},
): asserts condition {
  if (!condition) {
    throw new DomainError(code, message, details);
  }
}

/** Fail fast for settings that must be supplied explicitly by the caller. */
export function requireFiniteInt(value: number | undefined, name: string, min = 0): number {
  invariant(
    typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= min,
    'unfilled_settings',
    `${name} must be an explicit integer >= ${min}`,
    { name, value },
  );
  return value;
}
