# Sprint 18a — Design: detachable guidance methods, dual-axis plans, independent AI ability evaluation

Status: architecture discovery only. No production file was changed by this task.
Scope: `docs/reports/stage-18a-design.md` only; no dependency, schema, script, budget or git action.

## 1. Verified baseline (pinned 0.1.5-rc.2 / fb2c4b9)

- **Correction (Sprint 18b1).** The earlier claim that the host exposes no `ctx.skills`-style registry was
  wrong. The 18 `@deepseek-ai` packages under this project's `node_modules` are the *plugin's installed
  dependency subset*, not the host, so their silence proves nothing; the read-only harness checkout does
  ship a skill registry (`source/packages/skill/skill/src/index.ts` in `D:\DeepSeek Harness`). We still
  publish our own narrow `icpcGuidance` method service: it is **intentional compatibility isolation**, not a
  claim that no native facility exists. Detachability rides on public Cordis service injection/`ctx.effect`
  alone (`docs/dsh-integration.md`, host-boundary section).
- Current host composition: `src/plugin/index.ts` `activateHost()` builds store → audited client → services
  (workbench, coaching, planning) → `connection.fetch` routes, all inside `apply(ctx)` with one disposer
  (`ctx.effect(()=>runtime.dispose,'icpc-workbench: host')`, line 126-129). `inject=['connection','llm','sessions','sessionPersistence']`
  (line 38); `cordis.patch.yml` is a single `insert` row. Nothing is exported as a Cordis *service* today.
- Planning lifecycle already exists and is the model to generalize: `PlanAttemptStatus`
  `prepared|reserved|settled|uncertain|cancelled`, charged-status set, lease/expiry, `preparation` object +
  `evidenceHash`, `validatePlanAttemptTransition`, quota and `recoverExpiredReservations`
  (`src/application/planning-types.ts`, `src/application/planning-service.ts:830`). Paid calls go through one
  audited client (`src/adapters/dsh/audited-client.ts`, `DurableAuditSessions`) with Flash-only settings
  (`src/application/workbench-settings.ts:370-388`).
- Ability today: `ABILITY_ASSESSMENT_VERSION='ability.4'`, `aggregateAbilityForPlanning()`
  (`src/domain/ability.ts:62,1046`); the planning aggregate already carries `competition` (CF rating,
  max, activity, revision) and `trainingReference` (`src/domain/official-rating.ts:24-30`,
  `src/domain/ability-calibration.ts:17-23`). Official CF rating is stored separately in
  `official_rating_snapshots` (schema v6) as API `user.rating` history: `contestId, rank, ratedAt, oldRating,
  newRating` — **no `performance` field exists** in that API or in `OfficialRatingChange`.
- Provenance precedent to copy: user-supplied material already has an owned source with an id namespace
  (`USER_ANSWER_SOURCE_ID_PREFIX='user-answer-'`) and an explicit disclosure note
  (`src/application/workbench-api.ts:131-134`). API routes register by `operation` under
  `/api/icpc/v1/` through `registerApiRoute` (GET buffered, POST streaming; `src/plugin/api-transport.ts:122-196`).
- Storage versioning: additive-only `PRAGMA user_version` migrations, recognized v1…v7, refusal of newer
  files (`src/adapters/sqlite/schema.ts:33-48,468-530`). New tables are therefore cheap; rewriting
  `plan_attempts` bodies is not.

## 2. Decisions

1. **Plugin-owned public extension point (intentional isolation).** The core publishes one documented
   Cordis service; companion packages `inject` it and register methods. Uninstall/upgrade of a companion is
   ordinary Cordis service/effect disposal, with no core edit and no private internals.
2. **Methods are registered contributions, captured at preparation time.** The core never re-reads live text
   for a paid call: method id + version + content hash + source citations + the exact text are frozen into
   the immutable preparation, and therefore into `evidenceHash`. Changing or removing a method invalidates
   prepared inputs (`stale_preparation`) and forces a new preparation. Historical plans and reports are
   never rewritten; they keep their captured citations and are re-rendered, not migrated.
3. **Bottleneck over parallel tracks.** A plan attempt must not answer "methods A and B"; guidance output
   names one diagnosed prerequisite bottleneck (with reasons, confidence and evidence) and orders both axes
   against it: *thinking* (modeling / reasoning / proof) and *templates* (algorithm knowledge /
   implementation), each task declaring which axis it trains and which it consumes.
4. **Ability question.** The 11a aggregate is a historical practice assessment, not a contest-performance
   assessment. Independent AI evaluation is a genuinely new paid operation, so the **accepted planning
   lifecycle must first be generalized into a bounded, reusable attempt lifecycle** rather than cloning
   planning machinery; if that generalization cannot keep every existing planning guarantee and test green,
   the fallback is one new sibling service with its own table (see stage B).
