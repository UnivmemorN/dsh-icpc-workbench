# Stage 34B — Batch platform-material refresh UI

Sprint Contract: `.local/contract-34b-bulk-material-ui.md`, corrected on the same uncommitted tree by
`.local/contract-34b1-review-state-repair.md` and `.local/contract-34b2-recovery-scope-fix.md` (see the
34B1 and 34B2 sections below). Backend under test: the accepted
Stage 34A durable `material.*` batch (unchanged; no schema, adapter, import-service, AI-gateway, budget or
DSH change was needed, and none was made).

## What the browser can now do

A reusable panel (`src/ui/BulkMaterialRefresh.tsx`) exposes the durable Stage 34A batch from two entry
points without ever calling a model:

- **Problem bank** (`src/ui/Bank.tsx`): the shared top/bottom selection action bar gained
  `批量刷新平台材料（不调用 AI）`. It is enabled whenever the cross-page selection is non-empty, captures the
  selected canonical keys in their preserved order when opened, and prepares them with the current
  `accountId` (nullable → anonymous read) and `fetchStatement: true`. No cookie, statement body,
  editorial body or tutorial URL is requested or copied by this flow.
- **Tag review** (`src/ui/Review.tsx`): the blocked rows of the **currently selected** batch whose action
  is exactly `refresh_materials` are aggregated, deduped in first-seen order, and offered as one batch
  action. The free-preparation answer contributes only while its own `batchId` is the selected one and the
  stored detail only while it describes that same batch (see the 34B1 section below); a changed selection
  keeps none of the previous batch's rows. `supplement_editorial`/`supplement_statement` rows never enter a
  platform refresh. More than 100 unique keys are refused with an explicit sentence instead of being
  truncated.

Panel workflow and boundaries:

1. The boundary block is shown before any button: preparing is local/free, only start performs platform
   requests, and neither creates a model call, model attempt or DeepSeek quota use.
2. `免费准备刷新批次` calls `material.prepare` only; it starts nothing. `material.start` (labelled
   `开始平台刷新` for a first run, `继续平台刷新` after a run began) is the only action that performs
   platform IO. Only `prepared`/`paused` batches with `pending > 0` offer it.
3. `material.detail` is polled only while status is `running`, through `usePollAfterSettle`, so reads
   never overlap; every other state stops polling.
4. Deterministic counters (`共/待刷新/刷新中/已完成/需处理/已取消/快照变更`) and an item table in stored
   order; the external-key suffix is displayed while canonical keys are retained for calls.
5. `取消批次` is offered only while unfinished items remain and states that completed siblings are kept.
   `仅重试失败/已取消项` calls `material.retryFailed`, states completed items are retained, and still
   requires a separate start click. A cancelled batch is recoverable exactly this way.
6. `material.list` shows recent durable batches (time + status + size + completed/attention counts) and
   one can be reopened after reload; a stored/recovered paused batch is stated as not auto-running.
7. Close hides the panel only; durable work continues and can be recovered from the list.
8. Mutations are serialized by `useAction`; unmount aborts only the HTTP request and never pretends
   acknowledged durable work was cancelled.

Failure handling: all ten stable codes have a Chinese primary explanation; the raw code lives in a
per-row collapsible `诊断信息`. No failure text claims an absence — the shared disclaimer says a failure
only means *this read* did not complete, while a confirmed completed `editorial: 'absent'` renders as
`已确认无题解（成功观测）` and stays distinguishable from an operational failure.

Tag-review wording: after refresh the page (and the panel boundary note) shows
`平台材料刷新只更新题目材料快照；旧标签分析批次仍指向它当时捕获的不可变旧快照… 需要回到「免费准备批次」
重新准备一个批次，再明确点击开始付费分析；插件不会自动准备，也不会自动开始或恢复任何付费分析。`
No automatic paid action exists anywhere in this surface.

## Stage 34B1 — review-scope isolation and credential wording (corrective pass)

Three independently audited defects were fixed without redesigning the backend or the existing selection
model; the accepted panel workflow is unchanged.

