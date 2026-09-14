# Stage 30 — Luogu authenticated problem metadata recovery

## Result

Version 0.1.23 fixes a mismatch between authenticated submission synchronization and anonymous-only problem metadata retrieval. A known queued problem may require a logged-in reader even when its website page and submission history are accessible to the user. The previous UI also lost the useful `auth_required` diagnosis when no more specific parser reason was recorded.

The synchronization service now tries anonymous metadata first. Only an explicit `auth_required` outcome selects one authenticated fallback for the same problem and current account. Both per-item recovery and backlog draining use this path. Other failures do not broaden credential use. A final authentication refusal pauses for user action; a `forbidden` U/T problem or an explicitly empty statement stays queued while other items can proceed.

The UI explains the recorded failure code even without a parser reason, distinguishes authentication, access refusal and empty statements, and points to retry, login checking or manual recovery. Old records do not claim that authenticated fallback already ran. User instructions remain under `docs/user`; technical details remain in developer documentation.

## Implementation and boundaries

- `src/adapters/luogu/problem-session-reader.ts` binds an existing stored-session provider to one account and exact official HTTPS problem URL. Only the normalized `__client_id` / `_uid` pair is attached; unrelated cookies, alternate paths and cross-origin redirects are refused. The ephemeral cookie and problem binding are cleared on completion, failure or cancellation.
- `src/application/ports.ts` introduces the narrow metadata source port, consumed by `ImportService`. `LuoguSyncService` owns the anonymous-first fallback, separate paced gate operations and lease/membership checks immediately before each request. Configured-reader initialization failures remain visible with sanitized errors rather than masquerading as missing login.
- `src/plugin/luogu-host.ts` composes the fallback using the existing OS credential vault and stored-session provider. It does not create a second credential store or access model provider keys.
- Metadata, snapshots and queue resolution commit together through the existing transaction hook. The successful fallback resolves one item without incrementing the final failure counter for the initial anonymous refusal.
- This change covers account synchronization and queued metadata recovery. Generic anonymous catalog browsing is unchanged. It does not guarantee access to restricted or unavailable problems and does not fetch editorials with the session.
- No database migration: schema remains 10. No AI call is made for metadata synchronization or recovery.

## Validation actually performed

- Adapter behavior tests cover account/PID binding, the minimal cookie pair, redirects, cancellation, pacing, retries, byte limits, fresh sessions, overlapping calls and sanitized errors.
- Real SQLite integration tests cover anonymous success, one fallback, bulk draining, final authentication refusal, forbidden/empty/challenge/rate-limit outcomes, missing sessions, cancellation, lease takeover, factory failures and atomic queue recovery. Host composition tests check current-account isolation.
- Focused local review suite: 53 passed. The coordinator corrected a concurrency-test hang and added factory error, malformed source, foreign source and cancellation regressions.
- `npm run check`: type checking and architecture checks passed; 1,355 business tests with 1,354 passed, zero failed and one existing platform-conditional skip (the non-Windows vault case on Windows); 20 script tests passed. Independent ESM build, browser factory, shared React, disposal, math CSS and embedded font checks passed.
- Packaged installation on the local acceptance profile: version 0.1.23, schema 10. A verified offline SQLite backup preceded restart. Every table and setting matched its pre-upgrade baseline; all configured model roles remained official Flash. The balance companion plugin was retained and remained visible.
- Documentation/package audit: 40 documents, 243 local file links, no errors; installed package contains 10 user documents and no developer documents.
- Live platform reproduction: the reported problem returned anonymous HTTP 401; the account-bound reader retrieved its title and nonempty statement using the existing saved session. A subsequent real `luogu.retryMetadata` call resolved exactly that queued item. All non-target rows, submission/AC evidence, completion records, history coverage and checkpoints matched the pre-retry baseline; no model attempts were created.
- Browser acceptance on the installed package: the old code-only failure displayed the new login guidance; the recovered problem appeared in local search with its existing passed status, and the detail panel rendered its statement sections and samples.

Implementation was primarily completed by dsh with official Flash at max reasoning; the coordinator reviewed, repaired remaining issues locally, verified the package and performed live acceptance. Synthetic fixtures are committed. Real account identifiers, credentials, fetched statement bodies, runtime logs and backups remain local and excluded from Git.
