# Stage 4s2a — coaching generator and application port

Status: implemented locally; focused and full repository gates pass. No paid model call was made —
the tests drive the real generator through the real audited client with scripted local streams.

## Scope delivered

- `src/application/coaching-generation.ts` (new): pure `CoachingGenerator` port, the exact
  read-only request/outcome vocabulary reused by the next service, and `coachingGenerationProblem`,
  the pre-dispatch request check.
- `src/adapters/dsh/coaching-generator.ts` (new): `DshCoachingGenerator` over the existing audited
  client (one call, role `coaching`, no retry, no provider/session bypass), the fixed Chinese tutor
  system prompt, the exact task payload and the strict `{ text }` output parser.
- `src/adapters/dsh/index.ts`: barrel exports for the generator, its prompt/temperature, the parser
  and its option/client types.
- `tests/model/coaching-generator.test.ts` (new): 10 behavior tests.

Non-goals kept out (as contracted): coaching service, store, schema, API and UI; level progression
eligibility; retry/quota policy; any real paid call.

## Interfaces

- `CoachingGenerator.generate(request): Promise<ModelCallResult<{ text: string }>>`.
- `CoachingGenerationRequest`: `snapshot`, `level` (`CoachingLevel`), `provider`, `model`,
  `maxOutputTokens`, `requestTimeoutMs`, `effort: 'max'`, `attemptId`, `promptVersion`, `token`,
  `previousHints: readonly { level: 1 | 2 | 3; text: string }[]`, `explicitFullSolution`.
- Exported constants: `COACHING_PROMPT_VERSION` (`coaching-v1`), `COACHING_EFFORT` (`max`),
  `MAX_COACHING_PREVIOUS_HINTS` (3), `COACHING_TEMPERATURE` (0.2), `COACHING_SYSTEM_PROMPT`,
  `parseCoachingOutput`.

## Refused before any dispatch (typed `unsupported`, known-zero usage)

Full non-empty statement at every level; known level; non-empty configured provider/model/
attemptId/promptVersion/snapshotId; well-formed cancellation token; positive-integer output and
timeout limits (the audited client still enforces its final caps); `effort: 'max'`; `full` only with
`explicitFullSolution: true` (and a hint level may not carry the flag); at most three earlier hints,
one per level, each strictly below the requested level, each non-empty and ≤ 200000 characters.

## Prompt and output contract

- System prompt states the level discipline (1: conceptual direction only; 2: key invariant without
  full C++; 3: pseudocode allowed; `full`: explanation + C++17 only when explicitly requested), the
  untrusted-data rule, and the ban on claiming compilation/execution/judging. Level discipline is a
  prompt instruction, not regex-enforced.
- User message is one JSON object: problem metadata with the full statement, found editorial sources
  plus their solution text, the selected level, the explicit-full-solution flag and the earlier
  lower hints. No taxonomy ids, benchmark labels, credentials or endpoints.
- Output must be exactly `{"text": "..."}`: unknown keys, non-strings, blank or >200000-character
  answers and control characters fail the call as `invalid_output`; known usage is retained, unknown
  usage stays `null`. The answer is returned trimmed as text/Markdown, never interpreted as HTML.

## Commands actually run

1. `npm run typecheck` → pass.
2. `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/model/coaching-generator.test.ts`
   → 10 tests, 10 pass, 0 fail.
3. `npm run check` → typecheck pass; architecture check pass ("Architecture imports satisfy the
   declared layer boundaries."); 351 behavior tests pass (341 existing + 10 new); 6 accounting/
   context tests pass; `node scripts/build.mjs` reports "Built independent ESM package in dist."

## Open issues / notes

- `EditorialSource` stores metadata and a content hash, not the body text, so the editorial text
  sent is `EditorialSolution.text` of `found` sources; the absent source is omitted entirely.
- `DshCoachingGenerator` accepts an optional `now` for parity with the other dsh adapters and
  validates it at construction; this stage's value type is exactly `{ text }`, so no timestamp is
  derived here.
- Semantic hint-level compliance remains unverified by design; the next service must not treat a
  model answer as proof that a level was respected.

Coordinator acceptance: clarified that full-level C++17 source output is permitted while tool execution is not; grounded reasoning is allowed without inventing problem facts. The prior blanket ban on executable content conflicted with the full-solution feature. Focused tests and build rerun.
