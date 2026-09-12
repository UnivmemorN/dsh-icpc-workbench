/**
 * Storage adapter errors.
 *
 * The domain already models *data* violations (`immutable_violation`, `invalid_input`, …);
 * this type covers the failures only a persistence adapter can produce: an unusable path, a
 * database written by a newer schema, a closed store, a corrupt row. Codes are stable so the
 * plugin and tests can branch on them instead of matching prose.
 *
 * The scope codes are deliberate contracts, not implementation leaks:
 * `nested_transaction` — one connection cannot emulate parallel nested transactions, so a
 * nested `transaction()` call is refused before its callback runs; `backup_in_transaction` —
 * a backup issued from inside the store's own transaction would wait for the connection it
 * already owns; `transaction_scope_escaped` — an operation that outlived the transaction it
 * was started in must not silently write outside it.
 */
export type StorageErrorCode =
  | 'closed'
  | 'invalid_path'
  | 'open_failed'
  | 'schema_too_new'
  | 'unsupported_schema'
  | 'migration_failed'
  | 'backup_exists'
  | 'backup_failed'
  | 'corrupt_row'
  | 'transaction_scope_escaped'
  | 'nested_transaction'
  | 'backup_in_transaction'
  | 'close_in_transaction'
  | 'rollback_failed';

export interface StorageErrorDetails {
  readonly [key: string]: unknown;
}

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly details: StorageErrorDetails;

  constructor(code: StorageErrorCode, message: string, details: StorageErrorDetails = {}) {
    super(message, details['cause'] === undefined ? undefined : { cause: details['cause'] });
    this.name = 'StorageError';
    this.code = code;
    this.details = details;
  }
}
