# 0.1.3 acceptance: account guidance and merged bank

Account onboarding now explains Codeforces Handle and Luogu UID, accepts canonical identifiers or official profile links, and validates locally. A separate merged bank groups known Codeforces/Luogu mirror identities and displays selected accounts' real accepted-submission evidence while preserving native records, tags and difficulty.

Coordinator full check: 623 behavior tests and 9 script tests passed, including typecheck, architecture, build and shared-client compatibility. Cross-platform fixture tests cover both AC directions, missing metadata, duplicate AC/later WA, source/account/domain isolation, exact index suffixes, group paging and native spoiler guards.

A coordinator scale check found a correlated source-filter rescan. Materializing the member relation enables transient group-key indexes without changing the persistent schema. A real-store synthetic fixture checks exact source/search/solved counts and a generous linear function-call bound. On a private backup copy containing 11,393 problems, four full service reads measured 151–247ms locally. These are local measurements, not a performance guarantee.

Installed verification passed on the isolated icpc-acceptance profile at localhost:3081, pinned harness 0.1.5-rc.2. All 429 installed dist files matched the final build by SHA256. The additive API accepted independent source/account filters, clamped pages, retained redaction and refused invalid account/difficulty inputs. Four live API samples took at most 206ms.

The database integrity check returned ok. All 19 application tables, formal weakness reports, coverage and raw-tag provenance were identical before and after upgrade. Schema remains version 3. A backup preceded installation; no model requests, sync, fake accounts or production fixture records were created by browser acceptance.

Browser checks passed for CF/Luogu labels and profile-link input, inline identifier errors and platform-switch reset, merged default account scope, solved filtering, last page, Luogu navigation while a CF account is selected, native detail account isolation, closing detail without losing filters, raw-difficulty controls and reset when selecting all sources, and disabling state/attempt filters after clearing accounts. The actual bank's 504 locally catalogued accepted CF problems occupied 21 merged pages, with four rows on the last page. Cross-site pair collapse and both AC directions were verified in separate SQLite fixtures; no synthetic mirror was inserted into user data.

A final UI pass removed duplicated row text/columns, shortened repeated instructions, and fixed selected-toggle contrast. The workbench, account form, pagers and table had no horizontal overflow at 640x900; the viewport was reset. Post-layout typecheck, build, client compatibility and all 35 UI helper/transport tests passed. Browser and runtime proof files are private and excluded from Git.

Known mapping scope: exact official CF main-problem identifiers and corresponding Luogu CF-prefixed mirrors. Arbitrary manually paired problems, Gym, numeric-only CF indices and inferred title similarity are not implemented. Native platform judgments and formal per-account statistics remain unchanged. Tested harness remains 0.1.5-rc.2, independent from the plugin workspace and SQLite database.
