# Sprint 34A — Durable bulk platform-material refresh backend

Status: implemented, corrected by 34A1 (security/validation/state), 34A2 (lifecycle linearization,
transport-local cooldown, exact schema recognition) and 34A3 (Luogu source-wide Retry-After cooldown,
section 6). This report replaces the earlier placeholder: every statement below is implemented in the
tree and covered by the tests that are actually run at the end of it.

Scope: a durable batch operation that refreshes problem statements and editorial material for 1–100
selected **stored** problems through the accepted single-problem `ImportService.refreshMaterial`
path. It is platform IO only: nothing in the aggregate, the service, the routes or the durable record
can name a model, a budget or a model attempt, and no analysis is ever prepared, started or resumed
by it.

## 1. Operations and compatibility

Six typed POST operations, registered by `src/plugin/material-batch-api.ts` under
`/api/icpc/v1`:

| operation | kind | meaning |
| --- | --- | --- |
| `material.prepare` | local, free | validate 1–100 explicit items, prove every problem/account against the store, write one `prepared` batch |
| `material.start` | state transition + owned background work (202) | durably claim `running`, install the run owner in the same critical section, return promptly |
| `material.detail` | local read | one batch with its ordered items |
| `material.list` | local read | bounded page of summaries (newest first, `total` before the slice) |
| `material.cancel` | state transition | reach the active platform token, cancel every non-completed item, keep completed items |
| `material.retryFailed` | state transition | reset only non-completed attention/cancelled items; the caller then starts explicitly |

The accepted `material.refresh` route and DTO are unchanged. Batch states distinguish `prepared`,
`running`, `paused`, `completed`, `cancelled`; item states distinguish `pending`, `running`,
`completed`, `attention`, `cancelled`; input order is preserved by every projection.

## 2. Durable storage (schema v11)

`material_refresh_batches` (additive, `src/adapters/sqlite/schema.ts`) stores one canonical-JSON body
plus indexed `batch_id`, `status`, `revision`, `created_at`, `updated_at`, `item_count`. A body holds
the ordered items with their per-item optional account id, optional official tutorial URL, statement
flag, attempts, sanitized outcome and snapshot metadata. No column and no body field can represent a
Cookie, a credential reference, a statement, a raw tag, an editorial body, an upstream response body
or a raw exception text.

Migration follows the existing discipline: consistent pre-migration backup, one additive transaction,
rollback on failure, v11 refused by older builds, a newer database refused before any write, and
canonical-JSON validation that refuses a malformed row instead of repairing it.

## 3. Behavior guarantees

- **Conservative concurrency.** One batch run at a time (global platform concurrency one); each item
  calls the refresh service exactly once per attempt, so the Luogu source FIFO/pacing gate, the
  Codeforces transport pacing and the per-item optimistic snapshot-head check are preserved. The batch
  layer adds no hidden retry.
- **Stored-only, ownership-proven.** Prepare resolves every canonical key through the store
  (`missing_reference`, no row written) and re-checks at run time; a named account must be stored and
  belong to the problem's own source instance — never a silent anonymous fallback. At most 100 items,
  unique canonical keys, unknown/credential-like fields refused.
- **Partial failure is normal.** Auth, permission, rate limit, unavailable, changed-response,
  missing-reference and stale-head failures are sanitized per item (stable code, retryable,
  retry-after, attempts) and later items continue. A successful `absent` observation is a completed
  item; an operational failure is never reinterpreted as absence.
- **Cancellation** reaches the active token, stops pending siblings durably and is idempotent.
- **Recovery** on activation converts a `running` batch of a dead process to `paused` with its
  in-flight item retryable and starts no network work.
- **Disposal** cancels owned work, waits one shared finite deadline, leaves paused/interrupted state
  and leaks no unhandled rejection.
- **Metadata-only responses.** Canonical problem keys, statuses, timestamps, failure codes/retry
  metadata, statement/editorial/mirror status and snapshot id/version/hash/change flag/counts only. The
  official tutorial URL becomes a boolean; the account id (which encodes its handle) is dropped
  entirely, so no handle, display name, title, URL, note, body, raw tag or provider text can travel.

## 4. 34A1 repairs (security, validation, pre-run state)

1. Public batch responses no longer carry `accountId` or any handle-derived identifier.
2. `validateMaterialBatchPrepare` parses optional `accountId` through the canonical domain parser and
   validates optional `officialTutorialUrl` as an absolute, credential-free `http(s)` URL.
3. Tutorial URLs with userinfo are unrepresentable at the API boundary **and** in the aggregate/row
   validator, before persistence.
