# Stage 11a — Account ability assessment (foundation + UI)

This is the historical substage report. The completed host/UI integration and coordinator fixes are recorded in [Stage 11 acceptance](stage-11-acceptance.md).

Status: implemented; focused tests, the wider domain/workbench/UI/plugin suites and the architecture
check pass. Official rating fetching, empirical calibration and AI-plan integration are explicitly
out of scope of this contract.

## Scope delivered

A pure, versioned `computeAbilityAssessment` in `src/domain/ability.ts`, exposed as an additive
required field `WorkbenchWeaknessResult.ability` from the existing `weakness` read, plus a prominent
`能力评估` panel that is the default view of the weakness page. The assessment reuses exactly the
evidence one weakness read already collected (problems/submissions/retrospectives) and the injected
clock: no store read, no network call, no model call, no schema migration. The formal weakness
report, knowledge evidence, solved distribution, platform-label reference, ranking and plan evidence
are unchanged.

## Changed / added files

| File | Change |
| --- | --- |
| `src/domain/ability.ts` | New pure reduction + types (`computeAbilityAssessment`, `aggregateAbilityForPlanning`, `AbilityAssessment`, `AbilityTrainingEstimate`, `AbilityNativeDistribution`, `AbilityCoverage`, `ABILITY_EVIDENCE_REASONS`, `ABILITY_REASON_TEXT`, `ABILITY_*` / `CF_*` constants). |
| `src/domain/index.ts` | Exports the new domain surface. |
| `src/application/workbench-types.ts` | `WorkbenchWeaknessResult.ability: AbilityAssessment` (required, additive). |
| `src/application/workbench-service.ts` | `weakness()` feeds the same collected evidence + `this.now()` to `computeAbilityAssessment`; doc comment updated. |
| `src/ui/ability-view.ts` | Pure label/format rules of the panel (Chinese labels, missing-data branches). |
| `src/ui/Ability.tsx` | The `能力评估` panel: estimate, pools, modes, native quantiles, coverage, caveats, official-rating link. |
| `src/ui/Weakness.tsx` | `ability` becomes the default tab of the existing view switch; Stats gains an ability row; knowledge/platform/verified views keep their content. |
| `tests/domain/ability.test.ts` | 16 pure-reduction cases (13 original + 3 repair-1 regressions). |
| `tests/workbench/ability.test.ts` | 2 real-store service cases (same evidence/API, isolation, read counts). |
| `tests/ui/ability.test.ts` | 4 panel-rules cases (labels, missing data, staleness, no conversion). |
| `docs/reports/stage-11a-ability.md` | This report. |

## Public shape (selected account + source instance only)

- top level: `version` (`ability.1`), `accountId`, `sourceInstanceId`, `platform`, `computedAt`,
  `counts` (attempted/solved/unsolved distinct), `last90Days` (attempted, **first-AC** new solves,
  repeated old ACs), `completionModes` (all-time and window; independent/assisted/solution_used/
  unknown), `nativeDifficulty`, `estimate`, `officialRating`, `excludedFromEstimate`, `coverage`,
  `reasonCodes`, `reasons` (Chinese caveat texts).
- counting rules: distinct problem per account; repeated submissions never inflate; a **first** AC
  inside the recent window makes a new solve, a later AC of an old solve is reported as
  `repeatedAcDistinct` and never refreshes it; submissions after the explicit `now` are excluded;
  rows of another account are ignored and counted (`foreignSubmissionsExcluded`); a row claiming the
  selected account for a different source instance is refused (`ability_source_mismatch`); only the
  latest retrospective per (account, problem) defines the completion mode, and a missing
  retrospective is the explicit `unknown` mode, never "independent".
- native difficulty: per raw platform dimension, `count` / `missing` / `min` / `P25` / `median` /
  `P75` / `max` / `buckets`. Blank, text and non-finite values stay missing (`count + missing` is the
  distinct solved total). No cross-platform conversion: a Luogu `difficulty` is never shown as CF
  `rating`.
- estimate (Codeforces only, ≥ 5 valid distinct rated solved problems, where a valid value is a
  positive finite safe integer): supported sample median rounded to 100 is `baselineTrainingLevel`,
  reported as observed — never floored and never capped; `quartileBand` is the sample's own P25–P75
  range rounded outward to 100, a descriptive spread of these solves and not a calibrated
  uncertainty or confidence interval; `baselinePool` = baseline ± 100 and `stretchPool` =
  baseline + 100 … + 300, whose bounds are raised to `CF_TRAINING_POOL_FLOOR` (800), the explicitly
  chosen training-recommendation floor. Raw `0`, negative and fractional rating values stay in the
  descriptive native distribution but never satisfy the sample gate. Sample priority is
  `recent_independent` (confidence `medium`), then `recent_observed` (AC with unknown independence:
  `low`, `provisional`), then `historical` (`low`, `provisional`, `stale`). Insufficient or absent
  data returns `status: 'unknown'` with `null` band/pools — never `0` and never "newbie". Known
  `assisted` / `solution_used` problems are excluded from every tier and counted separately.
