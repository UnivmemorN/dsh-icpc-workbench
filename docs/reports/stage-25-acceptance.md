# Stage 25 — Luogu synchronization recovery and model credential boundary

Installed release: 0.1.20, schema 9; compatible host baseline remains 0.1.5-rc.2.

## Result

The account page now exposes a collapsed, paginated metadata backlog with body-free per-problem failure reasons, exact single-problem retry, and a manual title/Markdown supplement. Legacy failures remain explicitly unknown until observed. Empty descriptions stay queued while the batch can continue; authentication, HTML/challenge responses and rate limits remain source-level stops. Each successful metadata/snapshot write and dequeue is atomic, with cancellation, source lease and snapshot conflict checks. Manual supplementation never adds accepted submissions or confirms tags.

Model calls use dsh's public LLM service and retain the Flash-only policy. Workbench configuration does not accept provider credentials. Newly recorded upstream exceptions and provider-failure diagnostics use closed local projections; model input/output material remains audited verbatim. This does not erase historical logs or control host-side credential storage/logs. See [credential boundary](../credential-boundary.md).

## Verification

Implementation was principally carried out through dsh official Flash at max effort. The coordinator reviewed transaction boundaries, draft conflict handling, cancellation messages, public route registration and diagnostic projections. All committed test data are synthetic. Runtime evidence, account identifiers, model transcripts, downloaded material, balance records and backups remain local and are excluded from publication.

`npm run check` passed: typecheck, architecture, 1,304 native tests passed with one environment skip, 10 budget/context tests, independent ESM/browser build, scoped math assets and classic client/disposal verification. 

Installed the packed build into the existing isolated dsh profile after a fresh verified offline SQLite backup. The schema 8 to 9 upgrade preserved every business table and every workbench setting exactly. Every configured model role remains official Flash. All 750 installed dist files match the independently built package byte-for-byte. Client SHA-256: 6569c520c251d62d07484636467d2f47297a21e0c4bfa5dccf640ef1d5b2bdef.

One previously diagnosed live queued item was retried through the installed API. The platform again returned an empty description: outcome deferred, reason missing_statement, one diagnostic attempt added. The queue order, history coverage, checkpoints, existing problems, accepted submissions, tags and all other business tables were unchanged. No model calls were added. This confirms that failure only; legacy queued items are not assumed to share its cause.

Browser acceptance on the installed build passed: collapsed recovery entry; known failure reason and honest unknown legacy rows; first/next/last paging; 20 to 25 page-size change with 25 rendered rows; required title/body validation; unsubmitted draft discarded on close and absent after reopening; paging unmounts the form and leaves retry enabled; no stale start notice. No invented metadata was saved into real records. The browser is left on the recovery list.

Manual save, CAS conflicts, disconnected operation, exact-key authorization and transaction rollback were tested with real SQLite and synthetic accounts; live manual saving was deliberately unnecessary for data-preserving acceptance. CI results are available on the corresponding GitHub commit.