5. **CF rating exact, AI commentary separate.** `competition.rating`/`maxRating` remain exact official values
   with revision and `fetchedAt`; every AI number is labelled as commentary with a range and confidence and
   is never written into `official_rating_snapshots`.
6. **Virtual performance is imported evidence, not a formula.** The CF API exposes virtual participation as
   `rank` rows only; deriving performance would need an unsupported arbitrary formula. So the feature ships a
   real user-import path with provenance rather than nothing and never labels the value official.

## 3. Exact seams to add (stage A/B/C)

| # | File (new unless noted) | Public interface |
|---|---|---|
| S1 | `src/application/guidance-types.ts` | `GuidanceMethodDefinition {id,version,title,summary,text,sourceCitations,axes,supportedOperations}`; `guidanceContentHash()` (sha256 over id/version/text/citations via `contentHashOf`); pure `validateGuidanceMethod`, `GUIDANCE_METHOD_LIMITS {maxMethods, maxTextChars, maxCitationChars}` |
| S2 | `src/application/guidance-registry.ts` | `GuidanceRegistry` (application-level, no Cordis): `register(definition): () => void` (validates, rejects duplicate id, revision-scoped unregister), `list()`, `select(ids)`, `snapshot(ids): GuidanceCapture[]` |
| S3 | `src/plugin/guidance-service.ts` *(edited `src/plugin/index.ts`)* | Cordis service `ctx.provide('icpcGuidance')` exposing `{version, listCatalog(), registerMethod(definition), selectedMethods()}`, each registration disposed via the companion's own `ctx.effect`; host keeps `inject=['connection','llm','sessions','sessionPersistence']` unchanged |
| S4 | `src/application/planning-types.ts` *(edit)* | `guidanceMethods: readonly GuidanceCapture[]` added to `PlanAttemptPreparation`; `GuidanceCapture {methodId, methodVersion, contentHash, text, sourceCitations, axes}`; folded into `planPreparationEvidenceHash`; reason `guidance_changed` added to `PlanStalenessReason` |
| S5 | `src/application/planning-service.ts` *(edit)* | `PlanPrepareRequest.guidanceMethodIds?: readonly string[]`; pre-dispatch check refuses an unknown/changed method id as `unknown_guidance_method` before any dispatch; `revalidate` compares captured hash against the live registry and answers `guidance_changed` |
| S6 | `src/domain/training.ts` *(edit)* | `TrainingTask` gains `axis: 'thinking'|'templates'`, `role: 'trains'|'consumes'`, `methodCitationIds: readonly string[]`; `TrainingPlan` gains `bottleneck: {axis, taxonomyId, reasonCodes, confidence, evidenceRefs}`; `validateModelPlan` accepts/rejects these as untrusted model data |
| S7 | `src/application/guidance-content.ts` | `MAX_BOTTLENECK_REASONS`, reason-code vocabulary + Chinese render text (mirrors `ABILITY_REASON_TEXT`) |
| S8 | `src/application/ability-evaluation-types.ts` | `AbilityEvaluationAttempt` (same status/lease/identity/transition rules) with `evidenceHash` over the aggregate + imported performance rows + captured methods |
| S9 | `src/application/attempt-lifecycle.ts` | Shared helper extracted from `PlanningService`: reserve/settle/uncertain/cancel/quota/recovery sequencing parameterized by store port, prompt version, lease margin and generator |
| S10 | `src/application/ability-evaluation-service.ts` | `prepare/run/status/cancel/history` mirroring `PlanningService`, over a dedicated generator |
| S11 | `src/adapters/dsh/ability-evaluation-generator.ts` | `AbilityEvaluationGenerator.generate(request): Promise<ModelCallResult<{draft}>>` + `abilityEvaluationGenerationProblem()` pre-dispatch check; strict normalized draft (assessment, ranges, confidence, bottleneck, citations) |
| S12 | `src/domain/performance-evidence.ts` | `ImportedPerformanceEvidence {evidenceId, accountId, source:'user_import'|'platform_row', methodText, methodCitation, contestId, contestName, participatedAt, kind:'virtual'|'official'|'practice', independence:'independent'|'assisted'|'unknown', performanceValue:number|null, rank:number|null, importedAt, revision, note}` + pure validators/dedup key |
| S13 | `src/adapters/sqlite/schema.ts` *(edit)* | **v8**, additive only: `performance_evidence`, `ability_eval_attempts`, `guidance_selections`; keep v1…v7 helpers byte-identical |
| S14 | `src/plugin/ability-eval-api.ts`, `src/ui/ability-eval-view.ts`, `src/ui/guidance-view.ts` | Routes `guidance.catalog`, `ability.evaluation.prepare/run/status/cancel/history`, `performance.evidence.list/import/update/delete`; UI methods catalog + selection, dual-axis plan rendering, evaluation report with evidence/confidence, performance-evidence editor |
| S15 | `packages/dsh-icpc-method-thinking/` (+ `-templates/`) | Companion Cordis packages: `inject:['icpcGuidance']`, `apply(ctx)` registers each method through `ctx.effect(() => ctx.icpcGuidance.registerMethod(def))`, own `package.json`/`cordis.patch.yml`, installable/uninstallable independently of the core `.tgz` |

