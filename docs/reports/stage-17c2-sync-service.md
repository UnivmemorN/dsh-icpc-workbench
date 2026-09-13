# Stage 17c2 — synchronization service and connection adapter

Status: **complete for the assigned slice; final repair round 17c2-r2**. Parent scope:
`.local/contract-17c2-sync-service.md`. No UI, route, host composition, package/version change, Git
action, budget action, model call, credential inspection or network call was made in this
invocation. The plugin/host still composes nothing from this slice; the adapter barrel exports it
for 17d.

This report describes the **final 17c2 protocol after r1/r2**, not the first draft. In particular
the pacing gate paces *whole operations* from their completion, the durable credential protocol
writes the monotonic generation/journal record **before** the vault write, schema v7 holds **five**
Luogu tables, and a typed `invalid_input` refusal *pauses* automatic retries instead of retrying
the same refusal.

## What changed

| File | Change |
| --- | --- |
| `src/application/luogu-source-gate.ts` (new) | Pure, injectable source-wide pacing gate: FIFO serialization of **whole operations** (`run(token, work)`) and a floor of `LUOGU_SOURCE_MIN_INTERVAL_MS` (2000) measured from the previous operation's *completion*, so switching transports (authenticated reader ↔ anonymous metadata adapter) or adding a second account's reader cannot reset pacing. No host timer: time and waiting are injected ports (`now`, `wait`). |
| `src/application/luogu-sync-service.ts` (new) | `LuoguSyncService`: durable reservation/lease, bounded history passes through `ImportService.syncPage` (each request is `min(LUOGU_SYNC_PAGE_SIZE = 50, limits.pageSize)` rows), metadata repair through `ImportService.refreshProblemMetadata`, automatic sweeps, connection operations, cancellation and `close()` drain. Typed `LuoguSyncError` with fixed sanitized text; `invalid_input` is a *pausing* failure. |
| `src/adapters/luogu/connection.ts` (new) | `LuoguConnectionAdapter` implementing the accepted `LuoguConnectionManager`, the stored-session provider, and the submissions-source factory the service drives. Test-before-replace protocol, fresh opaque reference per save, **durable journal entry before the vault write**, monotonic per-account revision via `luogu_connection_generations`, CAS persist, `staleReference` for failed cleanups, CAS `forget`. |
| `src/adapters/sqlite/schema.ts`, `src/adapters/sqlite/store.ts` (extended by 17c2 r1) | Schema v7 now has **five** additive Luogu tables — `luogu_connections`, `luogu_connection_generations`, `luogu_connection_journal`, `luogu_sync_states`, `luogu_sync_settings`. The store implements the generation tombstone and the idempotent, secret-free journal writes/reads. |
| `src/adapters/luogu/index.ts` | Exports the new connection module (additive only). |
| `tests/sync/fixtures.ts` (new) | Synthetic clock/wait/timer, in-memory vault with injectable failures, synthetic `/record/list` feed the **real** 17a reader parses, metadata adapter, deterministic helpers. |
| `tests/sync/luogu-source-gate.test.ts` (new) | 3 behavioral gate cases (completion-based floor, queue release on rejection/cancellation, token passthrough and prior completion instant). |
| `tests/sync/luogu-connection.test.ts` (new) | 14 behavioral connection cases, including the four write-ahead/recovery cases added by r1. |
| `tests/sync/luogu-sync-service.test.ts` (new) | 12 behavioral service cases, including page-size-cap and `invalid_input`-pause cases added by r1. |

## Repair 17c2-r2 (this invocation)

The single failing focused case was a **test defect, not a production defect**.
`tests/storage/luogu-sync.test.ts` read the deliberately corrupted journal with the hand-written
literal `'luogu:www.luogu.com.cn:800001'`, which is **not** the canonical
`luoguScope('800001').account.id` (a compound account id escapes its instance part), so the query
matched no row and the call resolved `[]` — reported as "Missing expected rejection".

