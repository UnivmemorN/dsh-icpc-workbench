# Stage 20b — compact Luogu connection and sync card

Status: **complete for the assigned slice**. Contract: `.local/contract-20b.md`. This invocation touched
only the Luogu client view, its pure rules, its scoped styles, one focused test file, `docs/luogu-sync.md`
and this report: no backend, API, schema, host, credential, dependency, model, version or Git action was
taken, and historical reports were not rewritten.

## Result

The Luogu block on **账号与同步 → 导入与同步** is now one compact card instead of three simultaneous
verbose columns:

- **Default view (no textbox, no stats grid, no tutorial paragraph):** connection state and last login
  check, history coverage + metadata backlog + automation state, and the primary「开始 / 继续同步」.
  「暂停本轮」renders only while this instance is running;「检查登录」is secondary and exists only once a
  connection record does.
- **A failure is never hidden:** a failed/paused latest attempt gets one short sentence that names the
  failing stage (when the durable record has one) and points at「同步详情」; the long stage-aware advice is
  rendered exactly once, there. A successful probe stays a *current login check* in its own line and never
  retracts the failure.
- **Exactly one credential trigger:**「连接洛谷」before any connection record,「更新登录凭据」afterwards.
  Closing the form unmounts the inputs and drops both drafts *and* the mode; a submit attempt clears them
  and collapses the form; account switch, source switch (the import panel is keyed by source) and unmount
  clear them too. Only the form's submit button ever calls `luogu.connect`.
- **Three collapsed native disclosures:**「同步详情」(progress / history / latest attempt / backlog /
  stage-aware advice / login check),「自动同步设置」(existing automatic / startup / interval form with the
  unchanged CAS protection) and「高级操作」(the explicit whole-history confirmation, the reconciliation
  button and the pause-versus-automation note).
- **The settings bug is fixed:** the fields are disabled only while an action is in flight or the plugin is
  closing, never because the draft is unchanged, so untouched toggles can be turned on again; the save
  button still requires a real change, and opening the section saves nothing.
- JSON/CSV import and the generic public-sync section stay where they were and stay collapsed; no Luogu
  credential form exists for a CF/manual source.

## What changed

| File | Change |
| --- | --- |
| `src/ui/luogu-view.ts` | New pure compact rules: `luoguCredentialActionLabel`, `luoguCompactSummary` (+ `LuoguCompactSummary`, private `compactBacklog` / `compactAutomation` / `compactAlert`), `luoguPrimaryActionReason` and `luoguSettingsEditable`; new copy `LUOGU_CLIENT_ID_INSTRUCTION` and `LUOGU_SECRET_LOCAL_ONLY_NOTE`. Every existing projection, control gate, CAS patch, poll rule and failure sentence is unchanged. |
| `src/ui/LuoguSync.tsx` | Body rebuilt as one vertical compact card. Removed the `Stats` grid, the three-column grid, the default Cookie inputs, the settings-revision paragraph and the repeated manual-import paragraphs. The credential form sits behind the single trigger (`aria-expanded` / `aria-controls`) and unmounts on close; the three long sections are `<details>`; the settings inputs use `luoguSettingsEditable`; a compact alert carries state the closed card must not hide. Module doc updated. |
| `src/ui/styles.ts` | `.icpc-luogu` is now a section rule (top border) instead of a card nested in the import panel card; added `.icpc-luogu-status`, `.icpc-luogu-alert`, `.icpc-luogu-credentials`, `.icpc-luogu-detail*` and a row layout for checkbox labels; removed `.icpc-luogu-grid` / `.icpc-luogu-block`; actions wrap; dark-mode alert colour. All scoped under `.icpc-root`. |
| `tests/ui/luogu-view.test.ts` | Five new cases (no markup snapshots): the collapsed card states the same facts as the expanded sections (including the never-synced label and backpressure), a failed attempt gets one short sentence that never repeats the long advice, the single credential trigger's two labels, the settings-editability regression (`configure` is enabled only by a dirty draft, so the old gate locked an untouched form) and the primary-action reason noise rules. |
| `docs/luogu-sync.md` | Entry path now 账号与同步 → 数据来源：洛谷 → 导入与同步; documents the collapsed disclosures, the credential form's clear/collapse behavior, the one-line instruction + local-only note with the full help behind「如何获取 Cookie」, and the editable-fields/save-requires-a-change rule. |
| `docs/reports/stage-20b-compact-sync.md` | This report. |

`src/ui/Imports.tsx` and `src/ui/Accounts.tsx` were inspected and needed **no change**: the Luogu panel is
still mounted only for `source?.platform === 'luogu'` and the import panel is still keyed by source, which
is exactly what keeps CF/manual contexts free of the credential form and makes a source switch close the
form and drop both drafts.

## Bug fixed

`disabled={!controls.configure.enabled && !settingsDirty}` disabled every automatic-sync field whenever
the draft was unchanged — and because `configure` is enabled *by* a dirty draft, that was precisely the
state a user starts in, so the toggles could never be turned on. Editing is now gated by
`luoguSettingsEditable(status, busy)` (not busy, not closing) while saving still requires
`controls.configure.enabled`, i.e. a real change. A test pins the regression by asserting that the old
expression locked the form while the new rule says it is editable.

## Commands actually run (from `D:\dsh-icpc-workbench`)

1. `npm run typecheck` → **exit 0** (`noUnusedLocals` is on, so this also proves no dead imports).
2. `npm run check:architecture` → **exit 0** (`Architecture imports satisfy the declared layer boundaries.`).
3. `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/ui/luogu-view.test.ts tests/ui/luogu-sync-progress.test.ts`
   → **25 pass / 0 fail** (20 pre-existing + 5 new).
4. `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/ui/account-input.test.ts tests/ui/luogu-view.test.ts tests/ui/luogu-sync-progress.test.ts`
   → **39 pass / 0 fail**.

No live request, no credential, no model call, no `.local` file other than this contract and no broad
`npm test`/build was run (the coordinator owns the full check, install and browser acceptance).

## Open issues / follow-ups for the coordinator

- **Browser acceptance is still owed** (per contract): credential form open/close/clear, submit collapse,
  navigation and source switching, editable toggles versus the disabled save button, and the collapsed
  default view with a real failure state.
- `luoguNextRunSummary` is no longer rendered: the compact automation line carries the same facts in short
  form (state + next planned instant), and rendering the long paused-guidance sentence there would have
  been a second copy of the advice「同步详情」already shows. The pure helper and its existing tests remain.
- `LUOGU_PHASE_LABELS` moved from the removed stats grid into「同步详情」(同步阶段) so the durable phase,
  which is not the same fact as history coverage, stays visible.
- The outer block is still a `<details open={panelState === 'ready'}>`; the no-account state therefore
  stays collapsed to its summary until the user expands it. That matches Stage 20a and keeps the page
  compact, but it is the one default-open decision worth a browser look.
- `README.md` and `docs/merged-bank.md` already described the compact「连接洛谷 / 更新登录凭据」trigger in
  the current working tree; only `docs/luogu-sync.md` was still stale and was updated here.

Coordinator follow-up: final integration, revised source presentation, packaging and browser/data-preservation checks are recorded in [Stage 20 acceptance](stage-20-acceptance.md).
