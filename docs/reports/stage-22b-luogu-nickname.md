# Stage 22b — Luogu public nickname backend (completion report)

Status: **complete for the assigned backend slice** — this is the final completion pass of contract
`.local/contract-22b1-r1.md`. The previous worker exhausted its request cap after saving `refreshProfile` but
before finishing `storeProfile`, leaving one type error (the call passed the operation token to a two-argument
method). This round finished the saved implementation, repaired the one failing focused test at its root cause,
added the missing cancellation/lease/API regressions, and wrote this report. No UI feature work was done in this
invocation. No Git action, no network call, no credential/session/user-data/log access, no agent, no other
model, no dependency/schema/API/version/script change.

## What the backend ships

- **Adapter (`LuoguAdapter.fetchAccountProfile`)** — anonymous `GET /user/<canonical uid>` with
  `x-lentille-request: content-only`. Only `data.user` (`uid`, `name`) is read; `root.user` (the viewer identity)
  is never accepted, the parsed uid must match the requested canonical uid, and a wrong/missing/blank/oversized
  name is `changed_response` instead of a fabricated nickname. Returns only
  `{ sourceInstanceId, uid, displayName }` — no biography, scores or follower data. Every `PlatformError` of the
  path (transport, HTTP refusal, HTML, malformed JSON, unrecognized root, parser, declared body error) is rebuilt
  by `safeProfileError` with a fixed detail sentence, **no sample, no raw body, no parser message and no cause**,
  preserving the typed code, `retryable`, `retryAfterMs` and `attempts`; cancellation and programming errors are
  rethrown unchanged.
- **Service (`LuoguSyncService.refreshProfile`)** — a public, anonymous read: it needs no stored session, works
  before any connection exists and on a host whose credential backend is unsupported, and never touches the
  vault, connection rows, submissions reader or model gateway. A missing optional `fetchAccountProfile`
  capability is refused as the typed `unsupported` operation before any store or platform work. The operation
  still takes the service's one source slot and the durable per-account lease through `runConnectionOp` (so it is
  `busy` while a pass or another source operation runs, and cancelled by `close`), and records no history work
  and no failure: phase, watermarks, checkpoint, missing-metadata backlog and any stored synchronization failure
  are preserved exactly; the lease is released with `clearPausingFailure: false`.
- **Lease ordering** — the current lease is re-taken and re-checked (`renewLease`) **inside the shared gate's
  work callback**, immediately before the profile HTTP request, because the gate may park the operation behind
  another source operation for a long time. A takeover or expiry during that wait issues no public request and
  never dispatches on a stale claim.
- **Nickname write (`storeProfile`)** — the answer is re-validated against the account's canonical uid before the
  store is touched, then written inside one transaction that re-reads the account, re-checks that its identity
  did not change and re-checks this operation's own live lease with a clock reading taken **inside** the
  transaction, after the awaited reads. The caller's combined token is checked after the fetch, on both sides of
  every awaited read and immediately before and after the write; a port that answers after cancellation, or a
  store read/write that waited across one, rolls the nickname back instead of saving it. Only `displayName`
  changes; `id`, `sourceInstanceId`, `handle` and `profileUrl` are copied verbatim.
- **Typed API (`luogu.profile`)** — registered with `validateAccountRequest`, with no `requireConnectionBackend`
  check and no vault access. It answers the `{ account }` projection of the stored row only, re-asserts the route
  lifetime after the call (`assertOpen`), and is refused as `conflict` once the route was disposed. An unknown or
  foreign account is refused before any platform work.
- **`account.create`** — a repeated create that omits `displayName` preserves an already stored nickname; an
  explicitly supplied one replaces it, on the same single instance+account row.

## Changed in this completion pass

- `src/application/luogu-sync-service.ts` — `storeProfile` now takes the operation token
  (`storeProfile(account, displayName, opToken)`), clearing the saved type error. Inside the transaction it
  checks cancellation before the account read, after that read, after the state read, before the write and
  after the write (a post-write cancellation propagates, so the transaction rolls back), and reads the lease
  clock at that point instead of before the transaction. Documentation updated in place.
- `src/adapters/luogu/adapter.ts` — the entire `fetchAccountProfile` body is now wrapped so **every**
  `PlatformError` of the path is rebuilt through `safeProfileError` (previously only the parser branch was
  wrapped; a transport/HTTP refusal could still carry a body sample). Cancellation and unexpected errors pass
  through unchanged; the existing `profileJsonRoot` and `safeProfileError` behavior is preserved.
- `tests/sync/luogu-sync-service.test.ts` — the busy/concurrency fixture now seeds the synthetic source with the
  profile of the pinned uid (`100001`, `示例选手`); the previous failure was exactly that unseeded map
  (`synthetic profile source has no profile for this uid`), and no concurrency assertion was changed. Five new
  regressions: a non-cooperating port that answers normally after cancellation (late answer discarded, lease
  released); cancellation while the nickname transaction waits on its account read (nothing saved); cancellation
  while the write runs (the write is reached once and rolled back, the stored row survives); a source without the
  optional capability refused as `unsupported` with no platform call; and a lease lost while the profile gate
  waits (foreign takeover **and** expiry), which dispatches no request, leaves the foreign owner's row untouched
  and releases only the expired own claim.
