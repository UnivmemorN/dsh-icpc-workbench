# Stage 06 — problem-bank filters and numbered navigation

Accepted for experimental 0.1.1 on 2026-09-13. Implementation: dsh / DeepSeek Flash / max, one task plus one bounded repair. Coordinator independently reviewed, tested, packaged, installed and checked the browser.

## Behavior

- The bank filters by the selected account: all, solved, or unconfirmed. Unconfirmed includes never attempted; the existing attempted-only filter intersects with it.
- Numbered controls above and below the table show the filtered total and current/total pages, first/previous/nearby pages/next/last, direct page input with Enter, and 25/50/100 rows per page. Changing a filter or page size resets to page 1; inline problem details preserve the page.
- Empty results display 0 / 0 and disable navigation. Loading/errors do not invent zero totals or show previous-query rows. Invalid jump input stays visible with a correction hint; a positive out-of-range page clamps to the last page. Bottom navigation returns keyboard focus and scroll to the results.

## Compatibility and correctness

`POST /api/icpc/v1/problem.browse` is additive; the existing `problem.list` request, response and cursor binding remain unchanged. Required `page >= 1` and `limit` within 1..100; optional source/account/status/attempted/search/reveal/review filters. Unknown fields (including cursor), invalid values and account-dependent filters without an account are refused. The response includes page/pageSize/totalItems/totalPages and the existing redacted problem summaries. An empty API result has page=1 and totalPages=0; the UI displays 0 / 0.

Count, SQL LIMIT/OFFSET selection and projection share a transaction. All filters apply before counting/paging; literal case-insensitive title/ID search retains percent, underscore and quote semantics. Indexed EXISTS queries use account, the account's own source instance, full problem identity and accepted verdict. Repeated AC and a later WA still count one solved problem. No cursor crawling or submission-history materialization is used by this new path.

Coordinator review reproduced an incoherent CF-account/Luogu-problem record conferring solved status when source was omitted. The repair joins the stored account's source in both solved/attempted predicates and guards anonymous/foreign solved projections. Regression tests retain valid same-instance, different-domain solves. Original cursor-path validation remains intact. No schema migration or host SDK change; schema 3, dsh 0.1.5-rc.2, pinned public extension points.

Changed code covers application ports/DTOs/service/API map, SQLite query, request validation and route registration, Bank/pager/styles/browser operation allowlist, and package/bootstrap version metadata. No new dependencies. Existing route-count assertion changes from 33 to 34 for the added endpoint.

## Evidence

- Coordinator `npm run check`: typecheck, architecture, 545 behavior tests, 9 script tests, independent ESM build and classic shared-React/disposal checks passed. Focused tests cover filtered totals beyond the first page, duplicate AC, source/domain/account isolation, intersections, empty/clamped pages, malformed inputs, cancellation, redaction and no cursor/history walk.
- Packaged and installed 0.1.1 in the existing isolated icpc-acceptance profile. Authenticated bootstrap confirms plugin 0.1.1, host 0.1.5-rc.2 and schema 3. Existing database backed up first; all 19 table digests are unchanged after upgrade, integrity_check=ok.
- Independent authenticated local checks compare 123 page requests against stored records, including all three statuses, attempted intersection, 25/50/100 sizes, first/middle/last/out-of-range pages, search and malformed requests. All passed; maximum observed round-trip 43.96 ms in this run (local observation, not a performance guarantee).
- Actual browser: solved-only rows, last page, Enter jump to page 10, 100 rows/page resetting to page 1, bottom next-page focus, attempted+unconfirmed, empty results, invalid jump feedback, keyboard clearing, anonymous disablement, source/account reset, and inline detail preserving page all verified. At viewport width 640, root and both pagers have equal client/scroll widths (no horizontal overflow); temporary viewport restored.
- Local evidence and real account records remain private under .local. No account records, statements or editorials were sent to the construction worker. Browsing/import status did not trigger model calls.

## Limits

The bank counts only problems whose metadata is already in the local catalog. Submission-based training totals can be larger when some problem metadata is missing. Page order is canonical key order; no sorting UI or cross-platform merged account view was added. The indexed browse query excludes incoherent submission evidence; it does not scan and report every malformed historical row. Browser verification was on the local Codex browser, not a full browser matrix.
