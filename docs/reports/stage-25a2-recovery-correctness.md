# Stage 25a2 — Recovery transaction and storage correctness

Implemented by dsh Flash max and reviewed with additional coordinator tests. The final code separates the retry mutation from its outer transaction: successful imports mutate the queue within the existing import transaction, while failed attempts open their own transaction. Ordinary batch success also commits the problem, snapshot and dequeue together. Lease ownership, fresh expiry, cancellation and queued membership are checked at the write boundary. Failure reasons remain body-free; retry keeps unrelated history failures and sibling order.

Schema 9 protects the changed JSON state format from older writers. The table set is unchanged. The historical v8 migration helper still writes literal version 8, and a genuine v8 database upgrades after a verified backup without rewriting existing account, source or synchronization JSON.

Verified with real SQLite:

- Synchronization service suite: 64 passed (54 existing cases plus 10 recovery regressions). New cases cover blank-statement deferral followed by a successful import, source-pausing HTML, paginated known/unknown diagnostics, successful single-key snapshot commit, failed retry/history preservation and attempt saturation, cancellation/takeover/expiry after fetch, active same/other account leases and a key removed while waiting in the source gate. A delayed failed-batch state read also rechecks cancellation and fresh lease expiry before diagnostics or queue rotation.
- Dedicated upgrade suite: 2 passed. A genuine v8 fixture preserves legacy JSON byte-for-byte and produces a readable v8 backup; a future-version file is refused unchanged.
- TypeScript checks passed. Full release validation is recorded in [stage 25 acceptance](stage-25-acceptance.md).

Commands: native Node strip-types test runner with `tests/loader.mjs`, targeting `tests/sync/luogu-sync-service.test.ts` and `tests/storage/luogu-recovery-upgrade.test.ts`; `npm run typecheck`. All accounts and problem keys in tests are synthetic. No live records or credentials were sent to implementation workers.