- `tests/platform/luogu.test.ts` — new regression with a unique synthetic private marker
  (`PRIVATE_PROFILE_MARKER_7c41f0`) placed in an HTML page, malformed JSON, a declared body error and an HTTP
  refusal; asserts the marker never appears in the serialized error, message, stack or own enumerable
  properties, and that no sample or cause is attached.
- `tests/plugin/luogu-api.test.ts` — new `luogu.profile` API regressions: an unsupported credential backend
  (`implemented: false`) still resolves the public nickname with no vault write, no history call and no vault
  reference echoed (exact `{ account }` result shape, another account untouched, refused/unknown account
  dispatches no lookup); and a route reference captured before disposal is refused with `409 conflict` and
  performs no lookup.
- `tests/plugin/business-api.test.ts` — new `account.create` regression: repeated create without `displayName`
  keeps the resolved nickname, an explicit `displayName` replaces it, and the row count stays at one.
- `tests/plugin/composition.test.ts` — the exact host route count is now `60` (43 business/model/bootstrap +
  **8** typed Luogu + 3 virtual-performance + 6 assessment), with an explicit `luogu.profile` presence
  assertion so the added route cannot hide behind the total.
- `docs/reports/stage-22b-luogu-nickname.md` — this report (new; already listed in `package.json#files` by the
  earlier 22b round).

### Already saved by the earlier 22b1 rounds (verified, not rewritten here)

`src/application/ports.ts` (optional `fetchAccountProfile` capability and its request/result types),
`src/application/luogu-sync-service.ts` (`refreshProfile` claim/gate/`renewLease`/release and the
`unsupported` capability refusal, doc contract), `src/plugin/luogu-api.ts` (the `luogu.profile` route without a
credential-backend check), `src/plugin/business-api.ts` (repeat-create nickname preservation),
`src/adapters/luogu/adapter.ts` (`profileJsonRoot`, `safeProfileError`, `PROFILE_FAILURE_DETAILS`),
`src/adapters/luogu/parsers.ts`/`index.ts`, `src/application/workbench-api.ts` (operation map), and the single
mechanical `src/ui/api.ts` entry for `luogu.profile`.

## Commands actually run

Windows PowerShell, from `D:\dsh-icpc-workbench`.

