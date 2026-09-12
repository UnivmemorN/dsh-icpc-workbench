# Stage 03 — Codeforces editorial identity and extraction (worker report)

## Changed
- `src/adapters/codeforces/problem-index.ts`: index regex accepts a letter with an optional
  numeric suffix (the rejected-`A` bug); numeric padding kept exactly (`921/01` ≠ `921/14`, key
  `92114` still refused); href parsing requires exactly the four official path segments and
  refuses credentials, non-default ports, foreign protocols/hosts; `http://`/`www.` stay
  identity-only. `20C` unchanged.
- `src/adapters/codeforces/editorial.ts`: strict start rule — an explicit contest+index heading
  or a link-only paragraph only; bare `A`/`B` never start, even beside a contest heading. Label
  checks run on a marker skeleton, so prose around a link cannot form a heading. A section ends
  only at the next problem heading or bare-index heading, so method subheadings stay; the body
  must carry non-heading text; a duplicate target heading is ambiguous. Removed unused
  `looksLikeMethodHeading`, `isOfficialCodeforcesHostname` and the bare-contest fallback.
- `src/adapters/codeforces/html.ts`: `withoutMetadata` clones with the public `cloneNode` and
  strips `tag-box` in the copy (no reparenting of the original tree); the body check runs on the
  stripped nodes, so a title/metadata-only statement is `empty_statement`. Outside tag boxes stay
  readable as metadata; the statement keeps sup/sub, `math/tex` and `br` text.
- Tests: `tests/platform/editorial-extract.test.ts` (bare-letter success case now rejects; new
  regressions for link-only paragraph, prose link, method subheadings, headers-only body, legacy
  long paragraph, outside/inside metadata, title-only statement) and new
  `tests/platform/problem-index.test.ts` (letter/optional suffix, padding, exact hrefs).

## Commands actually run
- `npm run typecheck` — pass.
- focused editorial + index tests (`node --experimental-strip-types ... <two test files>`) — 20/20 pass.
- `npm test` — 164/165 pass. Remaining failure is pre-existing and out of scope:
  `tests/platform/codeforces.test.ts:315` expects `/x2 \+ y1/`, while `htmlToPlainText` renders
  `x^2 + y_1` (marker behaviour untouched by this contract); the statement itself is complete and
  metadata-free.
- `npm run check:architecture` — pass.

## Open
- `cfProblemKeyFromParts`, `cfSubmissionExternalKey`, `isOfficialCodeforcesHref`,
  `officialProblemPaths` are kept because `src/adapters/codeforces/index.ts` (out of scope)
  re-exports them; no other consumer exists. No adapter/cursor/http/pipeline/domain file touched.
