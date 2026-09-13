# Stage 11 acceptance — 0.1.6

Accepted locally on 2026-09-13 against dsh 0.1.5-rc.2. This version adds versioned tag-completeness review and immutable reruns, local ability assessment, and AI-first training plans through dsh's audited model service. Free rule plans remain available. This is the integrated result; the 11a–11e reports describe their individual construction contracts.

## Delivered behaviour

- A raw platform tag, or an old successful analysis, does not prove completeness. Every problem without the current completeness record can be prepared, including already-tagged problems. Missing material is shown as a blocked item with a repair action; it is never treated as evidence that no editorial exists. The verifier checks proposed tags and independently scans the editorial for omissions, even when the first pass proposed nothing. Its own new suggestions require manual review. Explicit reanalysis creates new immutable records and retains manual decisions and raw labels; unsupported old automatic adoptions stop counting through an appended review decision.
- Ability assessment is the default view inside 薄弱项. It uses distinct problems, first AC time, native difficulty and the latest retrospective, scoped to one account and source instance. Known assisted/solution-based completions are excluded from the CF difficulty estimate. The current 90-day pool is preferred; historical fallback is explicitly stale. At least five usable samples are needed. Baseline, practice/stretch bands, quartiles, confidence and missing evidence are shown. This is an uncalibrated training-difficulty heuristic, not an official account rating or a probability of mastery. Other platforms retain their native scales.
- Training plans open in AI mode. Free preparation persists the exact candidate pool, settings revision and aggregate evidence; an explicit generate action makes one paid dsh call using the configured analysis model (default DeepSeek official Flash, max). Selected candidates remain exact, native ACs are excluded, and automatic selection is bounded to 100 problems in the current account's source. The model receives identifier-free ability/weakness aggregates and public candidate metadata; no account identifiers, submission rows, retrospective notes, statements or editorials. Results must name real candidate IDs and obey the requested scheduling bounds. Saved evidence reflects the actual prepared aggregate.
- Planning reserves before dispatch, validates freshness before dispatch and after the answer, retains known usage on cancellation/failure and retains unknown outcomes as uncertain without automatic retry. A host-owned call survives an HTTP client disconnect. History/status recover on browser refresh and host restart. Expired unowned reservations recover as uncertain; live owned operations settle themselves. Planning and coaching have separate rolling 24-hour counters with a shared configured limit value. Concurrency is scoped to the plugin instance plus its durable reservations; this is not a cross-process global mutex.
- Unsolved-plan titles and task tag projections stay spoiler-safe by default; explicit reveal restores the stored title without changing its hash. Changing account, scope, schedule, settings or reveal invalidates the preparation. Rule-plan adoption, editing and check-off remain available; check-off does not claim an OJ AC.

## Checks actually run

| Check | Result |
| --- | --- |
| Coordinator npm run check | 793 functional tests and 9 worker/accounting tests passed; zero failures/skips. Type checking, architecture checks, independent ESM build, classic browser factory/shared React and disposal checks passed. |
| Backend regressions after final title/evidence fixes | 122 workbench, planning and plugin-planning tests passed; typecheck, build and client check passed. |
| UI regressions after final readability polish | 69 UI tests passed; typecheck, build and client check passed. |
| Isolated schema upgrade | Schema 3 to 4, automatic backup, integrity_check ok. All 19 pre-existing tables preserved their row counts and canonical-content hashes before acceptance mutations; formal weakness results, coverage and raw-tag provenance were unchanged. The additive plan-attempt table is the twentieth table. |
| Installed artifact identity | Version 0.1.6; all 481 installed dist files matched the current build by SHA-256. Package whitelist excludes local state, credentials, databases, logs and downloaded materials. Harness checkout stayed unchanged. |
| Restart recovery | Settled plan and one-call usage remained recoverable with no owned in-memory operation. Default/revealed/list title projections retained the original stored hash; history retained the settled result. |

CI runs the same repository checks and package dry-run on Ubuntu and Windows with Node 22 and 24. The GitHub check attached to each commit is the authoritative result for that commit.

## Real model acceptance

All four calls used the installed authenticated plugin APIs and the existing audited dsh client, DeepSeek official Flash at max, within the previously approved acceptance scope and budget. Only the labelled synthetic training account and the previously approved frozen public CF 580C editorial were used. Private account rows and notes were not sent to the model.

| Run | Calls | Input / output tokens | Observed result |
| --- | --- | --- | --- |
| Initial synthetic AI plan | 1 | 1,939 / 2,020 | Five real candidate tasks, native AC exclusion, immutable result, idempotent replay, history and spoiler projections passed. Browser inspection found the saved evidence summary still had a placeholder count; fixed below. |
| CF 580C analysis + independent verification | 2 | 10,228 / 1,652; 10,781 / 1,930 | New current completeness record; old analysis unchanged; a subsequent default preparation skipped the checked snapshot. Both attempts settled. |
| Synthetic plan after evidence fix | 1 | 1,939 / 2,037 | Five tasks saved; the stored and visible six-problem evidence count matched the model's prepared input. Replay did not call again. The original plan remained immutable. |

The conservative accounting for these four runtime calls was CNY 0.110886, not a provider billing statement. No unknown runtime-call usage remained. Construction accounting and earlier unsettled reserves remain separate in the private local ledger.

The actual 580C verifier proposed zero additional omissions. Deterministic tests exercise omission discovery and manual-review routing; this single live run does not establish improved precision or recall. The older 30-problem quality evaluation in [Stage 05](stage-05-acceptance.md) was not rerun and remains historical evidence for its earlier implementation.

## Browser acceptance

The actual installed workbench was reloaded and inspected in the in-app browser. Verified AI as the initial plan mode; bounded default form; free preparation, candidate exclusions and model/disclosure preview; removal of the paid action after a schedule change; the free-rule switch; persisted request history and saved-plan detail after reload; correct final evidence count and generic spoiler-safe AI title; default ability view for both a real local CF account and the explicitly synthetic account; compact ability cards and confidence labels in the real viewport; and the visible reanalysis checkbox and current completed analysis batch.

Real model dispatch was exercised through the authenticated business API, while browser interaction exercised the preparation/result views. No personal plan was submitted to the model during this acceptance, and no OJ submission was made. Browser screenshots, detailed account aggregates, server logs, database backups and model materials remain local and are not included in the public package.

## Limits and attribution

Official CF account rating/history is not fetched yet. The heuristic uses imported problem difficulties and retrospective evidence, has not been empirically calibrated and may be biased by incomplete imports or unknown assistance. Missing evidence stays unknown. [CF User](https://codeforces.com/apiHelp/objects#User), [Problem](https://codeforces.com/apiHelp/objects#Problem) and [RatingChange](https://codeforces.com/apiHelp/objects#RatingChange) are distinct API objects; a problem-difficulty estimate is not a replacement for contest rating.

OI Wiki remains a cited learning-link/definition reference; this release does not retrieve Wiki articles or generate Wiki reading tasks. Cross-platform label mapping retains its existing provenance, ambiguity rules and independent version. Nowcoder import and HydroOJ student-record integration remain future work. Platform raw tags stay provisional even when provided as bounded candidate hints to the planner. AI review records completion of a workflow, not a guarantee that every valid solution method has been found.

The original [icpc-workbench](https://github.com/ZF3373/icpc-workbench) inspiration and MIT notice, [NovaPhy](https://github.com/UnivmemorN/NovaPhy) architecture reference, [Nowcoder skill map](https://ac.nowcoder.com/acm/skill/acm) and [OI Wiki](https://oi-wiki.org/) references remain documented in [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md). No third-party article body, editorial body or account data was added to source control.