The test now declares the scope before the first `try`, addresses `alice.account.id` consistently,
and first asserts that the hand-edited row really is *that* account's journal entry before expecting
`StorageError('corrupt_row')`. The rejection therefore proves corruption of the intended target, not
an empty read of a misspelled id. No production code changed; no corruption behavior was weakened.
`docs/reports/stage-17c1-sync-storage.md` was corrected to name the five v7 tables and to document
the journal/generation store surface.

## Exact public interfaces 17d builds against

```ts
// application/luogu-source-gate.ts
export const LUOGU_SOURCE_MIN_INTERVAL_MS = 2_000;
export interface LuoguSourceGate {
  readonly minIntervalMs: number;
  run<T>(token: CancellationToken, work: (token: CancellationToken) => Promise<T>): Promise<T>;
}
export function createLuoguSourceGate(options: {
  now: () => number;                     // epoch ms
  wait: (ms: number, token: CancellationToken) => Promise<void>;
  minRequestIntervalMs?: number;         // raised to the floor, never lowered
  lastCompletedAt?: number | null;       // completion instant of a previous operation
}): LuoguSourceGate;

// application/luogu-sync-service.ts
export type LuoguSyncErrorCode =
  'account_missing' | 'account_foreign' | 'not_connected' | 'busy' | 'closing' | 'invalid_input'
  | 'stale_revision' | 'unsupported' | 'cleanup_failed' | 'lease_lost' | 'internal';
export class LuoguSyncError extends Error { readonly code; readonly details }

export type LuoguSyncStartMode = 'resume' | 'full';
export type LuoguSyncStartOutcome = 'started' | 'coalesced' | 'queued';
export type LuoguSyncSkipReason =
  'automation_disabled' | 'startup_disabled' | 'not_connected' | 'paused' | 'not_due' | 'busy' | 'already_running';

export interface LuoguSyncStatus {
  accountId; sourceInstanceId; settings: LuoguSyncSettings;
  connection: LuoguConnectionState | null;   // INTERNAL: opaque reference for adapter wiring; 17d must project it away
  phase: LuoguSyncPhase; historyComplete: boolean;
  resumePending: boolean; scanSince: string | null;    // frozen bound of the stored checkpoint
  running: boolean; leaseOwner: string | null; leaseExpiresAt: string | null;
  paused: boolean; failure: LuoguSyncFailure | null; nextRunAt: string | null;
  scanStartedAt; lastScanStartedAt; lastSuccessAt;
  pagesInPass; totalPages; submissionsSeen;
  metadataBacklog: number; metadataBacklogFull: boolean;
  metadataResolved: number; metadataFailed: number; backlogDropped: number;
  closing: boolean;
}
export interface LuoguSyncStartResult { accountId; mode: LuoguSyncStartMode; outcome: LuoguSyncStartOutcome; status: LuoguSyncStatus }
export interface LuoguSyncSweepResult { started: readonly string[]; skipped: readonly LuoguSyncSkip[] }
export interface LuoguSyncSettingsPatch { automaticEnabled?: boolean; runOnStartup?: boolean; intervalMinutes?: number }
export interface LuoguSyncServiceOptions {
  store: TrainingStore & LuoguSyncStore;
  imports: ImportService;
  connections: LuoguConnectionManager;
  sourceInstance: SourceInstance;
  submissionsFor: (account: Account) => SyncPageSource;   // stored-session reader
  metadataSource: PlatformAdapter;                        // anonymous; only fetchProblem is used
  ownerId: string; now: () => string; wait: (ms, token) => Promise<void>;
  gate: LuoguSourceGate; limits?: PlatformLimits; leaseMs?: number;
}
export class LuoguSyncService {
  constructor(options: LuoguSyncServiceOptions);
  status(accountId: string): Promise<LuoguSyncStatus>;
  configure(accountId: string, expectedRevision: number | null, patch: LuoguSyncSettingsPatch, token?): Promise<LuoguSyncStatus>;
  connect(accountId: string, sessionCookie: string, token: CancellationToken): Promise<LuoguSyncStatus>;
  probe(accountId: string, token: CancellationToken): Promise<LuoguSyncStatus>;
  disconnect(accountId: string, token: CancellationToken): Promise<LuoguSyncStatus>;
  start(accountId: string, mode: LuoguSyncStartMode, token?): Promise<LuoguSyncStartResult>;  // returns after the durable reservation
  cancel(accountId: string): Promise<LuoguSyncStatus>;   // cancels and drains that account's pass
  settle(): Promise<void>;                               // waits until no pass is running or queued
  startup(token?): Promise<LuoguSyncSweepResult>;         // runOnStartup accounts, still due-gated
  tick(token?): Promise<LuoguSyncSweepResult>;
  close(): Promise<void>;                                // closing + cancel + drain of every operation
}

// adapters/luogu/connection.ts
export type LuoguBoundSessionReader = LuoguSessionReader & { readonly sourceInstance: SourceInstance };
export interface LuoguConnectionStore {
  getAccount; getLuoguConnection; saveLuoguConnection; deleteLuoguConnection;
  listLuoguConnectionJournal; appendLuoguConnectionJournal; removeLuoguConnectionJournalEntry;
}
export interface LuoguConnectionAdapterOptions {
  store: LuoguConnectionStore; vault: LocalCredentialVault; sourceInstance: SourceInstance;
  now: () => string; newReference?: () => string; limits?: PlatformLimits;
  gate?: LuoguSourceGate | null;
  createReader?: (sessions: LuoguSessionProvider) => LuoguBoundSessionReader;
  transport?: { fetchImpl?; clock?; wait?; setTimer?; maxResponseBytes?; maxRedirects? };
}
export function createStoredLuoguSessionProvider(options: {
  store: LuoguConnectionStore; vault: LocalCredentialVault; requireConnectedStatus?: boolean;
}): LuoguSessionProvider;
export function createStoredSubmissionsSource(options: {
  store; vault; sourceInstance; requireConnectedStatus?; createReader?; transport?;
}): (account: Account) => SyncPageSource;
export class LuoguConnectionAdapter implements LuoguConnectionManager { capabilities(); connect(request); probe(accountId, token); forget(accountId, token) }
export function createLuoguConnectionManager(options): LuoguConnectionAdapter;
```

