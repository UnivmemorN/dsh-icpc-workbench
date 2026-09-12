# Stage 4h1 — non-model business endpoints (repair 1)

Status: contract-04h1-r1 complete; original h1 scope finished. No Git, no paid calls, no harness edits, no model calls.

## Changed files
- `src/plugin/business-api.ts` — route table now takes `(literalOperation, {method,validate,handle})` and returns `BusinessRouteEntry[]` (obsolete union/`registerable` removed); one guard maps `DomainError` to fixed codes and `PlatformError invalid_input` to 400 while rethrowing everything else; `registerBusinessApi` is async with reverse-order, attempt-all, aggregated, memoized disposal; found supplement built with `createEditorialSource`/`createEditorialSolution` (real sha256 hashes, ordinal 0, stable `editorialSourceIdOf`).
- `src/plugin/api-validation.ts` — `mapBusinessError` rethrows unknown errors instead of fabricating a 500 that suppresses the observer; `mapPlatformFailure` accepts only a known `PlatformError`/descriptor and rethrows `invalid_input`; `validateImportPreview`/`validateImportApply` split so `expectedHash` is apply-only; empty arrays allowed for CSV `accounts`/`problems`/`editorials`/`rawTags`/`ratings` and retrospective `taxonomyIds`/`solutionIds` (found editorial write-ups still require one); canonical identity via `problemKey(parseProblemKey(...))` and `parseAccountId` before reads; CSV `source.id` accepted and left to the parser to verify.
- `src/adapters/luogu/account.ts` — removed the incorrect 64-bit claim; the 20-digit bound stays as an opaque format limit.
- `tests/plugin/business-api.test.ts` — 17 new tests over real SQLite plus real `ImportService`/`WorkbenchService`, a fake registry and fake platform adapters.
- `docs/reports/stage-04-business-api.md` — this report.

## Commands actually run
- `npm run typecheck` — clean (immediately after the route-table fix, and again after the validator/supplement edits).
- `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/plugin/business-api.test.ts` — 17/17 pass.
- `npm run check` — 494 tests + 7 usage tests pass; architecture check and `dist` build pass.

## Behaviour covered by the new tests
account canonicalization, instance isolation, cancellation rollback; a committed sync page; `auth_required` vs `rate_limited` vs `unsupported`; preview writes nothing, apply hash mismatch → 409, idempotent re-apply; JSON and CSV public shapes with empty context arrays; found supplement persists both content hashes, a same-URL edit replaces exactly that source, hidden statement/raw tags/ratings survive, a stale snapshot id → 409 with no change; refresh answers are recursively redacted (algorithm and raw-tag sentinels absent) with auth failure vs absence distinct and cached material preserved; bank/detail/review/retro/weakness/plan roundtrip through the service DTOs with spoiler fields absent; unknown and nested unknown fields → 400; an unexpected store error → sanitized 500 + observer; async disposal with deferred disposers, delayed rejection, mid-registration rollback, memoization and no unhandled rejection.

## Open issues / limits
- `registerBusinessApi` now returns `Promise<() => Promise<void>>`; no accepted caller existed, so the composition stage must `await` it.
- A release that cannot dispose every registration rejects with `BusinessApiCleanupError` (carrying `cleanupFailures`) after reporting each failure through `onDisposeError`; the composition decides how to surface it.
- `plan.preview` is exercised for the honest empty-pool path only; draft generation itself is covered by the Stage 4w1b service tests.
- No batch, coaching, model-catalog, settings or bootstrap routes are registered; those remain later stages.
