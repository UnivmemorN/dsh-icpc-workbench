# Stage 09a — Knowledge learning evidence (backend)

Status: implemented, focused tests and the full suite pass. UI rendering and OI Wiki / Nowcoder
attribution links are explicitly out of scope here (next contract).

## Scope delivered

A pure domain reduction over the evidence one `workbench.weakness` read already collected, exposed
as an additive required field `WorkbenchWeaknessResult.knowledge`. No storage, platform or model
call was added; no schema migration; the formal weakness report, ranking, plan evidence and every
existing calculation are unchanged.

## Changed / added files

| File | Change |
| --- | --- |
| `src/domain/knowledge.ts` | New pure reduction + types (`computeKnowledgeEvidence`, `KnowledgeEvidenceReport`, `KnowledgeNodeEvidence`, `KnowledgeRatingRange`, `KnowledgeCoverage`, `KnowledgeNodeStatus`, `KNOWLEDGE_NOTES`, `DEFAULT_MINIMUM_INDEPENDENT_PROBLEMS`). |
| `src/domain/index.ts` | Exports the new domain surface. |
| `src/application/workbench-types.ts` | `WorkbenchWeaknessResult.knowledge: KnowledgeEvidenceReport` (required, additive). |
| `src/application/workbench-service.ts` | `weakness()` feeds the same collected evidence to `computeKnowledgeEvidence`; doc comment updated. |
| `tests/domain/knowledge.test.ts` | 10 pure-reduction cases. |
| `tests/workbench/knowledge.test.ts` | 5 real-store service cases. |
| `docs/reports/stage-09a-knowledge.md` | This report. |

## Public shape (per account, selected account only)

- top level: `accountId`, `taxonomyVersion` (catalog version echoed), `minimumIndependentProblems`,
  `coverage`, `nodes` (every catalog node, catalog order, zero-evidence nodes included),
  `unmatchedAlgorithmLabels`, `notes`.
- per node: `taxonomyId`, `parentId`, `kind`, `platformAttemptedDistinct` / `platformSolvedDistinct`
  (provisional raw tags), `verifiedAttemptedDistinct` / `verifiedSolvedDistinct` (effective
  decisions), `retrospectiveIndependentDistinct` / `retrospectiveAssistedDistinct` /
  `retrospectiveSolutionUsedDistinct` (latest retrospective per problem), `observedRelatedDistinct`
  (set union of the three channels, never their sum), `independentRatingRanges`
  (native dimension, `count` / `missing` / `min` / `max`), `status`, and for category rows
  `descendantTechniqueNodes` / `descendantTechniqueNodesWithIndependentEvidence`.
- statuses: `not_observed`, `unconfirmed`, `needs_practice`, `practicing` (independent 1..4),
  `independent_evidence` (independent ≥ threshold), `category_summary` for every category row.
  This is a transparent heuristic, not a validated mastery probability; no synthetic mastery
  percentage or score is produced.
- `coverage`: attempted/solved distinct totals, related and verified attempted distinct,
  retrospective problem distinct, unmatched-algorithm problem distinct.
- `unmatchedAlgorithmLabels`: distinct raw labels that resolve to no taxonomy node and are not
  recognised non-algorithm provenance (source/event/year/difficulty/language/noise). They stay
  unmapped; no taxonomy id is fabricated.
- unknown taxonomy ids in decisions or retrospectives are ignored; AC alone never confirms a method;
  only the latest retrospective per (account, problem) counts, and only for a problem this account
  got accepted; direct evidence propagates up to ancestors by distinct-problem sets and never down.

## Commands actually run

| Command | Result |
| --- | --- |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/domain/knowledge.test.ts tests/workbench/knowledge.test.ts` | First run: 14 pass / 1 fail (the foreign-account case expected 3 attempted problems; the account reduction correctly yields 2 because the other account's submission is excluded). Expectation corrected; the case is green in the runs below. |
| `npm run typecheck` | Clean (`tsc -p tsconfig.json`, no diagnostics). |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none "tests/domain/*.test.ts" "tests/workbench/*.test.ts"` | 144 pass / 0 fail. |
| `npm run check:architecture` | "Architecture imports satisfy the declared layer boundaries." |
| `npm test` (whole suite) | 638 pass / 0 fail. One pre-existing stderr warning (`ICPC_API_OBSERVER_FAILED`) comes from the API test that intentionally makes the observer throw; that test passes. |

## Acceptance checks → tests

- all catalog nodes empty / unknown → `tests/domain/knowledge.test.ts: every catalog node is reported in catalog order and empty evidence stays explicit`
- AC / raw / adopted tag alone is not mastery → `raw tags and adopted tags are related evidence but never a mastery status`, `AC alone never confirms a method and the five-sample formal gate keeps steering plans` (service)
- raw alias dedup → same two cases (`['stack', '栈']` counts one problem; repeated ACs count once)
- parent union, no propagation to children → `parents union their subtree once and never propagate evidence down to children`
- category summary is never mastery → catalog-completeness case (`category_summary`, descendant technique counts)
- latest retrospective downgrades → `the latest retrospective replaces an earlier stronger statement`
- independent threshold 4/5 → `the independence threshold moves exactly at the configured boundary` (plus a custom threshold)
- explicit retrospective without an adopted tag → `a retrospective confirms a method with no adopted tag at all`
- foreign account and no-AC problems rejected → `foreign rows and problems without an accepted submission are refused by the skill counts`, `knowledge stays inside the selected account and needs a real accepted submission` (service)
- stale AI excluded at the service → `stale AI output is excluded at the service and the latest manual rejection wins`
- current manual rejection → same case (accept then reject removes verified evidence again)
- rating dimension / missing handling → `ratings stay in native dimensions and every independent problem is accounted for`
- cancellation and no extra evidence reads → `the knowledge projection reuses the single evidence read and cancellation still wins` (counting store: 1 submission walk, 3 metadata reads, 1 source read, 0 bank pages; pre-cancelled token refuses)
- old formal report unchanged → `weakness returns the knowledge report beside an unchanged formal report` (byte-identical to a direct `computeWeaknessReports` over the same stored rows; `report` carries no `knowledge` field)
- focused tests and `npm run typecheck` → both green above.

## Open issues / notes

- `descendantTechniqueNodes` counts nodes whose `kind` is `technique` in the category's subtree;
  nested categories are not counted as techniques (by design).
- `coverage.retrospectiveProblemDistinct` counts latest retrospectives of solved problems even when
  every confirmed taxonomy id is unknown; node evidence still ignores those ids.
- The status heuristic and the attribution-page links (Nowcoder ACM skill page / OI Wiki) for the UI
  are the next contract's responsibility; this layer only carries `taxonomyVersion` and catalog order
  so the UI can attribute the vocabulary it renders.
