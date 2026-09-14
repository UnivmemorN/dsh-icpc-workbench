# Stage 23b — per-problem and bulk completion editing UI

Implemented with DeepSeek Harness Flash (max), Sprint Contract `.local/contract-23b.md`. UI and docs
only; no backend change. The 23a API shapes in `docs/reports/stage-23a-completion-edit.md` matched
the implementation exactly, so no mismatch report was needed.

## Changed files

New:

- `src/ui/completion-view.ts` — pure rules: mode labels and the honest `未标注`; bounded page
  selection (100-key union with an explicit skipped count); draft/intent validation; preview
  freshness keyed to account + intent; apply fields bound to the previewed hash and intent; conflict
  detection; post-await cancellation guard; redaction-safe retrospective prefill; knowledge picker.
- `src/ui/CompletionEditor.tsx` — reusable editor for one captured scope (account + 1..100 keys):
  one batched `retro.list`, explicit mode (no default), optional manual knowledge union, preview
  table (before → after, existing/added knowledge, cleared solution references), apply with the
  captured hash, success/conflict notices.
- `tests/ui/completion-view.test.ts` — focused tests for the rules above (no DOM): 13 in the first
  pass, 15 after repair 1 (the conflict test now drives a real transport error, plus focused
  no-record revealed/hidden and partially-redacted prefill tests).
- `docs/completion-editing.md` — user/implementation documentation.

Edited:

- `src/ui/Bank.tsx` — `完成方式` column + per-row `修改` (unrecorded rows show `未标注`), one
  `retro.list` for the confirmed page only and none without account/rows, honest pending/error labels
  with retry, `选择本页` / `选择本页未标注` / `清空` / `批量修改完成方式` controls with the selected
  count, truncation notice instead of silent loss, editor rendered near the controls and scrolled
  into view, page + completion column + open detail refreshed after apply.
- `src/ui/Retrospective.tsx` — visible current-mode summary and `修改完成方式` entry (reuses the
  editor) above the advanced disclosure; advanced form prefilled from the latest record (mode,
  taxonomy ids, solution ids, note) and reset on problem/account/latest id/spoiler availability;
  withheld fields replaced by a reveal instruction instead of empty editable values; `independent`
  save disabled while solutions are checked; every save sends `expectedRetrospectiveId`; banners
  reset on edits.
- `src/ui/Problem.tsx` — wiring only: passes `onReveal` so the advanced form can reveal spoilers.
- `src/ui/Weakness.tsx`, `src/ui/Ability.tsx` — guidance notes (AC without a record = `未标注`,
  mode-only edits do not confirm tags or rewrite history) and a link to the bank.
- `src/ui/AiAssessment.tsx` — note that completion edits do not rewrite stored AI reports.
- `src/ui/MergedBank.tsx` — notice that bulk completion editing requires the single-platform bank and
  a selected account; no cross-site history writes are introduced.
- `src/ui/styles.ts` — styles for the editor, knowledge list, preview and retrospective summary. The
  existing style file is `src/ui/styles.ts` (there is no `styles.css`).

## Commands actually run

- `npm run typecheck` — first run failed with 2 errors in `src/ui/CompletionEditor.tsx`
  (`TS18047` possibly-null preview at the apply label; `TS2345` held preview lacked `hash`). Both
  were fixed by adding the hash to the held preview and narrowing the label input. Re-run: **passed**
  (also after the final lifecycle edits).
- `npm run check:architecture` — **passed** (`Architecture imports satisfy the declared layer
  boundaries.`).
- `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none "tests/ui/*.test.ts"`
  — **171 passed, 0 failed** (existing UI tests plus the 13 new completion-view tests).

Per the contract's "no full build/gate" rule, the full `npm test`, `npm run build` and browser tests
were not run. No new dependency was added.

## Behavior guarantees covered by tests