## 4. Staged implementation plan

- **Stage A — method seam + immutable capture.** S1–S5, S15 (one companion with 2 methods), `guidance.catalog`
  route, UI catalog/selection with per-method source disclosure; register-time bounds (count, text bytes,
  citation count), duplicate-id refusal, Flash-only unchanged. No ability work yet.
- **Stage B — lifecycle generalization + independent ability evaluation.** S9 (extraction with planning
  tests unchanged), S8, S10–S11, S13 (`ability_eval_attempts`), routes/UI report. Quota, cancellation,
  restart recovery, `uncertain` accounting and staleness behave exactly as planning; official rating stays
  on its own immutable snapshot path; AI output is stored as a labelled commentary object with range and
  confidence. *Fallback:* if S9 cannot preserve all planning guarantees, keep `PlanningService` untouched and
  give the evaluation service its own copy of the sequencing with its own table — feature-complete, no
  regression risk, documented as intentional duplication.
- **Stage C — dual-axis plan output + bottleneck.** S6–S7, plan generator prompt/schema version bump
  (e.g. `planning-v5-bottleneck`), UI plan rendering (axis badges, bottleneck reason, cited methods), and
  `guidance_changed` staleness surfaced before paying.
- **Stage D — virtual-performance evidence + disclosure.** S12, S13 (`performance_evidence`), S14 evidence
  routes/editor: manual import of virtual contests (contest id/name, date, kind, independence, observed
  rank, optional performance value with method + citation), dedup on `(accountId, contestId, kind)`, update
  bumps `revision`, delete is a real removal, and every read returns a disclosure that the value is
  user-imported and not official CF performance. If a method/text pair is absent the value is stored as
  `null` rather than guessed.
- **Stage E — acceptance.** Focused tests per stage, then packaged install/uninstall of core + companion in
  the isolated profile, restart recovery and migration checks.

## 5. Compatibility

- **Public/API compatibility:** add `ctx.provide('icpcGuidance')`; existing Cordis services and the
  `connection.fetch` route set are untouched. New routes are additive `POST` (or buffered `GET` for
  `guidance.catalog`) below `/api/icpc/v1/`. A companion that is absent yields an empty catalog and an
  explicit `unknown_guidance_method` refusal — never a silent default method.
- **Backwards compatibility:** a stored `PlanAttempt` without `guidanceMethods` reads as `[]` and keeps its
  existing `evidenceHash` (empty capture hashes to a documented constant), so v7 databases open and settle
  unchanged; schema v8 is additive, refuses newer files, and plans/reports are never rewritten by a method
  change. Removing a companion keeps plan history and its captured citations readable.

## 6. Acceptance tests

1. Registry: rejects duplicate id, over-long text, malformed citation, non-contributing companion; disposal
   removes exactly that method and re-adds cleanly.
2. Capture: prepare twice with the same method text produces the same `evidenceHash`; editing one character
   changes the hash; prepare with a changed method after `run` returns `stale_preparation`
   (`guidance_changed`) and dispatches nothing.
3. Immutability: a settled attempt keeps its old method text/version after the method changes; no code path
   rewrites a historical plan or report.
4. Evaluation lifecycle: cancel before run is known-zero; cancel after reservation settles with usage;
   restart turns an expired reservation into `uncertain` and keeps the quota slot; quota exhaustion pauses
   without dispatch; concurrent runs are refused by the single-reservation rule.
5. Provenance: official rating is byte-identical to the stored snapshot and never affected by AI output;
   imported virtual evidence is labelled `user_import`, dedups on `(accountId, contestId, kind)`, bumps
   revision on update, disappears on delete, and never appears in `official_rating_snapshots`.
6. Dual axis: a model draft missing `axis`, citing an unregistered method, or naming a second bottleneck is
   refused by `validateModelPlan`, not repaired.
7. Regression: every existing planning/coaching/ability test passes unchanged after S9, plus schema v7→v8
   migration and newer-version refusal tests.

## 7. Open issues

- Method text is guidance content proposed for host companions (not uploaded user data), so shipping the
  two seed methods inside the companion packages is acceptable; long-term sourcing/citation review of each
  method remains a content-maintenance task with its own review gate.
- Whether the UI selects methods per preparation or per account default is a product choice; this design
  supports both (S5 accepts an explicit id list, S13 stores the last selection).
- Automatic virtual-performance derivation stays explicitly out of scope until a defensible, citable formula
  is approved; the import path above is the complete deliverable, not a placeholder.
- The design deliberately does not bind to the host's own skill registry even though one exists: a harness
  upgrade must not reinterpret installed method text, so S1/S3 own the seam and the captured-citation
  contract; remapping to a future host facility would touch only those files.
