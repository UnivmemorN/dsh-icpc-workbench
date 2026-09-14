# Stage 21a — Luogu platform tag names (continuation completion)

Status: **complete for the assigned slice**. Contract: `.local/contract-21a-complete.md` (continuation of the
saved partial work). This invocation touched only the UI views/module it was assigned, one focused test file,
two documents and `THIRD_PARTY_NOTICES.md`: no Git action, no network call, no credential/session/user-data/log
access (other than the assigned contract file), no agent, no other model, and no dependency, schema, API or
version change. `Plans.tsx`, `luogu-tag-dictionary.ts` and the already-finished parts of `raw-tag-view.ts` were
left as saved; the 505-pair snapshot was not regenerated.

## Result

- **Weakness → 平台标签参考（未复核）** now renders each row through `rawTagLabel(tag.rawTag, <selected
  account's source>)`. The readable name comes first and the exact raw string stays as a small plain line
  beneath it whenever the two differ (`luogu-tag:3` under `动态规划 DP`). Row keys stay `tag.rawTag`; all
  counters, sample sizes and the one-row-per-raw-tag statistics are untouched — nothing is merged or summed.
  A footnote appears only when at least one row actually resolved a Luogu numeric id; it links the official
  payload (`官方标签数据`), names the retrieval date and entry count, and keeps the honest fallback sentence.
  It does not repeat migration or storage implementation text.
- **Knowledge → 来源标签对照** resolves `mapping.raw` through `rawTagSourceOf(mapping.sourceInstanceId,
  boot.sources)` and shows the readable label with the exact raw string under it when they differ. The mapping
  row key, relation, target/candidate text, counts, explanation, reference links, filters, paging and
  "unmapped" semantics are unchanged. One brief linked provenance line appears only while the visible page
  contains a resolved Luogu id.
- **Problem.tsx copy**: the raw-tag list caption no longer claims a dictionary (or Luogu) origin for every
  platform — it is now simply `平台原始标签（未经本插件核验）`. The detailed, linked dictionary source remains
  only in the Luogu provenance footnote inside the collapsed raw-id disclosure. The tag key changed from the
  ambiguous `raws.join('|')` to `JSON.stringify(item.raws)`. Spoiler guards and all other copy are untouched.
- **Plans.tsx was reviewed, not changed**: candidate tags are already scoped to the selected account's source
  and the preparation is validated against the account through `currentPrepared`/`signature`, the footnote is
  linked and the spoiler guard is intact, so no adjustment was needed.
- **Tests**: new `tests/ui/raw-tag-view.test.ts` with 21 cases over the real module (no source-text snapshots).
- **Docs/attribution**: new `docs/luogu-tag-names.md` (source, scope, display rules, surfaces, maintenance),
  new `THIRD_PARTY_NOTICES.md` section, and this report.

### One small correctness fix inside the saved module

`rawTagListView` merged a bare text tag into whichever of two **differently identified** ids that share that
name arrived first, so the same multiset of raws could produce 2 rows in one order and 3 in another — an
order-dependent attribution guess. The function now pre-computes, from the input itself, which names are claimed
by two or more distinct ids; for those names the text row stays its own row and no id absorbs it, in either
order. An unambiguous id + exact name still merge into one row that remembers both raw strings, and two distinct
ids still keep two rows. The 2026-09-14 snapshot has **0 duplicate names** (505 entries, 505 unique names), so
this is defensive for future/injected maps, and it makes the module's documented rule true.

`LUOGU_TAG_DICTIONARY_NOTE` was removed: it was an unused plain-text variant that printed a bare URL, and every
surface can now render a linked footnote. `LUOGU_TAG_DICTIONARY_CAVEAT` is still exported and still used by the
Problem and Plans provenance lines.

## Contract item mapping

| Contract item | State |
| --- | --- |
| 1. Weakness table uses `rawTagLabel` with the account source; raw id visible; rows/counts unchanged; conditional linked Luogu footnote | done |
| 2. Knowledge mapping table resolves by `mapping.sourceInstanceId` via `boot.sources`; raw + unmapped/source semantics retained; brief provenance | done |
| 3. Problem copy no longer claims dictionary names for CF/plain tags; `JSON.stringify(item.raws)` key; spoiler guards preserved | done |
| 4. Focused tests for known/old/unknown/malformed/unsafe ids, source isolation, empty/absent, both merge orders, same-name identity, account switching, immutability, injected ambiguity map | done — 21 cases |
| 5. `docs/luogu-tag-names.md`, this report, notices with source/date/scope and no asserted third-party license | done |
| 6. Focused tests, `npm run typecheck`, `npm run check:architecture` | done (see commands) |

## Changed files

- `src/ui/Weakness.tsx` — row view model (`platformTagRows`), readable label + raw line, conditional linked footnote, imports.
- `src/ui/Knowledge.tsx` — `mappingRawView` (per-row source lookup), readable label + raw line, conditional linked provenance line, imports.
- `src/ui/Problem.tsx` — caption copy, React key.
- `src/ui/raw-tag-view.ts` — deterministic ambiguous-name merge, module/function docs, removed the unused plain-text note constant and its now-unused imports.
- `tests/ui/raw-tag-view.test.ts` — new, 21 cases.
- `docs/luogu-tag-names.md` — new.
- `THIRD_PARTY_NOTICES.md` — new "Luogu platform tag-name snapshot" section.
- `docs/reports/stage-21a-luogu-tag-names.md` — this report.

## Commands actually run

Windows PowerShell; node `v24.15.0`, npm `11.12.1`. All run from `D:\dsh-icpc-workbench`.

| Command | Result |
| --- | --- |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/ui/raw-tag-view.test.ts` | 21 tests, 21 pass, 0 fail (65.5 ms) |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none "tests/ui/*.test.ts"` | 142 tests, 142 pass, 0 fail (464 ms) |
| `npm run typecheck` | exit 0, no diagnostics |
| `npm run check:architecture` | `Architecture imports satisfy the declared layer boundaries.` |
| `node --experimental-strip-types --input-type=module -e "<dictionary audit>"` | `entries 505 mapSize 505 duplicateNames 0` |

The full `npm test`/build/browser/package gate, the real browser acceptance and Git remain the coordinator's
(per the contract, the coordinator also independently verified all 505 snapshot pairs against the official
response, so the snapshot was not regenerated here).

## Open issues

- There is no DOM/render test in this repo for `ProblemView`/`Plans`/`Weakness`/`Knowledge`; the display change
  is covered by the pure module tests plus typecheck, and needs the coordinator's browser acceptance for the
  final visual check.
- The snapshot is frozen at retrieval 2026-09-14: a Luogu tag id introduced later renders
  `洛谷标签 #<id>（名称未收录）` until a new snapshot ships. `docs/luogu-tag-names.md` records the update
  procedure (replace the pair table, update count/date); stored records never need migration or re-import.
- The ambiguity rule is exercised only through the injectable names map in tests because the current official
  snapshot has no duplicate names; if a future snapshot introduces one, the same rule applies automatically.
