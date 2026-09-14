# Stage 29 — visible page selection and compact completion editing

Date: 2026-09-14. Version: 0.1.22. Schema: 10 (unchanged).

## Problem and result

With 100 problems per page, the existing page-selection and completion-editing actions were below the entire table. The table header had no master checkbox. Opening the bulk editor also put 100 current-record rows before the completion-mode selector.

The bank now has a shared top/bottom action bar, with the top copy staying visible while scrolling. The header checkbox shows none/partial/all selection. Full-page toggling and explicit current-page removal preserve selections on other pages; selection remains bounded at 100 with a visible omitted-row count. Users can also select only the current page's confirmed unrecorded problems or clear the whole selection. Loading/failed reads disable page-derived choices.

The completion editor opens above the bank table, with an offset measured from the wrapping toolbar. Bulk current-record and preview tables start collapsed; counts and modification warnings remain visible. The existing explicit mode choice, preview hash, stale-draft rejection and manual apply remain intact. A single problem keeps its one-row details open.

User instructions: [problem bank guide](../user/problem-bank.md). Implementation reference: [completion editing](../completion-editing.md). The merged bank continues to refer completion editing to the platform-specific bank.

## Checks performed

- Focused completion-view behavior tests: 21 passed, including tri-state selection, cross-page removal, bounded union, duplicate keys and pending/error readiness.
- Final `npm run check`: typecheck, architecture checks, main tests (1,324 passed, 0 failed, 1 existing optional skip), 20 script tests, independent build and classic-client validation passed.
- Package documentation audit: 40 documents, 243 local/repository file links, no errors; package contains 10 user-document files and no developer-document files.
- Installed the package into the existing local acceptance profile. A fresh offline SQLite backup was verified before each update; every table hash and all settings matched afterwards. Runtime reported 0.1.22 / schema 10, with official Flash still configured for every model role.
- Real browser: master none/partial/all, full-page selection, current-page removal retaining another page, unrecorded-only selection, switching page size, cap feedback, and clearing selection passed. At 100 rows, the toolbar and editor mode/preview controls were directly reachable without traversing the records table.
- Real browser: 100-item preview displayed changed/unchanged totals and expandable per-row details; changing the mode invalidated the old preview and disabled apply. Browser checks only selected and previewed; no completion edit was applied. All database table hashes still matched after acceptance.

## Scope and limits

Implementation used local dsh official Flash with max reasoning; the coordinator reviewed, checked, installed and accepted it. No model call is involved in selecting or editing completion modes. No backend behavior, database schema or platform AC evidence changed. Cross-platform completion writes and selecting every result beyond the current page were not added.

Browser acceptance used the existing desktop viewport; no mobile-device claim is made. The existing optional test skip remains unchanged.
