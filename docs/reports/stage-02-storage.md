# Stage 2 — SQLite acceptance
Coordinator acceptance, 2026-09-12. Implemented by dsh / deepseek-flash / max; independently reviewed and tested.

Independent npm run check passed: 64 domain/storage behavior tests, 3 accounting tests, strict TypeScript, architecture import checks, and independent ESM build.

The store persists sources, accounts, submissions, problems, immutable snapshots/results/decisions, job counters/leases, manual revisions, retrospectives, plans and sync checkpoints. Tests cover close/reopen, identity scopes, idempotence, head monotonicity, rollback, concurrent outsider survival, cancellation-state lease recovery and consistent WAL backups.

Review repair covers nested-transaction rejection, transaction-scope escape, backup deadlock prevention, close/queue races, job identity guards, corrupt JSON object boundaries, byte-for-byte newer-schema refusal and backup-before-migration ordering. Nested transaction callbacks are deliberately rejected; normal reads/writes inside a transaction are supported.

Schema v1 supports a recognized metadata-only v0 migration, with verified SQLite backup before migration. Arbitrary foreign databases are refused. Failed migrations retain their original journal mode and readable data.

Limits: row decoding validates object boundaries/required SQL columns, not every domain field. Untrusted input needs adapter/API runtime validation. Pipeline, durable batch accounting, platform adapters, model calls, host API, UI and release acceptance are still outstanding. Worker request-limit stops are construction limits, not acceptance signals.
