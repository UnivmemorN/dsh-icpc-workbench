# Stage 17d2 — Luogu account connection and sync UI

Status: **complete for the assigned slice**. Parent scope: `.local/contract-17d2-luogu-ui.md`
(dispatch after 17d1). Contract `.local/contract-17d-luogu-ui.md` supplies the requirements. This
invocation touched only the browser half and documentation: no backend, host, schema, credential,
version, package, model, network or Git action was taken.

## Visible UI entry and exact operation names (acceptance handoff)

- Visible path: **题库 → 分平台题库（来源：洛谷）→ 导入与同步 → 「洛谷账号连接与同步」**.
  The section is a collapsible block with that exact heading inside the existing `导入与同步` panel,
  and it opens itself when the selected account is a Luogu account.
- Controls (Chinese, all labelled): `连接`, `检查登录`, `断开连接`,
  `开始 / 继续同步`, `全历史完整核对`（需勾选确认）, `暂停本轮`,
  `保存自动同步设置`（开关 + 启动时同步一次 + 间隔 5–1440 分钟）.
- Exact operations used by the panel, all already registered by 17d1 and all already in the UI
  allowlist:
  `luogu.status`, `luogu.connect`, `luogu.probe`, `luogu.disconnect`, `luogu.configure`,
  `luogu.start` (`mode: 'resume' | 'full'`), `luogu.cancel`.
- Coordinator acceptance needs no secret inspection: select the Luogu account, paste the Cookie
  **value** into the masked box, press `连接`, then read only the visible status/labels. The other
  six operations need no secret input at all.

## What changed

