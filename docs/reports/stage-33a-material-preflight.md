# Stage 33A — Material preflight and Chinese handling for blocked material

Status: implemented and verified offline. Package version stays `0.1.25`; the pinned dsh baseline
(`0.1.5-rc.2`) and the SQLite schema are unchanged.

## Symptom and root cause

A user selected a large fully-statements-populated batch, pressed the free preparation button, and
then "confirm paid analysis". Every problem of that batch ended as `editorial_unknown` in the batch
report: 100 problems, complete statements, `snapshot.sources.length === 0`,
`solutions.length === 0`, and `analysisCalls === 0`, `reasoningCalls === 0`, `retries === 0`,
`uncertainAttempts === 0`. No model call happened, so nothing was charged — but the user could not
tell that from the UI, and the batch looked like a runnable paid batch until it failed.

The root cause was **not** the classifier. `classifySnapshotAvailability` in
`src/application/analysis-pipeline.ts` classifies a snapshot as analysable only in two states:

1. `editorial` — at least one `found` source **and** a referenced, non-empty solution body;
2. `absent` — every source explicitly `absent` **and** a non-empty statement.

Everything else is an explicit refusal: `sources: []` is `unknown_sources` (an empty source list is
*unknown*, never "no editorial exists"), a `found` source without a body is `editorial_empty`,
auth/forbidden/rate-limited/unavailable/changed-response is `source_unavailable`, and "every source
absent but no statement" is `missing_statement`. `AnalysisPipeline.executeJob` then turns
`unknown_sources` into the `editorial_unknown` job error before any dispatch. **That defence is
correct and was kept exactly as it was**; it still protects historical batches, damaged rows, direct
callers and future regressions.

The defect was one layer **above** the pipeline: `ModelOperations.resolveCurrentSnapshots` in
`src/plugin/model-operations.ts` only rejected problems with no snapshot head. A problem with a
snapshot whose material could not be analysed was still handed to `pipeline.prepareBatch()`, so a
batch was created that *looked* startable, `batch.prepare` reported it as "new tasks", and only the
paid run discovered the truth. `Review.tsx` enabled the paid button from `status === 'pending'`
alone and printed the raw English error code as the page's message.

## The state machine

The decision now lives in one place, `src/application/material-preflight.ts`, as pure functions over
domain values (no store, clock, network or model port). `classifySnapshotAvailability` remains the
single classifier; the new module only *translates* its answer into the caller-facing vocabulary.

| Material state | Runnable? | Blocked reason | Primary action |
| --- | --- | --- | --- |
| `found` source with a referenced non-empty solution | yes (`editorial`) | — | — |
| every source explicitly `absent`, non-empty statement | yes (`absent`) | — | — |
| no current snapshot head at all | no | `material_missing` | `refresh_materials` |
| head exists, snapshot body unreadable | no | `snapshot_unreadable` | `refresh_materials` |
| no source records at all | no | `editorial_unknown` | `refresh_materials` |
| `found` source with no referenced body | no | `editorial_empty` | `supplement_editorial` |
| `auth_required` / `forbidden` / `rate_limited` / `unavailable` / `changed_response` | no | `source_unavailable` | `refresh_materials` |
| every source `absent`, empty statement | no | `missing_statement` | `supplement_statement` |

Two facts are deliberately kept apart even though both are "no usable snapshot": *nothing was ever
captured* (`material_missing`) is not the same as *a body was captured and cannot be read*
(`snapshot_unreadable`), because the user's next action differs. `unknown_sources` is never widened
to `absent`, so the expensive statement-only reasoning path can never start from a guess.

## Interface changes

`src/application/model-operation-types.ts`:

- `ModelBatchBlockedProblemView.reason` extends to the six reasons above and `.action` to
  `refresh_materials | supplement_editorial | supplement_statement`. No snapshot id, source id,
  statement, editorial body, provider string or classifier detail is part of the view.
- `ModelBatchAvailabilitySummary.error` is documented as *every* unusable material state (missing
  head and unreadable body included); `ready + absent + error` is the whole selection, and every
  non-runnable problem also appears in `blocked`.
- `ModelBatchCallUpperBound` gains `blocked`, so a preparation answer reports the blocked count
  next to the quota it never contributes to. A fully blocked selection therefore answers
  `upperBoundCalls = { analysisCalls: 0, reasoningCalls: 0, blocked: N }`.
