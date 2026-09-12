# Stage 2f — application analysis pipeline

Implementation worker report (dsh / deepseek-flash), 2026-09-12. Scope: `src/application/analysis-pipeline.ts`,
the application port/batch-type extensions it needs, the minimal semantic-hashing correction in
`src/domain/analysis.ts` + `src/domain/tags.ts`, the pipeline test suite and this report. Platform
material fetch/import, UI, host wiring, scheduling and Git stay outside this contract.

Repair 2 (this revision) closes the remaining commit race: cancellation/pause is now re-checked
**after every write** of the adoption transaction and throws an internal typed rollback signal, so
the store really rolls the transaction back instead of committing a partial adoption. It also moves
the gateway capability validation (`implemented`, finite positive integer `maxConcurrency`) ahead of
the claim, and corrects the pause documentation.

## Changed files

- `src/application/analysis-pipeline.ts` (new) — `AnalysisPipeline`: `prepareBatch`, `run`, `pause`,
  `resume`, `cancel`, `recover`, plus the exported pure `classifySnapshotAvailability` helper. Depends
  only on the domain and the two ports; time (`now`) and ids (`uniqueId`) are injected, so the module
  imports no Node/env/global resource. Repair 2: `commitAdoption` re-checks pause/cancellation after
  each adoption write and throws the internal `AdoptionRollback` signal (the store rolls the
  transaction back; only that signal is caught, outside the transaction); `run` validates the gateway
  capability contract before `claimBatch` writes `running`.
- `src/application/ports.ts` — `AnalyzeRequest`/`VerifyRequest`/`ReasonRequest` gained optional
  `attemptId`; every `ModelCallResult` variant gained optional `sessionId`. Both are host-correlation
  hooks for the later gateway: the pipeline passes the reserved attempt id into the request and stores
  `result.callId`/`result.sessionId` on the settled attempt.
- `src/application/batch-types.ts` — `AnalysisBatchJob.manualRevision?: number` plus validation in the
  create helper. A batch created now always records the captured revision; a record without it stays
  readable but refuses to execute.
- `src/domain/tags.ts` — `createAiTagSuggestion` id now hashes rationale + evidence (not only
  identity/timestamp).
- `src/domain/analysis.ts` — verification ids hash problem/snapshot/suggestion/verdict/role/evidenceOk/
  conflicts/note; reasoning-draft ids hash tags/rationale/evidence; analysis ids hash snapshotVersion,
  full suggestions/verifications/drafts/usage/failure.
- `tests/pipeline/analysis-pipeline.test.ts` (new) — 32 cases against a real `SqliteTrainingStore`
  temp database and a scripted fake gateway (tests only). The scripted store can arm a one-shot hook
  after a chosen write (`saveAnalysis`, `saveTagDecisions`, `saveJob`, `saveBatch`) to inject a
  cancellation *inside* the adoption transaction.
- `docs/reports/stage-02-pipeline.md` — this report.

## Protocol as implemented

- **prepareBatch** runs in one store transaction: every snapshot must exist and still be its problem's
  current head (otherwise `invalid_input` with an actionable message); the deterministic job of each
  snapshot is created only when absent; a `succeeded`/`cancelled` job is reported in `alreadyDone` and
  never reset; a previously `failed` job is requeued with its counters intact; a job already scheduled
  by another active batch is refused; each scheduled job records `getManualRevision(problem)` at this
  moment. When every requested job was already done, no batch is created (`batch: null`).
- **Legacy refusal.** `run`/`pause`/`resume` call an executable check first: any job without a
  non-negative integer `manualRevision` refuses with a message naming the batch and jobs, so a pre-v2
  batch can never silently adopt against the current manual revision.
- **Run claiming.** The in-process active-run slot is taken **before the first await**, so two
  simultaneous `run` calls on one instance cannot both proceed, and the claim transaction then re-reads
  the batch and writes `running` + owner + lease via `saveBatch(..., expectedRevision)`. A live lease is
  refused for **every** owner — including this instance's own owner string — so only an expired lease can
  be taken over (`recover` does that explicitly). `paused` and `failed` batches must be resumed first;
  terminal batches return a summary untouched.
- **Capability gate.** Before the claim writes anything, `run` requires `capabilities.implemented` and
  a `maxConcurrency` that is a finite positive integer. A violation is an `invalid_input` refusal that
  leaves the batch `pending`, unowned, with zero attempts and zero counters and no lease row change, so
  the very same batch runs unchanged once the gateway is fixed.
