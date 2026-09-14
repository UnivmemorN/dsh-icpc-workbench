# Stage 22a — Luogu metadata backlog drain (completion report)

Status: **complete for the assigned slice** — this is the second and final repair round of the review patch
(`.local/contract-22a-r2.md`). The previous review worker's runtime crashed after saving partial edits, so this
round finished the saved source instead of restarting the feature. The invocation touched only
`src/application/luogu-sync-service.ts`, `src/ui/luogu-view.ts`, the two focused test files and this report:
no Git action, no network call, no credential/session/user-data/log access, no agent, no other model, and no
dependency, schema, API or version change. `docs/luogu-sync.md` needed no edit (it already documents the raised
batch, the drain action and the lease rules).

## What stage 22a ships

- **Ordinary pass:** one history+metadata pass still reads at most `LUOGU_SYNC_MAX_PAGES_PER_PASS = 20` pages of
  `min(LUOGU_SYNC_PAGE_SIZE = 50, limits.pageSize)` rows, and now repairs `LUOGU_SYNC_METADATA_PER_PASS = 100`
  metadata keys (raised from the earlier 30). The missing-metadata backlog stays capped at
  `LUOGU_SYNC_MAX_METADATA_BACKLOG = 2000` with `backlogDropped` always `0` (backpressure, never dropping).
- **Explicit backlog drain (`luogu.start` mode `metadata`):** takes the same source-wide slot but repairs only
  the backlog present at its start, one attempt per distinct key, up to 2000 keys. It reads no history page,
  moves no watermark/checkpoint/`historyComplete`, creates no checkpoint, and never invokes a model — the
  metadata source is the anonymous problem adapter. `src/plugin/luogu-api.ts` accepts the third mode.
- **Pacing and lease:** every platform operation still runs through the shared source gate with at least a 2 s
  floor after the previous operation finished; each metadata item renews the lease and commits its own progress,
  so a drain is resumable, fair (a failed key rotates to the back of the backlog) and stoppable.
- **UI:** `LUOGU_METADATA_DRAIN_LABEL` = `补齐全部积压资料（不使用 AI）`, the long `LUOGU_METADATA_DRAIN_NOTE`
  (100-item ordinary batch, ≥2 s pacing, one attempt per key, page may be left while dsh stays open, pause keeps
  finished items, no history read) and `LUOGU_NO_AI_NOTE`, now
  `洛谷同步直接读取洛谷平台数据，不调用 AI 模型，也不消耗 AI 额度。` — the previous wording called the
  authenticated history a "公开接口"; it no longer does.

## Review-patch completion (this round)

The saved partial patch was internally inconsistent and is now complete:

- `settleState` gained its third `{ keepPriorFailure, priorFailure }` argument, so a pass that produced no
  failure of its own can settle `null` without erasing evidence it never retried.
- `isCancellation(error)` was added. It recognizes a caller/service cancellation (`DomainError: cancelled`), a
  close (`LuoguSyncError: closing`) and — needed for the new regression — the platform-code form
  (`PlatformError: cancelled`) that `refreshProblemMetadata` wraps a post-fetch cancellation in.
- `repairMetadata` declared `{ failure, priorFailure }` but still returned a bare `failure`; it now returns the
  declared object.
- `describeFailure` treats a platform `cancelled` as **no failure**, matching its own documentation and the
  history half's behavior. Before this fix a pause of an in-flight metadata item was recorded as a fabricated
  `internal` failure and overwrote the real item failure — the new cancel regression exposed exactly that.

Final semantics, all covered by focused tests:

| Pass | Stored failure before | Result |
| --- | --- | --- |
| metadata-only, success | `stage: 'history'` | **kept** (history was never retried) |
| metadata-only, empty backlog, success | legacy record without `stage` | **kept untouched**, no stage invented |
| metadata-only, success | `stage: 'metadata'` | **cleared** (the successful retry repaired it) |
| metadata-only, new metadata failure | any | new failure recorded normally, with `stage: 'metadata'` |
| metadata-only, cancelled/closed after an earlier item failed | earlier item failure | **kept**, per-item progress and backlog intact |
| ordinary history+metadata, success | any | cleared — the documented ordinary behavior is unchanged |
| lease taken over while the gate waits | new owner's row | **no request**; owner/failure/backlog untouched |
| lease expired while the gate waits | own row | **no request**; `lease_lost` recorded and the lease released |

The lease re-validation (`renewLease`) runs inside the gate's work callback, immediately before
`refreshProblemMetadata`, so a lease lost during the gate's park refuses the request instead of dispatching it.

## Changed files (this round)

- `src/application/luogu-sync-service.ts` — 3-argument `settleState` with the explicit keep rule,
  `isCancellation`, `repairMetadata` returning `{ failure, priorFailure }`, platform-cancelled treated as
  non-failure, docs updated in place.
- `src/ui/luogu-view.ts` — `LUOGU_NO_AI_NOTE` says 洛谷平台数据 instead of 公开接口.
- `tests/sync/luogu-sync-service.test.ts` — 5 new regressions (36 cases total in the file): successful
  metadata-only drain keeps a history failure and still records a new metadata failure; empty metadata action
  keeps a legacy stage-less failure; successful retry clears a metadata failure; cancel after the first
  transient item failure retains it; lease taken over/expired while the gate waits dispatches no request and
  clobbers no foreign row. A small `parkGate` helper parks the shared gate before its work callback.
- `tests/ui/luogu-view.test.ts` — the no-AI note is now asserted by exact text, not two loose regexes.
- `docs/reports/stage-22a-luogu-backlog.md` — this report (new).

### Already in the working tree from the earlier 22a rounds (listed from `git status --porcelain`; not rewritten here)

`README.md` (0.1.17 note: 100 per pass, pausable drain, no AI), `docs/luogu-sync.md`,
`src/application/luogu-sync-types.ts` (the raised constants), `src/application/workbench-api.ts`,
`src/plugin/bootstrap-api.ts`, `src/plugin/luogu-api.ts` (accepts the `metadata` mode),
`src/ui/LuoguSync.tsx`, `tests/plugin/luogu-api.test.ts`, `package.json`, `package-lock.json`.

## Commands actually run

Windows PowerShell, from `D:\dsh-icpc-workbench`.

| Command | Result |
| --- | --- |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/sync/luogu-sync-service.test.ts tests/plugin/luogu-api.test.ts tests/ui/luogu-view.test.ts` | first run: 73 tests, 1 fail (cancel-retention, recorded `internal`); after the `describeFailure` fix: **73 tests, 73 pass, 0 fail** (36 sync + 15 plugin + 22 UI) |
| `npm run typecheck` | first run: 1 error in the new test (a `satisfies` literal narrowed by `assert.deepEqual`); after the annotation fix: **exit 0, no diagnostics** |
| `npm run check:architecture` | `Architecture imports satisfy the declared layer boundaries.` |
| `git status --porcelain` / `git log --oneline -3` | read-only; used to list the pre-existing working-tree files above. No commit, push, reset or clean was run |

## Limits and open issues

- All regressions are synthetic: temporary SQLite, injected fake clock, in-memory vault, synthetic `/record/list`
  feed and in-memory problem adapter. No real credential, network call or Luogu response was used, and the 2 s
  source floor is exercised through the injected clock/wait rather than real sleeping.
- The new `parkGate` regression proves the ordering (gate wait → lease check → request) for a takeover and for
  an expiry, but the gate is monkey-patched in the test; the production path itself was not re-instrumented.
- The drain action and the 100-item batch are validated by tests plus `typecheck`/architecture gates only; the
  browser acceptance of the new copy and the full `npm test`/build/package gates remain the coordinator's.
- Git history and the release of these working-tree changes remain the coordinator's; nothing here was
  committed or pushed.