## Semantics implemented (and how)

- **Source-wide gate**: every platform operation of one instance — history pages, metadata fetches
  and connection validation — runs through one shared `gate.run(token, work)`. Operations are FIFO
  serialized, and the next one starts at `max(completedAt + 2000, ...)` measured from the *previous
  operation's completion*, not its start, because one `listSubmissions` call walks several server
  pages. A queued call whose token was already cancelled rejects without running `work`, and a
  failing or cancelled operation still opens the quiet-time window for its successor.
- **Reservation** runs in one store transaction that scans *every* stored Luogu account and its
  state (not `listLuoguConnections`), so an account that is connecting right now — and therefore
  has no connection row — still blocks a foreign pass. A live foreign lease is `busy`; only an
  expired one is recovered. `connect`/`probe` take the same lease, so cross-instance source
  exclusivity covers connection work too.
- **Whole-scan start is frozen.** A new scan writes `scanStartedAt` once; resumed passes keep it,
  `syncPage` continues from `checkpoint.cursor` with `checkpoint.since`, and completion sets
  `lastScanStartedAt` to that *original* instant. A >7-day interruption was tested with a 21-page
  backfill: no record skipped, none duplicated.
- **Incremental bound** = last successful scan start − 7 days inclusive (`LUOGU_SYNC_OVERLAP_MS`),
  frozen in the checkpoint for partial attempts. Completion only ever comes from `nextCursor: null`.
- **Phase/history independence**: a failed pass leaves `historyComplete` untouched; `full` sets
  `phase: 'reconcile'` + `historyComplete: false` without deleting rows; metadata-only passes do not
  advance history watermarks.
