# Architecture

> **开发参考** · [开发文档索引](development/README.md) · 日常操作请看[用户手册](user/README.md)。本文保留既有地址，供实现与排错核对。


## Runtime
TypeScript ESM, React and node:sqlite. Deliver one installable Cordis bundle with host and client halves.
Support baseline: dsh 0.1.5-rc.2, source commit fb2c4b9e698e30edb738bca4cf0618587db7d203.

Dependency direction:
- domain: immutable problem snapshots, submissions, evidence, tag decisions and training plans; pure rules.
- application: use cases and PlatformAdapter / ModelGateway / TrainingStore interfaces.
- adapters: CF, Luogu, SQLite and dsh implementations.
- ui: workbench rendering through the versioned API.
- plugin: validates configuration, injects services and registers disposable effects.

An explicit pipeline gathers normalized material, freezes a versioned problem snapshot, analyzes it, verifies evidence, and transactionally adopts a result.
Job progress, quotas and cancellation are persisted separately. Changed input or manual decisions make old results stale.
Storage is independent of dsh internals. IDs include source instance, domain and external key; submissions additionally identify the account.
Do not infer mastery of every possible solution from an AC submission.

## Integration
Use dsh Connection Fetch registrations below /api/icpc/v1/ to retain authentication and origin checks.
Register sidebar.panellist and a keyed main panel; use layout.selectPanel for entry/exit.
Model requests go through ctx.llm and are reconstructed from dedicated Session logs.
Platform/model/store implementations expose capabilities. Hydro is planned, never advertised as implemented.
Use validated runtime configuration for model roles, budgets, data directory, timeouts and concurrency.

## Compatibility
Pin the tested host and SDK versions. Refuse unsupported versions/capabilities before activation.
Build the bundle without needing a sibling harness source checkout.
Use SQLite schema versions, backup before migrations, reject databases from newer versions.
Uninstall preserves user data. Test in an isolated profile before installing in the existing Web profile.

## Reference
NovaPhy supplies the ideas of explicit data ownership, immutable model inputs, caller-owned state and capability-bearing interchangeable backends.
Do not mechanically translate its physics-specific classes or C++ build layout.
## Merged bank
The additive problem.mergedBrowse read model groups canonical CF/Luogu mirror identifiers while retaining each native problem key. Selected accounts are explicit and limited to one per source instance. Linked AC is attributed to stored accepted submissions and never written into another platform's history or substituted into native spoiler/weakness/plan rules. SQL groups before counting and paging; materialized member identities prevent correlated source/search filters from repeatedly scanning the bank. No schema migration is required. See docs/merged-bank.md for current mapping boundaries.

## Bulk material refresh
A distinct durable aggregate refreshes platform material for 1..100 stored problems; it is deliberately separate from the tag-analysis pipeline and can name no model, budget or model attempt, so it never prepares, starts or resumes a paid analysis. Six exact `material.prepare|start|detail|list|cancel|retryFailed` POST routes (`src/plugin/material-batch-api.ts`) sit over one `MaterialRefreshBatchService` under the same `/api/icpc/v1` origin and authentication checks; the accepted single-problem `material.refresh` route and DTO are unchanged.

Schema v11 adds one additive `material_refresh_batches` table (a canonical-JSON body plus indexed batch id, status, revision, timestamps and item count) with the established pre-migration backup, rollback and newer-database refusal. `prepare` writes a `prepared` batch locally and free after proving every canonical problem and same-instance account against the store; only the explicit `start` performs platform IO (202 answer, then owned background work).

Every item reuses the accepted single-item `ImportService.refreshMaterial` path once per attempt, and one batch runs at a time (global platform concurrency one), so the Luogu source FIFO/pacing gate, the transport-level Retry-After cooldown and the per-item optimistic snapshot-head check are preserved; the batch layer adds no hidden retry. Partial failure is normal: auth, permission, rate limit, unavailable, changed-response, missing-reference, stale-head and interrupted outcomes become sanitized retryable item findings carrying a stable code plus retry metadata, later items continue, and an operational failure is never reinterpreted as a confirmed `absent` editorial.

Answers are metadata-only projections: canonical keys, statuses, timestamps, failure codes and retry metadata, statement/editorial/mirror status, snapshot id/version/hash/change flag and counts. The stored official tutorial URL becomes a boolean and the stored account id (which encodes its handle) is dropped, so no statement, raw tag, editorial body, account handle, URL or provider error text is representable.

Activation recovery converts a `running` batch left by a dead process to `paused` with its in-flight item retryable and performs no network work. Disposal refuses new mutations, cancels owned runs, waits one shared finite deadline, leaves a detached run durably paused/interrupted and never leaks an unhandled rejection. No model gateway and no budget counter is reachable from the aggregate, the service or the routes.
