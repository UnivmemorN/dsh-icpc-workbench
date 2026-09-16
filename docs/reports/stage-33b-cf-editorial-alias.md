# Stage 33B (revised) — Shared-round editorial aliases and Luogu mirror reuse

Status: implemented and verified offline. Package version stays `0.1.25`; the pinned dsh baseline
(`0.1.5-rc.2`) and the SQLite schema are unchanged (no migration is required).

This revision supersedes the earlier `stage-33b-cf-mirror-editorial.md` scope. It was delivered in
the contract's order: **33A accepted first**, then **33B1** (Codeforces shared-round aliases), then
**33B2** (the Luogu mirror calling the improved ability).

## Why a fixed letter offset is not an option

A Div.1/Div.2 round may hold the same problem twice, and authors label the shared tutorial's sections
in whatever way that round's numbering makes convenient. There is **no platform rule** that maps a
Div. 2 letter to a Div. 1 letter:

- a round can place the shared problem at the same letter on both sides (`879E` ↔ `878E`);
- it can place it at different letters (`879D` ↔ `878E`, or `879E` ↔ `878B`);
- the Div. 1 set generally has fewer problems than the Div. 2 set, so any offset is round-specific.

An implementation that assumed `Div. 2 E = Div. 1 D` would therefore fetch a *different problem's*
write-up and store it as this problem's solution — a silent, wrong-material failure that no hash or
test would catch unless the offset happened to be wrong for the case at hand. For the same reason the
following are all refused as evidence: adjacent `contestId`, equal rating/tags/points, title
similarity, an AI judgement, and third-party mapping tables. The letter offset is **never computed**;
what is computed is the *verified placement* of each candidate's own contest, read from the official
contest metadata.

The test `the redirect follows verified placement, never a fixed letter offset` pins this directly: it
builds a round whose shared problem sits at Div. 2 `A` / contest `700` and Div. 1 `E` / contest `701`,
so any offset-based candidate is the wrong one.

## The two-level mapping

| Level | Rule | Establishes | Recorded as |
| --- | --- | --- | --- |
| 1 | `luogu_cf_identifier` (Sprint 33B2 / existing `cfMirrorIdentity`) | Luogu `CF879E` ↔ Codeforces `879E` | `mirror mapping from official Luogu mirror CF879E` |
| 2 | `cf-editorial-alias-v1` (Sprint 33B1) | Codeforces `879E` → section of `878E` | `cf-editorial-alias-v1; requested=879E; section=878E; blog=55435; method=official_division_pair` |

Both levels are verified **separately** and recorded **separately**. The Luogu key of the other
division (`CF878E`) is never derived by string surgery: nothing in the pipeline produces it, and a test
asserts it never appears.

## Evidence rules

### A. `explicit_reference` — unchanged, and free

A section heading that names the requested problem (both official keys, or links to both official
problems) is accepted exactly as before. The alias machinery is not consulted, so an exact hit costs
**no additional request**: the test asserts the request list is exactly the problem page plus the blog
entry.

### B. `official_division_pair` — the fallback, and only for `missing`

The redirect runs **only** when direct extraction returned `missing`. `ambiguous` and `empty` describe
a section that *was* found, so they are reported directly and never papered over — asserted by a test
that also checks the request count stays at two.

All ten clauses must hold:

1. the requested problem's page links the same `blogId`;
2. the blog names exactly one official Div.1/Div.2 contest pair (at most 4 contest links, else the
   answer is not a bounded pair);
3. the two contests come from the same round: identical `startTimeSeconds` and `durationSeconds`;
4. their core names — the name with the canonical `(Div. N)` marker removed — are identical;
5. the heading's relative reference (`Div. 1 C`) resolves to one of those contests, by the division the
   **candidate's own official contest name** declares;
6. the two problems' official titles are **identical** after Unicode NFC and whitespace folding only —
   no fuzzy match, not even case-insensitive;
7. their normalized **statement fingerprints** are identical, computed over the statement body with the
   page shell (number, title, time/memory limit, input/output file rows, tag boxes) removed;
8. the candidate's page also links the same `blogId`;
9. **exactly one** candidate holds — zero or two both refuse;
10. re-extracting under the candidate's key through the verified heading spellings yields exactly one
    non-empty section.

