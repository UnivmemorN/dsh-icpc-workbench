# Stage 13 — Knowledge evidence by native difficulty

Experimental version: **0.1.8**. Tested 2026-09-13 against dsh **0.1.5-rc.2**, Node **24.15.0**, isolated profile **icpc-acceptance**.

## Result

Knowledge mastery now has a native difficulty selector and an expandable comparison on each knowledge row. CF uses 200-point display intervals; Luogu keeps native levels; other sources keep native values or text levels. Source instances, problem domains and dimensions remain separate. Missing metadata or difficulty, blank or invalid CF ratings and Luogu unclassified level 0 stay explicitly unknown.

The selected band controls node status, counts, status distribution, category union summaries, filtering, sorting and pagination. Independent-evidence thresholds are evaluated inside each band: an overall total of five independent problems cannot qualify a band containing only four. Unobserved taxonomy nodes remain visible. Every band reuses the same account, distinct-problem, effective-tag and latest-AC-retrospective reduction; raw, verified and self-reported evidence remain separate.

No schema migration, model request, platform import, training-plan change or harness edit was needed. The prior native range helper now also uses the existing strict numeric reader, so blank strings cannot masquerade as a zero rating.

## Changed areas

- domain/knowledge-difficulty.ts: deterministic native partitions, source/domain/dimension identity, unknown bands.
- domain/knowledge.ts and index.ts: additive difficultyBands DTO, sparse node evidence, shared reduction rules.
- ui/knowledge-difficulty-view.ts, Knowledge.tsx, knowledge-view.ts and styles.ts: scope projection, selection, reset, comparison and layout.
- Domain, workbench and UI tests; package/bootstrap version and user documentation.

## Executed checks

- npm run typecheck: passed.
- Focused Node tests for domain knowledge, workbench knowledge and UI knowledge/difficulty: **44 passed**.
- npm run check: **817 functional tests + 9 construction-tool tests passed**, architecture/type checks, ESM and client builds, shared-module/disposal client checks passed.
- npm pack --json: private paths, databases, sessions and local artifacts excluded by the package content check.
- Local backup, verified process identity, offline install and isolated restart: passed.
- Installed distribution verification: **497 files** matched the working build; bootstrap returned 0.1.8 and schema 4.
- Database row counts and canonical row hashes across every existing table: identical before and after upgrade. Settings revision and quota settings unchanged; all roles remain Flash.
- Read-only API checks on the two existing acceptance accounts: each native dimension's band sums matched the total attempted/solved counts and every node's eight evidence counters. No extra account data was written.
- Browser: selector and per-node comparison visible; clicking a band updates the selector and node counts; unknown band keeps zero-evidence nodes; difficulty change from page 4 resets to page 1; account switch drops prior filters and native bands. Desktop screenshot inspected. User account restored.

The public repository excludes private API proof files, screenshots of account history, database backups and paid-worker logs. This iteration dispatched no paid worker and made no AI acceptance calls; the existing conservative budget ledger was retained.

## Limits and attribution

The intervals are this project's display convention, not official CF user-rating classes or calibrated mastery levels. AC alone still cannot certify a method. Counts in different native dimensions can overlap and must not be added. Parent categories do not certify all child knowledge.

Luogu levels and multiple native dimensions were verified using offline fixtures; no live Luogu import was performed for this iteration. No new model-quality benchmark or Hydro integration is claimed. Existing knowledge taxonomy, OI Wiki links and Nowcoder design attribution remain in the UI and THIRD_PARTY_NOTICES.md. See [difficulty behavior](../knowledge-difficulty.md).
