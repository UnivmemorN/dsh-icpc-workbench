# Stage 15 — Separate player ability from practice difficulty

Experimental version **0.1.10**, locally verified on 2026-09-13 with Node **24.15.0** and dsh **0.1.5-rc.2**.

## Problem and result

The previous interface labelled a selected practice cohort's median as the player's training level. A sufficient recent cohort took precedence, so easy practice could dominate despite substantial earlier high-difficulty experience. A practice median does not establish player ability.

The ability panel now separates account-owned **self-assessment** from descriptive practice evidence. A CF account can save, edit or withdraw a range; its source is visibly “用户自评”. Without calibration, player level remains unknown. All-time, recent and earlier difficulty distributions remain available and truthful; their medians no longer appear as player ratings. No numerical formula was tuned to fit a particular user.

New AI plan preparations carry an identifier-free trainingReference, with range, source and revision. The planning-v3-calibration prompt treats a supplied range as the primary selection reference and retains historical evidence. Legacy median-derived player baseline and pools are null in new aggregates. Existing immutable preparations remain readable without synthesizing new fields, but stale preparation is refused before dispatch. Changing or withdrawing a calibration invalidates an older preparation.

## Implementation and compatibility

- Domain: new ability-calibration types/closed validators; ability.3 separates trainingReference from the deprecated legacy practice estimate.
- Storage: schema v5 adds only ability_calibrations, with append-only account/revision records, existence checks, CAS and validated reads. The v4 DDL/helpers remain frozen. Recognized older stores are backed up before additive migration.
- Application/plugin: TrainingStore calibration methods, serialized calibration writes, the same calibration read in weakness/preparation/revalidation, and strict ability.calibrate API. The browser cannot supply a fabricated official source or timestamp.
- UI: editable account-scoped calibration, descriptive history headings, no median-derived baseline/stretch cards, and matching plan preparation provenance.
- Documentation: personal calibration behavior and updated history interpretation. Original upstream/OI Wiki/Nowcoder attribution is retained.

## Executed checks

- Focused domain/storage/workbench/API/UI/planning/model-adapter regression suite: **122 passed**.
- Full npm run check: **829 functional tests + 9 construction-tool tests passed**, with type checking, architecture rules, independent ESM/classic browser builds and client disposal checks.
- Tests cover easy practice preserving a supplied range; unknown ability without calibration; account isolation; range and provenance validation; concurrent stale-write rejection; withdrawal history; import/restart persistence; genuine v4 migration with intact backup; pre-dispatch calibration staleness; cancelled API writes; and unchanged legacy preparation round-trips.
- Offline installation into the existing isolated profile returned plugin 0.1.10/schema 5. All **513 distribution files** matched the build. Bootstrap/model-policy checks retained Flash for all roles, max configuration, settings revision and quota limits; Pro was rejected without a settings write.
- All pre-existing database rows retained their canonical hashes. Live UI acceptance intentionally added one user-supplied calibration and one free plan preparation, which was cancelled with zero model dispatches. Existing plans, submissions, snapshots and retrospectives were unchanged.
- Browser acceptance confirmed the saved self-report label and inputs, separate historical practice medians, and the same range in a free preparation with real candidates. Private account data and acceptance artifacts remain local.

No paid construction worker, AI call or platform fetch ran for this change. Model prompt/payload behavior was verified with offline fixtures and free local preparation; live model answer quality was not re-evaluated.

## Limits

This fixes the interpretation and permits explicit calibration; it does not implement a validated automatic competition rating estimator or load official CF user ratings. A self-report is labelled as such. No retrospective still means unknown independence. Other platforms retain their own difficulty scales; the editor currently applies to CF accounts only.

See [personal calibration](../ability-calibration.md), [history statistics](../ability-history.md), and [third-party notices](../../THIRD_PARTY_NOTICES.md).
