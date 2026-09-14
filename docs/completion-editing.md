# 修改完成方式

1. 选择当前账号，进入「题库 → 分平台题库」。可先筛选「已通过」，将每页数量调到 100。
2. 单题点击该行的「修改」；批量勾选题目，或用「选择本页」「选择本页未标注」，再点「批量修改完成方式」。选择可以跨页保留，每批最多 100 题。
3. 选择「独立完成」「使用提示完成」或「参考题解完成」，点击「预览修改」，核对逐题变化后保存。

默认保留已有备注、已确认知识点及参考题解引用。改成「独立完成」时，会在预览中明确列出将清除的参考题解引用数量。完成方式不会改变平台 AC 记录。

如果所选题目确实都用了相同知识点，可以勾选「同时补充实际使用的知识点」并手动选择；已有知识点不重复添加。只改完成方式不会把题目的全部标签计为已掌握。需要逐题调整知识点、备注时，在题目详情展开完整复盘表单，原值会自动填入。

修改后，本地知识点统计和规则能力评估读取最新记录。历史 AI 报告保留生成时的结果，需要主动重新准备、生成评估。编辑完成方式与查看本地统计不调用 AI。

没有完成方式记录的题目显示「未标注」，独立性保持未知。合并题库中的镜像题仍属于各自平台账号，批量编辑在分平台题库进行。

---
# Completion editing (Stage 23b)

How the plugin records and corrects **完成方式** (completion mode) — per problem and in bulk — and
what the UI deliberately does not do.

## Where a completion record can be edited

| Entry | File | Scope |
| --- | --- | --- |
| Bank table, one row: `修改` | `src/ui/Bank.tsx` | the one problem |
| Bank selection: `批量修改完成方式` | `src/ui/Bank.tsx` | the captured selection, 1..100 stored keys |
| Problem detail: `修改完成方式` | `src/ui/Retrospective.tsx` | the one open problem |
| Advanced form (skills, consulted solutions, note) | `src/ui/Retrospective.tsx` | the one open problem |

All four use the same reusable editor (`src/ui/CompletionEditor.tsx`) except the advanced form, which
is the full per-problem record form. The pure display/intent rules live in
`src/ui/completion-view.ts` and are covered by `tests/ui/completion-view.test.ts`.

## Exact scope of a bulk edit

- The bank reads completion modes for **the current page only**, with **one** batched
  `retro.list` call (`problemKeys` = the keys of the confirmed `problem.browse` page). There is never
  one detail request per row. Without a selected account, or without rows, no request is sent.
- `选择本页` / `选择本页未标注` union that page into the existing selection. The union is bounded at
  **100 keys** (the same bound `retro.list` / `retro.editPreview` / `retro.editApply` accept). If the
  bound is already full, the UI adds nothing further and states exactly how many visible rows did not
  fit — nothing is dropped silently. `选择本页未标注` only offers rows whose latest record is `null`,
  read from the same confirmed batch (never from platform data or an AC verdict).
- The editor captures its account and keys when it opens (`key` on the component). An account switch
  remounts the page and therefore closes it; a change of the selection closes an editor that was
  opened from that selection. Either way the in-flight HTTP request is aborted and the preview is
  dropped. `已选择 N / 100` and `本页` labels state the scope honestly; no filter pretends to cover
  pages the UI has not read.
- A bulk edit never writes to another account, another source instance, or a mirrored counterpart in
  the merged bank. The merged bank shows a notice pointing back to the single-platform bank.

## Preview before apply

`预览修改` calls `retro.editPreview` with the exact normalized intent and shows:

- the account scope and the number of problems in the batch;
- one row per problem: title, previous mode → next mode, existing knowledge counts, the knowledge
  points this edit would add, and how many consulted-solution references an `independent` edit would
  clear;
- changed / unchanged counts, and the apply button label `修改 N 题` (or `无变化`, disabled).

Changing the mode or the checked knowledge list changes the intent key, so the preview is shown as
invalid and cannot be applied; `retro.editApply` is only ever sent with the hash **and the intent
captured by that preview**, never with a newer draft. A transport `conflict` (domain `invalid_transition`) (someone
appended a record after the preview) drops the stale preview, keeps the draft and selection, and
asks for a re-preview. After every `await` the editor checks the abort signal, so a cancelled or
unmounted request can never set state.

## What an edit preserves

`retro.editApply` appends the *latest corrected* record:

- **notes are preserved**; `retro.list` / `retro.editPreview` never carry a note, so the bulk path
  cannot overwrite one;
- **previously confirmed knowledge is preserved**: checking `同时补充实际使用的知识点` is an explicit
  manual union of the chosen, non-category taxonomy ids onto every selected problem. It is the only
  knowledge input — no platform raw tag, no AI suggestion and no inferred AC label is used;
- the knowledge list is submitted only when the checkbox is on **and** at least one point is chosen;
  an unchecked box is sent as `{kind:'preserve'}` by omission, never as an empty `add`;
- an `independent` mode edit clears only the consulted solution references, and the preview lists the
  per-problem count first. The advanced per-problem form refuses that save while solutions are still
  checked, and explains the alternative.

## What is never touched

- **AC / solved state** is not modified by any completion edit; a stored AC without a record keeps
  displaying `未标注`, which means independence is *unknown*, not independent.
- No platform request, no model call and no paid request happens in this flow; only the local
  `retro.*` operations are used.
- Historical AI reports are frozen: the success notice says local knowledge statistics and the rule
  ability assessment use the latest record, while historical AI reports keep the result of the run
  that produced them. Refreshing one still requires the explicit prepare + generate actions on the
  assessment page.
- Editing a completion mode does **not** confirm the problem's tags.

## Redaction rules in the problem detail

`WorkbenchRetrospectiveView` withholds `taxonomyIds`, `solutionIds` and `note` while spoilers are
hidden (absent own properties, not `null`). `retrospectiveFormState` therefore reports
`advancedKnown: false` for withheld fields and never turns them into empty editable values; the full
form is replaced by a reveal instruction, while the mode-only editor keeps working (it preserves what
it cannot see). Once the fields are really present — including genuinely empty ones — the form
prefills mode, taxonomy ids, solution ids and note and can save them.

Saving the advanced form always sends `expectedRetrospectiveId` (the id the form was prefilled from,
or `null` when no record existed). A record appended while the form was open is refused with a
conflict message instead of being overwritten.

## Related UI notes

- Weakness (`src/ui/Weakness.tsx`) and Ability (`src/ui/Ability.tsx`) explain that an AC without a
  record counts as `未标注` (unknown independence) and link to the bank; changing a mode does not
  confirm tags and does not rewrite AI history.
- The AI assessment page (`src/ui/AiAssessment.tsx`) repeats that completion edits do not rewrite
  stored reports.
