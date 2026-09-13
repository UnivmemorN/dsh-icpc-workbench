# Sprint 11b — completeness review and rerunnable analysis

The editorial analysis now always receives an independent verification pass, including when the first pass proposed no tags. The new verification prompt requires `missingSuggestions`: existing claims are checked for errors and the editorial is independently searched for omissions. Discovered omissions use the same local evidence and taxonomy validation but remain pending human review, because the proposing pass cannot independently verify itself.

A successful two-pass run records `completeness-v1` for the exact snapshot and taxonomy. This records that the workflow ran, not that every possible method has been proven complete. Reasoning-only, failed, cancelled and historical unmarked results remain unchecked. Optional metadata is omitted from historical hashes and serialized bodies, preserving their identity.

Default preparation checks all successful run identities for a current check. Already-tagged and legacy unchecked problems remain eligible. Explicit reanalysis of completed, cancelled or failed work creates a new identity; the previous job, results, decisions and usage remain intact. Active work on the same snapshot blocks concurrent preparation. A missing material snapshot produces an explicit per-problem blocked entry and a refresh action, while other selected problems can proceed.

A completed check appends a pending decision for an old automatic tag it no longer supports. Raw labels and manual decisions remain intact. New checked results use a logical creation timestamp strictly after earlier AI results/decisions when clock readings coincide; actual audit check times and job leases retain the real injected clock. This preserves the existing domain and SQL ordering rules and allows a subsequent supported check to re-adopt the tag. Global manual tie precedence is unchanged.

The detail projection compares the current snapshot, audit version and reader taxonomy. A taxonomy change with unchanged material therefore shows the previous check as outdated. The constructor also rejects completeness metadata naming a different taxonomy from its analysis.

## Validation performed

- Initial worker: typecheck, architecture check and the then-current full `npm test` suite: 718 passed.
- Repair review corrected repeated preparation after a legacy rerun, timestamp ordering, and taxonomy projection.
- Final coordinator verification: 51 pipeline and workbench completeness tests passed, with no failures or skips; typecheck passed.
- Coverage includes empty-first-pass omission discovery, invalid evidence, current-check skipping across reruns, immutable old jobs and counters, failed-job explicit reanalysis, cancellation/unknown usage, manual precedence, fixed-clock withdrawal/re-adoption, SQLite reopen and changed-taxonomy detail projection.
- Full package and browser acceptance belongs to the combined Stage 11 acceptance report.

Changes span domain analysis/eligibility, the application pipeline and projections, strict dsh prompts/output parsing, model API/controller preparation, optional SQLite analysis-body serialization, and Review/Problem UI. No schema migration is needed for this part. Shared taxonomy definitions and material snapshots are unchanged.

The material-blocked list is intentionally explicit: no editorial absence or material snapshot is fabricated, and no model is called for missing material. The UI provides a link to open the affected problem and refresh its material. Viewing and preparation remain free; paid dispatch still requires the start action.

No live model quality benchmark was run in this substage. Deterministic test gateways validate workflow behavior, not real-model precision or recall. See [feature behavior](../completeness-review.md) for the public workflow and the combined acceptance report for final installation and live checks.
