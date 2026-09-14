# Stage 25a — Luogu metadata diagnostics

Implemented by dsh with the official Flash model at max effort. The final transaction, migration and manual recovery behavior is covered by [25a2](stage-25a2-recovery-correctness.md), [25a3](stage-25a3-manual-recovery.md) and the [release acceptance](stage-25-acceptance.md).

The platform error contract now carries a closed, body-free reason: missing statement, HTML response, invalid JSON or invalid payload. The Luogu parser identifies an empty description explicitly; it never infers a reason by matching an exception message. A missing statement remains incomplete and queued, while the synchronization batch can process other keys. Verification pages and unrecognized source responses retain their pause behavior.

Per-key diagnostics record only canonical problem identity, error code/reason, time and bounded failed-attempt count. Existing state without per-key diagnostics remains unknown and is not retrospectively attributed. The new paginated backlog and exact-one retry endpoints expose these fields without response bodies, snippets or credentials.

The initial worker ran 13 new diagnostic tests, the 172 platform tests, 54 existing synchronization tests and 17 API tests. Coordinator review identified and corrected the initial retry transaction nesting before release; passing those initial suites alone was not acceptance of retry success. Dedicated real SQLite success, cancellation, contention and migration tests were subsequently added and passed. Only synthetic material was used in workers and repository tests.
