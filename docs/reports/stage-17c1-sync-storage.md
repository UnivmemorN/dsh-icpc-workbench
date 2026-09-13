# Stage 17c1 — Luogu durable storage and import hooks

Status: **complete for the assigned slice**. Parent scope: `.local/contract-17c-luogu-sync-service.md`.
No scheduler, connection adapter (`LuoguConnectionManager` implementation), UI, host wiring, version bump,
package change, Git action or AI/network call was made in this invocation.

## What changed

| File | Change |
| --- | --- |
| `src/application/luogu-sync-types.ts` | `LuoguSyncSettings` gained `accountId`; `defaultLuoguSyncSettings(accountId, at)`; port signatures `getLuoguSyncSettings(accountId)` and `deleteLuoguConnection(accountId, expectedRevision)`; `luoguLeaseLive` semantics fixed, `luoguLeaseHeldByAnother` added; `luoguLeaseExpired` validates its clock argument; `backlogDropped` must be `0` (no drop path); backlog bound documented as backpressure. |
| `src/adapters/sqlite/schema.ts` | Schema-v7 draft corrected: `luogu_sync_settings` is account-scoped (`account_id` primary key) instead of a singleton; v7 docs updated. **Schema v7 adds five additive tables** — `luogu_connections`, `luogu_connection_generations`, `luogu_connection_journal`, `luogu_sync_states`, `luogu_sync_settings`; the generation counter and the write-ahead journal were folded into the unshipped v7 by 17c2 r1, so `STORE_TABLES_V7` holds all five. `migrateToSchemaV6` keeps its literal `user_version = 6` (now documented as frozen). Historical DDL ≤ v6 untouched. |
| `src/adapters/sqlite/store.ts` | `openSchema` now backs up and migrates v6 as well, and calls `migrateToSchemaV7`. Full `LuoguSyncStore` implementation on `SqliteTrainingStore` (no `TrainingStore` interface change): settings/state/connection reads with strict re-validation and row-identity cross-checks, revision CAS on every save and on delete, canonical stored-account + official-origin proof for every write, metadata-only connection listing. |
| `src/application/import-service.ts` | `syncPage` re-checks the token **after** the commit hook and before `COMMIT`; `refreshProblemMetadata` checks the token after its merge write and read, so a late cancellation rolls the metadata write back. |
| `tests/storage/luogu-sync.test.ts` (new) | Real temp-SQLite coverage: per-account settings, CAS create/update/stale, state CAS + canonical account/source rejection, transaction rollback, connection list/delete CAS incl. stale delete and idempotent missing delete, restart persistence, credential-shaped/foreign/lossy validator rejections, corrupt/identity-swapped row refusal, lease predicates, genuine v6 → v7 backup + row preservation, empty/v0/v1…v6 → v7 on every path, newer-than-v7 refusal byte-for-byte. |
| `tests/import/import-service.test.ts` | Three added cases: failing commit hook rolls back page rows + checkpoint + the hook's own sync-state write; cancellation after the hook rolls the same back; metadata-only refresh never calls `fetchEditorial`, preserves the stored statement and editorial snapshot material, rejects a mismatched fetched identity before writing, and reports a typed failure without a fabricated problem. |
| `tests/storage/schema.test.ts`, `tests/storage/official-rating.test.ts`, `tests/storage/ability-calibration.test.ts` | Updated the pinned "migrated to v6" expectations to the current schema version / removed the hard-coded `6`; the newer-schema refusal test now proves a v8 file is refused unmodified. No assertion was weakened. |

## Exact interfaces (17c2 must build against these)

```ts
export interface LuoguSyncSettings {
  readonly accountId: string;            // NEW: per-account, never a singleton
  readonly automaticEnabled: boolean;
  readonly runOnStartup: boolean;
  readonly intervalMinutes: number;      // 5..1440
  readonly updatedAt: string;
}
export function defaultLuoguSyncSettings(accountId: string, at: string): LuoguSyncSettings;

export interface LuoguSyncStore {
  getLuoguSyncSettings(accountId: string): Promise<LuoguSyncSettingsRecord | null>;
  saveLuoguSyncSettings(value: LuoguSyncSettings, expectedRevision: number | null): Promise<number>;
  getLuoguSyncState(accountId: string): Promise<LuoguSyncStateRecord | null>;
  saveLuoguSyncState(value: LuoguSyncState, expectedRevision: number | null): Promise<number>;
  getLuoguConnection(accountId: string): Promise<LuoguConnectionRecord | null>;
  saveLuoguConnection(value: LuoguConnectionState, expectedRevision: number | null): Promise<number>;
  deleteLuoguConnection(accountId: string, expectedRevision: number | null): Promise<void>;
  listLuoguConnections(): Promise<readonly LuoguConnectionState[]>;
  // Added by 17c2 r1, when v7 grew from three planned tables to five; all three are idempotent
  // per `(account, reference)` and the journal is secret-free by construction.
  listLuoguConnectionJournal(accountId: string): Promise<readonly LuoguConnectionJournalEntry[]>;
  appendLuoguConnectionJournal(accountId: string, reference: string): Promise<void>;
  removeLuoguConnectionJournalEntry(accountId: string, reference: string): Promise<void>;
}

export function luoguLeaseExpired(state, at): boolean;                  // validates `at`
export function luoguLeaseLive(state, owner: string | null, at): boolean;   // true only when the live lease is `owner`'s (or any, for null)
export function luoguLeaseHeldByAnother(state, owner: string, at): boolean; // explicit "someone else is running"
```

