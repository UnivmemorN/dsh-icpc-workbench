# Stage 20a — dedicated Accounts & Sync page

Status: **complete for the assigned slice**. Contract: `.local/contract-20a.md`. This invocation
touched only the client UI, its copy and this report: no backend, API, schema, host, credential,
dependency, version, package, model, network or Git action was taken, and Stage 20b still owns the
Luogu panel's inner density.

## Visible UI entry (acceptance handoff)

- Main nav now has a real page **账号与同步** (`accounts`, between 题库 and 标签审核).
- Header keeps the shared **当前账号** selector and a **管理账号** shortcut that navigates to the new
  page; the old global inline add-account form is gone.
- **题库** keeps a compact `账号与同步：导入与同步` link in place of the former embedded import panel,
  immediately followed by its problem list. No sync/import control remains on 题库.
- New page order: account list + `添加账号/取消` disclosure → **数据来源** selector → the unchanged
  `导入与同步` panel (generic public sync, Luogu connection panel, JSON/CSV import).

## What changed

| File | Change |
| --- | --- |
| `src/ui/Accounts.tsx` (new) | The page: account list with platform name and `aria-pressed` selection, selected-account context with optional profile link, one `添加账号/取消` disclosure, an initial prompt when no account is selected, a source selector (pinned while an account is selected, free for anonymous/manual use) and the source-keyed `ImportPanel`. `AddAccountForm` keeps the Stage 08a validation, error handling and newly-created selection, with platform help/example behind a `填写说明与示例` expansion. |
| `src/ui/App.tsx` | Header selector now calls the shared `selectAccount`; added `管理账号`, the `账号与同步` nav entry and `Accounts` routing; removed the inline add-account form and its state/imports. |
| `src/ui/common.tsx` | `PageName` gained `accounts`; context gained `selectAccount(accountId)`, documented as the one switch that also clears problem detail and candidate selection. |
| `src/ui/Bank.tsx` | Removed `ImportPanel` and its import; added the compact `icpc-sync-link` button to 账号与同步 and updated the empty-list copy. Browsing, filters, sorting, paging and detail are unchanged. |
| `src/ui/Imports.tsx` | Mounted only from the accounts page; Luogu panel gated to a Luogu source; submissions sync now requires the selected account's own source (`accountMatchesSource`) and explains a mismatch instead of sending `sync.page`. Sync bounds, cancellation, capability gating and preview/confirm flow are untouched. |
| `src/ui/styles.ts` | Scoped `.icpc-accounts*`, `.icpc-account-list`, `.icpc-account-guide`, `.icpc-sync-link` rules; nav wraps (`.icpc-root .icpc-nav{flex-wrap:wrap}`) instead of scrolling horizontally. |
| `src/ui/Today.tsx`, `Weakness.tsx`, `Knowledge.tsx`, `ability-view.ts`, `merged.ts` | Stale copy now points at 账号与同步; the Weakness button navigates to `accounts` instead of 题库. |
| `src/ui/account-input.ts` | `ACCOUNT_SAVE_NOTE` next step no longer says 题库 (the Stage 19 assertion `/导入或同步/` is preserved verbatim). |
| `src/ui/LuoguSync.tsx` | Module doc comment only: visible path is now 账号与同步 → 导入与同步 → 洛谷账号连接与同步. No panel behavior or layout change. |

## Behavior and evidence notes

- `selectAccount` is used by both the header selector and the account list, so creating an account
  selects it and clears `problemKey`/`selectedKeys` exactly like the old top selector; toggling the
  selected list entry clears the selection.
- The page source follows the selected account (adopted once the account appears in the refreshed
  bootstrap, mirroring the bank reconciliation). With an account selected, other source options are
  disabled; anonymous/manual users can pick any source, so public catalog sync and manual import stay
  usable without an account.
- A submissions request can never be addressed to a foreign source: the option is disabled, the
  buttons are gated on `account.sourceInstanceId === sourceId`, and the sync notice explains it.
- The Luogu panel mounts only when the selected source platform is `luogu`, so a Codeforces or
  manual context never creates it. Its durable, host-owned pass is untouched by navigation — only
  the component's HTTP request is aborted on unmount, which is the pre-existing `useAction` behavior.
- `ImportPanel` is keyed by source at the call site, so a source change remounts it and clears stale
  preview/applied results, sync pages and CSV context instead of mixing two sources.
- Nothing runs automatically: reading bootstrap, navigating to the page or expanding a disclosure
  starts no account creation, sync or model work; automation settings were not touched.

## Commands actually run (from `D:\dsh-icpc-workbench`)

1. `npm run typecheck` → **exit 0**.
2. `npm run check:architecture` → **exit 0** (`Architecture imports satisfy the declared layer boundaries.`).
3. `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/ui/account-input.test.ts tests/ui/luogu-view.test.ts tests/ui/luogu-sync-progress.test.ts tests/ui/ability.test.ts tests/ui/merged.test.ts`
   → **49 pass / 0 fail**, covering the account-input rules, Luogu view/progress rules and the two
   pure view modules whose copy changed.
4. Optional broad checks: `npm test` → **1086 pass / 2 skipped / 0 fail** (exit 0);
   `npm run build` → exit 0; `node scripts/check-client.mjs` →
   `Classic client factory, shared modules and disposal verified.` (exit 0). The build only refreshed
   the local `dist/` output.

## Open issues / follow-ups

- `README.md:37`, `docs/luogu-sync.md:9-10` and `docs/merged-bank.md:12` still document the old path
  题库 → 导入与同步. They are user documentation outside this contract's enumerated scope and were
  deliberately left for the coordinator to schedule; historical acceptance reports were not rewritten.
- Stage 20b owns the Luogu panel's inner layout/density; this slice intentionally kept it as-is.
- `package.json` `files` does not list this report (config/version changes are out of scope).
- `src/ui/account-input.ts` (one copy string) and the `src/ui/LuoguSync.tsx` doc comment are the two
  files touched outside the contract's file list; both are non-behavioral accuracy fixes required so
  the visible guidance no longer points at 题库.

Coordinator follow-up: final integration, revised source presentation, packaging and browser/data-preservation checks are recorded in [Stage 20 acceptance](stage-20-acceptance.md).