4. Prepare proves stored problems and stored, same-instance accounts before writing; absent problem,
   missing account and foreign account produce no batch row and zero adapter IO.
5. Cancel-before-first-start retries to `prepared`; a started cancel retries to `paused`; completed
   items stay immutable.
6. Recursive response redaction and closed-record validation cover every nested record.

## 5. 34A2 corrective work

### 5.1 Cancellation linearized with the active item

Defect: `refreshMaterial` commits a snapshot inside its transaction and only then returns the report.
A `cancel()` landing in that window wrote the running item as `cancelled`; the worker then discarded
the returned success, and `retryFailed` repeated platform IO whose result already existed.

Design: `cancel()` still writes its durable transition immediately (a non-cooperative adapter must
never hold a user's cancel open). The worker removed its post-report cancellation check — a report
that came back is a committed success — and, when the batch is already `cancelled`, restores exactly
that item to `completed` through the pure `completeCancelledMaterialRefreshItem`. Pending siblings stay
`cancelled`, a repeated cancel stays idempotent, and `retryFailed` preserves the restored item.

### 5.2 Close/start is a real lifecycle barrier

`close()` sets a synchronous `closing` flag before its first `await`; `prepare`, `start`,
`retryFailed`, `cancel` and `recoverInterrupted` check it both before queueing and inside their
serialized critical section. Close then drains the mutation claims already queued (so a start that
committed its durable `running` CAS is observed) before collecting, cancelling and waiting on the
owned runs. Run ownership is installed **inside the same critical section as the `running` CAS**, so a
start in flight when close begins can never leave an unowned running batch: close cancels it, and the
run records a retryable `interrupted` item, or nothing at all if it never claimed an item.

### 5.3 Non-cooperative adapters are detached, never unboundedly awaited

A run that outlives the one shared `closeWaitMs` deadline is marked `detached` and its batch is
interrupted durably (`paused` + retryable `interrupted` attention). A detached run performs no further
store read or write, so a late platform promise can neither resurrect work nor touch a closed store,
and every owned promise is observed so no unhandled rejection escapes. The composition no longer calls
`whenSettled()` after the timeout: `await materialBatches.close()` is the whole bounded disposal.

### 5.4 Direct start of a stale unowned `running` row

`start()` on a `running` batch this process does not own now CAS-saves
`interruptMaterialRefreshBatch` (paused, in-flight item retryable `interrupted`) and returns that view
with **no** network request. It never calls `startMaterialRefreshBatch` on the interrupted value in the
same action, and no run is claimed; the caller must `retryFailed` and start again explicitly.

### 5.5 Positive `Retry-After` is a shared **per-`HttpTransport`** not-before time

When a request gives up on a platform error with a positive `retryAfterMs` — retry budget exhausted,
terminal failure, or a delay above `maxRetryAfterMs` — `HttpTransport` advances its shared
`nextSlotAt` to at least `clock() + retryAfterMs` before throwing. Later requests through the same
transport still progress but dispatch no earlier than the provider deadline; the wait itself is
performed by the injected, cancellation-aware `wait` in `pace()`.

**Scope: one transport is not one source instance.** The deadline lives in the `nextSlotAt` field of
one `HttpTransport`, so it is transport-local by construction. A Luogu source deliberately runs
several transports — the anonymous business transport, the anonymous sync/metadata transport and one
authenticated transport per account — so a transport-local deadline can neither see a refusal another
transport made nor reach a request another transport is about to make. It also cannot see a refusal an
adapter answered as *data* instead of as a thrown error. Section 6 adds the source-wide layer that
closes both holes; the two layers are deliberately kept.

### 5.6 Exact SQLite table-set recognition

`requireTables` now compares the user-table set (SQLite internal `sqlite_%` tables excluded) for
**equality** for every recognized version v1…v11. A missing table and an unexpected table both raise
`unsupported_schema` from `detectSchemaState`, which runs before the pre-migration backup, any DDL or
any write; a refused database keeps its bytes, journal mode, version and every row.

## 6. 34A3 — the Luogu source-wide provider cooldown

### 6.1 Why a second layer is needed

`LuoguSourceGate` already serialized whole operations and kept the 2 s platform floor between them,
but it knew nothing about the provider's own deadline. The 34A2 cooldown (5.5) lives inside one
`HttpTransport`, and one Luogu source deliberately runs several. Worse, three Luogu paths answer a
refusal as **data** rather than throwing — an editorial `rate_limited` answer, an editorial
`unavailable` answer that declared a delay, and a failed metadata report — so no transport ever sees
them and a following operation of the same source could be dispatched on another transport
immediately.

### 6.2 One source-wide not-before instant

`LuoguSourceGate.run(token, work, retryAfterOf?)` gained an optional typed-result extractor, and the
gate owns one source-wide `notBeforeAt`. Before every operation it waits until the **later** of
`lastCompletedAt + minIntervalMs` and `notBeforeAt`, through the same injected cancellation-aware
`wait` and inside the same FIFO slot:

- a resolved value is passed to `retryAfterOf` **while the operation still owns the FIFO slot**; a
  positive, finite delay raises the instant to at least `now() + delay`. Recording after
  `await gate.run(…)` would be wrong, because a caller already queued behind it could start first;
- a thrown `PlatformError` is inspected the same way (`error.retryAfterMs`) and rethrown unchanged;
- the instant only ever moves forward (`Math.max`), so a newer, shorter delay can never release a
  caller earlier than an earlier answer demanded;
- it is a **delay, not a stop**: later work proceeds once it passed, a cancellation during the wait
  dispatches nothing, releases the FIFO and leaves the retained deadline intact for the next live
  caller.

`createGatedLuoguAdapter.fetchEditorial` supplies the extractor for `rate_limited` and for an
`unavailable` answer that declared a delay. Because the gate is shared, an authenticated-account
editorial limit delays a following anonymous operation and an anonymous thrown 429 delays a following
authenticated one. `LuoguSyncService.fetchMetadataWithFallback` supplies the extractor on **both** its
anonymous and its authenticated `gate.run` calls, reading the sanitized report error's `retryAfterMs`,
because `ImportService` returns a report rather than throwing for those failures.

### 6.3 Retry-After travels as a number, never as provider text

`EditorialFetchResult`'s `unavailable` variant gained the optional, `null`-safe `retryAfterMs` (the
`rate_limited` variant already had it), and the delay is carried through
`editorialFailureFromPlatformError`, both Luogu editorial sanitizers (anonymous and authenticated) and
the material-batch failure projection. Only the **number** travels:

- `HttpTransport` parses `Retry-After` (delta seconds or an HTTP date) into a rounded non-negative
  number, and its error `detail` stays path-only, so no header text, query string or body enters;
- `PlatformError` normalizes the value (finite, `>= 0`, rounded). The authenticated Luogu sanitizer
  rebuilds a failure from a known code plus a real boolean `retryable` and a normalized delay, with a
  fixed detail and no sample; the anonymous rebuild accepts a safe integer only, so a forged
  negative/fractional/infinite/non-numeric value is dropped, and an envelope-derived answer declares
  `retryAfterMs: null` instead of inventing one;
- the sync service folds the sanitized report error's number into the gate and into its durable
  `retryAt`; `buildFailure` ignores anything that is not finite and positive;
- the material-batch failure keeps exactly `code`, `retryable`, `retryAfterMs`, `attempts` — its
  closed-record validator refuses an undeclared field and a non-integer or negative delay — and the
  public batch and API views project those same four fields only. No `detail`, `sample`, body or
  exception text can travel with a delay, and a batch item that saw `unavailable` keeps the declared
  `retryAfterMs` while later items still progress.

### 6.4 Test correction (assertion, not product behavior)

The 34A2-derived assertion in `tests/plugin/luogu-gated-adapter.test.ts` expected the wait list
`[7000, 4000]`. The observed `[7000, 2000, 4000]` is correct: the anonymous catalog read that followed
the 7 s rate-limit answer dispatched and completed *at* the 7 s deadline, so the next whole operation
was paced by the **ordinary 2 s source floor** (a cooldown replaces the floor only while it reaches
further than the floor does, and it never removes the quiet time after an operation that already
completed); the 4 s `unavailable` answer then replaced the floor for the read after it. The test now
asserts that floor wait explicitly instead of omitting it. No product code changed for this.

## 7. Deterministic verification

All tests are offline and deterministic: synthetic in-process adapters/stores, promise gates and a
fake clock. No real waits, no live network, no credentials, no model calls.

New in 34A2:

- cancel during a held report return: item A `completed`, sibling B `cancelled`, retry repeats only B;
- close barrier: every later mutation refused, no second batch, no platform call, durable
  paused/interrupted;
- ownership inside the CAS: close begun mid-CAS still cancels the run and no platform request happens;
- non-cooperative refresh: `close()` bounded, durable `paused`/`interrupted`, then a store that
  refuses further use records **zero** late touches and no unhandled rejection;
- stale unowned `running`: direct start leaves the DB `paused`/`attention`, makes zero adapter calls,
  cannot remain `running`, and a second direct start is refused until an explicit retry;
- transport: 429 `Retry-After: 5` with `maxRetries: 0` makes the next request dispatch at ≥ 5000 ms on
  the same transport; cancellation during that cooldown dispatches nothing;
