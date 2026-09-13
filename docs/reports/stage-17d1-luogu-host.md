# Stage 17d1 — typed Luogu API and host lifecycle

Status: **complete for the assigned slice**. Parent scope: `.local/contract-17d1-luogu-host.md`
(no UI). No UI component, `App`/`Bank`/styles, package version, Git action, budget action, model
call, credential inspection or live platform request was made in this invocation. All focused gates
pass; the exact request/response contract 17d2 codes against is written out below.

## What changed

| File | Change |
| --- | --- |
| `src/application/workbench-api.ts` | Additive only: `LUOGU_API_OPERATIONS`, the seven Luogu request/response types and seven `WorkbenchApiMap` entries. `API_VERSION` stays `1`; no existing entry changed. |
| `src/ui/api.ts` | Only the client operation allowlist gained the seven `luogu.*` names (the single permitted UI-owned change). |
| `src/plugin/luogu-api.ts` (new) | `registerLuoguApi`: seven exact authenticated Fetch routes over `LuoguSyncService`, closed request validation, field-by-field status projection, sanitized Chinese failure mapping, atomic registration with rollback. |
| `src/plugin/luogu-host.ts` (new) | `createLuoguHost`: owns the workspace vault, the shared source gate, the connection manager, the stored-session submissions source, the durable sync service, `recoverDurableSync` and the single periodic timer. |
| `src/plugin/index.ts` | `ActivationEnvironment.luogu` seam; composition builds the host, recovers durable state and runs the startup sweep **before** registering routes, and registers the host disposer before the API disposer. |
| `tests/plugin/luogu-api.test.ts` (new) | 9 behavioural cases over real SQLite + synthetic vault/clock/timer/transport and the real 17a reader. |
| `tests/plugin/composition.test.ts` | Route-count assertion 42 → 49 for the seven real new operations; four new host-lifecycle cases (recovery/defaults/timer, enabled startup through injected transport, rollback on registration failure, unsupported platform keeps bootstrap/free routes). |
| `docs/reports/stage-17d1-luogu-host.md` | This report. |

## Exact API contract for 17d2

Every operation is `POST /api/icpc/v1/<operation>` with the versioned envelope
`{"apiVersion":1,"ok":true,"value":…}` or `{"apiVersion":1,"ok":false,"error":{"code","message"}}`,
`content-type: application/json; charset=utf-8`, `cache-control: no-store`. All seven are
`requestBody: 'streaming'` (JSON object body required, unknown keys refused).

### Request bodies

```ts
'luogu.status'      { accountId: string }
'luogu.connect'     { accountId: string; sessionCookie: string }
'luogu.probe'       { accountId: string }
'luogu.disconnect'  { accountId: string }
'luogu.cancel'      { accountId: string }
'luogu.configure'   { accountId: string; expectedRevision: number | null;
                      automaticEnabled?: boolean; runOnStartup?: boolean; intervalMinutes?: number }
'luogu.start'       { accountId: string; mode: 'resume' | 'full' }
```

Boundary rules (all refused with `400 invalid_input` **before** the handler reads the store, so
before any vault or platform IO):

- `accountId`: non-empty, ≤ 512 chars, no control characters, parses as a canonical compound id and
  names **this** configured Luogu instance. A Codeforces account id is therefore refused without IO.
- `sessionCookie`: non-empty/not blank, no control characters, **≤ 2560 UTF-8 bytes** (the OS
  credential blob cap). It is accepted only by `luogu.connect`.
- `expectedRevision`: `null` or a safe integer ≥ 1.
- `intervalMinutes`: safe integer `5..1440`; `automaticEnabled`/`runOnStartup`: boolean.
- `luogu.configure` requires at least one of the three patch fields; an empty patch is refused.
- `mode`: exactly `resume` or `full`.

A well-formed id that names no stored account answers `404 not_found`; a stored account of another
platform (or a non-canonical Luogu handle) answers `400 invalid_input`.

### Success values

