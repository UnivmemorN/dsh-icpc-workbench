# Stage 4w1a — bank, review and retrospective

Accepted after coordinator review and one dsh repair round.

- `workbench-service.ts` and `workbench-types.ts`: paged bank/detail, atomic manual review, current-method retrospective; injected store/taxonomy/clock/IDs.
- `ports.ts` and SQLite `store.ts`: optional literal title/external-key search and pending-review filtering before pagination, including reasoning drafts.
- Cursor binds every filter; account context is separate from only-attempted filtering.
- Hidden spoiler fields are optional and absent own properties, including nested snapshot and retrospective fields. Revealed/AC views preserve original, AI and manual provenance separately.
- One serialized transaction covers each bank/detail projection. Retrospective validates current-head solution membership inside its write transaction.
- Manual review wins over AI; tied clocks are monotonic and identical intent is idempotent. Stale AI cannot remain effective or resolve current review items.
- Submission walks reject a 50,001st row even on the terminal page. Retrospective ID arrays are bounded to 500.

Validation: `npm run typecheck`; focused workbench/storage checks; repaired a scripted-page fixture; final `npm run check` passed 406 behavior tests, 6 accounting/context tests, architecture gate and independent build. Coordinator reran all 23 workbench tests successfully.

This stage does not yet provide weakness/plans, host API or UI. A full solved-status bank scan above 50,000 submissions refuses explicitly; detail may stop at an earlier positive accepted-submission proof.