Any failure returns `changed_response` or `unavailable`; **never `absent`**. The conservative
consequence is intended: a round whose divisions really differ in a constraint or a sample produces a
different fingerprint and is refused, and the user is asked to supply the material by hand. Deleting
constraints or samples, or asking a model whether two problems are "basically the same", is not done.

## Parsing responsibilities

`src/adapters/codeforces/editorial-alias.ts` (new, pure): relative-heading parsing in the narrow
shapes the platform writes (`Div 1 D`, `Div.1 D`, `Div2 E / Div1 D`, `Div. 2 E = Div. 1 D`), heading
normalization and matching, and the contest-pair arithmetic (`contestsFormDivisionPair`,
`divisionOfContestName`, `contestCoreName`, `contestIdForDivision`). No network, no catalog, no store,
no model, and no self-decided equivalence.

`src/adapters/codeforces/editorial.ts` (pure): parses full official keys and links (unchanged),
enumerates bounded section headings, accepts an **already verified** alias list, and never decides
identity itself. `extractDivisionHeadingReferences` reports the blog's own division labels so the
adapter knows which candidate to verify; it says nothing about which is correct.

`src/adapters/codeforces/adapter.ts` (IO): official page requests, the pairing verification, the
candidate and statement-hash verification, the request bounds, cancellation and error conversion, and
handing the verified aliases to the extractor. No rule from here reaches the UI.

## Request boundaries

- Only `codeforces.com` official HTTPS pages and the official API (`contest.standings`,
  `blogEntry.view`) are contacted.
- Every URL is built server-side from `contestId`, `index` and `blogId`; a caller cannot supply a
  candidate problem number, a paired contest id or an arbitrary URL.
- A user-supplied tutorial URL is still only `https://codeforces.com/blog/entry/<id>`. When it is
  supplied, the target's page is fetched first and must link that blog before any alias is attempted.
- The documented two-second request gate is untouched: every additional request goes through the same
  `HttpTransport` pacing.
- Fixed bounds: at most **4** contest links read from a blog, at most **4** contest-metadata reads per
  attempt, at most **2** candidates, and a 4 MiB response cap on the metadata call.
- Over-budget, cancellation, 429, a challenge page and a structural change all stay **operational
  failures**; a budget overrun is reported rather than silently truncated into a weaker check.
- No AI is called anywhere on this path.

## Failure semantics

| Situation | Result |
| --- | --- |
| Direct section found | `found`, `explicit_reference` behaviour unchanged, no extra requests |
| Section `missing`, all ten clauses hold | `found`, note records the redirect |
| Section `missing`, any clause fails | `changed_response` |
| Section `ambiguous` or `empty` | `changed_response` (alias path not attempted) |
| No Tutorial link on the problem page | `unavailable`, detail says discovery is incomplete |
| Contest metadata unreadable / refused | `changed_response` (alias unverifiable) |
| Caller supplied a blog the page does not link | `changed_response` |
| Cancellation, 429, challenge, timeout | the existing operational failure code |

`absent` is never produced by any of these paths.

## Interface changes

- `src/adapters/codeforces/editorial-alias.ts` (new): `CfEditorialAlias`,
  `CfEditorialSectionTarget`, `CF_EDITORIAL_ALIAS_RULE_VERSION = 'cf-editorial-alias-v1'` and the pure
  rules. `evidenceHash` is an internal fingerprint: it is compared and dropped, never stored, logged,
  projected or returned.
- `EditorialSection` gains `sectionKey` (the key whose section was extracted) and `aliasMethod`
  (`null` for a direct hit).
- `ProblemPageContent` gains `intrinsicStatement` (furniture-free statement) and `tutorialBlogId`.
- Stored provenance: `EditorialSource.note` carries the fixed `key=value;` form. The official blog URL
  stays the source URL, `contentHash` is still derived from the extracted section body, and
  `solutionId` is still bound to the **requested** key so two problems can never share a task identity.
- `src/ui/material-view.ts` gains `parseMaterialAliasEvidence`, `materialAliasSummary`,
  `materialAliasLinks`; the problem page shows the one-line mapping with an expandable evidence block
  (both official problems, evidence type, official blog link).

