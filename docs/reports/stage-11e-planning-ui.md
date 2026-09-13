# Sprint 11e — default AI planning UI and ability presentation

This is the historical substage report. The completed host/UI integration and coordinator fixes are recorded in [Stage 11 acceptance](stage-11-acceptance.md).

Implement the approved user-facing behaviour on top of the accepted typed Stage 11d operations
(`plan.aiPrepare` / `plan.aiRun` / `plan.aiStatus` / `plan.aiCancel` / `plan.aiHistory`). No backend
reimplementation, no new dependency, no paid runtime call, no browser QA claimed by the worker.

## Delivered

- **训练计划 defaults to AI mode.** The mode switch is explicit (`AI 计划（免费准备，显式付费生成）`
  / `免费规则计划`). The rule mode keeps the legacy `plan.preview` flow: custom title, old bounds
  (days 1–30, minutes 1–1440, estimate ≤ the day), draft/adopt/edit/checkoff and the saved-plan list.
- **Free preparation first.** `免费准备` generates a UUID request id, sends the real parameters
  (`settings` with days/minutes/estimate/max tasks, explicit candidate scope, reveal) and records the
  returned preparation view. No model call happens on mount, on mode/view switching, on preparation,
  on history loading or on polling.
- **One explicit paid generation.** `生成 AI 计划（调用模型）` is the only paid trigger. It sends the
  settings revision the **preparation captured** (`view.settingsRevision`), never a value guessed
  from the bootstrap record; a preparation without a captured revision explains that settings must be
  saved and the plan re-prepared. The panel states one generation = one model call and that token cost
  depends on the output length.
- **Candidate scope is explicit and honest.** `已勾选题目` sends exactly the selected keys in the
  selected order, including an explicit empty list as `[]` (never an omitted member that the service
  would read as the automatic pool) with a sufficient `candidateLimit` of 100; more than 100 selected
  problems disable preparation with a "reduce the selection, it is never truncated" label. With no
  selection the visible default is `当前账号未通过题库（最多 100）`, described as the account's own
  bounded pool — never a cross-account or site-wide search.
- **Preparation preview discloses the real input.** Candidate list (title, key, link, estimated
  minutes, native ratings, and — only with the explicit reveal switch — effective tags plus raw
  platform labels marked provisional), actual exclusion counts (own solved / duplicates / foreign /
  considered), applied cap, provider, model, `max` effort, output cap, rolling-24h cap, concurrency,
  timeout and the fixed disclosure text. The compact identifier-free ability aggregate (baseline,
  quartile band, sample and tier, confidence, native medians on non-Codeforces platforms) is shown
  next to a navigation button to the full 能力评估.
- **Stale answers cannot be adopted.** An input signature (account, stored settings revision, scope,
  selection, schedule, reveal) invalidates the visible preparation immediately, and a late
  `plan.aiPrepare` answer of an older signature is discarded. Toggling the reveal switch clears the
  cached preparation synchronously, so hidden raw labels can never be re-rendered from an old object.
- **Pending, results and history.** `plan.aiStatus` is polled only while this instance owns a running
  operation or the attempt is durably `reserved` — an acknowledgement that arrives before the
  reservation keeps polling alive through the owned flag, and a terminal attempt stops polling and is
  never re-dispatched. A settled plan is selected in the existing plan list and the detail refreshes.
  `plan.aiHistory` (newest first, 20 rows here) lets a refreshed browser recover recent attempts;
  history is metadata only, so a historical preparation can only be cancelled or re-prepared for free,
  never resumed for pay. `查看结果` selects a stored plan; `查看状态` re-attaches to a pending one.
- **Cancellation is explicit and honest.** Cancel is offered for prepared/reserved/owned-running
  attempts; the label is `免费` only for a preparation. A pending cancel states that the real cost is
  whatever the settlement records; a paid settlement is never presented as refunded.
