# Stage 4s1a — workbench settings store and schema v3

Worker report (dsh / deepseek-flash / max), 2026-09-12. Scope: settings validation, singleton CAS
persistence, additive schema v3. Coaching CRUD/service/API/UI are intentionally absent.

## Changed files
- `src/application/workbench-settings.ts` (new): strict `validateWorkbenchSettings(unknown)` (recursive
  unknown-key rejection, strings 1..200, hard bounds, fixed `effort:'max'`, `leaseMs>requestTimeoutMs`);
  detached `defaultWorkbenchSettings()` (deepseek-official, flash/flash/v4-pro, 50/5 calls, concurrency
  2, timeout 180000/lease 240000, coaching 10/day/1/180000/65536); separate `SettingsStore` CAS port.
- `src/adapters/sqlite/schema.ts`: v3 constants and `SCHEMA_DDL_V3` (singleton `workbench_settings`,
  empty `coaching_attempts` + 3 indexes), `initializeSchemaV3`/`migrateSchemaV1ToV3`/`migrateSchemaV2ToV3`;
  `applySchemaV2` now writes 2 and the v1/v2 helpers stay historical.
- `src/adapters/sqlite/store.ts`: `implements TrainingStore, SettingsStore`; settings validated on write
  and read under revision CAS (create=1; stale/null mismatch rejected before writing); v2 backup plus
  one-transaction v0/v1/v2 -> 3 dispatch. `src/adapters/sqlite/index.ts` exports the new constants.
- `tests/storage/workbench-settings.test.ts` (new): defaults/detachment, rejection matrix, CAS+reopen,
  rollback, corrupt-row read. `tests/storage/schema.test.ts`: real v2 backup -> v3, failed v3 rollback,
  historical helpers still v2, current-version loops now `STORE_TABLES_V3`, old backup rows unchanged.

## Commands actually run
- `npm.cmd run typecheck` — exit 0.
- focused: `node --experimental-strip-types --import ./tests/loader.mjs --test tests/storage/workbench-settings.test.ts tests/storage/schema.test.ts` — 19/19 pass.
- `npm.cmd run check` — exit 0 (typecheck, architecture check, 329 behavior tests, 6 accounting/context tests, dist build).

## Open issues
- `coaching_attempts` is created empty and has no access methods; the attempt store/service is the next contract.
- Settings are persisted but not yet consumed by the plugin/host configuration loader.

Coordinator acceptance: corrected coaching's default to deepseek-flash (the approved low-cost default), rejected whitespace-only provider/model ids, and moved the deliberate migration collision to the second v3 table so rollback proves that already executed DDL is undone. Full gate rerun after these corrections.

## Stage 4s1b — coaching attempt store (appended)

Scope: `src/application/coaching-types.ts` (new), `coaching_attempts` CRUD in `src/adapters/sqlite/store.ts`,
`COACHING_ATTEMPT_FIELDS` + `coaching` cursor kind in `src/adapters/sqlite/entities.ts`,
`tests/storage/coaching-store.test.ts` (new). No schema/settings/service/prompt/API/UI change.

- `CoachingAttempt` (`level` 1|2|3|`'full'`; `reserved`|`uncertain`|`settled`) with strict unknown/missing-key
  rejection, canonical problem key + snapshot ownership, positive lease and ordered dates, status result shapes
  (reserved: no result; uncertain: finishedAt + error, no usage/response; settled: finishedAt + known usage +
  exactly one of response/error), nested `usage`/`error` key and bound checks (response <= 200000 chars).
- `validateCoachingAttempt` returns a detached normalized value; `validateCoachingAttemptTransition` fixes identity
  (including `expiresAt`), keeps known `hostSessionId`/`hostCallId`, and allows only `reserved -> uncertain|settled`,
  `uncertain -> settled`. Separate `CoachingStore` port (get/save/list/count); no new `TrainingStore` methods.
- SQLite: `implements TrainingStore, SettingsStore, CoachingStore`; inserts must be `reserved`, identical re-saves are
  no-ops and a duplicate id cannot overwrite a charged attempt; list is keyset-paged `requestedAt,id` with a 1..500
  bound and a cursor fingerprint bound to its filter set (`cursor_filter_mismatch`); count is one global indexed
  `COUNT(*)` across accounts/statuses (uncertain/failed included). All CRUD joins a caller transaction.
- Commands actually run: `npm.cmd run typecheck` exit 0; focused
  `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none "tests/storage/*.test.ts"`
  61/61 pass; `npm.cmd run check` exit 0 (339 behavior tests, 6 accounting/context tests, architecture check, dist build).
- Open: the coaching service (reserve + quota check in one outer transaction, prompt/gateway wiring) is the next task;
  `expiresAt` recovery deliberately has no store method — a future caller counts by status and compares deadlines.

## Stage 4s1b repair — account scope, read validation, safe counters (appended)

Scope: `src/application/coaching-types.ts`, coaching methods/helpers in `src/adapters/sqlite/store.ts`,
`tests/storage/coaching-store.test.ts`. No schema/settings/entities/service/API/UI change.

- `CoachingAttemptQuery.accountId` is now three-valued end to end: omitted = every account, explicit `null` =
  anonymous only (`account_id IS NULL`), a string = that account. The cursor fingerprint encodes the scope as an
  explicit `{scope: 'all' | 'anonymous' | 'account'}` object (an `undefined` member would vanish from canonical
  JSON), so a cursor can no longer be continued across scopes (`cursor_filter_mismatch`). `countCoachingAttempts`
  still has no account scope; the global quota total is unchanged and asserted after scoped reads.
- `getCoachingAttempt`, `listCoachingAttempts` and the previous-row read in `writeCoachingAttempt` now decode through
  one narrow `readCoachingAttempt` helper that runs `validateCoachingAttempt` and wraps a parseable but invalid body
  as `StorageError corrupt_row`. Every other storage entity keeps its existing structural-only row decoding.
- Usage counters require `Number.isSafeInteger` (non-negative): `Infinity`, `NaN`, `1.5` and integers beyond
  `Number.MAX_SAFE_INTEGER` are rejected. The known-usage/null-usage contract is unchanged; no total is invented.
- Tests: account-scope pagination with two anonymous + two named + one other-account attempt and seven cross-scope
  cursor rejections; a raw-SQLite tamper test (valid JSON with `level: 4`) proves both get and list fail with
  `corrupt_row` while an untouched row still reads; new Infinity/unsafe/NaN usage rejections; the misleading
  "a null filter means no restriction" assertion was corrected to "anonymous attempts only".
- Commands actually run: `npm.cmd run typecheck` exit 0; focused
  `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none "tests/storage/coaching-store.test.ts"`
  12/12 pass; `npm.cmd run check` exit 0 (341 behavior tests, 6 accounting/context tests, architecture check, dist build).
- Open: the coaching service must pass an omitted `accountId` to keep reading every account; `null` is reserved for
  the anonymous scope, so a service that wants "all history" must not send `null`.