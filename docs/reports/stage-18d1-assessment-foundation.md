# Stage 18d1 — ability-assessment foundation (repair / finish)

Status: complete for the assigned contract. Production files existed from the interrupted run; this
round repaired the new tests, fixed the real runtime defects they exposed, added the missing capture
and audited-adapter acceptance tests, and recorded the interfaces the next stage builds on.

Non-goals (unchanged, still absent): assessment service/lifecycle (reservation, quota, settlement,
recovery), UI/business-API endpoints, plugin wiring, Git, packaging and budget changes.

## Changed files

| File | Change |
| --- | --- |
| `src/application/assessment-capture.ts` | Defect fix: the synthetic `evidenceRef` pattern now accepts `_`, so the capture's own `ev-practice-all_time` reference validates. |
| `src/domain/assessment.ts` | Defect fix: `assessmentReportProblem` now prefixes the stable `details.reason` (`unknown_key: …`, `no_numeric_anchor: …`) so a refusal is assertable/loggable; `requireExactKeys` treats a declared member explicitly set to `undefined` as absent (`missing_key`) instead of handing it to the field check. |
| `tests/assessment-fixtures.ts` | Repair: `createAssessmentReportRecord`/`AssessmentReportRecord` imported from `domain` (they are not exported by `application/assessment-types`). |
| `tests/domain/assessment-report.test.ts` | Repair: relative imports (`../../src`, `../assessment-fixtures`), invalid `assert.throws(..., undefined, ...)` overload, and the cross-capture hash case now uses an evidence-changing capture (a different instant alone is the same clock-free evidence). |
| `tests/storage/assessment-attempts.test.ts` | Repair of wrong expectations: cleared usage is a shape refusal (`invalid_input`) while a valid replacement outcome is `immutable_violation`; a post-dispatch cancellation **settles** and keeps its usage (`cancelled` is reachable only from `prepared`); "settled without usage" case really uses `usage: null`; an identical re-preparation is the documented no-op, so stale revision / changed preparation are exercised with a genuinely different body; `b1` carries its own `requestedAt` so the global `requestedAt, id` order is unambiguous; an empty `statuses` list is asserted as refused. |
| `tests/workbench/assessment-capture.test.ts` | **New** acceptance: real `WorkbenchService.captureAssessmentInput` over a temporary `SqliteTrainingStore`. |
| `tests/model/assessment-generator.test.ts` | **New** acceptance: real `DshAssessmentGenerator` over a real `DshAuditedModelClient`, scripted provider streams. |
| `docs/reports/stage-18d1-assessment-foundation.md` | This report. |

## Fixed runtime defects (exposed by the tests)

1. **Capture rejected its own prompt.** `assessmentEvidenceEntries` publishes `ev-practice-<period>`
   with `period = all_time`, but `EVIDENCE_REF` allowed only `[a-z0-9:-]`, so every real capture
   failed `validateAssessmentCapture` with `invalid_evidence_ref`. The ref alphabet now includes `_`;
   the fixture/domain citation set was already using that spelling.
2. **Stable refusal reasons were unreachable.** `assessmentReportProblem` returned only the prose
   message, while the documented contract (and the acceptance test) uses the stable `reason`
   (`unknown_key`, `missing_key`, `unknown_evidence_ref`, `range_out_of_bounds`, `range_inverted`,
   `no_numeric_anchor`, `url_in_report`, …). The returned diagnostic now leads with the reason code.