- **Stable Chinese failure copy.** Quota, settings changed, model changed, stale preparation, invalid
  output, provider error, timeout, rate limit, cancellation and uncertain outcomes have dedicated
  messages; a known paid failure keeps its retained cost visible and an unknown cost is never shown as
  zero. Poll errors stay visible and wait for the manual refresh button; there is no automatic paid
  retry. Legacy saved plans stay reachable in both modes regardless of AI errors.
- **Ability presentation.** The page-level summary prints `训练 N 左右` or — for a non-Codeforces
  platform with real native values — `原生刻度评估（CF 估计不适用）` instead of `数据不足`; the
  headline says the CF estimate does not apply, the method/limitation list is collapsed into an
  expandable details block (missing-data coverage stays visible), and the old "训练计划仍只使用已复核
  标签" sentence is replaced by the actual behaviour: plans consume the aggregate statistics and the real
  candidates, while the model summary carries no account identifier, submission row or retrospective
  note.
- **Copy updates.** Settings labels `coaching.maxCallsPer24Hours` as `提示与计划各自的 24 小时调用上限`
  and explains that the counters are independent while sharing one limit value. The weakness platform
  reference now says raw labels never become formal tags but may travel as provisional candidate
  labels behind the reveal switch. README, `docs/ai-training-plans.md` and
  `docs/knowledge-learning.md` describe the shipped behaviour (default 能力评估 tab, default AI plan
  mode, provisional raw labels, no OI Wiki browsing/reading tasks).

## Changed files

- `src/ui/planning-view.ts` (new): pure mode/bounds/scope/signature/poll/formatting/error helpers.
- `src/ui/Plans.tsx`: AI default flow, free rule mode, shared saved-plan panel.
- `src/ui/common.tsx`: `usePollAfterSettle` (never overlaps itself, starts no work by itself).
- `src/ui/ability-view.ts`, `src/ui/Ability.tsx`: native-scale-only labels, expandable limitations,
  plan-consumption copy.
- `src/ui/Settings.tsx`, `src/ui/Weakness.tsx`: quota label/explanation, provisional raw-tag copy.
- `src/ui/styles.ts`: planning panel/table styles.
- `tests/ui/planning.test.ts` (new), `tests/ui/ability.test.ts` (one added case).
- `README.md`, `docs/ai-training-plans.md`, `docs/knowledge-learning.md`, this report.

No `src/application`, `src/domain`, `src/adapters` or `src/plugin` file was changed; `package.json`,
version and file lists are untouched.

## Commands actually run

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass (no diagnostics) |
| `npm run check:architecture` | `Architecture imports satisfy the declared layer boundaries.` |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/ui/planning.test.ts tests/ui/ability.test.ts` | 15 tests, 15 pass, 0 fail |
| `npm run check` (final, frozen tree) | exit 0: typecheck pass; architecture pass; `tests 793 / pass 793 / fail 0`; script tests `tests 9 / pass 9 / fail 0`; `Built independent ESM package in dist.`; `Built classic dsh browser factory with shared React.`; `Classic client factory, shared modules and disposal verified.` |

The focused suite pins the externally meaningful rules: default AI mode, approved AI bounds versus
the legacy rule bounds, `[]`-stays-`[]` scope payloads and the over-limit refusal, signature
invalidation of a late answer, owned/reserved polling with terminal stop, account-scoped tracking,
known versus unknown cost, the stable error copy, and the non-CF native-scale label.

## Known limits and open items

- No live/browser verification was performed by the worker (per contract): the coordinator owns the
  installed browser pass and any real model call. No paid call was made while implementing.
- The form disables `免费准备` for an explicit empty selection with an explanatory label instead of
  sending it; the request builder itself still preserves `[]` as `[]`, which is pinned by test.
- AI plans are unverified model output; adoption stays manual and the plan detail marks a
  `source: 'model'` plan as such. Candidate raw labels remain provisional and never become accepted
  tags.
- History shows the latest 20 attempts (service bound 50); a historical `prepared` attempt has no
  restorable parameter preview and can only be cancelled or re-prepared for free.
- No OI Wiki browsing or Wiki reading tasks are generated; the ability heuristic still does not load
  the official account rating.
- `dist/` is a local build artifact produced by the verification command.
