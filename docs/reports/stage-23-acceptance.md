# Stage 23 — completion editing acceptance

Release **0.1.18** adds per-problem and selected-batch completion editing. Schema remains **8**; the plugin and Harness workspaces remain separate. Implementation used DeepSeek Harness Flash max, with coordinator review, integration and release checks. Existing third-party attribution and licenses remain intact.

## Delivered behavior

- The bank shows the latest completion mode for each visible problem, with row editing and explicit current-page/current-page-unrecorded selection. Selections span pages, capped at 100 keys per batch.
- A preview binds the exact account, problem keys, modes and optional manual skill union to the current records. Stale previews or full-form records are rejected. Missing or foreign problems and cancellation roll the entire batch back. Unchanged items append no duplicate history.
- Mode-only edits retain notes and confirmed skills. Explicit independent edits announce how many consulted-solution references will be cleared. Optional knowledge addition unions only the skills the user chose for each selected problem. AC submissions are untouched.
- Existing retrospective fields are prefilled; omitted spoiler fields cannot become empty editable values. A first record keeps an explicit unselected mode. Conflicts provide re-preview or explicit full-form reload.
- Knowledge and rule-based ability read the latest record. Stored AI reports retain their original evidence; users must explicitly prepare/generate a new report. These edits and local statistics make no AI calls.

## Executed checks

- `npm run check`: passed, including typecheck, architecture, **1200 passed / 0 failed / 1 environment skip** across 1201 tests; **10 worker/context/budget tests passed**; independent ESM build and classic shared-React client/disposal checks passed.
- The environment skip is the unsupported-OS credential-vault refusal case on a Windows host that has that vault; it is covered by the non-Windows CI leg.
- Backend focused checks: 12 passed. Plugin integration checks: 169 passed. UI review checks and fixes are recorded in [stage 23b](stage-23b-completion-ui.md).
- Packaged installation on dsh **0.1.5-rc.2**: a fresh offline SQLite backup was verified, every database table and every plugin setting matched after installation, schema remained 8 and all model roles remained Flash. Companion plugins were retained.
- All **709 dist files** matched the installed plugin byte-for-byte. Client SHA-256: `afdd5c3b93edc7289e9da6e30b6790b759f7490e7d703d442b7829e864c52ba8`.

## Live browser and persisted-statistics acceptance

The live local workbench used only a clearly labelled synthetic account for writes:

1. An existing retrospective prefilled its assisted mode, binary-search skill and note. Saving it as independent updated the visible bank row and retained its save acknowledgement.
2. A problem without a record opened on the explicit placeholder. Its preview showed unrecorded → solution-used; changing the draft invalidated that preview and disabled apply.
3. Filtering to accepted problems and selecting current-page unrecorded selected just the missing record. Selecting the page then produced the exact two-problem batch.
4. The batch preview independently showed the existing skill count and the new stack skill on each row. Applying changed both problems to assisted and refreshed the bank.
5. The ability page showed independent 0 / assisted 2 / solution-used 0 / unknown 0. The stack knowledge row showed assisted 2, while the existing binary-search evidence remained assisted 1. Persisted API assertions confirmed the latest modes, old notes and old skill preservation.
6. A before/after hash proved that all other accounts' retrospective rows were unchanged. No AI assessment was generated, and no real-user completion mode was assigned by the coordinator.

The public CI workflow checks Windows and Ubuntu on Node 22 and 24: [CI workflow](https://github.com/UnivmemorN/dsh-icpc-workbench/actions/workflows/ci.yml). The exact publication run is checked after pushing.

## Boundaries

Completion modes are self-reported evidence. Mode-only edits do not assert mastery of all platform/AI tags, and optional skill union means the user confirms those skills were used on every selected problem. Cross-site mirrors retain their native account histories; bulk edits happen in the single-platform bank. Editing does not rewrite earlier AI reports or claim a new contest rating.
