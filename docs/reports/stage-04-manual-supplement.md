# Stage 4m1 — manual supplementation without exposing or erasing hidden tags

Status: implemented, repaired against review findings and checked locally. No adapter, HTTP, UI,
schema or contract file changed.

## Scope delivered

`ImportService.supplementMaterial(request, token)` plus the pure input/output types in
`application/import-types.ts`. This is the write path the approved manual statement/editorial
form needs: the unsolved-problem DTO deliberately omits raw tags, ratings and cached editorial,
so a full re-import from the browser could erase them.

- One `store.transaction`. Inside it the service reads the stored problem, its source instance
  and the current snapshot, then refuses (before any write) a missing problem, a stored
  reference that does not match the requested key, a missing source instance, or an
  `expectedSnapshotId` that is not the current head (`invalid_transition`).
- The new problem is built from the **stored** `ref`/`title`/`url`/`ratings`/`rawTags`, replacing
  only the supplied statement and the observation time (`fetchedAt`). A client copy of the
  problem is never accepted, so hidden metadata cannot be erased.
- `upsertProblems` and the snapshot save share the transaction; `throwIfCancelled` follows every
  write, so a cancellation after either write rolls the whole call back.
- Reuses the existing private `mergeEditorialMaterial` and `persistSnapshot` (and
  `declaredMaterialResult` for the declaration shape). Identical semantic content reuses the
  exact previous snapshot: same id, same version, `changed: false`, no `saveSnapshot` call.
- Material merge keeps the shared rules: declared source ids are replaced, other sources and
  their solutions survive, an explicit `absent` is recorded under the target-derived check id
  and never deletes a source that already holds successful material.
- Return is `{problemKey, snapshot: SnapshotWrite, material: MaterialReport | null}` only — no
  problem body, tags or editorial text is echoed.
- No platform or model call: an `absent` declaration is a recorded decision and never triggers
  the reasoning role.

## Validation (strict, before any read or write)

- the request object is closed: an unknown own top-level field (`rawTags`, `title`, …) and an
  array in the `request`, `material` or `material.result` position are `invalid_input`, never
  silently ignored;
- at least one of `statement`/`material` required; an explicit `null` for either is rejected
  (this operation never deletes a stored statement or clears material);
- `problemKey` must be a canonical problem key; `expectedSnapshotId` must be `null` or a
  snapshot id of that same problem; a foreign token is `invalid_input`;
- `statement` keeps the caller's text (the domain trims it) but must be non-blank and at most
  `MAX_SUPPLEMENT_STATEMENT_CHARS` (200 000) characters;
- `material` must be for the same problem and declare `found` or `absent` only. A `found`
  declaration needs a non-empty source/solution set, sources with a real id, URL, title,
  `retrievedAt` and sha256 body hash at `availability: 'found'`, and every solution rebuilt
  through `createEditorialSolution` (literal body, ids, ordinal) against a declared source. An
  `absent` declaration needs URL, title and note.

## Repair round — acceptance findings

Two review findings were repaired without touching the contract or any adapter/UI/schema file:

1. **The request shape is now closed.** `validateSupplementRequest` rejects an array request
   and any unknown own top-level field (`rawTags`, `title`, `snapshotId`, …) with
   `invalid_input` instead of silently ignoring it; `material` must be a non-array object and
   its `result` must be a non-array object. The already-normalised port shapes are otherwise
   unchanged. The validation test supplies those shapes and its existing zero-write assertions
   prove none of the rejected calls wrote a problem row or advanced the head.
2. **A `found` answer never drops a successful source it does not name.** The `found` branch of
   the shared `mergeEditorialMaterial` removed every previous source whose id equalled the
   target-derived check id, even when that source was `found`. Supplementing an independent
   editorial with a `null` declaration URL (target = problem URL) therefore erased the prior
   successful article stored under `editorialSourceIdOf(problem.ref, problem.url)` and kept its
   solution, producing an orphan-solution failure. The branch now removes the check-id source
   only when it is a non-`found` placeholder, and retained solutions are filtered to retained
   sources, so every successful source not explicitly named survives with its solutions.
   `applyManual`, `syncPage` and `refreshMaterial` keep their behavior; their tests are
   unchanged and pass.

## Changed files

- `src/application/import-types.ts` — `MAX_SUPPLEMENT_STATEMENT_CHARS`,
  `SupplementMaterialRequest`, `SupplementMaterialReport`. Unchanged by the repair round.
- `src/application/import-service.ts` — `supplementMaterial`, the class-level contract bullet,
  `validateSupplementRequest` / `validateSupplementMaterial` / `validateSupplementSource`, and
  the `found` branch of `mergeEditorialMaterial` (repair round).
- `tests/import/supplement.test.ts` — new, 10 tests against the real SQLite store; the repair
  round adds the closed-request assertions and the found-branch regression test.
- `docs/reports/stage-04-manual-supplement.md` — this report.

## Commands actually run

Original implementation round:

```
npm run typecheck
node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none "tests/import/supplement.test.ts"
npm run check
```

Results: focused file 9/9 pass; `npm run check` passes typecheck, the architecture dependency
check, 382 behavior tests (373 before, +9 here), the 6 accounting/context tests and the bundle
build (`Built independent ESM package in dist.`).

Repair round (focused checks first, then the full check once):

```
npm run typecheck
node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none "tests/import/supplement.test.ts" "tests/import/import-service.test.ts"
npm run check
```

Results: typecheck clean; the two focused files 35/35 (25 `import-service.test.ts` + 10
`supplement.test.ts`, including the new regression test); `npm run check` passes typecheck, the
architecture check, 383 behavior tests (382 + the one new supplement test), the 6
accounting/context tests and the bundle build. No refresh, manual-import or sync test was
changed.

## Test coverage

Hidden metadata survives a statement-only and a material-only supplement (tags, ratings, title,
url in both the stored row and the snapshot); an identical supplement reuses the exact snapshot
with no new version and no second `saveSnapshot`; a superseded or `null` `expectedSnapshotId` is
refused with nothing written; cancellation after the problem write and after the snapshot save
both roll back (the attempted snapshot id is not retrievable); validation rejects nothing-to-
write, blank/oversized/`null` statement, a declaration for another problem, `unavailable`, an
empty `found` set, an empty literal solution body, an unknown source reference, an `absent`
without URL/title/note, a foreign snapshot token and an unstored problem; independent articles
survive an `absent` declaration with its attribution retained; an `absent` check for a target
that already holds material preserves that material and reuses the snapshot. The repair round
adds: unknown own request fields (`rawTags`, `title`, `snapshotId`) and an array as the request,
the `material` or the `material.result` are all `invalid_input` with nothing written; and a real
SQLite case where a `found` supplement with a `null` declaration URL keeps the prior successful
source stored under `editorialSourceIdOf(problem.ref, problem.url)` together with its solution,
while the distinct new article and its solution are added as well.

## Open issues / follow-ups

- The plugin/UI layer still has to call this operation from the manual form; no UI wiring was in
  scope here.
- `refreshMaterial` continues to decide material availability for fetch paths; `supplementMaterial`
  deliberately does not trigger the reasoning role, so a reviewer-driven reasoning call remains a
  separate later step.
- No live platform or model verification was involved (none is possible in this operation).
- The closed request shape means the plugin/UI caller must send exactly `problemKey`,
  `expectedSnapshotId`, `statement` and `material`; an extra field is now a hard `invalid_input`
  rather than being ignored.
