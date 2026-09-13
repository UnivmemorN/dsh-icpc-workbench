# Stage 14 — Always assess historical solving evidence

Experimental version **0.1.9**, tested 2026-09-13 with Node **24.15.0** and dsh **0.1.5-rc.2** in the isolated icpc-acceptance profile.

## Problem and result

The previous near-term estimate selected recent independent or recent observed samples whenever they met the gate. Older solves were then visible only in a native distribution, or used as a fallback if recent samples were insufficient.

The ability panel now always shows three parallel assessments: **all imported solving history**, **recent first-known ACs**, and **earlier first-known ACs**. Each reports solved/eligible/independently confirmed counts, known assisted or solution-used exclusions, missing or invalid difficulty, completion modes and native quantiles. CF periods need at least five eligible distinct solves for a median-based difficulty reference. The original near-term training recommendation is separately labelled.

New AI plans carry the same identifier-free history comparison and the planning-v2-history prompt asks the planner to consider both historical experience and recent observations. This change does not estimate an official contest rating or invent a blended Elo.

## Compatibility

- Ability report version is ability.2; the old estimate remains available with its existing near-term selection rule.
- Planning history is additive and optional for old immutable preparations. Strict validation preserves a legacy body without adding fields; new history rejects undeclared nested identifiers and inconsistent counts.
- Fresh plan preparations hash the historical evidence. Actual changes to earlier records invalidate a prepared plan even if the recent estimate stays the same. Observation timestamps are excluded from the aggregate; a clock advance alone does not invalidate it.
- Older requests and plans remain readable. New generation from an outdated preparation requires free re-preparation.
- Database schema stays 4. No harness code, platform importer, stored submission, snapshot or retrospective was changed.

## Executed validation

- Type check passed.
- Focused ability/UI/storage/planning/model-adapter checks: **69 passed** before the additional service regression.
- Full npm run check: **824 functional tests + 9 construction-tool tests passed**, including the additional SQLite preparation/revalidation case, architecture checks, ESM/client build and client module/disposal checks.
- Regression cases cover a sufficient recent pool coexisting with older higher-difficulty evidence; latest-mode downgrades; future/foreign row exclusion; first-AC deduplication; custom window boundaries; period count conservation; no borrowing a historical score into an empty recent period; non-CF native scales; legacy preparation round-trip; and the model payload's history field.
- A local database backup preceded offline package installation. Installed **505 distribution files** matched the build; bootstrap returned 0.1.9 and schema 4.
- All existing database table row counts and canonical row hashes matched before/after upgrade, including old plan records. Model roles, quota settings and settings revision were unchanged.
- Read-only runtime checks confirmed the all-time/recent/earlier partition and sample-exclusion conservation on both existing acceptance accounts.
- Browser inspection confirmed three populated assessments, expandable earlier-period details and desktop card layout. Account data and screenshots are kept out of the public repository.

No paid construction worker, AI call or platform fetch ran in this iteration. Model payload and prompt behavior were tested with offline fixtures; no new claim about live model quality is made.

## Limits and references

These are practice-difficulty summaries, not calibrated ability scores. Selection of easier recent problems does not establish skill decline; historical achievements do not certify current competition performance. Records not imported, or lacking metadata or difficulty, remain explicit gaps. No retrospective still means unknown independence.

Existing CF native-rating and OI Wiki/Nowcoder reference attribution is retained; this period comparison is the project's own implementation. See [historical assessment behavior](../ability-history.md) and [third-party notices](../../THIRD_PARTY_NOTICES.md).