- `ModelBatchPrepareResult.batchId` is documented as `null` whenever no runnable job was produced
  (previously only "every requested job was already done").
- `ModelBatchView.materialBlocks` is a **read-only** projection of the batch's own immutable
  snapshots, reusing `ModelBatchBlockedProblemView`. It is computed while `batch.detail` is
  projected and writes nothing.
- `ModelOperationErrorCode` gains `materials_blocked`.

`src/plugin/model-operations.ts`:

- `resolveCurrentSnapshots` now returns `{ runnable, blocked, availability }` from one pass over the
  same reads, so counts, runnable jobs and blocked entries cannot describe different selections.
  Only `runnable.map(entry => entry.snapshotId)` reaches `AnalysisPipeline.prepareBatch`.
- `prepareBatch` skips the pipeline entirely when nothing is runnable, so no batch row and no job
  row is written. Blocked problems are not jobs: no attempt, no audit call, no counter, no fee.
- `materialBlocksOf(batch, token)` is the shared free preflight of a stored batch. It is called by
  `startBatchOperation` (`batch.run` / `batch.resume`) **before** the settings CAS, the model probe,
  the owned operation, any reservation and any counter movement, and by `batchDetail` for the
  read-only report. A start with a blocker throws `materials_blocked` and changes nothing.
- Alias: `src/plugin/model-api.ts` maps `materials_blocked` to the transport code of the same name;
  `src/plugin/api-transport.ts` registers it as `409` with a fixed safe message.

`src/ui/Review.tsx` plus the new pure `src/ui/review-view.ts`:

- The preparation summary reports runnable new tasks, already-checked skips, reruns, material
  pending, found editorials, confirmed absences, material errors and the call hard bound as
  separate numbers. A blocked problem is never described as a new task.
- Every blocked problem renders as a row with its problem label, its Chinese reason and one action
  button that navigates to that problem's "refresh or supplement material" area. Both actions are
  advertised as free and as not calling a model.
- `确认开始付费分析` is offered only when a freshly prepared runnable batch exists **and** the
  selected stored batch has no `materialBlocks`; `确认继续付费分析` follows the same rule. When
  nothing runnable was prepared the page states `未创建可运行批次，不会产生费用`.
- `恢复中断状态` is described as handling leases and interruptions only, never as a material fix.
- Raw English codes moved into a collapsible 诊断信息 area; the failure notice for a refused start
  uses the Chinese `materials_blocked` text.

## Historical-batch compatibility

Old batches are **not** deleted, migrated or rewritten. A batch stored by an earlier version keeps
its jobs, counters, status and audit rows; `batch.detail` merely reports the material preflight of
the snapshots it captured. Because a refreshed material state produces a *new* snapshot while the
batch keeps the immutable snapshot it captured, refreshing material can never clear an old batch's
block: the only remedy is to refresh or supplement and then **prepare a new batch**, which is what
the UI says and what `tests/plugin/material-gate.test.ts` pins.

`AnalysisPipeline.executeJob`'s runtime defence is unchanged and still covered by
`tests/pipeline/analysis-pipeline.test.ts` for all four low-level outcomes.

## Safety and cost boundaries

- A blocked problem is never a job: no attempt row, no audit call record, no quota unit and no
  provider request. An entirely blocked selection writes no batch at all.
- The second gate runs before the model-availability probe, so a refused start cannot even expose
  provider metadata, and before the owned operation, so no operation id is created.
- No plan, statement, editorial body, source identity, excerpt or English diagnostic travels
  through any DTO; `tests/plugin/model-operations.test.ts` and `tests/plugin/model-api.test.ts`
  assert that on the serialized answers.
- `material.refresh` (platform material request) and `material.supplement` (locally provided body)
  remain the two free entries. A user-provided answer keeps its own source identity and is never
  presented as a platform editorial. At the time of Stage 33A, `absent` was recorded only from an
  explicit user decision. Stage 33C later added one strict platform path: an authenticated Luogu response
  whose declared count is zero and whose result list is empty may also record `absent`; operational errors
  and unknown shapes still never do.
- No prompt, taxonomy, model selection, dependency version or SQLite schema changed.

## Verification actually performed

