# Sprint 18b2a — guidance propagation through the plan services

Status: implemented and verified with focused suites. Scope was deliberately limited to the three
service/export targets named by the contract: `src/application/workbench-service.ts`,
`src/application/planning-service.ts` and `src/domain/index.ts`. No adapter, generator, UI/API,
performance or assessment code was touched; the existing 18b/18b1 foundation (`domain/guidance.ts`,
`domain/training.ts`, `domain/plan-generator.ts`, `application/planning-types.ts`,
`application/planning-generation.ts`, `application/guidance-catalog.ts`, plugin composition) was used
as-is and not rewritten.

## What changed

### `src/domain/index.ts` (exports only)

- The `./training.js` export block now also exposes the guided-plan vocabulary: `PlanDiagnosis`,
  `TrainingTaskAxis`, `TRAINING_TASK_AXES`, `MAX_PLAN_OBJECTIVE_CHARS`, `planDiagnosisProblem` and
  `validatePlanDiagnosis`. `./guidance.js` was already re-exported wholesale, so `GuidanceSnapshot`
  and the method seam were public beforehand.
- This closes the two typecheck errors in `src/application/planning-generation.ts`
  (`PlanDiagnosis`, `TrainingTaskAxis`).

### `src/application/workbench-service.ts`

- `capturePlanGuidance` (new small private helper). `undefined`/`null` keeps the legacy unguided
  contract and returns no capture at all. An explicit list is captured through the live catalogue with
  `captureGuidance(catalog, 'plan', ids, { required: true })`, so a missing, replaced or
  plan-incapable method throws a typed `DomainError` (`reason: 'guidance_refused'`, carrying the
  catalogue's own refusal reason and method id) before any candidate is read or anything is written.
  A selection with no catalogue composed is `unfilled_settings`.
- `preparePlanInput` now puts the capture on the `PlanAttemptPreparation`
  (`...(guidanceSnapshot === undefined ? {} : { guidanceSnapshot })`) **before**
  `planPreparationEvidenceHash` runs, so the capture is part of the evidence hash exactly when it
  exists; an omitted selection stores no key at all and keeps the pre-guidance hash byte-for-byte.
- `revalidatePlanInput` re-proves the stored capture against the live catalogue
  (`revalidateGuidance`) right after the account/source checks, returning the typed
  `guidance_changed` staleness finding when the method was uninstalled, replaced, or the composition
  has no catalogue. The planning service calls this port inside both its reservation and its
  settlement transaction, so that single check covers "before dispatch" and "before the plan write".
- `guidanceRefusalError` (new pure helper) turns a catalogue refusal into the caller-facing typed
  error. The doc comments of `preparePlanInput`, `revalidatePlanInput` and `saveModelPlan` state the
  binding rule.

### `src/application/planning-service.ts`

- `PlanPrepareRequest.guidanceMethodIds` (new, optional): `1..MAX_GUIDANCE_SELECTION` distinct
  non-empty ids, or omitted/`null` for the legacy contract. `parseGuidanceSelection` refuses a
  non-array, an explicit empty list (`missing_method`) and duplicate ids before any store read.
- Request identity: `PREPARE_REQUEST_KEYS`, `ParsedPrepare` and `assertPrepareIdentity` retain the
  selection, and `prepare` forwards it to `PlanningDataPort.prepare`. `canonicalGuidance` is
  order-sensitive and hashes `null` as its own `legacy_unguided` scope, so re-preparing an id with a
  different method selection is a `request_conflict` (`reason: 'request_guidance_conflict'`) and a
  legacy id can never compare equal to an explicit selection.
- Free view: `PlanningPreparationView` now carries `guidanceMethodIds` (`null` for legacy) and
  `guidance` (the full immutable `GuidanceSnapshot` — public instructional text — or `null` for
  legacy). The candidate/tag spoiler rules are unchanged.
- Generation request: `generationRequestOf` sends `guidance: preparation.guidanceSnapshot ?? null`, so
  the adapter receives the exact stored capture, or an explicit statement that no method was involved.
- Settlement: `validateModelPlan` is called with
  `guided: reservation.preparation.guidanceSnapshot !== undefined` — the reservation, never the model
  answer, decides the answer shape — and `draftToRaw` now forwards `diagnosis` and per-task
  `axis`/`objective` whenever the draft carries them. A guided answer that omitted them is refused
  (`invalid_axis` / `invalid_objective` / `unbalanced_axes`), an unguided answer that invents them is
  refused (`invalid_shape`), and nothing is silently dropped.

## Tests

`tests/planning/guidance-service.test.ts` (new, 4 tests) drives the real `PlanningService`, the real
`WorkbenchService` as its data collaborator, a real SQLite store, a real `GuidanceMethodRegistry` and
the installable `balanced-dual-axis` companion package. It pins:

1. legacy omission: the view reports `null` and the stored preparation has **no** `guidanceSnapshot`
   key; an explicit selection stores exactly `captureGuidanceSnapshot('plan', [definition])` and its
   ids in the view; an identical replay is idempotent, a different selection under the same request id
   is `request_guidance_conflict`, and an explicit empty list is `invalid_request`;
2. a guided answer missing a task axis settles `invalid_output` with its paid usage retained, and the
   dispatch carried the stored capture including its method text;
3. an unguided attempt refuses a model answer that invents `axis`/`objective`;
4. replacing the installed method (1.0.0 → 2.0.0) makes `revalidatePlanInput` report
   `guidance_changed` and makes the paid run refuse `stale_preparation` with **no** dispatch; a new
   preparation captures the 2.0.0 text; uninstalling the method refuses a new preparation with the
   typed `guidance_refused` error instead of degrading it to unguided.

Existing planning/workbench tests were not modified.

## Commands actually run (repository root)

| Command | Result |
|---|---|
| `npm run typecheck` | pass, exit 0 (baseline had the 9 expected errors: 2 missing domain exports + 7 unused/undefined guidance symbols) |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/planning/guidance-service.test.ts tests/planning/service.test.ts tests/workbench/plans.test.ts tests/model/plan-generator.test.ts` | pass, 52/52 |
| same runner over `tests/workbench/*.test.ts`, `tests/plugin/planning-*.test.ts`, `tests/storage/planning-store.test.ts`, `tests/guidance/*.test.ts`, `tests/ui/planning.test.ts` | pass, 124/124 |
| `npm run check:architecture` | pass |

The full `npm test` suite was not run by this worker (focused subsets above only); the coordinator
owns full acceptance. No install, publish, Git write, budget or permission change was made.

## Remaining work (explicit, outside this contract's three targets)

1. **Storage cannot yet round-trip a guided plan.** `src/adapters/sqlite/entities.ts` `PLAN_FIELDS`
   does not list `diagnosis`, and `bodyOf(plan, PLAN_FIELDS)` projects onto declared fields only, so
   the plan-level diagnosis is dropped while the whole `tasks` array (with `axis`/`objective`) does
   survive. `WorkbenchService.saveModelPlan` re-reads the stored row and compares the full content
   hash, so a plan carrying a diagnosis would throw `invalid_transition`, the settlement would roll
   back and re-settle `provider_error` with the paid call retained and no plan stored. Adding
   `'diagnosis'` to `PLAN_FIELDS` is required before a guided run can store a plan end-to-end. This is
   why the focused test pins the guided refusal paths and deliberately does not assert a stored guided
   plan today.
2. **The planner adapter has no guidance awareness yet.** `src/adapters/dsh/plan-generator.ts` must
   inject the captured methods' plan guidance into the task data (keeping the fixed numeric, privacy
   and output contract) and emit `diagnosis` plus per-task `axis`/`objective` when `request.guidance`
   is present. `planningGenerationProblem` already validates the capture and requires
   `kind: 'plan'`; without the adapter change a guided dispatch answers as an unguided draft and is
   refused `invalid_output` (honest, but no guided plan can be produced).
3. **API/UI transport.** `plan.aiPrepare` (`src/plugin/model-operations.ts`) forwards the request
   object unchanged, so `guidanceMethodIds` reaches the service as soon as the transport/UI supplies
   it. The request schema, the method selector, the `guidance.catalog` route, and rendering
   `PlanningPreparationView.guidance`/`guidanceMethodIds` are the next stage. `WorkbenchPlanView` also
   does not expose the plan diagnosis or per-task axis/objective to a revealed reader yet; the 18b2
   unrevealed-projection rule (generic axis label only, hide the free-form objective and diagnosis
   reason while unrevealed) belongs to that plan-projection/UI stage.
4. Packaging: `package.json` `files` does not list this report or the companion packages; that is the
   packaging step of the final 18b acceptance.

## Open issues

- A preparation captured with an explicit method can no longer be re-prepared as unguided under the
  same request id (`request_guidance_conflict`), by design; a caller that wants a different method
  scope must use a new request id. This mirrors the existing candidate-selection rule.
- The guided happy path is blocked only by remaining item 1; the service-side resolution (capture,
  request identity, dispatch payload, domain validation, staleness) is complete and tested here.

## Final integration update

The catalogue composition, adapter prompt, API/UI, plan projection and packaging follow-ups above were completed for 0.1.13. A real Flash max call generated and persisted a guided dual-axis plan. These are historical stage handoff notes; current acceptance is recorded in stage-18-acceptance.md.
