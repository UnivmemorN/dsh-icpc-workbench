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