1. **Blocked rows can no longer cross batches.** The aggregation no longer concatenates `prepared.blocked`
   with the stored detail by hand. `reviewMaterialScope` (pure, in `src/ui/review-view.ts`) returns the rows
   of the selected batch and of no other: the preparation's rows are used only while
   `prepared.batchId === batchId`, the stored rows only while `detail.batch.batchId === batchId`, and both
   are merged/de-duplicated in first-seen order only when they describe that one batch. Prepare A and then
   select B ⇒ B's rows only; select B while its detail is still loading ⇒ no rows at all (the loading
   sentence states this), so no A row stays displayed, retried or turned into a material batch under B's
   text. The preparation result table uses `preparedBlockedRows(prepared, batchId)` for the same reason and
   explains the hiding with `PREPARED_BLOCKED_ELSEWHERE_TEXT` instead of silently dropping rows.
2. **The reusable panel is pinned to one scope identity.** `materialScopeIdentity(analysisBatchId,
   problemKeys)` is a pure, length-prefixed identity over the analysis batch plus the canonical ordered
   refresh keys. `Review.tsx` stores the identity it opened and renders the panel only while it still
   matches, with `key={panelScope}`; a changed analysis batch or refresh-key scope therefore closes and
   resets the panel (a later open mounts a fresh instance), so its controls can never start/cancel/retry a
   material batch belonging to the prior analysis scope while the new scope's text is shown. `Bank.tsx`
   keeps its deliberately captured scope and keys the panel by the identity of that capture, so re-opening
   the action for a different selection also resets it.
3. **Cookie wording corrected.** `materialAccountText` no longer claims the plugin never saves any Cookie.
   It now states precisely: `按当前选择的账号读取。本材料批次记录不会复制、显示或单独保存 Cookie 值；平台
   读取可能使用账号连接流程已保存在 Windows 凭据管理器中的会话。` No credential value is echoed, and the
   sentence still never promises that a platform read is anonymous.

The no-AI/no-auto-paid-analysis boundary is unchanged and still asserted: preparing is local and free, only
the explicit start performs platform requests, and nothing in this surface can prepare, start or resume a
paid tag analysis (`OLD_ANALYSIS_BATCH_TEXT` still requires a new 免费准备批次 followed by an explicit start
click).

## Stage 34B2 — fully blocked preparation scope and durable history reachability (corrective pass)

The two final audited UI blockers were fixed without touching the backend, the schema, the lifecycle, the
account projection, the adapters, the AI gateway or any quota accounting; no route, record or wording
outside the UI helper/panel/bank files changed.

1. **A fully blocked free preparation now owns the empty selection.** `batch.prepare` legitimately answers
   `batchId: null`, `jobs: []` and a non-empty `blocked` list; the page already rendered
   `preparedBlockedRows(prepared, null)`, but the platform-refresh aggregation stayed empty, so the bulk
   panel could not be opened for exactly the problems that need it. `reviewMaterialScope`
   (`src/ui/review-view.ts`) no longer returns early for `selectedBatchId === null` and treats ownership as
   an equality test, so `prepared.batchId === selectedBatchId` — including `null === null` — is owned by the
   current Review selection, while a preparation that created batch `A` still owns neither the empty
   selection nor stored batch `B`. Only `refresh_materials` rows enter the aggregation;
   `supplement_editorial`/`supplement_statement` stay excluded. `loading` is now
   `selectedBatchId !== null && detailPending`, so the "reading the selected batch" sentence never appears
   over an empty selection, and a changed stored selection still contributes no row of the previous batch.
2. **Durable history is reachable after a reload.** `Bank.tsx` gained an always-enabled
   `刷新历史与恢复` opener beside `批量刷新平台材料（不调用 AI）`. It captures no scope and renders the reusable
   panel with `problemKeys={[]}`, so `material.prepare` is refused by the existing 1..100 gate while
   `material.list`, selecting a stored batch, `material.detail` and that batch's own state-valid
   `material.start`/`material.cancel`/`material.retryFailed` all stay available. Opening the panel, loading
   the list and selecting a batch issue reads only; the explicit start requirement and the
   "poll only while running" rule are unchanged, and a stored paused batch never resumes by itself. The two
   bank panels are mutually exclusive, so one panel's scope sentence is never rendered over another panel's
   batch.