Aliases are used **only** for editorial section location. They do not merge the two Codeforces bank
entries, link AC, copy tags, ratings, submissions or retrospectives, or change a manual decision. If AC
linking is ever wanted, the verified relation should first be promoted to its own auditable
problem-equivalence record in a separate sprint.

## Verification actually performed

Order: 33A accepted, then 33B1, then 33B2. All commands were run offline against synthetic blogs,
synthetic problem pages and synthetic contest metadata. No real platform request, credential, private
batch or model call was involved.

```
node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none \
  tests/plugin/material-gate.test.ts tests/plugin/model-operations.test.ts \
  tests/pipeline/analysis-pipeline.test.ts tests/plugin/model-api.test.ts tests/ui/review-view.test.ts
node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none \
  tests/platform/cf-editorial-alias.test.ts tests/platform/codeforces.test.ts tests/platform/editorial-extract.test.ts
node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none \
  tests/import/cf-mirror-editorial.test.ts tests/ui/material-view.test.ts
npm run typecheck
npm run check:architecture
git diff --check
npm run check
```

Measured results:

| Command | Result |
| --- | --- |
| 33A acceptance set (gate, model operations, pipeline, model API, review view) | 81 tests, 81 passed, 0 failed |
| Codeforces platform set (aliases, adapter, extractor) | 83 tests, 83 passed, 0 failed |
| Mirror and material-view set | 29 tests, 29 passed, 0 failed |
| `npm run typecheck` | passed (no diagnostics) |
| `npm run check:architecture` | "Architecture imports satisfy the declared layer boundaries." |
| `git diff --check` | exit 0 (line endings only; `core.autocrlf=true` normalises them on commit) |
| `npm run check` | passed: typecheck, architecture, 1452 business tests with 1450 passed / 0 failed / 2 skipped (the existing non-Windows credential-vault cases), 20 script tests, ESM build, browser factory/shared React/disposal checks |

Coverage against the contract's test list:

1. **Direct full keys** — `878C / 879E` in one heading, and both official links; both succeed with
   exactly the two requests the old path made.
2. **Div.1-only heading** — request `879E`, heading `Div. 1 E`, verified pair/titles/statement/blog;
   the section is extracted under `878E` and the note records the redirect.
3. **Non-fixed arrangement** — Div. 2 `A` on contest `700` answered from Div. 1 `E` on contest `701`,
   proving no offset is baked in.
4. **Refusals** (each asserted to be `changed_response`/`unavailable`, never `absent`): same title but
   different statement; a one-character constraint change; a different sample; a different official
   title; a title differing only in case; a candidate page linking another blog; a requested page that
   does not link the blog; different start times; different durations; different core names; a blog
   naming more contests than the bound; a foreign link; a heading with no problem index; a prose
   heading that merely mentions a division; two matching headings; an empty section; a section naming
   neither problem; no Tutorial link; unreadable contest metadata.
5. **Run boundaries** — the request budget is asserted (`<= 5` requests), the requested page is fetched
   once and reused for the alias check, `ambiguous`/`empty` provably make no extra request, an
   unreadable metadata answer makes the alias unverifiable, and the existing 429/5xx/challenge/
   cancellation/response-cap behaviour is unchanged and still covered by `tests/platform/codeforces.test.ts`.
6. **Import integration** — a Luogu `CF879E` mirror saved a shared-round editorial: the two-level
   provenance is complete in the stored note, the statement still comes from Luogu, Luogu is never asked
   for an editorial, the blog URL is preserved, the solution id is bound to `879E`, `CF878E` never
   appears, a head that moves during the fetch refuses the write with nothing committed, the older
   material is preserved on a failure, the DTO carries no statement hash or body, and no model is called.

## Historical open issue: Luogu's own authenticated editorial reading (resolved in Stage 33C)

The following was the boundary when this Stage 33B slice closed; Stage 33C later implemented guarded
authenticated Luogu editorial reading.

This stage did not implement authenticated Luogu editorial fetching. A Luogu problem that is not
an exact `CF<contest><index>` mirror has no automatic source of material; that state is reported as
`source_unavailable` or `changed_response` (never `absent`), and the supported free paths remain
refreshing the platform material and pasting a user-provided answer with its own source label. The
sanitized-response prerequisite recorded for that work is unchanged.