3. **`undefined` was not "absent".** `{ …report, summary: undefined }` was reported as
   `invalid_text` instead of `missing_key`; the strict key check now treats `undefined` as absent
   (`null` stays data, matching the sibling attempt validator's documented rule).

## Added acceptance tests (externally meaningful behaviour)

`tests/workbench/assessment-capture.test.ts` (3 tests)

- a free capture needs **no unsolved plan candidate** (empty bank, then an all-solved bank), is
  honest about `anchor.kind === 'none'`, publishes `knowledgeTotalRows`/omitted counts, and a
  recapture with only a moved observation instant yields **identical** `evidenceHash`/`sourceHash`;
- the serialized prompt carries no account id, handle, source-instance id, problem title/statement/
  URL, submission id, retrospective note, official contest name, raw platform tag, ledger evidence
  id/contest id/source URL/note, or exact timestamp — while two identical-evidence accounts still
  produce **different** `sourceHash` values;
- every semantic mutation invalidates `sourceHash`: a new submission, a retrospective, a virtual
  ledger save (anchor becomes `virtual_performance`), an official rating save (anchor becomes
  `official_rating`), a method selection, a replaced installed method text, and a different
  source instance.

`tests/model/assessment-generator.test.ts` (4 tests)

- one request is exactly **one** audited dispatch: `role: 'assessment'`, `snapshotId:
  assessment:<attemptId>`, `reasoningEffort: 'max'`, fixed temperature, provider/model/budget echo,
  one audit session, known usage;
- the payload is the identifier-free capture (`{task, evidence}` with exactly the prompt keys, the
  evidence list and anchor sent unchanged) and never the private source evidence;
- a guided call keeps the selected method's assessment text in the **trusted system section**
  (heading + name + summary + every section) and never in the untrusted task JSON;
- an anchored well-formed report is accepted; unknown key, missing key, unknown evidence ref,
  fabricated URL and a numeric range without an anchor are refused as `invalid_output` with the
  provider-reported usage retained and no retry; the honest `estimatedRange: null` diagnostic answer
  stays valid; unknown usage stays `null` instead of becoming a free call.

## Interfaces for the next stage (18d2 service/UI)

- **Domain report** (`src/domain/assessment.ts`): `AssessmentReport`, `AssessmentRatingRange`,
  `AssessmentAxisAssessment`, `AssessmentAnchorFacts`, `AssessmentReportContext`,
  `AssessmentReportRecord`, `assessmentAnchorOf`, `assessmentReportProblem`,
  `validateAssessmentReport`, `validateAssessmentReportRecord`, `createAssessmentReportRecord`,
  `assessmentConflict`, `ASSESSMENT_AI_DISCLOSURE`, `ASSESSMENT_REPORT_VERSION`, and the enforced
  bounds (`MAX_ASSESSMENT_*`, `ASSESSMENT_ESTIMATE_MIN/MAX`, confidence/priority/anchor enums).
- **Capture** (`src/application/assessment-capture.ts`): `AssessmentDataPort.captureAssessmentInput
  (request, token)` (implemented by `WorkbenchService`), `AssessmentCapture`,
  `AssessmentCaptureRequest` (accountId, explicit `capturedAt`, optional `guidanceMethodIds`),
  `AssessmentSourceSnapshot`, `AssessmentModelEvidence`, `AssessmentEvidenceEntry`,
  `AssessmentKnowledgeRow`, `assessmentEvidenceRefs`, `assessmentEvidenceHash`,
  `assessmentSourceHash`, `ASSESSMENT_INPUT_DISCLOSURE`, `MAX_ASSESSMENT_KNOWLEDGE_ROWS`.
- **Generation port** (`src/application/assessment-generation.ts`): `AssessmentGenerator.generate`,
  `AssessmentGenerationRequest` (provider/model/budgets are caller-configured; `effort: 'max'`),
  `AssessmentGenerationOutcome`, `ASSESSMENT_PROMPT_VERSION`, `ASSESSMENT_EFFORT`,
  `assessmentGenerationProblem`, `assessmentReportContextOf`.
- **Attempts + persistence** (`src/application/assessment-types.ts`): `AssessmentAttempt`,
  `AssessmentAttemptStatus`, `ASSESSMENT_ATTEMPT_CHARGED_STATUSES`, `ASSESSMENT_QUOTA_WINDOW_MS`,
  `ASSESSMENT_LEASE_MARGIN_MS`, `AssessmentAttemptPreparation`, `AssessmentStore` (`get`/`save`
  with revision CAS, account-scoped `listAssessmentAttempts`, global `countAssessmentAttempts`),
  `validateAssessmentAttempt`, `validateAssessmentAttemptTransition`, `assessmentInputHash`,
  `reportContextOf`, `attemptAnchorFacts`, `ASSESSMENT_DISCLOSURE`. SQLite schema v8 table
  `ability_evaluation_attempts` implements the port.
- **dsh adapter** (`src/adapters/dsh/assessment-generator.ts`): `DshAssessmentGenerator`,
  `parseAssessmentOutput`, `ASSESSMENT_SYSTEM_PROMPT`, `assessmentGuidedSystemPrompt`,
  `ASSESSMENT_GUIDANCE_HEADING`, `ASSESSMENT_TEMPERATURE`.

The next stage still owns: reservation/quota/cancellation/settlement and recovery, `assessment.*`
business-API endpoints, UI states, and the plugin composition of prepare → reserve → generate →
settle.

## Commands actually run

```text
npm run typecheck
  -> exit 0

npm run check:architecture
  -> "Architecture imports satisfy the declared layer boundaries." (exit 0)

node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none
  "tests/domain/assessment-report.test.ts" "tests/storage/assessment-attempts.test.ts"
  "tests/workbench/assessment-capture.test.ts" "tests/model/assessment-generator.test.ts"
  -> tests 20, pass 20, fail 0 (exit 0)
```

The full suite was intentionally not run repeatedly (contract: focused checks only). No install,
build, plugin, UI, lifecycle, Git or budget commands were run.

## Open issues / notes

- `assessmentReportProblem` now returns `"<reason>: <message>"`; the dsh generator surfaces that
  string inside its `invalid_output` message. No test pinned the old prose-only string.
- The storage test's repaired expectations follow the documented contracts in
  `assessment-types.ts` (`cancelled` ⇔ prepared-only; settled outcome immutability) rather than the
  previous ad-hoc assumptions; no gate was skipped or weakened.
- `package.json`'s report file list was left untouched (packaging is coordinator-owned).
