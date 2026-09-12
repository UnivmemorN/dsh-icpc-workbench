# Model HTTP API acceptance

Thirteen model/settings routes use the accepted controller and versioned transport. Requests have closed field sets, bounded identifiers and nested settings validation. Paid starts return 202; settings_changed/model_busy/model_invalid return fixed 409 errors, with no automatic retry. Full-solution starts require an explicit flag.

Four real SQLite/controller tests verify batch preparation and settlement, stale settings, aborts, free coaching replay, default body omission, explicit reveal, terminal refusal, registration rollback and once-only cleanup. Focused tests passed; the combined host check passed 525 behavior tests and 7 script checks.

Coordinator implementation completed this binding after dsh construction was stopped to preserve the remaining acceptance budget. No paid model was used in these tests.