- missing record → `未标注`, never an implicit independent; the mode placeholder parses to `null`;
- draft validation (mode required; knowledge checked but empty refused);
- `preserve` is sent by omission, `add` only as a non-empty deduplicated list;
- a changed draft invalidates the preview and an old hash cannot be applied to a new intent;
- apply carries the previewed hash plus the intent captured at preview time;
- abort guard used before/after every awaited editor call;
- page selection union stays within 100 and reports skipped rows (no hidden loss);
- `选择本页未标注` uses only `mode === null` rows;
- preview totals (changed/no-op counts, cleared solution references, distinct added skills);
- compare-and-set conflict detection for re-preview;
- withheld spoiler fields vs a genuinely empty record in the advanced-form prefill;
- form reset key = problem + account + latest record id;
- knowledge picker excludes category nodes and matches name or id.

## Open issues / not claimed

- Browser and screenshot acceptance is coordinator-owned and was not run here; this report does not
  claim live verification.
- The advanced form's reveal button depends on the parent `ProblemView` passing `onReveal` (done for
  both bank and merged-bank details).
- After a successful apply the bank page, its completion column and the open problem detail are
  refreshed; bootstrap is deliberately not re-read because it carries no completion record.
- Merged-bank member details use the same `Retrospective`/editor path with the member's own account;
  no cross-site write was added.

## Repair 1 — reviewed UI integration issues (`.local/contract-23br1.md`)

Bounded repair of the completion UI only; no backend, package/version, worker, contract or runtime
data was touched.

- `src/ui/completion-view.ts`
  - `isCompletionConflict` now recognizes the real transport code `conflict` that
    `src/plugin/api-validation.ts` maps the domain's `invalid_transition` onto (the raw domain code
    is still accepted). An `ApiClientError` from `src/ui/api.ts` therefore really drops the stale
    preview and permits a re-preview, instead of silently keeping an unusable held preview.
  - `retrospectiveFormState`: a revealed no-record problem (`latestRetrospective === null` with
    `spoilersVisible === true`) now yields an editable empty form with `mode: null`; a hidden
    no-record problem stays behind the reveal notice. An existing record is `advancedKnown` only when
    spoilers are visible **and** all three own properties `taxonomyIds`/`solutionIds`/`note` are
    present, so a partially redacted record is never rendered as a half-editable draft with empty
    values that a save could write back.
  - `completionPreviewTotals` adds `addedSkillTotal` (sum of per-problem additions) beside the
    distinct union count `addedSkillCount`, so the preview states both honestly.
  - `pageSelectionNotice` no longer carries the implementation-flavoured `（没有静默丢弃）` aside; the
    exact skipped count is the message.
- `src/ui/CompletionEditor.tsx`: the preview skill line now reads
  `共同选择的知识点逐题补齐；已存在的不重复添加` and reports the distinct union count together with the
  total number of additions (the per-row table is unchanged); the overflow notice drops the false
  `（没有隐藏已选项）` claim (the filtered checkbox list does hide non-matching rows) and points at the
  separately displayed selected names instead.
- `src/ui/Retrospective.tsx`: the saved acknowledgement now survives the parent refresh that is still
  pending — it clears only when a different record actually arrives, on a scope change, or on a draft
  edit. The save sends the captured `form.retrospectiveId` as `expectedRetrospectiveId` instead of the
  `latestId` prop that can advance before the form resets. The internal retrospective id is no longer
  displayed (a plain-Chinese latest-record check replaces it). A full-form conflict renders an
  explicit `重新载入最新记录（放弃当前草稿）` button that discards the draft and asks the parent
  (`onChange`) to re-read, so nothing is overwritten silently. The quick editor key stays
  `problemKey|accountId`.
- `src/ui/Bank.tsx`: the detail `onChange` now refreshes both `problem.browse` and the batched
  `retro.list`; identical page keys keep the `retro.list` request string unchanged, so without the
  explicit refresh the completion column stayed stale after a full-form or quick-editor save. The
  detail key is deliberately untouched, so the form that saved stays mounted and its own
  acknowledgement remains visible.

### Checks actually run (repair pass)

- `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none "tests/ui/completion-view.test.ts"`
  — **15 passed, 0 failed**.
- `npm run typecheck` — **passed**.
- `npm run check:architecture` — **passed**
  (`Architecture imports satisfy the declared layer boundaries.`).

Full suite, build and browser acceptance remain coordinator work, per the contract.