- **Commit hook**: `onPageCommitted` re-reads the state inside the page transaction, refuses a lost
  or expired lease (`lease_lost`), refuses keys that would overflow the backlog, and writes
  progress + backlog + lease renewal atomically with the page rows and checkpoint. No network there.
- **Page size and backpressure**: each history request asks for `min(LUOGU_SYNC_PAGE_SIZE = 50,
  limits.pageSize)` rows, so a smaller configured page size is honored instead of failing the pass,
  and the 50-row cap stops one operation from walking an unbounded page. Paging stops *before* the
  fetch when fewer than 50 backlog slots remain; the continuation stays durable; `backlogDropped`
  stays `0` and a key is never forgotten.
- **Metadata repair**: `refreshProblemMetadata` only (tests assert `fetchEditorial` is never called),
  ≤10/pass, each key at most once per pass, failures rotated to the end of the durable backlog so a
  permanently failing key cannot starve the others, failures counted and typed while already
  imported submissions stay.
- **Automation**: per-account settings, off by default, `startup()` honors the account's
  `runOnStartup` and both sweeps honor a durable due instant (`failure.retryAt`, one interval after
  the last success, or one interval after the last durable write of an unfinished scan), so a restart
  cannot loop. Only `connected` + enabled accounts are eligible.
- **Backoff and pausing**: `rate_limited` honors `Retry-After` exactly; other retryable failures
  double from `LUOGU_SYNC_MIN_BACKOFF_MS` (derived from the persisted previous `retryAt − at`, hence
  restart-safe) up to the contract ceiling. `auth_required`/`forbidden`/`changed_response`/
  `not_connected`/`unsupported`/`cleanup_failed` pause until an explicit action (`start` or a
  successful `connect`), and a typed **`invalid_input`** refusal is likewise recorded as a pausing
  failure — automatic retries stop until an explicit action instead of replaying the same refusal.
- **Cancellation/close**: a cancelled pass keeps every committed page and checkpoint, records no
  failure, and automation resumes it at the next durable due instant. `close()` marks closing,
  cancels the running pass *and* every connection operation, drains all of them and only then
  returns; later operations are `closing`.
- **Connection protocol (order matters)**: resolve the already stored canonical account; recover
  orphaned journal references; test the ephemeral cookie through the real reader; clean a previously
  recorded stale reference; allocate a fresh opaque reference and **journal it durably before the
  vault write**; then persist the connection under revision CAS. The revision itself is issued from
  the per-account `luogu_connection_generations` tombstone, so a deleted revision is never reissued
  and a writer prepared against an older revision can neither update nor delete the replacement.
  A CAS/validation failure removes only the fresh reference (compensating cleanup uses a
  never-cancelled token so an abort cannot orphan it); a failed previous-secret removal stays
  visible as `staleReference` and is retried by the next probe. Recovery *adopts* a journaled
  reference that is the row's current or stale reference (never deleting a working session) and
  removes only genuine orphans. `forget` removes credentials before the row so a failure leaves a
  retryable, addressable row, then retires journal entries and deletes under CAS.

## Commands actually run (all from `D:\dsh-icpc-workbench`)

1. `npm run typecheck` → **pass** (exit 0).
2. `npm run check:architecture` → **pass** (exit 0; "Architecture imports satisfy the declared layer
   boundaries").
3. `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/sync/luogu-source-gate.test.ts tests/storage/luogu-sync.test.ts tests/storage/schema.test.ts tests/sync/luogu-connection.test.ts tests/sync/luogu-sync-service.test.ts tests/import/import-service.test.ts tests/platform/luogu-session.test.ts tests/vault/credential-vault.test.ts`
   → **121 pass / 0 fail**, exit 0 (duration ≈ 5.5 s). Per file: source gate 3, Luogu storage 10,
   storage schema 13, connection 14, sync service 12, import service 28, Luogu session reader 28,
   portable credential vault 13.
   - This includes the case that failed before this repair
     (`unlinked credential references are journaled durably, per account, and carry no secret`),
     which now rejects with `corrupt_row` for the canonical account id.
4. Native Windows vault: `tests/vault/credential-vault-windows.test.ts` was **not run in this
   invocation** (it drives the real OS credential store). The coordinator verified the native vault
   separately in the earlier invocation; this round's vault evidence is the portable
   `tests/vault/credential-vault.test.ts` run above.

No whole-project suite, no build, no network call and no user-data access were made, per contract.

## Test coverage

Gate: the floor is measured from the previous operation's *completion* (an operation spanning four
seconds delays the next by the full floor); a rejected or cancelled operation releases the queue and
still opens the quiet-time window; a missing operation is a typed refusal; the caller's token is
passed through; a prior completion instant delays the first operation.

