# Stage 3b2 — manual interchange parser and adapter

Status: implemented, focused suite 17/17 and `npm run check` green (222 behaviour tests + 3 usage tests, typecheck, architecture, build). No Git actions, no network, no storage/UI/pipeline/LLM changes.

## Changed files
- `src/adapters/manual/types.ts` (new): version 1 schema constants and limits, exact input interfaces, `ManualDocument`/`ManualEditorialEntry`/`ManualPreview`/`ManualProblemMaterial`, issue codes and option unions.
- `src/adapters/manual/parse.ts` (new): `parseManualJson(text, options?)` and `parseManualCsv(text, options)`; shared `normalizeManualTimestamp` (strict ISO-8601 with timezone **and** calendar/rollover check) and `manualAttributionUrl` (absolute http(s), no userinfo). Strict recursive field sets, optional source `id` verified against the derived `platform:domain`, Codeforces handle canonicalisation through `adapters/codeforces/account.ts`, reference/duplicate detection, limits (8 MiB text, 10 000 rows, 200 000-char statement/solution, 2 000-char other strings).
- `src/adapters/manual/adapter.ts` (new): `ManualPlatformAdapter`/`createManualPlatformAdapter`; owned frozen clones of every result, explicit offline capabilities, `limit` 1..500, opaque cursors bound to document content hash/resource/source/account/since, typed `unavailable` for missing problem detail, `materialFor`/`listMaterials` for a later import service.
- `src/adapters/manual/index.ts` (new): public barrel.
- `tests/platform/manual.test.ts` (new): 17 tests over original synthetic fixtures only, no network, no filesystem.
- `docs/manual-import.md` (new): JSON schema, CSV columns (JSON cells for `rawTags`/`ratings`), limits, editorial semantics, adapter notes and one original synthetic JSON+CSV example.

## Behaviour highlights
- Editorials are `found` (URL/title/one-or-more verbatim solutions), explicit `absent` (non-empty deliberate note, no solutions) or `unavailable` when no record exists; a blank field never implies absence.
- Imports preserve source identity: a Codeforces supplemental import keeps `codeforces:codeforces.com` problem/account ids with canonical lowercase handles; credential-looking fields are rejected by the strict schema and no URL is ever fetched or rendered.
- Duplicate identities reject; identical duplicate submission rows are `duplicate_row`, conflicting ones `duplicate_conflict`; the document is wholly valid or the caller gets explicit errors with `path`/`row`/`line`/`field`, never a partial write or a silent merge.
- Adapter calls check cancellation before reading cached arrays; mutating parser context, a returned page or its problems cannot change later answers.

## Commands actually run
- `npm run typecheck` (green)
- `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/platform/manual.test.ts` (17/17)
- `npm run check` (green: 222 tests + 3 usage tests + architecture + build)

## Open issues
- CSV has no editorial kind (deliberate); editorials arrive through JSON or `options.editorials`.
- No application service persists a document yet; `materialFor(ref)`/`listMaterials()` are the intended hook.
- Text-only by design: pasted HTML is stored as literal text, never parsed or rendered.

## Repair round 1 — manual acceptance (narrow scope)

Status: focused manual suite 22/22, `npm run check` green (227 behaviour + 3 usage tests, typecheck, architecture, build). The coordinator probe `.local/manual-acceptance-probe.mjs` now reports `sameHash:false` for all four metadata variants, `fractionalMemory valid:true`, and `row 2, line 3` for the bad third physical line.

### Changed files
- `src/adapters/manual/parse.ts`: `fingerprintOf` now covers every semantic field (full source including `displayName`/`baseUrl`; accounts; problems; submissions; editorial entries with source/solution ids, kind, title, language, availability, note and derived content hashes), excluding only `importedAt`/`fetchedAt`/`retrievedAt`; large bodies are represented by their `contentHash`. `memoryKiB` uses a finite non-negative number reader (JSON) and a fractional-aware CSV cell reader, preserving values exactly. CSV `line` is the record's physical start line, derived from cumulative `info.lines`/`info.empty_lines`. CSV parsing is capped with `to: MANUAL_MAX_ROWS + 2`; a full cap is rejected as `too_many_rows`, never truncated into a valid import.
- `src/adapters/manual/types.ts`: `timeMs` documented as whole milliseconds, `memoryKiB` as an exactly preserved fractional value.
- `tests/platform/manual.test.ts`: 5 added tests — hash metadata sensitivity and parse-time stability, cursor rejection after a metadata-only change, fractional `memoryKiB` (JSON/CSV, valid + invalid), physical start lines (ordinary rows, blank lines, BOM, multiline quoted record), row-limit `limit` accepted / `limit + 1` rejected.
- `docs/manual-import.md`: content-hash coverage, fractional `memoryKiB`, start-line semantics, row-cap rejection.

### Commands actually run
- `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/platform/manual.test.ts` → 22/22
- `npm run check` → green (227 + 3 tests, typecheck, architecture, build)
- `node .local/manual-acceptance-probe.mjs` → four hash variants differ, fractional memory accepted, bad third line reported as row 2 / line 3

### Open issues
- JSON input stays bounded by the 8 MiB byte cap alone (arrays validate after `JSON.parse`); only CSV materialisation needed the explicit record cap.

## Coordinator acceptance
- Independent full gate: 227 behavior tests + 3 accounting tests passed, typecheck/architecture/build.
- Original reproduction now confirms semantic edits change the hash, fractional KiB is retained, and the third physical CSV line is reported as line3.
- Public input types now match the documented validator: omit unknown timeMs/memoryKiB fields; explicit null is not a numeric value in interchange v1.