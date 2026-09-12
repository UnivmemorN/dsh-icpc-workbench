# Stage 1 — rule correctness repair (second review)

Scope: core domain rule correctness plus focused regression tests only. No UI, storage,
platform, packaging or contract changes.

## Changed files

| File | Change |
| --- | --- |
| `src/domain/ids.ts` | Replaced the hand-written byte escape/decode routines with `encodeURIComponent`/`decodeURIComponent`; every component (including nested instance ids and nested account ids) is escaped when a key is composed; parsers require canonical re-encoding; control characters rejected; `INSTANCE_SEPARATOR` exported and used. |
| `src/domain/source.ts` | `sourceInstanceIdOf` now yields `platform:domain` with the domain escaped, accepts `host:port` (no colon rejection), lowercases hosts only. |
| `src/domain/problem.ts` | Normalised ref is built once and the key is derived from it, so `problem.ref.externalKey` and `problem.key` cannot disagree (no double encoding). |
| `src/domain/submission.ts` | Submission id escapes the platform submission id as well; composite id stays unambiguous. |
| `src/domain/analysis.ts` | `createAnalysisResult` rejects verifications/reasoning drafts from another problem or snapshot; `transitionJob`: non-retryable `fail` is terminal `failed`, `consume_call`/`succeed` require `running`, `requeue` refuses a live lease. |
| `src/domain/eligibility.ts` | Only `completed` analyses may auto-adopt (`analysis_incomplete` → needs review); `resolveTagDecisions` reports `stale` even with zero suggestions; `evaluateAnalysis` also checks the analysis/snapshot problem match. |
| `src/domain/tags.ts` | Removed unused import; added the `analysis_incomplete` decision reason. |
| `src/domain/snapshot.ts` | Removed unused import. |
| `src/domain/index.ts` | Removed the duplicate `createEvidenceRef` export. |
| `src/domain/training.ts` | `editPlanTask` validates its `at` input without binding an unused local. |
| `tests/domain/regressions.test.ts` | New focused regressions (13 tests) for all of the above, built only from public domain factories. |

## Identity semantics fixed

* Instance id = `platform:domain` (domain escaped), e.g. `codeforces:codeforces.com`,
  `hydro:localhost%3A8080`. Two Hydro deployments and `host:port` are supported.
* Problem key = `esc(instance)|esc(domain)|esc(externalKey)`, account id =
  `esc(instance)|esc(handle)`, submission key = `esc(accountId)|problemKey`, submission id =
  `submissionKey|esc(externalId)`. Nested compounds are escaped as opaque single parts.
* Handles and external problem/submission ids keep their platform spelling (case
  preserved); only trimming + NFC normalisation happens in the domain.
* Parsing rejects wrong arity, malformed percent-encoding, non-canonical escaping and
  control characters.

## Commands run

```
npx tsc -p tsconfig.json                       # clean, no diagnostics
node --experimental-strip-types --import ./tests/loader.mjs --test --test-isolation=none \
  tests/domain/regressions.test.ts tests/domain/zz-probe.test.ts
  # tests 13, pass 13, fail 0
npm run check:architecture                     # Architecture imports satisfy the declared layer boundaries.
```

## Verification notes

* `isSnapshotStale` already compared id + hash + version, so the `A -> B -> A` rule only
  needed a locking test (first and third snapshot share id/hash, version 3 vs 1 → stale);
  the actual defect was `resolveTagDecisions` reporting `stale: false` for an empty
  suggestion list, which is fixed.
* Caller-owned arrays/objects passed to `createNormalizedProblem`/`createProblemSnapshot`
  stay unfrozen and unmutated; a caller-side mutation after snapshot creation cannot reach
  the snapshot.

## Open issues / not done

* `TrainingCandidate.ref` and `Submission.ref` still store the caller's ref verbatim while
  the derived key is produced by `problemKey` (which trims/escapes). They agree for all
  factory-produced refs; normalising refs inside those factories was left out as out of
  scope for this repair.
* `docs/reports/` did not exist before this file; nothing else was added to it.