| File | Change |
| --- | --- |
| `src/ui/luogu-view.ts` (new) | Pure derived-view rules: mirrored interval bound constants (asserted against the application module in tests), panel-state decision, session-draft validation (fixed sentences, UTF-8 byte bound, never echoes the draft), honest coverage/attempt/backlog/progress/next-run projections, fixed failure-code guidance, status-driven control gating, compare-and-set settings patch, poll-delay rule and the guiding copy. |
| `src/ui/LuoguSync.tsx` (new) | `LuoguSyncPanel`: the visible「洛谷账号连接与同步」 block. Memory-only masked session input (cleared before the request settles, on account switch and on unmount), account/UID/source identification, not-selected / wrong-platform / unsupported-OS guidance, status-driven start/resume/full-reconciliation/pause, per-account automation with revision CAS, separate coverage/attempt/backlog rendering, bank+bootstrap refresh after a committed completion, and safe `luogu.status` polling (mounted-only, activity-gated, aborted on account switch/unmount by `useRequest`). |
| `src/ui/Imports.tsx` | Mounts the panel inside the existing `导入与同步` panel (passing the selected source's platform) and replaces the manual-import-only Luogu sentence: a Luogu source now points at「洛谷账号连接与同步」while HydroOJ keeps its own note. |
| `src/ui/styles.ts` | Scoped `.icpc-luogu*` classes: collapsible block, responsive three-column grid that collapses to one column at 640 px, wrapping text, guide list, inline field error. |
| `tests/ui/luogu-view.test.ts` (new) | 11 focused cases over the pure rules (gating, secret draft, CAS patch, poll gate, honest projection, guidance requirements). No DOM/fake-React test. |
| `docs/luogu-sync.md` (new) | User guide: entry, connection steps, `_uid`/`__client_id` explanation and whole-Cookie preference, no-AI-chat warning, Windows Credential Manager storage, disconnect scope, Windows/Linux support, operation semantics, coverage vs attempt vs backlog, recent window vs full reconciliation, host/auto lifecycle, resumability, metadata backpressure, real-authentication validation limitation, and source/MIT references. |
| `docs/merged-bank.md` | The stale sentence that claimed Luogu is import-only now points at the connection panel and links the new guide. |
| `src/ui/api.ts` | **Unchanged.** All seven `luogu.*` operations were already in the client allowlist from 17d1, so no new operation had to be added. |

No version, `package.json`, lockfile, installation, schema, host or backend file was modified.

## Commands actually run (from `D:\dsh-icpc-workbench`)

1. `npm run typecheck; node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/ui/luogu-view.test.ts tests/ui/api.test.ts; npm run check:architecture`
   → typecheck **exit 0**; UI tests **14 pass / 1 fail** (the failure was one assertion *inside the new
   test* that expected the wording `/不会/`, while the reviewed copy states 避免丢掉题目键 — the
   assertion was corrected to pin the same guarantee; no production code changed for it);
   architecture check **pass** (exit 0).
2. After that correction:
   `$files = Get-ChildItem tests/ui -Filter *.test.ts | ForEach-Object { $_.FullName }; node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none @files; npm run build`
   → **88 pass / 0 fail** (exit 0), `npm run build` → **exit 0** (`Built independent ESM package in dist.`
   and `Built classic dsh browser factory with shared React.`).
3. Final gate after the documentation was written:
   `npm run typecheck; node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/ui/luogu-view.test.ts`
   → typecheck **exit 0**, **11 pass / 0 fail** (exit 0).

No whole-project suite, no network request to Luogu, no real credential access, no installation and
no real browser session were used. Real login acceptance remains the coordinator's.

## Test evidence (externally meaningful behaviour)

- **Mirrored bounds cannot drift**: the UI interval constants are asserted equal to
  `LUOGU_SYNC_INTERVAL_MIN_MINUTES` / `LUOGU_SYNC_INTERVAL_MAX_MINUTES`, and the secret bound to the
  documented 2560-byte credential blob.
- **Failure vocabulary is complete and distinct**: every `LUOGU_SYNC_FAILURE_CODES` entry has a
  non-trivial next-action sentence, no two codes share one, and the cursor-drift code names the full
  reconciliation/restart action.
- **Panel reads nothing without a Luogu account**: `no-account`, `wrong-platform` and `ready` are
  decided before any request, so `luogu.status` is never issued for a foreign account.
- **Session draft**: blank is `empty`, control characters are refused, 2560 ASCII bytes are accepted,
  2561 bytes and a 900-character multibyte value are refused (byte counting), and no refusal message
  contains the draft or its UID fragment.
- **Status-driven controls**: unsupported OS disables connect/probe/disconnect with the platform named
  while sync is refused for its real reason (not connected); running disables start and enables pause;
  a live lease of another instance still allows the reservation the service coalesces; a paused/expired
  connection disables sync; `closing` and a busy action disable everything with a reason; full
  reconciliation needs the explicit confirmation; automation save needs a real change.
- **CAS settings patch**: only changed fields are sent, `settingsRevision` (including `null`) is always
  named, an unchanged draft is refused, and `5`/`1440` are accepted while `''`/`abc`/`4`/`1441`/`10.5`/`-5`
  are refused locally — and an unusable interval draft does not count as "dirty".
- **Poll gate**: no polling for an unread/idle status, 2 s while running/reserved/leased, 30 s while
  automation is enabled, and no polling while closing.
- **Honest numbers**: a never-synced account reports "尚未完成一次全历史核对" / "还没有完成过一次同步"
  and processed rows are labelled as including duplicate checks and rejudge replays with no new-submission
  claim; coverage, latest attempt and backlog render separately; an unread status contains no digits at
  all; a full backlog is described as backpressure that avoids losing problem keys; `started` never
  claims completion and `queued` says it waits.

## Design notes

- **A running job is never recreated by the UI.** The panel keeps no job state: every control and every
  sentence is derived from the durable `luogu.status`, so remounting re-derives the same view. Status
  reads are aborted on account switch/unmount by `useRequest`, so a late answer cannot overwrite a newer
  one, and polling stops entirely once nothing can change.
- **Refresh timing.** The bank read (`onChange`) and the bootstrap refresh run only when
  `lastSuccessAt` changes for this account (the first observation is adopted silently), i.e. after a
  committed completion — not after a reservation, a failure or a poll.
- **Automation copy.** The panel states that「暂停本轮」stops only the current pass, that the automation
  switch is the separate decision, that automation runs only while dsh is open, and that a global
  `platformLimits` change needs a dsh restart while per-account settings apply immediately.
- **Unsupported OS.** `connectionAvailable: false` renders the fixed reason with the resolved platform
  and hides the credential input, while `luogu.status` and the import/account/AI flows stay usable.

## Open issues / notes

1. Real-authenticated acceptance is pending: nothing in this invocation contacted Luogu, and the
   Linux/unsupported path was exercised through the status field, not on a real Linux host.
2. The panel deliberately has no component test (coordinator runs real browser QA); its rules are
   covered by the pure `luogu-view` cases and the client contract test.
3. `luogu.start` is treated as a committed reservation (202): the panel shows the returned outcome and
   then polls `luogu.status`; it never claims the pass finished.
4. Version bump, package acceptance, whole-suite run and Git remain the coordinator's.

## Sprint 17d2 repair — first/partial sync refresh and copy corrections (this invocation)

Scope: `.local/contract-17d1-r2.md`, browser half only. Two integration defects and three inaccurate
sentences were repaired. The seven API DTOs and the seven operations are unchanged; no backend, host,
schema, version, package, model, network or Git action was taken.

### What changed

| File | Change |
| --- | --- |
| `src/ui/luogu-view.ts` | New pure `luoguSyncProgressStep` (plus `LuoguSyncProgress` / `LuoguSyncProgressState` / `LuoguSyncProgressStep`) deciding when the bank and the bootstrap must re-read: a first read or an account switch is adopted silently, a new `lastSuccessAt` refreshes once, and committed pages seen mid-pass are paid exactly once when the pass is observed to end. The baseline is initialized even while `lastSuccessAt` is `null`, so a never-synced account's first success is no longer mistaken for an already-seen instant and a partial pass that ended by cancellation/failure still refreshes its committed rows — while a 2 s poll that changed nothing refreshes nothing. `LUOGU_FAILURE_GUIDANCE.changed_response` no longer prescribes a full-history reconciliation/restart as the universal cure: it names a possible site verification or shape change, an official-browser login/verification check, a compatible-update check and the retained checkpoint. |
| `src/ui/LuoguSync.tsx` | The `seenSuccess` ref (which ignored `lastSuccessAt: null` and never saw a partial pass) is replaced by the pure transition helper over `lastSuccessAt`/`totalPages`/`submissionsSeen`/`running`/`leaseActive`; `onChange()` + bootstrap refresh run only when the helper says so. |
| `docs/luogu-sync.md` | Three claims corrected: the backlog is **题目资料** and this path fetches only problem metadata/statement (never editorials); the lease is **at least 120 s** and extends to cover a page's request budget, renewed per committed page; `changed_response` is described as possibly a site verification/shape change with the checkpoint kept, and a full reconciliation only when the user explicitly wants one. |
| `tests/ui/luogu-sync-progress.test.ts` (new) | Six focused cases over the pure transition (first read with a null instant, first success, cancelled partial pass, observed end after mid-pass progress, no refresh storm, unchanged polling/foreign lease/account switch). |
| `tests/sync/luogu-sync-service.test.ts` | Unchanged in this part of the repair (see the Stage 17d1-r2 section for the four coordination cases run alongside these). |

### Commands actually run (from `D:\dsh-icpc-workbench`)

`npm run typecheck; npm run check:architecture; node --experimental-strip-types --import ./tests/loader.mjs
--test --experimental-test-isolation=none tests/sync/luogu-sync-service.test.ts tests/sync/luogu-connection.test.ts
tests/sync/luogu-source-gate.test.ts tests/storage/luogu-sync.test.ts tests/plugin/luogu-host.test.ts
tests/plugin/luogu-api.test.ts tests/plugin/composition.test.ts tests/ui/luogu-view.test.ts
tests/ui/luogu-sync-progress.test.ts`
→ typecheck **exit 0**, architecture **exit 0**, tests **91 pass / 0 fail** (`TESTS_EXIT=0`) with all 11
prior `luogu-view` cases and the new 6 transition cases passing. No whole-project suite and no build.

### Evidence

- The repair keeps the panel's contract that a remount never restarts or clears host work: the
  transition is derived only from the durable status, and a status that repeats itself returns
  `refresh: false`.
- The copy corrections are the only wording changes; every other failure sentence, control reason and
  honest-numbers sentence is untouched, and the existing UI assertions (including
  `/完整核对|重启/` on `changed_response` and the mirrored interval bounds) still pass.

## Sprint 17d2-r2 — false「历史覆盖」correction and copy alignment (this invocation)

Scope: `.local/contract-17e.md`, browser half only. A live browser session showed a never-connected,
never-synced Luogu account (all counters `0`, `phase: backfill`, `historyComplete: false`) labelled
`历史覆盖 仅最近窗口` with the paragraph 目前只覆盖最近窗口的增量记录, while the note under
「开始 / 继续同步」claimed that button always scans the recent window. Neither claim was true: no
history had been read at all. The seven API DTOs and the seven operations are unchanged; no backend,
host, schema, version, package, model, network or Git action was taken.

### What changed

| File | Change |
| --- | --- |
| `src/ui/luogu-view.ts` | New pure `luoguHistoryState` (`never` / `backfill` / `reconcile` / `complete`), `LUOGU_HISTORY_STATE_LABELS` and `luoguHistoryCoverageLabel`. `never` requires positive evidence that nothing was ever read (no `resumePending`, no `scanStartedAt`, no `lastScanStartedAt`, no `lastSuccessAt`, `totalPages === 0`, `submissionsSeen === 0`); every other incomplete status falls back to the unfinished-**backfill** wording, so no branch invents a covered window. `luoguHistoryCoverage` now answers 尚未开始历史回溯 / 尚未同步记录 for a never-started account, 历史回溯未完成（已提交 N 页、处理 M 条记录）+ the stored checkpoint for a partial backfill, 全历史核对未完成 for an unfinished reconciliation, and the completed instant for `historyComplete: true`. `luoguProgressSummary` says 尚未同步记录 for the never state instead of reporting a zero-filled pass. `LUOGU_RECENT_WINDOW_NOTE` states the real order of work (backfill first; recent-window incremental only after one complete whole-history scan). This panel's backlog copy says 题目资料 instead of 元数据, and `LUOGU_MANUAL_STILL_AVAILABLE` says 本页的 JSON / CSV 手工导入入口 (the manual panel is below this block, not above it). The Cookie guide now names the exact visible label 「登录凭据（Cookie 值，只在本机使用）」. |
| `src/ui/LuoguSync.tsx` | The 历史覆盖 stat renders `luoguHistoryCoverageLabel(value)` instead of the inline `historyComplete ? … : 仅最近窗口` chain, the backlog stat is labelled 待补题目资料, and the pure helper is imported. |
| `tests/ui/luogu-view.test.ts` | The two stale assertions that pinned the false wording were replaced; a new case pins all four states (never / partial backfill with checkpoint / unfinished reconciliation / completed with instant), the no-invented-coverage fallback, the 尚未同步记录 progress sentence and the aligned guide/manual-import copy. |

### Commands actually run (from `D:\dsh-icpc-workbench`)

1. `npm run typecheck; npm run check:architecture; node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/ui/luogu-view.test.ts tests/sync/luogu-sync-service.test.ts`
   → typecheck **exit 0**, architecture **exit 0**, tests **31 pass / 1 fail**: one pre-existing
   assertion still expected the never-state progress sentence to carry the processed-rows disclaimer.
   The assertion was corrected to pin that disclaimer on a status that actually reports counters; no
   production code changed for it.
2. Final focused gate: the same command for `tests/ui/luogu-view.test.ts` → **12 pass / 0 fail**
   (`UI_TESTS_EXIT=0`), and for `tests/sync/luogu-sync-service.test.ts` → **20 pass / 0 fail**
   (`SYNC_TESTS_EXIT=0`).

No whole-project suite, no build, no network request to Luogu, no real credential access and no real
browser session were used. Real browser acceptance remains the coordinator's.

### Evidence

- **The live shape is now honest**: a status with `phase: 'backfill'`, `historyComplete: false` and
  every instant/counter `null`/`0` classifies as `never`; its stat reads 尚未开始历史回溯, its paragraph
  states 尚未同步记录 / 尚未开始历史回溯 with no page/row count and no 只覆盖最近窗口 claim, and the
  progress paragraph omits the 本轮已提交 counter sentence entirely.
- **Partial work is still named**: a checkpointed 20-page backfill reads 历史回溯未完成（已提交 20 页、
  处理 1000 条记录）and says it continues from 已保存的检查点; an unfinished reconciliation reads
  全历史核对未完成; `historyComplete: true` reads 完整核对已完成（<time>）and the paragraph names the same
  instant.
- **No invented fallback**: an incoherent incomplete status (`phase: 'incremental'`,
  `historyComplete: false`) is reported as 历史回溯未完成, never as a covered recent window.
- **Copy alignment**: the guide contains the same label the input renders (suffix 只在本机使用 included),
  the 题目资料 wording is confined to this panel, and the manual-import sentence points at 本页.