All commands were run offline against synthetic snapshots, the in-memory/temporary SQLite store and
a scripted local gateway. No real platform request, real credential, real batch or real model call
was made; session model calls and network calls were both zero for this stage.

```
node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none \
  tests/plugin/model-operations.test.ts tests/pipeline/analysis-pipeline.test.ts \
  tests/plugin/business-api.test.ts tests/ui/review-view.test.ts
node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none \
  tests/plugin/material-gate.test.ts
npm run typecheck
npm run check:architecture
git diff --check
npm run check
```

`tests/plugin/business-api.test.ts` is the contract's name for the batch HTTP boundary; this
repository registers those routes in `src/plugin/model-api.ts` and tests them in
`tests/plugin/model-api.test.ts`, so the new `batch.prepare` / `batch.detail` / `batch.run` /
`batch.resume` field and gate cases were added there.

Measured results:

| Command | Result |
| --- | --- |
| Focused contract set (`model-operations`, `analysis-pipeline`, `model-api`, `review-view`) | 74 tests, 74 passed, 0 failed |
| Same set plus the new `material-gate` file | 81 tests, 81 passed, 0 failed |
| `npm run typecheck` | passed (no diagnostics) |
| `npm run check:architecture` | "Architecture imports satisfy the declared layer boundaries." |
| `git diff --check` | exit 0 (line endings only; `core.autocrlf=true` normalises them on commit) |
| `npm run check` | passed: typecheck, architecture, 1400 business tests with 1398 passed / 0 failed / 2 skipped (the existing non-Windows credential-vault cases), 20 script tests, ESM build, browser factory/shared React/disposal checks |

New and extended cases:

- `tests/plugin/model-operations.test.ts` — a usable editorial and a confirmed absence each create a
  job; `material_missing`, `snapshot_unreadable`, `sources: []`, a `found` source without a body,
  all five operational source failures, and "all absent but no statement" each become an explicit
  block with the right reason and action; a fully blocked selection answers `batchId: null`,
  `jobs: []`, `upperBoundCalls { analysisCalls: 0, reasoningCalls: 0, blocked: N }` and writes no
  batch, no job and no attempt row; a mixed selection prepares only the runnable problems and an
  explicit rerun stays limited to them; the serialized preparation answer carries no title,
  statement, source URL, editorial body, excerpt or classifier detail.
- `tests/pipeline/analysis-pipeline.test.ts` — the low-level defence still fails
  `editorial_unknown`, `editorial_empty`, `source_unavailable` and `missing_statement` before any
  analyze/verify/reason dispatch, with zero counters and no attempt rows.
- `tests/plugin/material-gate.test.ts` — historical pending and failed batches, a mixed historical
  batch, a damaged snapshot body and an already-refreshed problem: `batch.run` and `batch.resume`
  both refuse with `materials_blocked`, no operation is created, no attempt is written, counters and
  job statuses are byte-identical before and after, the gateway records zero calls, and refreshing
  material produces a new current snapshot without clearing the old batch's block.
- `tests/ui/review-view.test.ts` — one distinct Chinese explanation per reason (each stating that no
  task was created and no model will be called), no start without a runnable batch, no start or
  resume while `materialBlocks` is non-empty, the normal pending/paused cases still startable, the
  recovery action never described as a material repair, and the raw code confined to diagnostics.
- `tests/plugin/model-api.test.ts` — the new `blocked` / `availability` / `upperBoundCalls.blocked`
  and `materialBlocks` fields over HTTP, a refused `batch.run` and `batch.resume` at `409
  materials_blocked` with no operation and no call, and continued response redaction.

## Historical open issue: Luogu editorial retrieval (resolved in Stage 33C)

The following was the boundary when Stage 33A closed. Stage 33C later implemented guarded authenticated
Luogu editorial reading, and Stage 33B added the verified Codeforces mirror reuse described in its own
reports.

This stage did **not** implement authenticated Luogu editorial fetching. On Luogu, a problem's
solution material can require a logged-in session, and the anonymous read can answer
"needs login" rather than "no editorial". That case is reported here as `source_unavailable` with a
refresh action, and it correctly never becomes an `absent` reasoning path — but the user still has
no automatic way to obtain that material. Cross-site editorial reuse (Codeforces and Luogu mirrors
sharing one write-up) is likewise not implemented. Until either lands, the supported free paths are
refreshing the platform material and pasting a user-provided answer with its source label.