Storage guarantees 17c2 can rely on:

- every write requires an **already stored** account and proves its source instance is the official
  `luogu:www.luogu.com.cn` origin (platform `luogu`, domain `www.luogu.com.cn`, origin
  `https://www.luogu.com.cn`); an unknown account is `missing_reference`, a foreign/repointed one is
  `invalid_input` (`reason: not_official_luogu_source`).
- `save*` are compare-and-set: create requires `expectedRevision === null`, update requires the stored
  revision, mismatch rejects before any write (`invalid_transition`, `reason: stale_revision`).
- `deleteLuoguConnection` is a no-op for a missing row, but refuses a row at another revision, so a
  stale disconnect cannot remove a session that replaced it.
- reads re-validate every body and cross-check it against the row's own columns
  (`account_id`, `source_instance_id`, `reference`, `status`, `checked_at`); a swapped, truncated or
  credential-shaped body is `StorageError('corrupt_row')`.
- all methods join the caller's open transaction (`withRead`/`withWrite` + transaction scope), so the
  `syncPage` commit hook can write state and backlog atomically with page rows and checkpoint.
- `backlogDropped` must stay `0`; the validator refuses anything else. Backpressure (stop paging at
  `LUOGU_SYNC_MAX_METADATA_BACKLOG`) is 17c2's job.
- the write-ahead journal (`listLuoguConnectionJournal` / `appendLuoguConnectionJournal` /
  `removeLuoguConnectionJournalEntry`) stores only an account id, an opaque credential reference and
  an instant — it has no column a cookie could live in, an append is idempotent per
  `(account, reference)`, and a hand-edited reference is `corrupt_row` on read. The
  `luogu_connection_generations` tombstone keeps connection revisions monotonic across a delete, so
  a revision is never reissued.

## Commands actually run (all from `D:\dsh-icpc-workbench`)

1. `npm run typecheck` → **pass**.
2. `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/storage/luogu-sync.test.ts tests/storage/schema.test.ts tests/storage/official-rating.test.ts tests/storage/ability-calibration.test.ts tests/import/import-service.test.ts tests/storage/store.test.ts tests/storage/planning-store.test.ts` → **74 pass / 0 fail**.
3. `npm run check:architecture` → **pass** ("Architecture imports satisfy the declared layer boundaries").
4. `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/storage/concurrency.test.ts tests/storage/workbench-settings.test.ts tests/storage/coaching-store.test.ts tests/storage/batch.test.ts tests/storage/merged-query-scale.test.ts` → **42 pass / 0 fail**.

No full project suite and no build were run, per contract.

## Remaining work for 17c2 (service/connection/UI — out of scope here)

1. `LuoguConnectionManager` adapter: capabilities, `connect` (test via a real authenticated page,
   store under a fresh opaque reference, persist the reference before deleting the old credential),
   `probe`, idempotent `forget`; use `deleteLuoguConnection(accountId, revisionRead)`.
2. Sync service: lease claim/heartbeat via `saveLuoguSyncState` CAS, page loop with
   `onPageCommitted` writing state + missing-metadata backlog, **backpressure before requesting more
   history pages once the backlog is at `LUOGU_SYNC_MAX_METADATA_BACKLOG`**, metadata repair via
   `ImportService.refreshProblemMetadata`, failure-code mapping and pausing/backoff rules.
3. Disconnect flow must disable only that account (`saveLuoguSyncSettings({...automaticEnabled:false}, revision)`);
   the store deliberately does not cascade a connection delete into settings.
4. UI/host/plugin composition, version bump, and package/`files` acceptance remain with the coordinator.

## Open issues / notes

- `luogu_sync_settings` changed shape while schema v7 is unshipped; any local draft v7 database must be
  deleted (a v7 file with the old singleton table is rejected by `luogu_sync_settings` column use, and
  the store cannot migrate a draft that was never released).
- The store compares stored source-instance base URLs by parsed origin, because URL normalization adds
  a trailing slash; raw-string comparisons were the cause of one caught test failure and are avoided.
