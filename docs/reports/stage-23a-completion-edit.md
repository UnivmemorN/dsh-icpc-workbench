# Stage 23a — completion edit backend

Implemented with DeepSeek Harness Flash max; coordinator reviewed the diff and completed acceptance after the bounded worker reached its request limit.

## Interfaces

- `retro.list`: `{ accountId, problemKeys }` (1..100), returns `{ accountId, items: [{ problemKey, title, mode, retrospectiveId, recordedAt }] }`; absent record fields are null.
- `retro.editPreview`: `{ accountId, problemKeys, mode, knowledge? }`, knowledge defaults to `{ kind: 'preserve' }` or explicit `{ kind: 'add', taxonomyIds }`. Returns `{ accountId, mode, previewHash, items, changedCount, unchangedCount }`. Each item has problemKey, title, previousMode, nextMode, changed, existingTaxonomyCount, addedTaxonomyIds and clearedSolutionCount.
- `retro.editApply`: same intent plus `expectedPreviewHash`; returns accountId, changedCount, unchangedCount and compact items with problemKey, mode, retrospectiveId, recordedAt, changed.
- `retro.record`: optional `expectedRetrospectiveId` compare-and-set; null requires no prior record. Omitted preserves old client behavior.

The new module `src/application/retrospective-edit.ts` and thin service wrappers preserve notes, confirmed skills and consulted references across mode-only edits. An explicit independent edit clears consulted references, counted in preview. Skill addition is a manual union. No raw or AI label is automatically promoted. Transactions reject stale previews, wrong sources, missing problems and cancellation atomically. No-op edits append nothing. No AI or platform calls occur.

## Executed checks

- `node --import tsx --test tests/workbench/completion-edit.test.ts tests/plugin/completion-edit-validation.test.ts`: 12 passed.
- `npm run typecheck`: passed.
- `npm run check:architecture`: passed.

The integration fixture now advances its fixed clock beyond the monotonic appended timestamp before assessing ability; production future-evidence filtering is unchanged. The fixture verifies the latest mode in knowledge, rule ability and a fresh assessment capture.

UI, full-suite registration assertions, build, packaged install and browser acceptance remain for stages 23b/23 integration. No schema change.
