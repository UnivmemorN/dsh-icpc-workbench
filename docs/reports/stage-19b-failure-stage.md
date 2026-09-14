# Stage 19b — truthful Luogu sync failures and cookie acceptance review

Status: **complete for the assigned slice**. Parent scope: `.local/contract-19b.md` (implement after
19a). Only the files listed below were touched: no version, `package.json`, lockfile, schema, Git,
Harness, NovaPhy, credential, private `.local` or network action was taken. Every test uses synthetic
fixtures; no live request and no additional model or agent was used.

## Problems this stage fixes

1. An authenticated history read and an anonymous problem-metadata read share the failure code
   `auth_required`, but the stored failure had no way to say which half of a pass failed. The panel
   therefore explained every `auth_required` as an expired Cookie — a false conclusion for a metadata
   access failure, and false again for an old failure that a later connection probe showed was no
   longer a login problem.
2. Stage 19a review: `boundedCookieText` trimmed the raw cookie text **before** the control-character
   check, so a leading or trailing CR/LF/TAB silently disappeared instead of being refused.

## Changed files

| File | Change |
| --- | --- |
| `src/application/luogu-sync-types.ts` | New `LuoguSyncFailureStage` (`'history' \| 'metadata'`) and `LUOGU_SYNC_FAILURE_STAGES`; optional `LuoguSyncFailure.stage`; `requireExactKeys` gained an optional-key list so a legacy four-field failure stays valid while any other undeclared key is still a hard refusal; `validateLuoguSyncFailure` validates `stage` when present and returns a legacy record without inventing one. |
| `src/application/luogu-sync-service.ts` | `runPass` records the failing half: a thrown history/page-commit failure is described with `stage: 'history'`; a metadata failure from `repairMetadata`, including an exception thrown while doing that work, with `stage: 'metadata'`. The metadata phase still runs exactly when the history phase did not throw, so cancellation/pause semantics are unchanged. `buildFailure`/`describeFailure` take the stage. The `probe` contract now states that a successful probe never clears a sync failure. |
| `src/ui/luogu-view.ts` | Stage-aware copy: `LUOGU_FAILURE_STAGE_LABELS`, `luoguSyncFailureGuidance` (used by the latest-attempt summary **and** the automatic-pause summary), metadata-specific and history-specific sentences, and a neutralised stage-less `auth_required` sentence that asks for a login check instead of asserting expiry. New `luoguLoginCheckSummary` shows a probe that succeeded **after** the failure as a successful current login check that does not retract the failure and is never a successful sync. |
| `src/ui/LuoguSync.tsx` | Renders `luoguLoginCheckSummary` next to the latest-attempt summary. The connection block keeps the standalone probe's stage-free failure advice. |
| `src/domain/luogu-session-cookie.ts` | `boundedCookieText` runs the control-character check on the **original** raw input before `trim()`; outer spaces and the `Cookie:` prefix remain accepted. Comments corrected: normalizing the authenticated request to the required pair is not a way around platform verification, and the platform may still refuse a valid session. |
| `tests/platform/luogu-session.test.ts` | New regression test: leading/trailing/interior CR/LF, TAB, vertical tab and NUL are refused with `unsafe_characters` on the raw text; outer spaces and `Cookie:` still unwrap; the two-field mode takes the value verbatim. Three edge-control cases added to the adapter-level rejection list. |
| `tests/storage/luogu-sync.test.ts` | New storage test: both stages round-trip, a legacy four-field failure stays four-field across a restart (no invented stage), invalid stages (`'guess'`, `'HISTORY'`, `''`, `42`, `null`) are refused before any write, and a credential-shaped key is still refused. |
| `tests/sync/luogu-sync-service.test.ts` | New cases: a metadata `auth_required` is stored as `stage: 'metadata'` while history coverage, submissions and the backlog are preserved, and a later successful probe neither clears nor unpauses it; a genuine history `auth_required` is `stage: 'history'` and clears nothing; an exception thrown while repairing metadata is `stage: 'metadata'`. |
| `tests/ui/luogu-view.test.ts` | New cases: metadata vs history vs legacy `auth_required` wording is consistent across the latest-attempt summary, the automatic-pause summary and the guidance helper; a successful probe after a failure is a current login check and never a successful sync. |
| `docs/luogu-sync.md` | Connection guidance completed (default `__client_id` Value only, selected `_uid` readonly, optional whole-Cookie extraction, old stored whole-Cookie compatibility, normalization ≠ bypassing platform checks); new「失败发生在哪一步」 section covering `stage`, metadata failures and the probe-after-failure rule. |
| `docs/reports/stage-19b-failure-stage.md` | This report. |

No schema, store, migration, host, route or version file was modified.

## Durable interface

`LuoguSyncFailure` gains exactly one optional field:

- `stage?: 'history' | 'metadata'` — which half of the pass failed. The persisted body stays closed:
  `code`/`at`/`retryAt`/`paused` are still required, `stage` is the only additional key allowed, an
  unknown or wrongly typed stage is `invalid_input`, and a four-field record written before this stage
  is read back exactly as stored (`'stage' in failure === false`). There is **no DB schema change, no
  migration and no data rewriting**: the field lives inside the existing canonical JSON `body`.
- The service always writes the stage for a new failure; only records that predate the field lack it.
- `LuoguSyncFailure` already reached the panel unchanged through `ApiLuoguStatusView.failure`, so the
  typed API surface needed no projection change.

## Behaviour pinned by the new tests

- A metadata failure never marks history incomplete and never discards submissions: the page data,
  checkpoint and `historyComplete` are committed before the metadata phase runs, and the metadata
  write only touches `missingMetadata`, the metadata counters and `failure`.
- The failing metadata key stays in the durable backlog (rotated) and is reported as backlog, not as
  data loss.
- A successful `luogu.probe` only updates the connection record; it does not clear, downgrade or
  unpause the stored sync failure, and automatic sweeps still skip the account as `paused`.
- A genuine history `auth_required` is recorded as `stage: 'history'`; it still never clears
  `historyComplete` and never empties the backlog.
- UI: metadata-stage `auth_required` says the problem-data completion step failed and explicitly does
  **not** mean the saved login expired; history-stage `auth_required` names the authenticated read and
  asks for a login check; a legacy record without a stage uses neutral wording that suggests checking
  the login and does not assert expiry; a probe newer than the failure is rendered as “current login
  check succeeded” while the sync failure remains and is never rendered as a successful sync.
- Cookie acceptance: a CR/LF/TAB anywhere in the raw pasted text — including at either end — is
  `unsafe_characters`; only outer spaces and an optional `Cookie:` prefix are unwrapped.

## Stage 19a work carried by this change set (no separate 19a report)

19a delivered the pure cookie normalizer and its wiring, then hit its request cap before writing its
report or documentation; the coordinator independently ran the 71 targeted reader/connection/API/UI
tests (all passed) and handed the documentation gap to this contract. Summarized from the code in the
tree:

- `src/domain/luogu-session-cookie.ts` (new): the single pure rule that turns a pasted `__client_id`
  **value** or a whole Cookie header into the canonical `__client_id=…; _uid=…` pair bound to the
  selected account's UID, with fixed, input-free refusal sentences; plus the two-field panel mode
  (`luoguSessionCookieFromClientId`).
- Wiring: `src/adapters/luogu/session-reader.ts` and `src/adapters/luogu/connection.ts` normalize on
  every read, so a stored legacy whole-Cookie value keeps working without a vault rewrite; the connect
  route (`src/plugin/luogu-api.ts`) validates through the same rule; the panel gained the default
  `__client_id` Value mode with a readonly `_uid` and an optional advanced whole-Cookie mode
  (`src/ui/luogu-view.ts`, `src/ui/LuoguSync.tsx`).
- 19b adds the raw-control ordering fix, its regression tests and the documentation that 19a could
  not write.

## Commands actually run (from `D:\dsh-icpc-workbench`)

1. `npm run typecheck` → **exit 0**.
2. `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/platform/luogu-session.test.ts`
   → **30 pass / 0 fail** (includes the new CR/LF/TAB regression case).
3. `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/storage/luogu-sync.test.ts tests/ui/luogu-view.test.ts tests/sync/luogu-sync-service.test.ts`
   → **47 pass / 0 fail** (includes the new stage storage, service and UI cases).
4. `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/plugin/luogu-api.test.ts tests/plugin/luogu-host.test.ts tests/ui/luogu-sync-progress.test.ts tests/sync/luogu-connection.test.ts tests/sync/luogu-source-gate.test.ts`
   → **42 pass / 0 fail**.
5. `npm run check:architecture` → `Architecture imports satisfy the declared layer boundaries.`
   (**exit 0**).

Total for this stage: **119 focused tests, 0 failures**, plus typecheck and the architecture gate. The
full `npm run check` was deliberately not run (contract: “No test weakening or full check yet”). No
test was weakened, skipped or deleted.

## Open issues / handoff

- Packaging, version and real-account acceptance are recorded in [Stage 19 acceptance](stage-19-acceptance.md).
- This worker slice made no live Luogu requests. Its fixtures establish error handling, not current platform availability.
- Legacy stored failures keep no stage until the next failure is recorded; the panel deliberately stays
  neutral for them rather than guessing `history`.
- The stored **connection** record still carries only a failure code (no stage), by design: it is
  written by the standalone probe/connect, which is a different operation from a sync pass.
