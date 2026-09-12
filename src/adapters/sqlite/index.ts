/**
 * SQLite persistence adapter.
 *
 * `SqliteTrainingStore` is the only public entry point: construct it with an explicit
 * database path, use it through the {@link TrainingStore} port and `close()` it when the
 * plugin unloads. The other modules are implementation details (schema/versioning, row
 * codecs, connection serialization, error codes).
 */
export { SqliteTrainingStore, type SqliteTrainingStoreOptions } from './store.js';
export { StorageError, type StorageErrorCode, type StorageErrorDetails } from './errors.js';
export {
  META_MARKER_KEY,
  META_TABLE,
  SCHEMA_VERSION_EMPTY,
  SCHEMA_VERSION_V1,
  SCHEMA_VERSION_V2,
  STORE_MARKER,
  STORE_SCHEMA_VERSION,
  STORE_TABLES_V1,
  STORE_TABLES_V2,
  STORE_TABLES_V3,
} from './schema.js';
