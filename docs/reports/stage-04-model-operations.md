# Stage 4h2a — bounded model-operation owner (repair 1)

## Changed files
| File | Kind |
|---|---|
| `src/plugin/model-operations.ts` | repair — retained safe coaching result + `coaching.status.operation`, cancel/duplicate/open checks, quota bound, memoized `close()` |
| `src/application/model-operation-types.ts` | repair — `ModelCoachingStatusResult` now carries `operation`; corrected upper-bound docs |
| `src/application/coaching-service.ts` | repair — a supplied settings revision also refuses a missing record; closed ask keys |
| `tests/plugin/model-operations.test.ts` | 18 tests (was 13), real SQLite/service/controller with scripted gateway/generator |
| `tests/coaching/service.test.ts` | 23 tests (was 22) |

## Repair 1 guarantees
- `coaching.status` reports this instance's own operation even without a durable row: an acknowledged pre-reservation (`running`/`pending`), a terminal refusal (`refused` + stable code) or a background failure (`failed` + safe code). Only the safe metadata projection is retained — never a hint body — and it is attached only for the exact account+problem the operation was started for.
- `coaching.cancel` returns the real durable status or `unknown` (never an invented `reserved` before the reservation); duplicate `coaching.ask` is refused on a cancelled caller token or a closed controller; concurrent `close()` callers share one attempt and one report while `whenSettled()` still waits for durable work.
- `batch.prepare.upperBoundCalls` is now the batch quota (`maxAnalysisCalls`/`maxReasoningCalls`; zero for a jobless batch), so verification and retries are covered; a regression drives 4 analysis calls with 2 retries under a 1-job/2-call prediction.
- A supplied `CoachingAskRequest.expectedSettingsRevision` refuses `settings_changed` when the stored record is missing or differs, inside `reserve` after durable dedup and before any reservation; omitting it keeps the legacy defaults path, durable replays stay free, and unknown ask keys are rejected.

## Commands actually run
- `npm run typecheck` — clean (after implementation, then again after the test edits).
- focused: `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/plugin/model-operations.test.ts tests/coaching/service.test.ts` → **41/41 pass**.
- `npm test` → **513/513 pass** (no accepted test weakened; one bound assertion corrected to the new expectation).
- `npm run check:architecture` → pass.

## Open limits
- The quota bound is conservative, not job-count-tight: per-job `maxAnalysisCalls` is outside `AnalysisBatchLimits`, so the reported maxima are the batch limits.
- `TrainingStore.listModelCallAttempts` still returns the whole scoped array; `batch.detail` keeps its existing scoped refusal bound instead of paginating.
- `ModelOperationError` → transport mapping and route registration remain 4h2b; no HTTP/root/UI/store-port change, no paid call, no Git, no harness edit.

Coordinator acceptance: retained refusals remain observable while another request runs; independent in-memory audit passed with zero paid calls. Full npm run check: 514 behavior + 7 script tests, typecheck, architecture and build pass. Repair hit the request cap after its checks; the unseen request remains conservatively reserved. Worker now stops at the configured request-start cap rather than starting one beyond it.
