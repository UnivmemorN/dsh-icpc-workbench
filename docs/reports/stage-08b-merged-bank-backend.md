# Stage 08b — merged bank backend (repair round 1)

Scope: finish the merged cross-site problem bank backend (`problem.mergedBrowse`, additive) by
resolving the coordinator's three repair findings and completing the route-inventory regression
check. No UI edits, no schema migration, no writes, no version/package/worker/contract/Git changes.

Contract: `.local/contract-08b-merged-bank.md`; coordinator findings: `.local/contract-08b-r1.md`.
Acceptance, full package check, install and browser verification remain with the coordinator.

## Repairs

### R1 — CF4A expectation (tests/workbench/merged-bank.test.ts)

The grouping-boundaries test looked up `groupOf(page, sameTitleCf.key)` (the raw canonical key of
Codeforces `4A`) and therefore failed once that identity was correctly grouped under
`merged:cf:4A`. The expectation now asserts the recognized identity explicitly:

- `merged:cf:4A` is `mappingKind: 'luogu_cf_identifier'` with exactly one member (the Codeforces
  row), while the same-titled Luogu `P1000` row keeps its own canonical single-group key;
- the mirror-group set and the single-group count (7) stay asserted, and the new zero-padded
  identities from R3 raise the boundary fixture to 14 groups with singles unchanged.

### R2 — one deterministic display member for both sort directions (src/adapters/sqlite/merged-bank.ts)

Before: `problem_asc`/`title_asc` aggregated `MIN(...)` over the group's members and
`problem_desc`/`title_desc` aggregated `MAX(...)`, so a mirror pair (`1A` + `CF1A`) changed its sort
value when only the direction changed.

Now a `display_members` CTE selects exactly one member per group with
`ROW_NUMBER() OVER (PARTITION BY group_key ORDER BY <source match>, problem_key)`:

- with a `sourceInstanceId` filter, the requested source's own member is the display member;
- otherwise the member with the lexicographically least full canonical `problemKey` (naturally the
  Codeforces spelling of a recognized pair);
- the requested source value is bound before the grouped/difficulty parameters, matching the
  statement text order.

`problem_asc`/`problem_desc` read that member's natural-sorted `external_key`, and
`title_asc`/`title_desc` read that member's `title` (NOCASE); `..._desc` only reverses the same
comparison. The canonical `group_key ASC` tie-break is unchanged, the count/page SQL and paging are
unchanged, the `default` canonical-key order and the difficulty order (selected source, numeric,
unknown last both directions) are unchanged, and nothing is re-sorted client-side.

New real-SQLite test `a descending sort reverses the same display member instead of switching
members` seeds a mixed set (pair + standalone `A1`/`B1`) whose keys straddle the pair's two
spellings, with different translated titles (`Alpha` vs `Zulu`), and asserts:

- Luogu-filtered `problem_asc` = `[A1, B1, merged:cf:1A]` (the Luogu member's `CF1A`), with
  `problem_desc` the exact reverse;
- unfiltered order uses the least canonical key `1A` and still reverses exactly;
- Luogu-filtered `title_asc`/`title_desc` read the Luogu member's `Zulu`, not the Codeforces
  `Alpha`, and reverse exactly.

### R3 — zero-padded index suffixes are exact identities (src/domain/problem-equivalence.ts)

The rule excluded alphabetic suffixes with a zero/padded numeric part (`A0`, `A01`). The contract's
index grammar is uppercase letters plus an optional numeric suffix, matched exactly on both sites
and never normalized, so the three patterns now read `[A-Z]+[0-9]*`:

- `CF_MAIN_EXTERNAL_KEY`, `LUOGU_CF_EXTERNAL_KEY`, `CF_MIRROR_INDEX` (used by
  `cfMirrorIdentityOf`, hence by `parseMergedGroupKey` for stored `merged:cf:` keys);
- module docs and `CF_MIRROR_RULE_EXPLANATION` now state that the suffix is preserved exactly,
  zeros included, while case variants and contest-id padding remain unrecognized;
- `1A`, `1A0`, `1A01` and `1A1` are four distinct stable group keys, each shared by its
  `CF<contest><index>` Luogu spelling; `1a0`, `01A0`, `CF01A0` stay unrecognized; a numeric-only
  index (`1`, `CF1`) and the Gym/domain/out-of-range guards are untouched.

Domain test gains `a zero-padded index suffix is its own exact identity and is never normalized`
(recognition, exact `index`, shared group key, distinctness, `parseMergedGroupKey('merged:cf:1A01')`
round-trip, case/contest-padding refusals); the stale `1B01`/`1B0` negative cases were replaced by
the numeric-only-index refusals. The SQLite boundary test now seeds `1A0`/`CF1A0` and `1A01`/`CF1A01`
pairs and asserts two members each, distinct from `1A` and from each other.

### R4 — route-inventory regression check

`tests/plugin/composition.test.ts` asserted the exact registered route set as `34`; the additive
`problem.mergedBrowse` route makes the live count `35`. The assertion was updated to `35` with a
comment naming the additive route — no test was weakened or skipped.
`tests/plugin/merged-browse-validation.test.ts` already covers the new route's declaration, refusal
and delegation, and `tests/plugin/business-api.test.ts` derives its operation count from
`WORKBENCH_API_OPERATIONS`, so neither needed a change.

## Files changed by this repair

| File | Change |
| --- | --- |
| `src/domain/problem-equivalence.ts` | index grammar `[A-Z]+[0-9]*`, exact-suffix docs/explanation/invariant, `A0`/`A01` preserved |
| `src/adapters/sqlite/merged-bank.ts` | `display_members` CTE; one display member for asc+desc key/title sorts; module/planner docs |
| `tests/workbench/merged-bank.test.ts` | CF4A expectation fix; zero-padded pair boundaries; new display-member sort test |
| `tests/domain/merged-equivalence.test.ts` | zero-padded identity test; numeric-only-index refusals; stale negatives removed |
| `tests/plugin/composition.test.ts` | exact route inventory 34 → 35 (additive merged route) |
| `docs/reports/stage-08b-merged-bank-backend.md` | this report |

No UI, schema, migration, version/package, worker, contract or Git-metadata file was touched. The
report is intentionally not added to `package.json` `files` (package edits are out of scope).

## Commands actually run

Baseline before the repair (focused):

```
node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/plugin/composition.test.ts tests/workbench/merged-bank.test.ts tests/domain/merged-equivalence.test.ts tests/plugin/merged-browse-validation.test.ts
```

Result: 27 tests, 25 pass, 2 fail — `f.routes.size` 35 !== 34, and the
`gym, non-canonical, numeric and foreign references stay separate groups` lookup of the raw `4A`
key. Exit 1.

Focused after the repair (same command): 29 tests, 29 pass, 0 fail. The two new tests
(`a descending sort reverses the same display member instead of switching members`,
`a zero-padded index suffix is its own exact identity and is never normalized`) and the updated
boundary/composition cases all pass.

Gates:

```
npm run typecheck
npm run check:architecture
```

Result: `tsc -p tsconfig.json` exit 0; `Architecture imports satisfy the declared layer boundaries.`
exit 0.

Full behavioral suite:

```
npm run test
```

Result: 610 tests, 610 pass, 0 fail, 0 cancelled/skipped.

Working-tree scope check:

```
git status --short; git diff --stat
```

Result: this repair's only tracked-file change is `tests/plugin/composition.test.ts` (one line, the
route count); the remaining entries are the pre-existing uncommitted Sprint 08a/08b work plus the
four untracked 08b files repaired here. Nothing was committed, pushed, reset or cleaned.

## Open items for the coordinator

- Full `npm run check` (usage/context accounting tests, `scripts/build.mjs`, client check),
  dependency installation and browser acceptance are not run here.
- The merged read stays read-only: no schema migration, no destructive normalization, no new
  account selection and no metadata fetch were added.

Coordinator scale follow-up: the actual large-bank source filter exposed a correlated rescan absent from small fixtures. The member relation now uses SQL materialization, enabling transient group-key indexes without a schema change. tests/storage/merged-query-scale.test.ts seeds 1,200 CF problems and 600 mirrors and verifies exact source/search/status counts with a generous linear identity-evaluation bound. All 12 focused scale/merged tests passed. The full gate and measured results are in stage-08-acceptance.md.