Connection: connect validates through the real reader and survives a restart; another account's
cookie is refused with the previous connection and vault untouched; a compare-and-set loss keeps the
old connection and removes only the fresh reference; a failed previous-secret cleanup keeps the new
connection usable and clears on a probe retry; probe records `session_expired`/`schema_changed`/
`unavailable` without echoing a secret marker; forget is CAS-guarded, account-scoped, idempotent and
also removes journaled references; an unsupported platform stays constructible and honest; the
stored-session provider re-reads connection + vault per call; a crash between the vault write and
the link leaves a journaled reference the next operation cleans; recovery never deletes an adopted
credential; a vault write that commits and then fails is compensated; a CAS loss whose cleanup also
fails keeps the orphan recoverable; connect refuses to report `connected` when the stored row was
removed or replaced; a deleted connection revision is never reissued.

Service: connect → backfill → checkpoint → incremental resume → AC projection → reconnect
persistence; 20-page partial pass + >7-day interruption resuming the same whole scan; manual full
reconciliation without deleting rows; backlog backpressure with no dropped keys and no watermark
advance; metadata bounded/fair/never-editorial with durable retry; per-account automation, startup
opt-in, no restart loop; live foreign lease refused / expired lease recovered / stolen lease rolls
the page back; disconnect draining and account isolation; `Retry-After` backoff and pausing auth
failures; a configured page size below the 50-row cap honored instead of failing; `invalid_input`
pausing automatic retries; close drain and post-close refusal.

Storage/import/reader/vault: the v7 schema, CAS and corruption behavior, the write-ahead journal and
generation tombstone, the import commit-hook and metadata-only paths, the authenticated reader's
sanitization/redirect/limit rules, and the portable vault's reference, capacity, cancellation and
error-projection rules.

## Remaining work for 17d (out of scope here)

1. Project `LuoguSyncStatus.connection` away before it reaches the UI/model, and expose the rest
   through the business API.
2. Host composition: one `createLuoguSourceGate` shared by the service and the connection adapter,
   a host `wait` port, `tick()` on a host interval, `startup()` once at host start, and the
   anonymous `PlatformAdapter` as `metadataSource`.
3. UI for connect/probe/disconnect, settings (`configure`), manual resume/full, status display.
4. Version bump, package `files`/exports acceptance, and any host-level cancellation wiring.

## Open issues / notes

- The accepted 17a reader folds every non-login HTML answer into `changed_response`, so this adapter
  maps that to `schema_changed` and the `challenge` connection status is unreachable by this
  implementation (documented in the adapter header). Distinguishing a CAPTCHA needs a reader-level
  discriminant.
- A `full` request made while another pass runs is queued in memory only; a restart drops the queue
  (the durable state stays honest). The same is true of `settle()`'s knowledge, not of any durable
  fact.
- `leaseMs` defaults to `max(120 s, one page's worst case under the configured limits)`, so a valid
  request cannot outlive its lease; `pagesInPass` resets per pass while every watermark is preserved.
- `close()` rethrows the first *bookkeeping* failure (a settlement write that failed after all page
  data was committed) once everything is drained; operation cancellations themselves are observed by
  their own callers.
- Canonical account ids are compound and escape their instance part, so a hand-written
  `luogu:www.luogu.com.cn:<handle>` literal is never a valid lookup key. Tests and callers must use
  the id produced by the domain factories (`accountIdOf`).