- `officialRating` is always `{ status: 'not_loaded', apiHelpUrl: 'https://codeforces.com/apiHelp/objects#User', note }`:
  this bounded task does not call the official API, and the link explains user rating vs. problem
  rating. Non-CF platforms report `non_cf_native_scale_only` and no CF band.
- `aggregateAbilityForPlanning(report)` returns an identifier-free aggregate (estimate, counts,
  native quantile summaries, caveats) for a future plan/model summary: no account id, handle, source
  instance id, problem key, submission id or retrospective note is part of the shape.

## Commands actually run

| Command | Result |
| --- | --- |
| `npm run typecheck` | Clean (`tsc -p tsconfig.json`, no diagnostics). |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/domain/ability.test.ts tests/workbench/ability.test.ts tests/ui/ability.test.ts` | First run: 15 pass / 4 fail (a `solution_used` key bug in the mode counter, one wrong median expectation, two UI copy expectations). Fixed; final run 19 pass / 0 fail. |
| `npm run typecheck` (repair 1) | Clean (`tsc -p tsconfig.json`, no diagnostics), exit 0. |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/domain/ability.test.ts tests/workbench/ability.test.ts tests/ui/ability.test.ts` (repair 1) | 22 pass / 0 fail (19 pre-existing + 3 new regressions), exit 0. |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none "tests/domain/*.test.ts" "tests/workbench/*.test.ts" "tests/ui/*.test.ts" "tests/plugin/*.test.ts"` | 353 pass / 0 fail. |
| `npm run check:architecture` | "Architecture imports satisfy the declared layer boundaries." |

`npm run check` (full suite, build, client check) is the coordinator's acceptance run.

## Acceptance checks → tests

- account/source isolation → `another account is isolated and a foreign source instance is refused`
  (domain), `another account is isolated and the ability projection adds no store read` (service).
- repeated AC / first-AC recency → `first AC defines a new solve and a repeated AC never refreshes it`.
- future timestamps excluded → `submissions after the explicit now are excluded, never clamped`.
- empty / fewer than five → `empty and below-gate evidence is unknown, never zero or newbie`
  (`status: unknown`, `null` baseline, `no_data` / `insufficient_samples`).
- missing numeric CF ratings → `missing, blank and text ratings stay missing; non-CF platforms never
  convert`.
- independently confirmed vs assisted, latest downgrade → `assisted and solution-used problems are
  excluded, and the latest retrospective wins`, plus `unknown independence gives a provisional
  low-confidence recent estimate`.
- historical fallback/staleness → `an old pool is used only with the explicit stale caveat`.
- no cross-platform conversion → same missing-ratings case (`nativeDimension: 'difficulty'`, no CF
  dimension invented).
- extreme-outlier robustness with no invented cap → `quantiles resist extreme outliers and suggested
  pools are never capped`.
- ratings above 3500 preserved → `CF problem ratings above 3500 are preserved instead of clamped`.
- invalid ratings cannot satisfy the gate → `zero, negative and fractional CF ratings never satisfy
  the sample gate`.
- floor is recommendation-only → `the training floor shapes suggested pools but never rewrites
  observed statistics`.
- quantiles/distribution with sample counts → `native difficulty reports quantiles, buckets and
  missing coverage per dimension`.
- tier priority → `recent independent samples take priority over a larger historical pool`.
- identifier-free aggregate → `the planning aggregate carries no account, handle or row identifiers`.
- same evidence + typed API, no extra read → the two service cases (byte-identical to a direct
  `computeAbilityAssessment` over the same stored rows; one submission walk, no bank page, one source
  read).
- UI labels and missing data → the four `tests/ui/ability.test.ts` cases (`数据不足`, `0 – 0` never
  printed, named missing counts, explicit stale/heuristic/no-conversion copy).

## Open issues / notes

- The estimate is an unvalidated local heuristic (`cf-rating-band.1`); it is not an official rating,
  not a calibrated Elo score and not a mastery claim. Practice samples may differ from contest
  performance (`selection_bias_practice_vs_contest`).
- Repair 1 (ability scope only): `CF_RATING_MAX` was removed and `CF_RATING_MIN` was replaced by
  `CF_TRAINING_POOL_FLOOR`. The official CF problem API documents no 3500 upper bound, so observed
  high ratings (regression: five 4000-rated ACs → baseline 4000) and high suggested pools are
  preserved; candidate availability above the old 3500 value is a later concern and is deliberately
  not handled here.
- The official Codeforces user rating is `not_loaded` by design; no API fetch/cache exists in this
  stage.
- `aggregateAbilityForPlanning` is exported and tested but not yet consumed: AI plan generation still
  uses only reviewed/adopted tags, exactly as contracted.
- Non-CF platforms get descriptive native quantiles only; a platform-specific heuristic needs its
  own contract.
- `metadataMissing` counts attempted problems without a local metadata row; those problems still
  count as attempted/solved but cannot contribute a difficulty value.
