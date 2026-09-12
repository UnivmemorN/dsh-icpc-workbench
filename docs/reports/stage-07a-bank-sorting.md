# Stage 07a: problem-bank sorting

The bank now sorts the full filtered result by natural problem ID, title or one platform difficulty dimension before paging. ID and numeric difficulty comparisons handle ties deterministically, and unknown difficulty stays last in either direction.

Changes span application browse types/validation/service, deterministic SQLite ordering helpers, pure domain sorting rules, API validation and the Bank selector. No schema changes or new dependencies. Existing cursor-list order and omitted browse-sort order are preserved.

The UI requests `problem_asc` by default. Sorting resets page 1; other filters remain. CF uses `rating`, Luogu uses `difficulty`, and other sources allow a bounded dimension label. Title order is SQLite NOCASE: ASCII case insensitive, with non-ASCII text left in its original order; it is not a locale-aware dictionary sort.

Verification included real SQLite whole-set ordering/paging above100rows, stable ties, punctuation/prefix/long-digit keys, unknown/text/blank difficulties, source/dimension/account boundaries, status intersections, literal hostile dimension binding, strict API validation, cancellation and no submission/cursor walk. The worker passed focused36tests and the then-current full557+9 gate. Final coordinator validation and installed-browser results are in [0.1.2 acceptance](stage-07-acceptance.md).
