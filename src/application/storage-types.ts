/**
 * Storage-facing application types.
 *
 * Shared by the persistence port (`./ports.js`), its adapters and the callers that keep
 * incremental sync state. They carry **no credentials**: an account is a handle plus a
 * source instance and every secret stays in the plugin's adapter configuration, so a store
 * implementation has no field in which a credential could be persisted.
 *
 * Pagination bounds are part of the contract: a page holds between `minPageSize` and
 * `maxPageSize` items and cursors are opaque strings produced by the store, so no caller
 * can request an unbounded read or invent a cursor that changes the ordering.
 */
import { encodeIdPart } from '../domain/index.js';

/** Hard bounds every store implementation must enforce on `PageRequest.limit`. */
export interface StoragePageLimits {
  readonly minPageSize: number;
  readonly maxPageSize: number;
}

export const STORAGE_PAGE_LIMITS: StoragePageLimits = { minPageSize: 1, maxPageSize: 500 };

/** Platform resource tracked by an incremental sync checkpoint. */
export type SyncResource = 'problems' | 'submissions';

export const SYNC_RESOURCES: readonly SyncResource[] = ['problems', 'submissions'];

/** Identifies one incremental sync stream. `accountId` is null for instance-wide problem lists. */
export interface SyncCheckpointRef {
  readonly sourceInstanceId: string;
  readonly accountId: string | null;
  readonly resource: SyncResource;
}

/** Persisted position of one incremental sync stream (opaque platform cursor plus a time bound). */
export interface SyncCheckpoint extends SyncCheckpointRef {
  readonly cursor: string | null;
  readonly since: string | null;
  readonly updatedAt: string;
}

/**
 * Stable key for one checkpoint scope, used as the storage primary key.
 *
 * Components are escaped with the domain's canonical encoder, so an account id (itself a
 * compound `instance|handle` id) can never be confused with the surrounding separators.
 */
export function syncCheckpointKey(ref: SyncCheckpointRef): string {
  return [
    encodeIdPart(ref.sourceInstanceId),
    ref.accountId === null ? '' : encodeIdPart(ref.accountId),
    ref.resource,
  ].join('|');
}

/**
 * Request to acquire the lease of one analysis job.
 *
 * `owner` is an opaque worker/process identity. A store claims a job only when it is
 * `pending` or when a `running` lease has expired at `at`, so two workers can never own the
 * same job at once; `leaseMs` must be positive and comes from validated configuration.
 */
export interface JobLeaseRequest {
  readonly jobId: string;
  readonly owner: string;
  readonly at: string;
  readonly leaseMs: number;
}