`luogu.status`, `luogu.connect`, `luogu.probe`, `luogu.disconnect`, `luogu.configure`,
`luogu.cancel` answer **200** with `ApiLuoguStatusView`. `luogu.start` answers **202** with
`ApiLuoguStartResult` (the durable reservation is committed; the pass runs in the background).

```ts
interface ApiLuoguConnectionView {
  status: 'connected' | 'session_expired' | 'challenge' | 'schema_changed' | 'unavailable';
  connectedAt: string; checkedAt: string;
  failureCode: LuoguSyncFailureCode | null;   // fixed allowlist, never provider text
  cleanupPending: boolean;                    // a previous credential still needs removal
}

interface ApiLuoguStatusView {
  accountId: string;
  uid: string;                                // canonical decimal Luogu UID of the stored account
  sourceInstanceId: string;
  connectionAvailable: boolean;               // false when this OS has no supported credential store
  connectionPlatform: string;                 // e.g. 'win32' | 'linux' (disclosed even when false)
  connection: ApiLuoguConnectionView | null;
  settings: { accountId: string; automaticEnabled: boolean; runOnStartup: boolean;
              intervalMinutes: number; updatedAt: string };
  settingsRevision: number | null;            // revision the next configure must name
  phase: 'backfill' | 'incremental' | 'reconcile';
  historyComplete: boolean; historyCompletedAt: string | null;
  resumePending: boolean; scanSince: string | null;
  running: boolean;                           // this plugin instance is running that pass now
  leaseActive: boolean;                       // any instance holds a live durable lease
  paused: boolean;
  failure: { code: LuoguSyncFailureCode; at: string; retryAt: string | null; paused: boolean } | null;
  nextRunAt: string | null;
  scanStartedAt: string | null; lastScanStartedAt: string | null; lastSuccessAt: string | null;
  pagesInPass: number; totalPages: number; submissionsSeen: number;
  metadataBacklog: number; metadataBacklogFull: boolean;
  metadataResolved: number; metadataFailed: number;
  backlogDropped: number;                     // always 0 in this build
  closing: boolean;
}

interface ApiLuoguStartResult {
  accountId: string; mode: 'resume' | 'full';
  outcome: 'started' | 'coalesced' | 'queued';
  status: ApiLuoguStatusView;
}
```

**Never present in any answer:** `sessionCookie`, `cookie`, `reference`, `staleReference`,
`leaseOwner`, raw platform bodies, editorial/statement text, vault notes and adapter exception
messages. The projection is built field by field (asserted in tests by searching the serialized
answer for those markers).

### Failure mapping (never echoes adapter text)

| Condition | HTTP | code | message (fixed Chinese) |
| --- | --- | --- | --- |
| unknown/extra/invalid field, oversized or control-char cookie, empty patch, bad revision/interval/mode | 400 | `invalid_input` | per-field sentence |
| foreign or non-canonical account id | 400 | `invalid_input` | 该账号不属于已配置的洛谷来源。 |
| account not stored | 404 | `not_found` | 该账号未存储在本机工作台中。 |
| not connected / busy / closing / stale revision / lease lost / unsupported OS / cleanup failed | 409 | `conflict` | one fixed sentence per code |
| client aborted before/while handling | 499 | `cancelled` | 请求已取消。 |
| anything unexpected | 500 | `internal` | 洛谷同步操作失败。 (real error goes to the route observer only) |

`luogu.connect`/`probe`/`disconnect` on a host without a supported credential backend answer
`409 conflict` with the fixed text 当前操作系统没有可用的安全凭据存储… **without any store, vault or
platform IO**; `luogu.status` stays 200 and reports `connectionAvailable: false`.

## Host composition and lifecycle

- One `createLuoguHost` per activation composes: `WindowsCredentialVault({dataDir})` (workspace
  scoped), one `createLuoguSourceGate` shared by the connection adapter and the sync service
  (2 s source-wide floor measured from the completion of whole operations), the connection manager,
  the stored-session submissions source, the anonymous `LuoguAdapter` as `metadataSource`, and
  `LuoguSyncService` with `ownerId = luogu-sync-<uuid>` and the stored settings' `platformLimits`.
