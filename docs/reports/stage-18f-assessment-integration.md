# Stage 18f — assessment integration acceptance

Worker report for Sprint Contract `.local/contract-18f.md` (integration acceptance repairs).
Scope was limited to `src/application/assessment-service.ts`, `tests/assessment/*integration*.test.ts`,
`tests/plugin/assessment-api.test.ts`, `tests/plugin/composition.test.ts` and this report.
`src/application/assessment-service.ts` was **not** modified: every case below passes against the
coordinator's repaired service, so no demonstrated defect required a service change.

## Changed files

| File | Change |
| --- | --- |
| `tests/assessment/assessment-integration.test.ts` | **New.** 10 real-chain integration tests: real `AssessmentService` + real `WorkbenchService.captureAssessmentInput` + real `SqliteTrainingStore` + real `GuidanceMethodRegistry` with the installed `dsh-icpc-method-balanced` companion. Only the generator (one model call) and the clock are injected. |
| `tests/plugin/assessment-api.test.ts` | **New.** 3 tests driving the six real `registerAssessmentApi` routes with real `Request`/`Response` over the same real service chain. |
| `tests/plugin/composition.test.ts` | Route count `53 → 59` (both assertions) and a loop asserting all six assessment routes are registered after activation; the count comment now names the 6 assessment operations. |
| `src/application/assessment-service.ts` | Unchanged (no defect demonstrated). |

`tests/assessment/service.test.ts` and its scripted capture port are untouched; `tests/plugin/business-api.test.ts` was used as the transport-test pattern, not modified.

## Commands actually run

| Command | Result |
| --- | --- |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/assessment/assessment-integration.test.ts` | 10 pass / 0 fail |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/plugin/assessment-api.test.ts` | 3 pass / 0 fail |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/plugin/composition.test.ts tests/assessment/service.test.ts tests/assessment/assessment-integration.test.ts tests/plugin/assessment-api.test.ts` | 35 pass / 0 fail (14 composition + 8 service + 10 integration + 3 API) |
| `npm run typecheck` | exit 0 |
| `npm run check:architecture` | exit 0 (`Architecture imports satisfy the declared layer boundaries.`) |

Baseline before the composition edit: `tests/plugin/composition.test.ts` failed with `59 !== 53` in
two tests — the six assessment routes were already registered by `src/plugin/index.ts`, the
assertion was stale. No other test file asserts the host route count.

## What the integration tests prove (real SQLite transactions, not scripted ports)

`RealChain` records the transaction mode of every delegated capture, which is what makes the
transaction claims observable rather than asserted:

- **Valid report commits through the real capture (anchored).** prepare → run → settle; the mode
  sequence is `own, own, join, join` (prepare capture, outer run check, reservation re-proof,
  settlement re-proof). The two paid-path captures *join* the service transaction; a nested
  `transaction()` would have been rejected by the store. Stored report `evidenceHash` equals the
  frozen capture hash, every stored citation belongs to the captured evidence set, host correlation
  is recorded, and exactly one charged row exists.
- **No-anchor report commits.** With no official rating and no eligible virtual run the capture
  anchor is `none`; the honest diagnostic answer (`estimatedRange: null`) is stored as a report with
  usage. A settlement-capture nested transaction would have been swallowed by `reportBasisProblem`
  into a sanitized `provider_error` with `report: null`, so this case is the direct regression guard
  for the join fix.
- **Real source change before cost.** A stored submission + problem mutation between prepare and run
  is refused `stale`; no `join` capture happens, no model call, zero charged rows, the preparation
  survives.
- **Source change inside the reservation window.** A mutation performed in the reservation
  transaction's own scope (through the joined store) is seen by the in-transaction re-proof, which
  throws `stale`; the mutation *and* the reservation roll back together (the problem title is back to
  its prepared value), zero charged rows, no model call.
- **Mutation during the paid call.** The generator mutates stored evidence before answering; the
  settlement re-proof refuses the answer (`provider_error`, `report: null`) while the provider's
  actual usage is retained and the row stays charged.
- **Cancellation with a provider that ignores the token.** The generator resolves successfully after
  `cancel()`; the late answer is discarded (`report: null`, `error.code: cancelled`) but its usage is
  kept and the charged slot retained.
- **Close during pending work.** With preparation gated mid-admission, `close()` resolves only after
  the admitted preparation commits (asserted ordering `['prepared','closed']`), the row stays durable,
  and a later `run` is refused `closing`. With the run's outer capture gated, `close()` makes the
  admitted run reject `closing` inside the reservation transaction: no reservation, no paid call,
  empty drain report.
- **Settings/method staleness with real capture.** A settings save after prepare refuses `settings`;
  uninstalling the companion method from the real registry refuses `stale`; both happen before any
  `join` capture and cost nothing.
- **Unload/reload durability.** After `service.close()` + `store.close()` + reopen on the same file
  (and a fresh registry re-registering the package method), the settled report, its `evidenceHash`
  and every citation are intact, the charged quota slot still refuses a second call, and the settled
  request replays as `started: false`.

## What the API tests prove

- `assessment.config / prepare / run / status / cancel / history` over real routes: free config,
  free prepare (with `guidance.methods[0].methodId` = the installed companion method and a non-null
  identifier-free `evidence`), paid run, terminal status, a metadata-only history page with
  `nextCursor: null`, known-zero idempotent cancellation of a prepared attempt.
- Account isolation: a foreign account gets `200 {value: null}` from `status`, `404 not_found` from
  `run`/`cancel`, and an empty history; no stored identity is echoed.
- Closed request shapes: unknown key, missing required key and unknown `config`/`history` fields are
  all `400 invalid_input`.
- Unsupported method: `prepare` with an uninstalled method is `400` and stores nothing (the real
  capture refuses before any evidence read or cost).
- Sanitized errors: the stale run is a `409 conflict` with the fixed Chinese message; the envelope
  contains no `missing_method`, `nested_transaction`, SQLite text, store path or file name.
- Projection boundary: no `attempt`, `accountId`, `sourceInstanceId`, `inputHash`, `preparation`,
  `hostSessionId`/`hostCallId`, no `sourceEvidenceHash` and no raw `sourceHash` *value* travel;
  `evidence` carries no internal `snapshot`. The history page keeps `report` deep-equal to the stored
  `AssessmentReportRecord` (citations intact) while `evidence` is `null`.

## Open issues / notes

- No service defect was demonstrated. The coordinator's four repairs (own vs join capture
  transaction, revalidation inside `reserve`, admission drained before shutdown, late successful
  answer after cancellation discarded with usage) are all exercised above and hold.
- Behaviour note (verified, not changed): a `run` already admitted when `close()` starts is refused
  with `closing` by the in-transaction `requireOpen()` rather than completing its reservation; no
  paid call is dispatched and the free preparation stays durable. This is the intended
  "prevents late paid call" semantics.
- `docs/reports/stage-18e-assessment-ui.md` still quotes the old composition assertion
  (`routes.size === 53`). That document is coordinator-owned and was deliberately not edited.
- Per contract, no full `npm run check`, no install, no Git and no budget edits were performed;
  the coordinator owns the post-parallel full run.
