# Stage 27 — recoverable problem management

Version 0.1.21; SQLite schema 10; tested host 0.1.5-rc.2.

Luogu backlog management now offers pending, skipped and recycle-bin tabs with per-item and bounded page selection. Skip suppresses metadata work while preserving evidence. Trash hides the native problem, submissions and retrospectives from bank, merged AC evidence, statistics and new ability/planning inputs. Raw rows remain recoverable and incoming synchronization cannot remove a disposition. Restore requeues absent or blank statements and preserves the latest stored evidence.

Mutations use the existing source lease, one transaction and expected-state checks. Every related source account queue is updated together. Cancellation, lease expiry, a stale selection or restore overflow rolls the batch back. Read and mutation routes are authenticated, local-only and usable without a cookie. Native keys on other platforms are independent; historical reports/plans remain snapshots.

The migration adds one table after a verified backup. Genuine v8/v9 preservation and rejection of newer formats are covered. Regression checks cover merged count/paging, disappearance of accepted evidence, raw reimport, restart, restored data, zero platform IO, invalid batches and expiry after awaited work.

Validation: full npm run check passed: 1,318 application tests passed, one pre-existing optional test skipped; 20 script tests passed; type/architecture/build/client checks passed. dsh Flash max implemented service/API integration and targeted correctness repairs; coordinator reviewed storage, migration, UI and verification.

Packaged acceptance passed on the local installed host: all original table fingerprints and settings preserved across the schema9→10 upgrade, a verified pre-install backup retained, and every installed dist file matched the built package.

Browser acceptance used 26 explicitly synthetic, disconnected Luogu records. Per-item skip reduced the backlog to25 without removing evidence. Batch trash of2 reduced solved count26→24 and showed exactly2 recovery entries. A skipped item could also move to trash. Batch restore of3 emptied the recycle bin and restored backlog/solved counts to26, including blank stored statements. Last-page navigation cleared prior-page selection. Synthetic-only cleanup proved every original table fingerprint identical to the pre-fixture baseline. The real account was returned to the pending/skipped/recycle-bin entry without applying any management action to real problems.

Visual inspection caught vertical checkbox labels; these reuse the existing horizontal checkbox style, and the current management tab is highlighted. Typecheck/build/client checks were repeated for this presentation-only correction. Companion balance plugin retained. No AI or platform request was used by the recovery actions.
