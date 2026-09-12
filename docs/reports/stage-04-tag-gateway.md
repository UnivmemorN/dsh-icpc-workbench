# Stage 4a2 — strict tag gateway repair report

Scope of this repair round: `src/adapters/dsh/model-gateway.ts`, `src/adapters/dsh/model-output.ts`,
`tests/model/gateway.test.ts` and this report only. The audited client and the accepted analysis
pipeline were not touched, no Git command ran and no paid model call was made.

## Repairs

1. **Valid analysis fixture nesting** — the happy-path test now puts the `note` on an *evidence*
   entry, matching the strict schema (note is permitted on evidence only). The parser was not
   relaxed; a suggestion-level `note` is still an unknown key and fails the call.
2. **Input-cap assertion** — the test no longer expects internal byte accounting in the public
   error. It asserts `unsupported`, `retryable: false`, zero usage, zero dispatch, and that the
   message leaks neither `UTF-8` framing, the editorial excerpt nor the pasted input.
3. **Merged rationales preserved** — when one taxonomy id is legitimately supported by distinct
   solutions, `parseAnalyzeOutput` now keeps every distinct rationale in deterministic encounter
   order, joined with `\n`, and fails the whole call with `too_long` if the joined text exceeds
   `MAX_RATIONALE_CHARS` (2000). Identical rationales are stored once. Repeating a tag for an
   already-cited solution is still `duplicate_entry`.
4. **Local verification input gate** — `verifyInputProblem` now requires at least one evidence
   entry per suggestion, a shown solution of the same snapshot, and an excerpt that is at least
   `MIN_EVIDENCE_EXCERPT_CHARS` (12) normalised literal characters of that solution via the domain
   `verifyExcerptInSolution`. Empty, non-text, foreign or unmatched citations are refused with
   `unsupported`, zero usage and no dispatch. The output-side `requireLocalEvidence` defence in
   `parseVerificationOutput` is unchanged and still covered by a direct validator test.

## Tests added or rewritten (`tests/model/gateway.test.ts`)

- `an identical repeated rationale is kept once in encounter order` — same-tag/distinct-method
  merge with identical prose keeps one rationale and both evidence entries.
- `combined rationales above the cap fail the call instead of being truncated` — two distinct
  1990-character rationales for the same tag fail the call.
- `fabricated or empty evidence is refused locally before any dispatch` — replaces the old
  fabricated-quote test; asserts `unsupported`/zero usage/no dispatch for a quote that is not in
  the named solution and for an empty evidence list.
- `the output validator still refuses a support verdict without local evidence` — drives
  `parseVerificationOutput` directly and expects `unverified_support`, proving the output defence
  remains.
- The distinct-solutions merge test now asserts the newline-joined rationale in encounter order.

## Commands actually run

| Command | Result |
| --- | --- |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/model/gateway.test.ts` | pass, 34/34 tests, 0 fail |
| `npm run typecheck` | pass, no diagnostics |
| `npm run check` | pass: typecheck, architecture check, 319/319 tests, 6/6 usage and worker-context tests, `Built independent ESM package in dist.` |

No test was skipped, weakened or deleted, and no gate was bypassed.

## Limitations and open issues

- The local evidence gate duplicates the output-side excerpt check, so for gateway-driven calls the
  `unverified_support` path is now reachable only through a direct parser call; it is retained as
  defence in depth for callers that bypass `verifyInputProblem`.
- Rationale merging is a repair of Stage 4a2 scope only. Precision/adoption effects remain
  unmeasured: no paid tag benchmark has run, and live model verification is still separate from
  these offline fixtures.
- Suspicious metadata lengths of upstream suggestion objects (for example a non-array `evidence`
  from untyped callers) are rejected by the gateway at runtime through a non-narrowing
  `isNonEmptyArray` guard; the compile-time port type stays `readonly EvidenceRef[]`.
