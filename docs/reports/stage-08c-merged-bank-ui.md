# 0.1.3 merged bank UI

Implemented through the approved dsh Flash/max workflow; coordinator completed review and regression checks after the bounded worker invocation.

- Bank has separate platform and merged modes; the review queue retains its native workflow.
- Each source has an explicit account selector, with only the header account selected by default. Empty/no-account sources explain how to add an account. Source filtering is independent of selected-account evidence.
- Merged groups retain all native members, source-specific difficulty, linked/direct AC labels, and attributed accepted-submission evidence. The leading member matches the backend's stable sort anchor.
- Numbered paging, page size, source/status/search/attempt filters and difficulty-dimension validation reuse tested rules. Page/filter changes dismiss stale details; opening/closing a member preserves the page.
- Member detail provides its native account through context to detail, coaching and retrospective components. Linked AC does not override native spoiler rules. No sync, model calls or account creation is triggered by browsing.
- Account addition now reconciles the native bank source when refreshed bootstrap arrives, and blocks platform/input changes during a save.

Coordinator verification: npm run check passed 623 behavioral tests and 9 script tests, typecheck, architecture checks, ESM build, shared React/client factory/disposal checks. The new transport regression exercises the exact merged endpoint and preserves selected-account payload, credentials and abort signal. Browser and installed-package results are recorded in stage-08-acceptance.md.
