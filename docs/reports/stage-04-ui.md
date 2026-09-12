# Stage 4 — Workbench UI and durable audit integration

The browser entry uses the public main slot, sidebar panel list and layout selection contracts. Today, problem bank, tag review, weakness, plans and settings all use the typed /api/icpc/v1 business API. No browser code reaches SQL, provider credentials or platform HTTP directly.

Implemented workflows: bounded catalog/submission sync; JSON/CSV preview with content-hash confirmation; current and stale snapshot evidence; manual tag review; progressive hints and explicit full-solution requests; metadata-first history and caller-owned replay IDs; completion-method retrospectives; minimum-sample weakness; rule-plan preview/adopt/edit/checkoff; settings revisions and local backup. The shipped classic browser factory shares host React and owns disposable styles/slots.

Live integration identified three defects, now addressed:
- An empty search field was sent as a non-empty-string API field. Empty search is now omitted.
- Settings allowed zero calls while batch validation required positive quotas. Zero disables analysis/reasoning; concurrency remains positive.
- sessions.flush only reports participating observers. It does not create a durable session handle. The adapter now prepares a detached public Session, owns a sessionPersistence handle, serializes append/flush and closes it after owned operations settle. Detached sessions avoid duplicate writes from automatic live-event routing. Plugin audit records carry the documented ignorable marker for host conversation reconstruction, preserving every payload and sequence number. Training decisions remain separately durable in SQLite.

The initial live model trial also exposed an undocumented output constraint: at most one evidence entry per source/solution pair. Analysis prompt v2 spells this out; strict literal evidence validation remains intact. First-pass failures and costs are retained in the private benchmark report, never replaced with success.

Validation: type checking, dependency-direction check, 532 behavior cases and 9 script cases; package build and classic-factory/shared-React/disposal smoke. An isolated real dsh installation mounted the workbench; actual browser entry, navigation, search, spoiler withholding/reveal and missing-statement hint refusal were observed. A zero-paid-call probe wrote and reread both audit event kinds through the mounted persistence backend. Broader browser acceptance and the final 30-case scoring remain in progress.

Budget reconciliation uses a user-reported platform total of approximately CNY30 plus CNY5 contingency. Original run estimates remain immutable; only later runs add to the reconciled baseline. This is a conservative coordinator ledger, not a claim that the provider charged CNY35. Original CNY100 ceiling and CNY90 new-dispatch threshold remain.