3. **A historical batch is never mislabelled.** `materialBatchOrigin`/`materialScopeCopy` (pure, in
   `src/ui/material-batch-view.ts`) decide the scope block. With nothing selected — or with the batch this
   panel itself just prepared — the captured preparation-scope sentence and the current-account sentence are
   shown, plus `materialPreparedNowText`, which names that batch as the result of *this* free preparation
   rather than an arbitrary historical pick. With a stored batch selected both are replaced by
   `materialStoredBatchText`, which carries the batch's own durable identity (id, creation instant, status,
   size) and states that the current bank selection and the current account do not alter it. The historical
   account is neither claimed nor inferred: the sentence says the public projection does not provide it.
   Changing the select clears the previous batch's local mutation answer and any error before the new
   detail renders (`setLocal(null)`, `action.clear()` and the `localMaterialView` render guard), so no
   stale counter, control or scope text survives the switch.

## Files

- new `src/ui/material-batch-view.ts` — typed pure helpers/constants: status labels, ten failure
  explanations + disclaimer, editorial labels, boundary sentences, counters/progress, prepare/start/
  cancel/retry gates, polling predicate, `refresh_materials` aggregation with overflow refusal, bank
  prepare items (`order`, `accountId`, `fetchStatement: true`), display-key extraction, item/snapshot/
  statement text, batch-list/time labels, old-analysis-batch wording; 34B1 added the analysis-scope
  identity (`materialScopeIdentity`) and the corrected credential sentence; 34B2 added the history entry
  (`MATERIAL_HISTORY_ENTRY_LABEL`/`MATERIAL_HISTORY_TITLE`/`MATERIAL_HISTORY_SCOPE_NOTE`),
  `materialBatchOrigin`, `materialStoredBatchText`, `materialPreparedNowText`, `materialScopeCopy` and the
  `localMaterialView` selection guard.
- new `src/ui/BulkMaterialRefresh.tsx` — the reusable panel (four typed mutations + detail read +
  `material.list` read; no other operation is nameable from it).
- `src/ui/Bank.tsx` — selection-bar action + captured scope + identity-keyed panel render; 34B2 added the
  always-enabled `刷新历史与恢复` opener and the empty-scope history panel render.
- `src/ui/Review.tsx` — `refresh_materials` aggregation over the selected batch only, scope notice,
  old-batch sentence, identity-pinned panel.
- `src/ui/review-view.ts` (34B1) — `reviewMaterialScope`, `preparedBlockedRows`, `blockedProblemRows`,
  `REVIEW_SCOPE_LOADING_TEXT` and `PREPARED_BLOCKED_ELSEWHERE_TEXT`; `blockedRows` now delegates to
  `blockedProblemRows`; 34B2 made `reviewMaterialScope` own a `batchId: null` preparation for the empty
  selection (`null === null`) and tied `loading` to an actually selected batch.
- `src/ui/styles.ts` — restrained `.icpc-material-batch*` rules using existing variables only; narrow
  widths stack the picker/table. No existing selector was modified, so bank filters, completion editor,
  problem detail, review controls and merged-bank mode are untouched.
- `tests/ui/material-batch-view.test.ts` — 26 focused cases (34B2 added six: history entry with an empty
  scope, stored-vs-prepared classification, stored-batch copy, just-prepared copy, selection-change local
  clearing, and a source contract over the bank opener and the panel).
- `tests/ui/review-view.test.ts` — 18 cases, of which 4 are the 34B1 isolation cases and 2 are the 34B2
  all-blocked/null-batch cases: the pure `reviewMaterialScope`/`preparedBlockedRows` rules and a source
  contract over `Review.tsx`/`Bank.tsx`.
- This report; `.local/34b-worker-result.md`.

## Checks actually run

| Command | Result |
| --- | --- |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/ui/material-batch-view.test.ts tests/ui/review-view.test.ts` | 36 pass / 0 fail (34B1 re-run, includes the new isolation cases) |
| same runner with `tests/ui/material-view.test.ts tests/ui/completion-view.test.ts tests/ui/api.test.ts` | 73 pass / 0 fail |
| `npm run typecheck` | clean |
| `npm run check:architecture` | `Architecture imports satisfy the declared layer boundaries.` |
| `npm test` | 1637 tests: 1635 pass, 0 fail, 2 skipped |
| `npm run build` | ESM package + classic dsh browser factory (322 modules) built |
| `node scripts/check-client.mjs` | scoped math CSS, 20 font faces / 60 embedded assets, factory + disposal verified |

### Stage 34B2 checks (re-run on the same uncommitted tree)

| Command | Result |
| --- | --- |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/ui/material-batch-view.test.ts tests/ui/review-view.test.ts` | 44 pass / 0 fail (34B2 re-run; includes the 6 + 2 new cases) |
| same runner with `"tests/ui/*.test.ts"` | 297 pass / 0 fail |
| `npm run typecheck` | clean |
| `npm run check:architecture` | `Architecture imports satisfy the declared layer boundaries.` |
| `npm test` | 1652 tests: 1650 pass, 0 fail, 2 skipped |
| `npm run build` | ESM package + classic dsh browser factory (322 modules, 98 licensed packages) built |