- schema: current v11 + extra table refused, v11 missing a table refused, migratable v10 + extra table
  refused with no backup and not one byte changed.

New in 34A3:

- gate: a thrown `PlatformError` with Retry-After delays the next work; a returned typed result's
  Retry-After is recorded while the slot is owned; a shorter later deadline never shrinks it; a
  cancellation during the cooldown dispatches nothing, does not poison the queue and leaves the
  retained deadline for the next live caller;
- gated adapter: an authenticated editorial rate limit delays a following anonymous operation, and a
  thrown anonymous 429 delays a following authenticated one; the extra wait observed in the corrected
  case is the ordinary 2 s floor (6.4);
- sync metadata: an anonymous and an authenticated report failure each establish the shared source
  deadline, and both attempts of the next drain wait for it;
- material batch: an `unavailable` answer keeps its declared `retryAfterMs` in the sanitized item
  failure while every later item still progresses;
- existing source minimum interval and all pre-existing Luogu tests remain valid.

### Commands and results

34A2 run (as recorded then):

| command | result |
| --- | --- |
| `npm run typecheck` | passed (`tsc -p tsconfig.json`, exit 0) |
| `npm run check:architecture` | passed — "Architecture imports satisfy the declared layer boundaries." |
| focused: `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none "tests/application/material-refresh-batch.test.ts" "tests/plugin/material-batch-api.test.ts" "tests/plugin/composition.test.ts" "tests/storage/material-refresh-batch.test.ts" "tests/storage/schema.test.ts" "tests/platform/http.test.ts" "tests/ui/**/*.test.ts"` | 385 tests, 385 pass, 0 fail, 0 skipped |
| focused (batch/API/storage/HTTP only, 34A2 cases): same runner with those four files | 69 tests, 69 pass, 0 fail |
| `npm run check` | passed end to end: typecheck, architecture, full suite 1632 tests (1630 pass, 2 skipped, 0 fail), 20 script tests, `npm run build`, `check-client` |

34A3 run (final tree, after the test correction in 6.4 and the report edits):

| command | result |
| --- | --- |
| `npm run typecheck` | passed (`tsc -p tsconfig.json`, exit 0) |
| focused 34A3: same runner with `"tests/sync/luogu-source-gate.test.ts" "tests/plugin/luogu-gated-adapter.test.ts" "tests/sync/luogu-sync-service.test.ts" "tests/application/material-refresh-batch.test.ts"` | 108 tests, 108 pass, 0 fail, 0 skipped |
| existing Luogu adapter/session/platform-error set: same runner with the 18 files `tests/platform/luogu{,-session,-problem-session,-editorial-shape,-editorial-read,-zero-memory,-recovery-diagnostics}.test.ts`, `tests/platform/http.test.ts`, `tests/sync/luogu-{connection,metadata-session,manual-recovery,problem-management}.test.ts`, `tests/plugin/luogu-{api,host}.test.ts`, `tests/plugin/composition.test.ts`, `tests/import/{import-service,cf-mirror-editorial}.test.ts`, `tests/ui/luogu-metadata-view.test.ts` | 342 tests, 342 pass, 0 fail, 0 skipped |
| `npm run check:architecture` | passed — "Architecture imports satisfy the declared layer boundaries." |
| `npm run check` | passed end to end: typecheck, architecture, full suite 1644 tests (1642 pass, 2 skipped, 0 fail), 20 script tests, `npm run build`, `check-client` |

## 8. Remaining risks

- A process crash between the snapshot commit and the report return still leaves the item durably
  in-flight, so recovery marks it `interrupted` and the next explicit retry repeats that single read.
  The material merge is idempotent (unchanged content reuses the stored snapshot), so the repeat is
  bounded to one platform read per crash window.
- `close()` deliberately discards the outcome of a promise that outlived its deadline; the item stays
  retryable `interrupted` and a later activation re-reads it.
- `start` on a paused batch whose remaining items are all attention is refused by the pure record
  (nothing pending); the caller must call `material.retryFailed` first. This is intended and
  documented.
- Two not-before layers exist and they do **not** have the same scope. The 34A2 cooldown is shared per
  `HttpTransport` — one transport, not one source instance; a Luogu source has several transports, and
  an adapter that answers a refusal as data never reaches a transport at all. The 34A3 deadline is
  shared per Luogu **source instance** through `LuoguSourceGate`, the one object every Luogu operation
  of that instance passes through (section 6). The source-wide instant is in memory only: a restart
  starts a fresh window, which at worst delays one operation and can never release a caller earlier
  than the 2 s floor.