| Command | Result |
| --- | --- |
| `npm run typecheck` | first run: **1 error** — `TS6133: 'LuoguAccountProfile' is declared but its value is never read` after the safe-wrap restructure; after restoring the annotation: **exit 0, no diagnostics** |
| `npm run check:architecture` | `Architecture imports satisfy the declared layer boundaries.` |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none "tests/platform/**/*.test.ts" "tests/sync/**/*.test.ts" "tests/plugin/**/*.test.ts"` | first run: **388 tests, 385 pass, 3 fail**; after the two fixes below: **388 tests, 388 pass, 0 fail** (14.96 s) |
| `npm run typecheck && npm run check:architecture && <same focused test command>` | final combined run: typecheck exit 0, architecture pass, **388/388 focused tests pass** |

The three first-run failures and their resolution:

1. `tests/sync/luogu-sync-service.test.ts` — *a profile refresh holds the one source slot…* — unseeded synthetic
   profile map (the exact failure the coordinator reported). Fixed in the fixture setup; the `busy` assertions
   for the same and the other account are unchanged.
2. `tests/platform/luogu.test.ts` — *a refused profile answer never quotes the page body…* — my assertion
   demanded `sample === undefined` while `PlatformError` normalizes an absent sample to `null`. Relaxed to a
   null-tolerant check only; the marker/leak assertions are unchanged and still strict.
3. `tests/plugin/composition.test.ts` (2 cases) — the hard-coded host route count was stale at `59` because the
   new `luogu.profile` route is intentionally registered; updated to `60` with the breakdown comment and an
   explicit profile-route presence assertion.

No full `npm run check`, build, packaging or UI run was performed (explicitly out of scope for this pass).

## Limits and open issues (for the coordinator / next stage)

- **UI is still deferred**: this invocation changed no `src/ui` file and added no user-visible nickname-refresh
  control. The previously saved single mechanical `src/ui/api.ts` entry for `luogu.profile` is the only UI-side
  touch from the earlier 22b1 round.
- **Live acceptance pending**: every regression is synthetic — temporary SQLite, injected fake clock, in-memory
  vault, synthetic metadata adapter and in-memory HTTP harness. No real credential, real Luogu page or network
  request was used, so the live behavior against `www.luogu.com.cn` (and the real anonymous rate limits) is the
  coordinator's acceptance step.
- The adapter's anonymous profile path is exercised directly and through the service/API; the gate lease
  regressions monkey-patch the shared gate (`parkGate`), they do not re-instrument production code.
- Git history, versioning and the release of these working-tree changes remain the coordinator's; nothing was
  committed, pushed, reset or cleaned. `package.json` already lists this report path (pre-existing 22b working
  tree change, no version bump in this pass).

## Stage 22b2 UI pass — nickname presentation

Status: **implemented and focused-checked; live acceptance against `www.luogu.com.cn` is still pending** and
remains the coordinator's step. This pass touched only UI, UI tests and documentation: no backend, API,
schema, version, script, Git or credential behavior was changed, and the UI calls only the existing typed
`luogu.profile` route (public, anonymous, no Cookie, no AI).

### Changed in this pass

- `src/ui/account-name.ts` (new) — the pure naming rules (Luogu primary = trimmed distinct `displayName`
  else `洛谷用户`; secondary = `UID <handle>`; header option = `nickname · UID <handle> · 洛谷`; the
  account's platform resolved from the real `boot.sources` list, never parsed from the opaque instance id),
  the fixed refusal-reason table, and `lookupLuoguNickname`, the one injected async read that checks the
  caller's signal before the request, after it settles and before it reports, and refuses an answer that
  names another account.
- `src/ui/Accounts.tsx` — account list and current-account line use the split labels; the selected Luogu
  account gets the manual「刷新洛谷昵称」button with a busy state and a retryable short failure notice; one
  automatic attempt runs per mounted page when the selected Luogu account shows no distinct nickname, keyed
  by account id/displayed name (with `refresh` read through a ref) so a bootstrap refresh cannot start a
  second lookup and a distinct custom nickname is never overwritten automatically. `AddAccountForm` now
  performs the public read after `account.create` and **before** selecting the account (selecting unmounts
  the form and would abort the read), checks `signal.aborted` after every awaited step and before every
  selection/close/refresh side effect, refreshes then selects then closes on success, and on refusal keeps
  the saved binding and shows「账号已添加，昵称暂未获取」with one explicit retry that never deletes or
  recreates the account. The Codeforces create path is behaviorally unchanged apart from the abort guard.
- `src/ui/App.tsx` — header selector option text comes from `accountOptionLabel`, so a Luogu account reads
  `nickname · UID <handle> · 洛谷` (duplicate nicknames stay distinguishable) while the other platforms keep
  their previous text; the source is looked up in the bootstrap list.
- `src/ui/LuoguSync.tsx` — the panel summary now prints the Luogu account label and「洛谷 UID」separately,
  so the UID is never repeated as a nickname.
- `src/ui/account-input.ts` — `ACCOUNT_SAVE_NOTE` now says that adding only stores the public identifier and
  that a Luogu account reads its public nickname once (no Cookie), while做题记录 still needs a separate
  sync/import; the existing UID guidance is untouched.
- `tests/ui/account-name.test.ts` (new) — pure label tests (missing/empty/UID-equal name, actual trimmed
  name, duplicate nicknames disambiguated by UID, Codeforces unchanged, source-list lookup) and async flow
  tests (no read when already aborted, late answer dropped, refusal raced with cancellation reported as an
  abort, foreign-account answer refused, fixed reasons that never echo server text).
- `tests/ui/account-input.test.ts` — the save-note assertions now pin the public-nickname/separate-history
  distinction instead of the retired「不会自动同步」wording.
- `docs/luogu-account-names.md` (new) and `THIRD_PARTY_NOTICES.md` — document the public
  `GET https://www.luogu.com.cn/user/<UID>` read (`x-lentille-request: content-only`), verified anonymously
  by the coordinator on 2026-09-14; only `data.user.uid`/`data.user.name` are used, never `root.user`, no
  profile body or third-party code is copied, no AI is involved, and the official
  <https://www.luogu.com.cn/user/1> is cited only to identify the endpoint.

### Commands actually run

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit 0, no diagnostics |
| `npm run check:architecture` | `Architecture imports satisfy the declared layer boundaries.` |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none "tests/ui/**/*.test.ts"` | **158 tests, 158 pass, 0 fail** (289.8 ms), including the new `tests/ui/account-name.test.ts` and the updated save-note assertions |

### Open issues / limits for the coordinator

- **Live acceptance is still pending**: the worker ran no network request, so the real anonymous read
  against `www.luogu.com.cn` (and its real rate limits) is unverified here.
- This repository has no DOM test runner (React is bundled without `react-dom`), so the effects themselves
  are not rendered by tests. The async flow they call is covered directly; the one-attempt-per-mount rule,
  the abort on unmount and the select-after-profile ordering are visible in the reviewed source and are
  worth a manual UI check during live acceptance.
- That automatic attempt deliberately retries only through the explicit button after a failure (no
  automatic retry loop), and it never replaces a distinct custom nickname.
- The header/list naming rules are shared by `account-name.ts`; other surfaces that render account names
  (e.g. the merged bank's account selector) were out of this contract's allowed scope and were not changed.


## Coordinator acceptance

Packaged and live results after these worker checks are recorded in [Stage 22 acceptance](stage-22-acceptance.md). Worker-only pending items above describe the worker invocation, not the final release.