- `start(token)` runs `recoverDurableSync` first: for every stored Luogu account it materializes the
  contract defaults (per-account settings with `automaticEnabled: false`, empty sync state) and
  clears **only** a lease whose persisted deadline is already in the past. Then it runs one
  `startup()` sweep and starts the periodic tick (`LUOGU_TICK_INTERVAL_MS = 60_000`, unref'd, so it
  never keeps a standalone process alive). Composition awaits this **before** registering routes.
- Per-account `automaticEnabled` / `runOnStartup` / `intervalMinutes` are the service's own durable
  rules; with the defaults no account is eligible, so activation makes **no** platform request
  (asserted).
- Disposal order in `activateHost` (reverse of registration): Luogu routes removed → host disposer
  (timer stopped, tick token cancelled, `service.close()` drains the pass and every connection
  operation) → storage closed. If a Luogu route registration fails, the already-pushed host disposer
  runs the same shutdown before the storage closes and the original error is rethrown.
- Legacy surfaces are untouched: `business-api.ts` and `bootstrap-api.ts` still use the anonymous
  `LuoguAdapter` through `adapterFor`, so the legacy `sync.page` path cannot reach the authenticated
  reader, its lease or its checkpoint. All old CF/manual/AI routes and the whole-user suite component
  tests still pass.
