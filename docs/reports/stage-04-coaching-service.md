# Stage 4s2b — progressive coaching service

Status: implemented locally; focused suite and the full repository gate pass after one acceptance
repair round (stale-answer projection races, sanitized generator exceptions, guarded reservation
recovery). No paid call was made — every test uses a scripted local generator and a real on-disk
SQLite store.

## Scope delivered

- `src/application/coaching-service.ts` (new): `CoachingService` (one store intersection =
  `CoachingStore & TrainingStore & SettingsStore`, generator, injected `now`, bounded-read guard),
  the readonly JSON-serializable ask/history/status DTOs, `CoachingServiceError` (typed
  `invalid_request` / `request_conflict` / `history_overflow` / `storage_inconsistent`) and the
  quota/lease/page constants.
- `tests/coaching/service.test.ts` (new): 22 behavior tests over real SQLite (18 original plus one
  wrapper test per acceptance-repair defect).

## Protocol pinned by the implementation

- `ask({requestId, accountId, problemKey, level, explicitFullSolution?}, token)`: request id is
  the durable attempt id, so a repeat never pays twice; a repeat with another identity is
  rejected. Refusals before generation cost nothing: unknown problem/account, account from
  another source instance, missing snapshot, missing full statement, `full` without the explicit
  flag, unearned hint level (levels 2/3 need **all** lower levels settled), rolling-24h global
  quota, global single-flight.
- One reservation transaction re-reads the head, recovers expired `reserved` rows as `uncertain`
  (timeout error, quota kept), dedups, enforces quota/single-flight, collects `previousHints`
  (latest settled successes, current snapshot, same account scope, levels strictly below), writes
  the reservation (`expiresAt = now + requestTimeoutMs + 30000`, provider/model/promptVersion
  captured) and re-checks the token — a cancellation there rolls the reservation back. No
  provider IO inside any transaction (asserted in tests).
- Settlement is durable and never throws the token: success keeps its text; a success whose
  snapshot stopped being the head settles its cost with a stale error and stores no text; unknown
  usage becomes `uncertain`; a cancellation sampled at settlement is recorded as a `cancelled`
  error with its usage. A cancel racing after the commit hides the return but the settled row
  stays immutable and readable through `getStatus`.
- `history` is metadata-only by default (no `responseText` key, no error messages); a body needs
  exactly one explicit `level` plus `includeResponseText`, and a stale snapshot additionally
  `includeStale`. `getStatus(requestId, accountId, problemKey, token, options)` matches identity
  (mismatch rejects), states `current`/`stale` and hides stale bodies unless explicitly requested.
  Every answer DTO is `verification: 'unverified_ai'`. All internal walks are bounded (500/page,
  10000 bound) and overflow is a typed actionable error instead of a partial quota count.

## Commands actually run

1. `npm run typecheck` → pass.
2. `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/coaching/service.test.ts`
   → 22 tests, 22 pass, 0 fail.
3. `npm run check` → typecheck pass; architecture check pass; 373 behavior tests pass (369
   existing + 4 repair); 6 accounting/context tests pass; `scripts/build.mjs` reports
   "Built independent ESM package in dist."

## Acceptance repair round

Four concrete defects were fixed in `src/application/coaching-service.ts`; `tests/coaching/service.test.ts`
gained one wrapper test per defect. No store, generator, schema, API or UI file was touched.

1. **A stale answer could be projected as a new current answer.** `settlementResult` computed
   `snapshotState` and then returned `answered` with a hardcoded `current` whenever the outcome was
   `answered` and the token was not cancelled, ignoring the computed state. A head that moved after
   the settlement commit but before projection therefore leaked the text as a current answer.
   Success is now gated on `snapshotState === 'current'`; otherwise the return is
   `failed`/`stale_snapshot` with no text, while the already settled immutable cost and history are
   untouched. Test: a real `SqliteTrainingStore` subclass advances the head inside a `transaction()`
   wrapper immediately after the settlement transaction returns and before projection.
2. **`history` read the head before awaiting the page.** A head advance during that await could
   expose a stale response as `current` without `includeStale`. The page is now read first and the
   head re-read at the last await before projection, with the token re-checked after both reads.
   Test: a store wrapper advances the head right after the page read; the default requested-level
   body hides it, and the explicit `includeStale` read reveals it.
3. **Arbitrary exception text reached the durable record.** `settleThrow` copied `Error.message`
   into the durable `gatewayError`, which the immediate ask and the duplicate `resultOfAttempt`
   then exposed. Unexpected generator exceptions now record fixed sanitized messages
   (`provider_error`; a cancelled generation keeps `code: 'cancelled'`), and the attempt stays
   `uncertain` with `null` usage, its quota slot and its host correlation. The optional
   `onInternalError` hook is the only place the raw value is handed out, and it runs after the
   settlement is durable. Test: a thrown message carrying a sentinel secret and a credentials path
   never appears in the JSON of the first result, the dedup result, the durable row, `history` or
   `getStatus`, while exactly one attempt is counted with `null` usage and the hook still receives
   the original error.
4. **Reservation recovery could return through an early branch without a token check.** Recovery
   writes happen at the top of the reservation transaction, but the `existing`/refused branches
   returned with no token check, so a pre-dispatch cancellation could commit recovery writes. The
   token is now thrown at the transaction entry, after each awaited recovery write and before every
   early return, so the whole transaction (recovery included) rolls back. Charged settlement is
   deliberately untouched: there the token stays sampled, never thrown. Test: a store wrapper
   cancels right after the recovery write for (a) a dedup branch and (b) a branch that would
   otherwise be refused as `level_not_earned`; no model call happens, no new row appears and the
   original expired row stays `reserved`. The existing cancel-after-paid-write tests stay green.

## Open issues / notes

- The durable attempt vocabulary is the model-gateway vocabulary, so a stale completion is stored
  as `provider_error` with an explicit "discarded as stale" message; the immediate ask DTO
  reports the precise `stale_snapshot` code and the attempt view always states `snapshotState`.
- A cancellation that lands after the reservation commit but before dispatch settles the
  reservation with known-zero usage, so it occupies one audit row and therefore one quota slot;
  deleting audit history is not a supported store operation.
- Semantic level discipline (a level-1 answer really being conceptual) remains a prompt
  obligation, not verified here, as contracted.
- A thrown generator is settled as `uncertain` with a fixed sanitized message, so the raw diagnostic
  value is only available through the injected `onInternalError` hook; without that hook a thrown
  generator leaves no forensic detail beyond the sanitized code.