- **Job claiming** never calls `claimJob`: `getJob` + pure `transitionJob` + `saveJob`, in one
  transaction that also re-verifies the head and extends the batch lease. A job owned by a live lease is
  skipped; an expired lease is requeued then started; a snapshot that is no longer current fails the job
  with `stale_snapshot` before any call is made.
- **Reservation.** Each dispatch writes a `reserved` `ModelCallAttempt`, consumes job budget
  (`transitionJob.consume_call`) and batch budget, and renews both leases in one transaction *before* the
  network call; the model is never awaited inside a transaction. Batch limits: default 20 jobs, 50
  analysis calls (analyze + verify share them), 5 reasoning calls, concurrency 2. The pool is bounded by
  `min(batch concurrency, pipeline concurrency, gateway maxConcurrency, job count)`.
- **Settlement.** Successes, typed errors, cancellations and unexpected throws are all persisted; an
  unexpected throw becomes an `uncertain` record with the reservation and counters retained and is never
  silently retried. Retries happen only for `retryable` errors, inside the pipeline retry budget and the
  job attempt budget; each retry restarts the job (counters/attempts survive) and the next dispatch
  reserves and counts again. When the retry budget is spent the final job error is recorded
  non-retryable, so the job cannot stay schedulable by accident. A declared `quota_exhausted` is never
  retried: it persists `paused` + `paused_quota` and only an explicit resume continues. Recorded usage is
  the sum of the job's persisted **settled** attempts (a reused analysis pass and failed retries
  included); `uncertain` attempts carry no usage and are reported separately as a count.
- **Durable reuse.** A settled `analysis` attempt of the same batch/job with the same snapshot, provider,
  model and effective prompt version — `<prompt version>|taxonomy:<taxonomy version>`, also sent to the
  gateway on the request — and an unchanged captured manual revision is reused for the verification pass
  instead of paying for analyze again; verified by the restart and identity tests.
- **Commit.** One transaction re-reads batch status/owner/lease, job status/owner/lease, snapshot head
  (id + hash + version) and manual revision, and re-checks the pause/cancellation state after every
  await **and after every write**; only then does it write the immutable analysis result, the decisions
  resolved by `resolveTagDecisions` (manual precedence, taxonomy index, evidence rules) and the job
  success together. A stop observed *before* the first write is a plain refusal (nothing was written, so
  committing the read-only transaction is harmless). A stop observed *after* a write throws the internal
  typed `AdoptionRollback` signal from inside the callback, so the store rolls every write back —
  returning a refusal there would **commit** a partial adoption, which is exactly the race this repair
  removes. Only that signal is caught, outside the transaction, and turned into persisted state by
  `handleAbort`; a storage failure keeps propagating. Stale snapshot / changed manual revision fail the
  job explicitly; a pause leaves the job `pending` for `resume`; an external cancellation persists a
  terminal cancelled batch/job; a lost or expired job leaves the model result as audit and adopts
  nothing.
- **Linearization.** The commit transaction is the linearization point. `pause`/`cancel` persist their
  own state through the same store, so those write transactions serialize with the commit: whichever
  commits first wins. A pause/cancel that persists before the commit's re-read is refused by that read;
  one observed in-process while the commit runs rolls the commit back; one that lands **after** the
  commit has resolved does not undo the adoption — the adopted result is durable and only subsequent
  work sees the paused/cancelled state. The report does not claim that a cancellation can undo an
  already-committed write, because it cannot: the guarantee is that no *partial* adoption survives.
- **Availability.** `>=1 found source with a referenced non-empty solution` → analyze; every source
  explicitly `absent` *and* a non-empty statement → reason (drafts always need review, never
  auto-adopted); auth/forbidden/rate-limited/unavailable/changed-response, a found-but-empty source, an
  empty source list, or an absent editorial with an empty statement → explicit job failure, never a
  reasoning call. Raw-tagged problems are never skipped.
