# 0.1.2 acceptance: sorting and training statistics

0.1.2 adds whole-bank ordering, solved-problem difficulty distributions, and a usable platform-tag reference when reviewed weakness evidence is sparse. It preserves the formal evidence threshold and existing training data. Implementation used the approved dsh Flash / max worker workflow; coordinator review, independent checks and local browser acceptance are separate.

## Delivered behavior

- Bank: natural problem ID, title and original-dimension difficulty, ascending/descending. Ordering applies inside SQLite before pagination, across the complete filtered result. Unknown difficulty is last in both directions. Every tie has a stable canonical-key order. Sorting resets page 1 and retains the account/status/search context. Custom dimensions accept 1–100 characters with inline validation.
- Compatibility: omitted/null/default `problem.browse.sort` preserves the previous canonical-key order; `problem.list` cursor behavior is unchanged. Difficulty sorting requires an explicit source instance and raw dimension. Account/source/domain checks and spoiler projection remain in place.
- Today and Weakness: distinct accepted-problem distribution with exact numeric bucket counts and an explicit unknown bucket. Each dimension sums to the accepted total, including accepted history without local metadata. An AC followed by WA remains solved; duplicate submissions count once. Dimensions retain their original scales.
- Weakness: separate platform-label reference and reviewed analysis. When reviewed ranking is empty but raw labels are available, reference is shown first. Reference displays accepted/attempted counts, unconfirmed counts, rates and sample sufficiency; it never supplies accepted taxonomy evidence or training-plan inputs. Exact coverage fractions and actionable explanations are available in a collapsed disclosure. Formal ranking, insufficient samples and retrospective completion modes remain accessible.
- Viewing statistics, changing views and following the material/review navigation do not start model analysis or synchronization. No host source edits, schema migration or new dependencies.

## Verification

- Coordinator `npm run check`: 574 behavior tests and 9 construction/accounting tests passed; typecheck, architecture boundaries, independent ESM build, shared-React classic client factory and disposal checks passed.
- Sorting fixtures cover more than 100 rows across all pages, natural IDs with punctuation/prefixes/40-digit integers/leading-zero ties, title case handling, unknown-last difficulty, raw dimensions, status intersections and malformed request refusal. Independent comparator probe passed 10,000 digit/punctuation/Unicode pairs.
- Statistics fixtures cover duplicate AC, later WA, missing metadata, blank/text/nonfinite values, multiple dimensions and first-occurrence duplicate dimensions, raw-label deduplication, minimum samples, account/source/domain isolation, read bounds and unchanged formal report/plan evidence. Histogram helpers verify exact bar proportions and dimension selection.
- Installed loopback profile: 126 first/middle/last/clamped page comparisons matched an independent read-only SQLite oracle. Distribution totals/buckets and all raw-tag counts matched independent reductions of the existing local records. Maximum sampled response time was 135.28 ms; this is one local acceptance sample, not a performance guarantee.
- Database integrity was `ok`; all 19 application tables and the previous formal report/coverage/provenance were identical before and after the isolated upgrade. A backup was taken before installation. Private proof files remain outside Git.
- Browser: Today histogram and unknown counts; Weakness default/reference/formal switching and coverage disclosure; bank natural order, solved+difficulty sorting, last page and reset on sort change; source/account reset, invalid custom dimension, all-unknown histogram and anonymous empty state. At a 640×900 viewport the bank pagers, histogram and workbench root had no horizontal overflow; viewport was reset after testing.

## Limits

Platform algorithm labels can remain incomplete or inaccurate; reference counts are descriptive, not verified mastery. Reviewed weakness still needs effective tags on at least five attempted problems per tag. Missing metadata stays unknown until the user supplies or synchronizes available materials. HydroOJ online import remains planned. Tested host remains dsh 0.1.5-rc.2, with the plugin workspace and database independent from the harness.