Focused tests cover: all batch/item status labels; every failure code (distinct wording, no raw code in
the primary text, no absence claim); confirmed completed `absent` vs operational failure; item row facts;
counters; start/cancel/retry/poll gates across all five states plus the null state; prepare gate at
0/1/100/101 keys; `refresh_materials` filtering/order/dedupe/overflow; bank prepare inputs;
boundary/cancel/retry/close/paused wording; old-analysis-batch wording requiring a new free preparation
and denying automatic paid actions; a source-level check that the panel names only the six `material.*`
operations (no `batch.*`, `plan.ai`, `assessment.*`); batch list/time labels; display keys; newest-view
selection; and the six typed allowlisted transport endpoints.

One test expectation was corrected during execution (not the product): `material.retryFailed` is legal on
a cancelled batch in the accepted backend (it resets only cancelled items and still requires a separate
start), so the cancelled-state case now asserts exactly that instead of refusing retry.

34B1 focused coverage: `reviewMaterialScope` for matching/selected/loading/null/no-batch inputs (including
the same problem key carrying a different reason in another batch), first-seen de-duplication,
`preparedBlockedRows` visibility, the supplement-only refusal, and a source contract asserting that
`Review.tsx` derives its rows from the one helper, pins the panel with
`materialScopeIdentity(batchId, refreshScope.keys)`/`key={panelScope}`, and that `Bank.tsx` keys its captured
scope; the pure identity function (distinct analysis batches, orders, memberships and empty scopes are all
distinct, and length prefixes make the encoding collision-free); and the corrected credential wording (no
absolute "never saves a Cookie" claim, it names the account connection flow and Windows Credential Manager,
and echoes no credential).

34B2 focused coverage: a `batchId: null`/`jobs: []`/non-empty `blocked` preparation returning
`fromPrepared: true` over the empty selection, filling `refreshMaterialProblemKeys` with its
`refresh_materials` keys (and only those) while `preparedBlockedRows(prepared, null)` still lists them; the
same preparation contributing nothing to a selected stored batch, a `batchId: 'A'` preparation
contributing nothing to the empty selection, and a null-batch preparation never lending rows to a loading
selection; `materialBatchOrigin` classification (nothing selected / this panel's preparation / stored);
`materialScopeCopy` showing the captured scope and current account only for `none`/`prepared_now`, and the
stored-batch sentence — batch id, creation instant, status, size, "current selection and current account do
not alter it", "the projection does not provide the account" — with `scopeText`/`accountText` `null` for
`stored`; `materialPreparedNowText` naming a freshly prepared batch as this preparation's result rather
than a history pick; `localMaterialView`/`newestBatchView` dropping the previous batch's local answer after
a selection change; and a source contract that `Bank.tsx` renders an opener with no `disabled` gate that
passes `problemKeys={[]}`, and that the panel clears its local answer/error on selection change while its
prepare handler still refuses an empty scope before naming `material.prepare`.

## Live-acceptance handoff

At the end of the 34B implementation run, no live platform request or real credential had been used. The
coordinator subsequently completed the isolated packaged-runtime and browser checks in
[`stage-34c-bulk-material-acceptance.md`](./stage-34c-bulk-material-acceptance.md): explicit prepare/start,
real Codeforces `auth_required` handling, cancel-before-start and retry, reload recovery, stored-batch
provenance wording, the fully blocked Review entry, and unchanged AI/analysis tables all passed while the
existing 3081 backend remained untouched.

The live acceptance intentionally did not use a real account credential. A 100-item narrow-width visual
stress pass and the connected-Luogu variant of the account/Cookie sentence remain broader UX exercises;
the deterministic 100-item boundary, responsive styles and credential-redaction rules are covered by the
automated gate.
