# Stage 2d — durable batches, model-call attempts and v1 migration

Implementation worker report (dsh / deepseek-flash), 2026-09-12. Scope: `src/application/batch-types.ts`,
`src/application/ports.ts` docs, storage tests and this report. The pipeline that orchestrates a batch is
**not** started; this stage only completes the durable records, their rules and the v1→v2 migration tests.

## Changed files

- `src/application/batch-types.ts` — temporal ordering and host-correlation rules; honest persistence comment.
- `src/application/ports.ts` — `saveBatch`/`saveModelCallAttempt` docs state the added rules.
- `tests/storage/fixtures.ts` — `LEASE_UNTIL` (a lease deadline after `LATER`).
- `tests/storage/batch.test.ts` — host-correlation test, temporal-metadata test, honest wording for the
  existing top-level extra-field exclusion test (behavior unchanged).
- `tests/storage/schema.test.ts` — real v1 fixture world plus two v1→v2 tests. The three previously unused
  declarations (`seedV1`, `STORE_TABLES_V1`, `createAnalysisBatch`) are now exercised by real coverage
  instead of being deleted.
- `docs/reports/stage-02-batches.md` — this report.

## Coverage added

- **v1 → v2 migration, rows kept.** `seedV1World` builds a genuine v1 database with the frozen v1 DDL:
  one real problem, its job (status/counters/lease columns) and one manual decision plus revision. Opening
  the store copies the file first (one `.backup-v1-*` with `user_version = 1`, `journal_mode = delete`,
  `integrity ok`, exactly the v1 table set and the same bodies) and then migrates in one transaction.
  `getProblem`/`getJob`/`getManualRevision`/`listManualDecisions` return the pre-migration bodies, counters
  and manual revision 1; the added v2 tables accept a new batch on the migrated file; the live file ends at
  `user_version = 2`, all `STORE_TABLES_V2`, `journal_mode = wal`.
- **Failed v1 → v2 migration.** A pre-existing VIEW named `analysis_batches` makes the first v2 DDL
  statement fail. The constructor reports `migration_failed`; the file stays v1 (same table set,
  `journal_mode = delete`, `integrity ok`), the rows and the conflicting view are still readable, and the
  verified pre-migration copy is intact.
- **Host correlation is a recorded fact.** A known non-null `hostSessionId`/`hostCallId` on a
  reserved/uncertain attempt cannot be reassigned or cleared by a later `uncertain`/`settled` save
  (`immutable_violation`, `details.reason = 'host_correlation'`); settling with the real correlation still
  lands. Learning the ids while the call is still reserved remains legal.
- **Temporal metadata.** `updatedAt >= createdAt`; a `running` batch's `leaseExpiresAt` must be strictly
  after `updatedAt`; a settled attempt's `finishedAt >= requestedAt` (equal is a legal zero-duration call).
  A pause→running resume with an ordered lease still lands.
- Unchanged: newer-schema byte-for-byte refusal, WAL-consistent `backupTo` and recovery, failed-migration
  rollback, and the top-level extra-field exclusion test.

## Commands actually run

| Command | Result |
| --- | --- |
| `npx tsc -p tsconfig.json` | clean (the three TS6133 unused-declaration errors are gone) |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/storage/schema.test.ts tests/storage/batch.test.ts` | 18/18 pass |
| `npm test` | 75/75 pass (was 71; +2 schema, +2 batch) |
| `npm run check:architecture` | pass |
| `node scripts/usage.test.mjs` | 3/3 pass (see blocker) |
| `npm run build` | `Built independent ESM package in dist.` |
| `npm run check` | passes typecheck, architecture and 75 tests, then stops at `node --test scripts/usage.test.mjs` with `Error: spawn EPERM` (Node test-runner child spawn blocked by this session's file sandbox). Not a code failure: the same file run in-process passes 3/3. Sandbox escalation was unavailable ("requires approval, but no approval channel is available"), so the coordinator should re-run the unmodified gate outside this confinement. |

## Next worker (pipeline stage) — store surface available

- `getProblem(key)`: one `NormalizedProblem` by canonical key, no scan; `null` when absent.
- `getBatch(batchId)` / `listBatches(status | null)`: body-backed reads ordered by `created_at, batch_id`.
- `saveBatch(batch, expectedRevision): Promise<number>`: `null` = create (stores revision 1), a number must
  equal the stored revision and returns `expectedRevision + 1`. Identity, monotonic counters, terminal
  `completed`/`cancelled`, lease shape and temporal order are validated before any write.
- `getModelCallAttempt(attemptId)` / `listModelCallAttempts({ batchId?, jobId?, status? })`: deterministic
  `requested_at, attempt_id` order.
- `saveModelCallAttempt(attempt)`: insert must be `reserved` (before dispatch); an identical re-save is a
  no-op; lifecycle `reserved → uncertain | settled`, `uncertain → settled`; a settled row is immutable; a
  known host correlation is pinned; `finishedAt >= requestedAt`. The caller owns the surrounding
  transaction, so the reservation and the job/batch counter bump commit together.

## Limits / open issues

- Storage projects only declared **top-level** fields; `usage`/`error`/`outcome` are nested canonical JSON
  trusted as validated by the model gateway at runtime. A deep nested validator is deliberately not added
  here, so adapters/gateway still own runtime validation of external payloads.
- The v1→v2 migration is additive only (two tables plus indexes, no row rewrite); downgrade is unsupported
  and a newer database is refused byte-for-byte.
- Budget reservation/enforcement, worker orchestration, recovery of uncertain calls and lease renewal are
  pipeline responsibilities, not implemented in this stage.
- Worker request-limit stops are construction limits, not acceptance signals.

Coordinator acceptance: npm run check passed75 behavior tests +3 accounting tests, typecheck, architecture and build. The accounting runner now uses the same supported in-process isolation option as other tests, so dsh does not require a child-process permission for this gate.
