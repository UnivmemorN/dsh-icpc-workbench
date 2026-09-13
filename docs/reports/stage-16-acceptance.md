# Stage 16 — Official competition scores and source-backed assessment

Experimental version **0.1.11**, verified locally on 2026-09-13 with Node **24.15.0** and dsh **0.1.5-rc.2**.

## Problem and resulting behavior

The selected practice cohort's median does not establish player ability. Reviewing the upstream workbench confirmed that its automatic method also uses a recent AC median with historical fallback. This change uses **CF official current rating** as the automatic score and separately shows the official maximum and rated-contest history. No formula is tuned to a desired personal range.

An existing user self-assessment remains an explicit per-account training override; withdrawal falls back to a loaded official rating. Unrated and unloaded remain distinct from genuine zero or negative official ratings. Older contest evidence is labelled, without inventing a rating decay. All-time, recent and earlier practice distributions retain their descriptive meaning, and platform difficulty scales remain separate.

## Implementation

- The Codeforces adapter adds an optional official-rating capability. Both public API requests use its existing HTTPS transport, cancellation and at-least-two-second pacing. Handle, payload, timestamp, uniqueness and profile/history consistency checks reject incomplete or mismatched results.
- Schema v6 adds only official_rating_snapshots. Successful fetches append account-scoped immutable revisions with a stale-write guard. Network IO runs outside the transaction; cancellation, failed refresh and racing results cannot overwrite the previous snapshot. Genuine v5 stores require their ownership marker and are backed up before migration.
- ability.syncRating accepts only accountId. The browser cannot supply a fabricated official score. ability.4 reports self-assessment, official competition evidence and practice evidence separately.
- New immutable plan preparations include a closed, identifier-free competition summary. An official reference must match that evidence. A rating refresh invalidates older preparations, including those retaining a self-report override. Old preparations remain readable without synthesizing missing fields.
- UI provides synchronization state/errors, current and maximum rating, contest dates/history with incremental older rows, and method/source links. Self-assessment inputs retain their own provenance and never relabel an official score as user input.

## Executed checks

- Focused regression suite: **178 passed**.
- Final **npm run check**: **841 functional tests + 9 construction-tool tests passed**, with type checks, architecture rules, independent ESM/classic browser builds and client disposal verification.
- Behavioral checks cover migration backups, foreign-marker refusal before writes, restart/CAS, signed scores, unrated/error distinction, account isolation, failed-refresh and cancellation preservation, shared pacing, easy-practice invariance, self-report priority/withdrawal, plan staleness and identifier rejection.
- Packaged isolated runtime returned 0.1.11/schema 6, with **521 distribution files** matching the local build. Existing settings, quotas and Flash-only model policy were preserved; Pro remained refused without a settings write.
- Live browser synchronization matched the official account rating and complete returned contest history, while preserving the saved self-assessment. The history expansion loaded older rows correctly. The practice median remained descriptive and unchanged.
- All pre-existing database rows retained their hashes. Acceptance intentionally added one official snapshot and one free plan preparation. The preparation included the official aggregate and existing self-report, was cancelled, and had no host/model dispatch identifiers. No old submission, retrospective, problem, calibration or plan was modified.

Local acceptance scripts and private account data remain in the ignored .local directory. No paid construction worker or AI generation ran. Official API fetches were live; model prompt/payload behavior was checked offline and through free preparation, not a paid generation.

## Sources and limits

See [score sources and rules](../ability-scoring.md) and [third-party notices](../../THIRD_PARTY_NOTICES.md). The upstream MIT project informed evidence/override presentation, not an adopted ability formula. Official CF API fields and its problem-rating explanation determine the meaning of displayed scores. AtCoder AHC v2 was reviewed but not transplanted to practice AC records. No upstream code, article bodies or formula images were copied.

Current CF rating is a competition-performance indicator, not a complete assessment of every skill. Historical maximum is not current ability. There is no calibrated free-practice-to-CF estimator or Luogu/Nowcoder rating conversion in this change; a competitor without official CF rating can still use explicit self-assessment and diagnostic training.
