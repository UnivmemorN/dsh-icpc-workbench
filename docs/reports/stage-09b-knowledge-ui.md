# Stage 09b — Knowledge UI (repair round 1)

Scope: finish the knowledge-view UI acceptance work of Sprint 09b after the first worker hit the
40-request cap. This report covers the repair round only; the coordinator owns the final gate,
version/docs outside this report, and Git.

## What this round delivered

| Contract item | Change | Evidence |
| --- | --- | --- |
| 1. Complete `tests/ui/knowledge.test.ts` | New file with 14 helper cases: Chinese/English/alias/id search (case- and separator-insensitive), nested categories, counts excluding category rows, stable numeric sorts with catalog-order ties and no input mutation, all/zero-result paging, filter reset, parent-union category summaries, threshold-aware status explanations, all-missing rating ranges, unknown catalog ids | focused run below (36/36 pass) |
| 2. Subtree membership by explicit parent links | `knowledgeIdInCategory(catalog, taxonomyId, categoryId)` now walks `parentId` chains (`knowledgeLineageIds`, cycle-safe, unknown id = equality only); `knowledgeCategoryOptions` derives depth and subtree counts from the same walk instead of `id.split('.')`. No external callers existed, so the signature change is contained to `src/ui/knowledge-view.ts` and `Knowledge.tsx` | fixture whose parent chain deliberately disagrees with its id prefix + sibling-isolation assertions |
| 3. Reconcile a category that disappeared | New pure `reconcileKnowledgeCategory(state, catalog)`: still-valid selection returns the **identical** state object; a vanished (or no-longer-category) id falls back to all categories and page 1. `Knowledge.tsx` runs it in an effect keyed on the catalog, so the stable identity prevents render loops | `every filter change clears the page, and a vanished category falls back to all` |
| 4. Honest entry-point copy | Button relabeled `去题库记录复盘`; the Notice now says to pick the **已通过** filter in the bank and records the retrospective there. Removed the product-implementation narration ("本页只提供入口…不会自动选题…") | code review + typecheck/build |
| 5. Category reference links | The selected category's summary Notice now renders its OI Wiki links (`knowledgeResourcesFor(categorySummary.taxonomyId)`) with the relation label, reusing the same metadata as technique rows | code review + typecheck/build |
| 6. Accurate resource comment | `src/domain/knowledge-resources.ts` header now states that on the checked date URLs and titles were matched against OI Wiki's official navigation, and explicitly that this does not claim every full article was read or individually content-verified. No network requests added | resource test unchanged and passing |
| 7. Report + gates | This file; commands below were actually run | see below |

## Files changed in this round

- `tests/ui/knowledge.test.ts` (new)
- `src/ui/knowledge-view.ts` (parent-link lineage, category options, reconcile helper)
- `src/ui/Knowledge.tsx` (import, reconcile effect, category links in summary, Notice/button copy)
- `src/domain/knowledge-resources.ts` (module/interface/date comments only; mapping untouched)
- `docs/reports/stage-09b-knowledge-ui.md` (new)

## Commands actually run

1. Focused knowledge tests (new UI file + domain + resources + workbench):

```
node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/ui/knowledge.test.ts tests/domain/knowledge.test.ts tests/domain/knowledge-resources.test.ts tests/workbench/knowledge.test.ts
```

Result: `tests 36 / pass 36 / fail 0 / duration_ms 356.06`.

2. Typecheck, build and client check (one sequenced command so every gate ran):

```
npm run typecheck; npm run build; node scripts/check-client.mjs
```

Result: `GATES typecheck=0 build=0 check-client=0`. Output included
`Built independent ESM package in dist.`, `Built classic dsh browser factory with shared React.`
and `Classic client factory, shared modules and disposal verified.`

## Remaining limitations / open issues

- The markup-only changes (button label, Notice wording, category link list) are covered by
  typecheck, build, `check-client` and review — not by a DOM test: this repo tests UI through pure
  helpers (`tests/ui/*`) and has no component render harness. A future component test would be the
  natural next step for copy/markup assertions.
- The full `npm run check` suite (all tests + architecture check) was deliberately left to the
  coordinator's final gate per the contract; only the focused knowledge tests were run here.
- `reconcileKnowledgeCategory` must keep returning the identical object for a valid selection; that
  identity is what makes the effect settle. It is asserted in the new tests
  (`assert.equal(reconcileKnowledgeCategory(paged, CATALOG), paged)`).
- Learning links remain navigation-level checked on `2026-09-13` (the module comment now says
  exactly that). OI Wiki reorganisations can still stale a URL; the mapping is frozen and unknown
  ids keep returning an empty list rather than a guessed link.
- Coordinator-owned items untouched: package version `0.1.4`, docs outside this report, Git
  history. No backend, statistics, storage, plan, AI, install or harness changes were made.
- Budget: this repair round used about 33 of the 40 allowed calls.