- **pause / cancel / resume / recover.** Both pause and cancel persist first and then notify local runs.
  Pause also cancels the local token, asking an in-flight call to stop; a provider that answers anyway
  has its attempt row written as audit, but no analysis result and no tag decision is adopted while
  `paused`, the job returns to `pending` for `resume`, and a later `resume` continues from the paid
  pass. Cancel cancels the batch and every unfinished job and then cancels the local tokens, so a
  late result is only audit; an external token cancelled without `cancel()` is persisted the same way
  (including a pre-cancelled token). Resume refuses a `running` batch, requeues `paused_quota`/`failed`
  jobs, accepts raised limits and keeps every counter. Recover returns an expired batch lease to
  `pending`, requeues expired jobs and turns their reserved attempts into `uncertain`; a live lease is
  skipped whatever its owner (including this instance's own owner string) and nothing is refunded.

## Commands actually run

| Command | Result |
| --- | --- |
| `npm run typecheck` (`tsc -p tsconfig.json`) | clean (Repair 2: clean after removing one unused test import) |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/pipeline/analysis-pipeline.test.ts` | 32/32 pass |
| `npm run check` | exit 0 — typecheck, architecture check, 107/107 behavior tests (75 non-pipeline + 32 pipeline), 3/3 accounting tests, `Built independent ESM package in dist.` |

Intermediate focused runs failed on three real issues that were fixed before the original final run:
pipeline `DomainError` codes outside `DomainErrorCode`, a test handler-type mismatch, and two
test-fixture faults (shared `uniqueId` sequences and a batch-level concurrency of 2 where the quota
ordering needed 1). No production behaviour was weakened to make a test pass.

## Coverage

Happy two-pass adoption with raw tags preserved and an already-done re-prepare; two-job constrained
analysis budget pausing on the second verification, resume with raised limits keeping counters and
reusing the settled analyze; restart reuse without a second analyze; cancellation while an analyze call
is deferred (audit only, no adoption); a manual decision during the model run (no adoption); a newer
snapshot during the model run (no adoption); operational source status, empty source list and missing
statement never calling any model; true absence running reasoning with zero decisions; retry counts
(job attempts/retries, batch retries, settled audit rows) plus a non-retryable failure; two racing
pipeline owners with exactly one execution; recovery of expired batch/job leases and a reserved attempt
with counters intact and no adoption from the abandoned run; legacy batch refusal; a job refused by a
second active batch; and semantic-id regressions for all four hashed record types.

Repair 1 added: a manual revision changed after preparation fails the job before any paid call; a
snapshot superseded by the analysis pass refuses the verification dispatch; an external cancellation
during verification cancels terminally while the paid audit survives; a pre-cancelled token cancels
without dispatching; a cancellation landing inside the commit before any write; a pause aborting the
local call and leaving the paid result reusable by `resume`; two simultaneous `run` calls on one
pipeline; in-flight calls never exceeding the smallest configured concurrency; two instances sharing one
owner string; a pause landing between the initial read and the claim; recovery of a self-owned expired
lease while `resume` refuses a running batch; a gateway `quota_exhausted` pausing instead of burning
retries; a throwing call recorded `uncertain`; a bounded retry budget across an explicit resume; and
analysis-pass reuse only under the same provider and prompt identity.

Repair 2 added: an unimplemented provider refusing before the claim and leaving the batch `pending`,
unowned, with zero attempts and zero counters; `0`, `-1`, `1.5`, `NaN` and `Infinity` `maxConcurrency`
also refusing before the claim, with the same batch still completing under a healthy advert; and a
cancellation injected *inside* each adoption write (`saveAnalysis`, `saveTagDecisions`, `saveJob`,
`saveBatch`) against the real SQLite store, asserting the rollback leaves zero analyses/decisions, the
batch and job terminally `cancelled`, the settled paid attempts preserved, and no unhandled rejection.

## Limits / open issues

- Pause is cooperative for an in-flight call: it persists `paused`, stops new dispatches and cancels the
  local token, but a provider that ignores the token still returns. That attempt is kept as settled
  audit and the commit refuses adoption, so the job stays resumable — pause never becomes a terminal
  cancel.
- Failure outcomes live in `AnalysisJobState.lastError` and the attempt rows; no
  `AnalysisResult(status: 'failed'|'cancelled')` is persisted. Add one later if the UI needs a
  first-class failed analysis record.
- Only the settled analysis pass is reused, not a settled verification pass (per contract). A crash
  between a successful verification and the commit pays for verification again.
- Batch limits are the operative per-batch budget; `ModelLimits.maxAnalysisCalls/maxReasoningCalls` seed
  the job limits and defaults but are not enforced as a global cap across batches.
- Not covered: real platform material (snapshots are assumed already persisted), real provider
  rate-limit/timeout behaviour, cross-process concurrency (the racing test uses two pipelines over one
  store), UI/host wiring, and the actual gateway adapter that will consume `attemptId`/`sessionId`.

## Coordinator acceptance
Independent npm run check passed on 2026-09-12: 107 behavior tests, 3 accounting tests, strict type checks, architecture checks and standalone build. Reviewed transaction rollback after every adoption write and capability refusal before lease claiming. Stage 2 is accepted; real model/platform/host/UI acceptance remains in subsequent stages.