- No AI call can occur in this slice: neither new module imports a model port
  (`tests/plugin/composition.test.ts` asserts the host's model/session counters stay `0`).

### Injected environment seam (`ActivationEnvironment.luogu`)

```ts
interface LuoguHostSeam {
  vault?: LocalCredentialVault; platform?: string;
  now?: () => string; nowMs?: () => number; wait?: WaitFn;
  setInterval?: (callback: () => void, ms: number) => () => void; tickIntervalMs?: number;
  transport?: LuoguReaderTransportOptions; metadataSource?: PlatformAdapter;
}
```

Production supplies no field and gets the real vault, process clock and OS timers.

## Commands actually run (all from `D:\dsh-icpc-workbench`)

1. `npm run typecheck` → **pass** (exit 0).
2. `npm run check:architecture` → **pass** (exit 0; "Architecture imports satisfy the declared layer
   boundaries").
3. `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/plugin/luogu-api.test.ts tests/plugin/composition.test.ts tests/plugin/business-api.test.ts`
   → **47 pass / 0 fail**, exit 0 (≈2.4 s) — intermediate run, before the last two test cases.
4. Final gate:
   `npm run typecheck; npm run check:architecture; node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/plugin/luogu-api.test.ts tests/plugin/composition.test.ts tests/plugin/business-api.test.ts`
   → typecheck exit 0, architecture **pass**, **48 pass / 0 fail**, exit 0 (≈2.5 s). Per file: Luogu
   API 9, composition 13 (9 existing + 4 new), business API 26.

No whole-project suite, no build, no network call and no real credential access were made.

## Test evidence (externally meaningful behaviour)

- **Route map exact**: the registered set equals the seven `LUOGU_API_OPERATIONS` paths, all POST,
  streaming; `luogu.unknown` is not registered; every answer carries `apiVersion: 1`, the success
  flag and `no-store`.
- **Auth envelope through the host primitive**: each case drives `route.fetch(new Request(...))`
  exactly as the host carrier does; the registry is the existing in-process double.
- **Validation before side effect**: 20 malformed requests (extra keys, missing/oversized/blank
  cookie, control characters, empty patch, bad revision, out-of-range interval, bad mode, wrong
  types) all answer 400 with zero vault writes, zero platform requests and no settings/state row.
- **Identity before IO**: a stored Codeforces account and a malformed id are refused with no vault
  or feed call; a well-formed but unknown Luogu uid answers 404.
- **Secret-free success and failure**: after a real connect the serialized answers contain neither
  the cookie, its `__client_id` marker, `sessionCookie`, `reference`, `staleReference`, `leaseOwner`
  nor `cookie`; the vault holds exactly that secret under one opaque reference and the synthetic
  feed observed that exact cookie. Failures carry only the fixed Chinese sentence.
- **Account/CAS isolation**: `configure` increments per account, a stale `expectedRevision` is 409
  and changes nothing, and a second account's settings stay independent.
- **Status/start/cancel response**: a real backfill through the real reader reaches
  `phase: incremental`, `historyComplete: true`, 2 pages / 60 submissions / 2 metadata repairs,
  `nextRunAt = lastSuccessAt + 30 min`, then `cancel` returns a not-running status.
- **Restart preserves resume**: 25 pages of 50 rows → one pass commits exactly 20 pages and keeps
  `resumePending: true`, `historyComplete: false` and the frozen `scanStartedAt`; a fresh service
  over the same rows reports the same totals and finishes the remaining 5 pages to 1250 submissions.
- **Startup off by default**: activation with default settings creates the settings/state rows,
  registers exactly one timer, makes zero platform requests, then disposal stops the timer and
  removes every route while the durable rows remain.
- **Enabled startup**: an `automaticEnabled + runOnStartup` connected account is picked up by the
  startup sweep, syncs through the injected transport and repairs metadata through the injected
  anonymous source (editorial requests stay 0).
- **Unsupported OS**: `connectionAvailable: false` (platform disclosed), connect/probe/disconnect
  answer 409 with the fixed text and touch nothing, while configure/start/status and
  bootstrap/`account.create`/`import.apply` keep working.
- **Disposal drains work**: routes are removed while a pass is parked on the platform; the drain
  releases the durable lease (`owner: null`, `leaseExpiresAt: null`), records no failure and refuses
  later starts as `closing`. A registration failure stops the timer and leaves no route behind.

## Open issues / notes for 17d2 (UI) and the coordinator

1. `luogu.start` answers **202**, not 200; the UI should treat it as "reservation committed", then
   poll `luogu.status` (or use the returned `status`) rather than assuming completion.
2. `settingsRevision` is `null` only when no settings row exists. In a host activation the recovery
   pass always materializes the row, so the UI can normally send the number it read.
3. `luogu.status` is the only status source: there is no separate "capabilities" operation.
   `connectionAvailable`/`connectionPlatform` come from the credential backend, not from the request.
4. The service is constructed at activation with the then-current `platformLimits`; a later
   `settings.save` change to `platformLimits` takes effect after a restart (unchanged 17c2 behavior).
5. Periodic ticks run every 60 s and only enqueue accounts whose durable due instant has passed;
   the UI must not infer network activity from the timer.
6. Version bump, package `files`/exports acceptance, `docs/handoffs` update and Git remain the
   coordinator's.

## Sprint 17d1-r1 — close/drain race repair (this invocation)

Scope: `.local/contract-17d1-r1.md` (recheck of `final17d1`). Only the verified close/drain races in
the host runtime, the typed API boundary and the necessary service closing guards were repaired. The
seven DTO contracts, the operation names, the versioned envelope and every accepted behavior are
unchanged. No UI, version, Git, harness, credential, model, network or paid-API action was taken.

### What changed

| File | Change |
| --- | --- |
| `src/application/luogu-sync-service.ts` | `start` and every `sweep` are now tracked launch attempts (`trackLaunchAttempt`, counted synchronously before the first `await`), so `close()`/`settle()` wait for them and not just for the running pass. `claim(account, request, token)` re-checks closing/cancellation inside the reservation transaction — before the first read and immediately before the only write — so a race cannot commit a reservation nothing may launch. `commitLaunch` launches the committed reservation or releases this pass's **own** lease and refuses (`closing`, or the caller's cancellation). `connect`/`probe` pass their combined token into the claim and re-check before the adapter call, so a reservation written just before the close is released instead of leaked. An interrupted sweep returns its partial result. `combineTokens` is exported for the API boundary. |
| `src/plugin/luogu-host.ts` | The tick is a tracked promise instead of a boolean flag; `start()` is a tracked attempt that re-checks disposal after recovery and after the startup sweep (no timer can be created after the close); `dispose()` is one cached promise that stops the timer, cancels the tick token, starts `service.close()` synchronously and drains the tick and the raced start before it resolves. A throwing `onInternalError` observer is recorded and rethrown by `dispose()` instead of becoming an unhandled rejection. The module header now discloses the `platformLimits` restart scope. |
| `src/plugin/luogu-api.ts` | `registerLuoguApi` owns a route lifetime: closing flag + lifetime cancellation set synchronously by the disposer, the request token linked to that lifetime via `combineTokens`, every accepted handler tracked and drained, `assertOpen` at every store boundary, and a disposal that removes every route even when one disposer throws (failures rethrown only after the drain). Registration rollback disposes the same lifetime. Public DTOs and operation names are unchanged. |
| `tests/plugin/luogu-host.test.ts` (new) | Host lifecycle races: deferred tick drain, disposal racing `start()`, throwing observer surfaced by disposal. |
| `tests/plugin/luogu-api.test.ts` | Three new cases: deferred status request drained plus a late captured handler refused without any store read; deferred connect interrupted by disposal with zero vault/platform IO; one throwing route disposer still removes every route and the cached disposal keeps the failure. |
| `tests/sync/luogu-sync-service.test.ts` | Three new cases: close inside a deferred `start` reservation; close after the reservation committed; close inside a sweep. |

### Commands actually run (from `D:\dsh-icpc-workbench`)

1. `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/plugin/luogu-host.test.ts tests/plugin/luogu-api.test.ts tests/plugin/composition.test.ts tests/sync/luogu-sync-service.test.ts`
   → **43 pass / 0 fail**, exit 0 (≈2.5 s). Per file: host 3 (new), Luogu API 12 (9 existing + 3 new), composition 13 (unchanged), sync service 15 (12 existing + 3 new).
2. `npm run typecheck` → **pass** (exit 0).

No whole-project suite, no build, no network call and no real credential access were made.

### Evidence for the repaired races

- **Tick parked in the store**: with `listAccounts` deferred until after `dispose()` began, disposal
  stays pending; releasing it lets the interrupted sweep stop at its account boundary and disposal
  resolves. Afterwards no further store call happens and no platform request is detached.
- **Startup/dispose race**: `dispose()` during `recoverDurableSync` leaves `timers.entries.length === 0`
  (no timer after the close) and the raced `start()` settles as a no-op.
- **Observer failure**: an `onInternalError` that throws is reported by `dispose()` (asserted) and
  never surfaces as a detached rejection.
- **Reservation races**: a `close()` landing inside the reservation read refuses the start as
  `closing`, keeps the durable row at `owner: null` and commits no page; a `close()` landing after the
  reservation committed (driven from inside the durable write) is caught by `commitLaunch`, which
  releases that reservation (`owner: null`) and launches nothing; an interrupted `tick()` returns
  `{started: []}` and later starts are refused as `closing`.
- **API lifetime drain**: the deferred `luogu.status` handler is drained (its own caller still gets
  200), while a captured route reference invoked after disposal is refused `409 conflict` with **no**
  store read; a deferred `luogu.connect` is refused after disposal with zero vault writes and zero
  platform requests; a throwing route disposer still removes all seven routes with the failure
  retained by the cached disposal.

### Open issues / notes

1. `platformLimits` remain snapshotted at host activation: the shared gate's floor and this source's
   request budget are fixed for the host's lifetime, so a change to the global platform limits needs
   a plugin restart for this source. Per-account synchronization settings stay live (read from the
   durable rows on every decision).
2. `createLuoguHost().dispose()` can now reject with a recorded observer failure (or with
   `service.close()`'s first background failure); the API disposer likewise rethrows collected route
   disposer failures. `disposeAll` in composition still aggregates them into its cleanup error.
3. Version bump, package `files`/exports acceptance, `docs/handoffs` update and Git remain the
   coordinator's.

## Sprint 17d1-r2 — concurrent same-owner start repair (this invocation)

Scope: `.local/contract-17d1-r2.md` (final bounded integration repairs). The finding was concrete:
`start()` checked `this.running` and only then awaited its durable claim, while
`luoguLeaseHeldByAnother` deliberately ignores *this* owner's own live lease — so two starts of one
account could both commit a reservation, the second `launch()` overwrote `this.running`, the earlier
pass became untracked and `close()`/`drainPass()` no longer drained everything. `tick()` racing a
manual `start()` had the same shape, and a connection operation holding the same owner's lease could
have its lease released by the pass (or the reverse).

No UI, version, package, Git, harness, worker, budget, network or credential action was taken; no
exported DTO, operation name or public method signature changed.

### What changed

| File | Change |
| --- | --- |
| `src/application/luogu-sync-service.ts` | One in-memory **source slot** per service, taken synchronously before an operation's first `await`. `beginPass` publishes the `RunningPass` to `this.running` *before* the durable reservation is written (with a cancellation source and a `finish` gate); `reservePass` writes the reservation and either attaches the real pass (`launched = true`) or releases its own lease and retires the pass. `start` answers `busy` while a same-account reservation is still being written (documented choice: `coalesced` would claim an outcome the store has not returned yet) and coalesces/queues only once the pass is launched; another account, or a claim while a connection operation holds the lease, is `busy`. `sweep` publishes its pass the same way. `runConnectionOp` refuses while a pass (or its reservation) owns the slot, and any claim refuses while a connection operation owns it — the same-owner window the durable check cannot see. `finishPass` queues a follow-up reconciliation only for a pass that really ran and reserves it synchronously. The obsolete `commitLaunch`/`launch` pair is gone. |
| `tests/sync/luogu-sync-service.test.ts` | Four new deterministic cases (deferred store/adapter gates, no timing sleeps). |

### Commands actually run (from `D:\dsh-icpc-workbench`)

1. First combined run of `npm run typecheck; npm run check:architecture; node --experimental-strip-types
   --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/sync/luogu-sync-service.test.ts
   tests/sync/luogu-connection.test.ts tests/sync/luogu-source-gate.test.ts tests/storage/luogu-sync.test.ts
   tests/plugin/luogu-host.test.ts tests/plugin/luogu-api.test.ts tests/plugin/composition.test.ts
   tests/ui/luogu-view.test.ts tests/ui/luogu-sync-progress.test.ts`
   → typecheck **failed** on two findings of my own edit (a leftover `commitLaunch` that still called
   the removed `launch`), architecture pass, tests **90 pass / 1 fail** (`a close that lands after the
   reservation committed releases that reservation` got the pass's `cancelled` error instead of
   `closing`). Both were repaired before the gate below.
2. Final gate, same command →
   typecheck **exit 0**, architecture **exit 0** ("Architecture imports satisfy the declared layer
   boundaries"), tests **91 pass / 0 fail** (`TESTS_EXIT=0`, ≈4.4 s). The combined command reported 91 passing tests; groups overlap earlier checks.

No whole-project suite, no build, no network call and no real credential access were made.

### Evidence for the repaired races (all deterministic, no sleeps)

- **Two simultaneous starts of one account**: the first reservation is parked inside its deferred
  `listAccounts` scan and the second start is issued before the gate is released. Exactly one call
  answers `started`, the other is `busy` or `coalesced`, and the durable state afterwards is
  `totalPages: 2` / `submissionsSeen: 60` with `leaseOwner: null` — one pass, one platform scan, one
  lease, released.
- **`tick()` racing a manual start**: the manual reservation is parked the same way, then the sweep
  runs. Exactly one of the two reserves the account; `totalPages` stays `2`, so the account is not
  scanned twice.
- **Close during the queued reconciliation reservation**: `full` while a pass runs is `queued`, the
  first page is released, and the queued pass's own reservation scan is parked. `close()` during that
  window leaves `owner: null` / `leaseExpiresAt: null`, launches no platform work (`feed.calls`
  unchanged after the close), keeps the finished pass's 60 committed rows, and resolves.
- **Connection-vs-start same owner**: while `connect` holds its durable lease (parked in the
  adapter), `start` is refused `busy` instead of re-claiming the same owner's lease; the connection
  releases only its own lease and the account then syncs normally to completion.

### Open issues / notes

1. While a same-account reservation is still being written, `start` answers `busy` rather than
   `coalesced`. That is deliberate and documented: the window is one store transaction, and `busy` is
   the only answer that cannot be contradicted by a store refusal.
2. `connect` and `probe` refuse with `busy` while a source pass is running. `disconnect` first cancels and drains its own account's pass, then removes its session; another account holding the source can still cause a busy refusal. The UI surfaces the fixed conflict message.
3. Version bump, package `files`/exports acceptance, `docs/handoffs` update and Git remain the
   coordinator's.

## Sprint 17e — reservePass release-failure unwind

Scope: `.local/contract-17e.md` (the separate exception-unwind finding). When a `close()`/caller
cancellation won *after* the durable reservation committed, `reservePass` awaited `releaseLease(...)`
**before** `finishPass(pass)`. If that release write failed with anything other than the store's
expected stale-revision refusal, `finishPass` never ran: the published, unlaunched pass stayed in
`this.running` and `settle()`/`close()` waited forever on a promise nothing would resolve. No DTO,
operation, signature or accepted behavior changed; no UI, version, package, Git, harness, worker,
budget, model, credential or network action was taken.

### What changed

| File | Change |
| --- | --- |
| `src/application/luogu-sync-service.ts` | The release is wrapped in `try` / `catch` / `finally`: a failure is recorded on `backgroundFailures` (so `close()` reports the original error instead of swallowing it) and `finishPass(pass)` runs in the `finally`, so the local pass is always retired and `settle()`/`close()` always settle. A failed release deliberately does **not** clear the durable row: the lease keeps its owner and `leaseExpiresAt` until it expires on its own (the next accepted pass recovers it) instead of being faked clear. The `reservePass` doc comment states the guarantee. |
| `tests/sync/luogu-sync-service.test.ts` | One new deterministic case: the close lands after the claim (driven from inside the durable write) and every de-lease write throws. |

### Commands actually run (from `D:\dsh-icpc-workbench`)

1. `npm run typecheck; npm run check:architecture; node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/ui/luogu-view.test.ts tests/sync/luogu-sync-service.test.ts`
   → typecheck **exit 0**, architecture **exit 0**; sync service **20 pass / 0 fail** (19 existing +
   1 new). The only failure in that run was inside the 17d2 copy assertions and is recorded in the
   17d2-r2 section.
2. Same focused sync command after that correction → **20 pass / 0 fail** (`SYNC_TESTS_EXIT=0`,
   ≈1.45 s), with all three earlier close/claim race cases and the queued-reconciliation close case
   still passing.

No whole-project suite, no build, no network call and no real credential access were made.

### Evidence for the repaired unwind

- **Controlled close, no hanging runner**: with `saveLuoguSyncState` throwing on every `owner: null`
  write and the close driven from inside the reservation's own durable write, `close()` rejects
  within the same test with the **original** error object (`error === releaseFailure`, asserted), and
  the release write is attempted exactly once.
- **The pass is retired anyway**: `service.status(...).running === false` afterwards, so `settle()`
  and a second `close()` return instead of waiting on the published pass.
- **The lease is retained, not faked clear**: the durable row still holds
  `owner: 'svc-release-failure'` with a non-null `leaseExpiresAt`, so the next accepted pass recovers
  it by expiry.
- **Nothing was launched**: `feed.calls` is unchanged and no submission row was committed.
