# Stage 3c — import service acceptance repair

## Changes (src/application/import-service.ts)
- `writeProblems` re-snapshots every merged problem in the page transaction: reads the previous
  snapshot, carries its sources/solutions over, and calls `persistSnapshot` with merged metadata.
  First catalog sync creates a head; changed title/tags/ratings/statement advance the version
  (staling in-flight analyses); unchanged semantic content reuses the exact previous snapshot and
  saves nothing; a null statement still never erases stored text.
- New `validatePage` runs in the fetch phase before any write: parseable `fetchedAt`, array `items`
  with `length <= limit`, `nextCursor` null or a non-empty string. Post-commit re-validation removed.
- Docs updated; no exported API changed.

## Tests (tests/import/import-service.test.ts)
- First catalog page creates a v1 head per problem; metadata change advances the head preserving
  imported editorial and the stored statement; timestamps-only page keeps id/version and saves
  nothing; catalog A->B->A gives versions 1,2,3 with hash(A) stable; cancel at snapshot write rolls
  problem, head, checkpoint and source instance back.
- Invalid `fetchedAt` (`invalid_timestamp`) and oversized page (`invalid_input`) leave problem, head,
  checkpoint and source instance untouched.
- Harness: `instrumentStore` gained `afterSaveSnapshot`; scripted pages may override `fetchedAt`.
- Existing tests and adapters were not weakened.

## Commands actually run
- focused import test -> 25 pass, 0 fail.
- `npm.cmd run check` -> exit 0 (252 + 3 pass, 0 fail; build succeeded).

## Limits
- Catalog-page snapshot writes are not exposed in `SyncPageCounts`; callers see them via store heads.
- Catalog pages still rewrite the problem body when only `fetchedAt` moved (existing behavior).
- Rollback is covered for a thrown cancellation, not for process death mid-transaction.
