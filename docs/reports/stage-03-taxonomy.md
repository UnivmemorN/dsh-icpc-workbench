# Stage 03 — taxonomy release 2026.09.2

Additive release: `TAXONOMY_V1`/`2026.09.1` node data unchanged (still resolves old snapshots);
`CURRENT_TAXONOMY` -> `TAXONOMY_V2`/`2026.09.2`. Benchmark expectations untouched; no paid calls.

## Added nodes (parents pre-existed; bilingual; `data-structure.disjoint-set` absent — DSU is `data-structure.dsu`)
- `graph.minimum-spanning-tree`, `implementation.sorting`, `math.number-theory.modular-exponentiation`
- `data-structure.stack`, `data-structure.queue`

## Files
- new: `src/domain/taxonomy/v2.ts`, `tests/domain/taxonomy-v2.test.ts`
- exports only: `src/domain/taxonomy/v1.ts`, `src/domain/taxonomy/index.ts`, `src/domain/index.ts`

## Commands run
- focused: `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/domain/taxonomy-v2.test.ts` -> 4/4 pass
- `npm run check` -> exit 0 (typecheck, architecture, 256 tests, usage, build); first attempt hit a
  test-only TS2367 literal comparison, fixed and re-run

## Open issues
None. No import cycles; `CURRENT_TAXONOMY` compatibility kept. No Git action taken.
