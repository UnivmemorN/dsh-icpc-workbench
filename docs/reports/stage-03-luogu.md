# Stage 3b1 — Luogu adapter

Status: implemented, tested, `npm run check` green. No Git actions, no network IO added to tests.

## Changed files
- `src/adapters/luogu/parsers.ts` (new): runtime validation of `/problem/list`, `/problem/<pid>`, `/_lfe/tags`; statement assembly from all sections + samples (Markdown/math kept verbatim); raw `difficulty` and numeric tag ids (negative allowed) preserved; `data.errorCode` → typed errors; HTML/malformed bodies → `changed_response`.
- `src/adapters/luogu/cursors.ts` (new): opaque base64url list cursor binding version/source/account/page/offset/perPage/count/lastPid plus sha256 fingerprint; unsafe numbers, foreign scope and broken fingerprints are `invalid_input`.
- `src/adapters/luogu/adapter.ts` (new): `LuoguAdapter`/`createLuoguAdapter`/`luoguSourceInstance`; exact `https://www.luogu.com.cn` origin and `luogu:www.luogu.com.cn` id/domain coherence validated before any request; shared `HttpTransport` with `x-lentille-request: content-only`; limit 1..500 paged across fixed server pages without skip/duplicate; server drift fails with `changed_response` + restart hint; cancellation checked after every await; optional explicit tag dictionary (`tagDictionary` or `resolveTagNames` via `/_lfe/tags`) that adds names next to `luogu-tag:<id>` and surfaces failures instead of zero-tag success. `fetchProblemDetail` additionally exposes validated time/memory limits.
- `src/adapters/luogu/index.ts` (new): public barrel.
- `tests/platform/luogu.test.ts` (new): 14 tests, in-process harness/stub fetch only.

## Capabilities / honest limits
- `problems: true`, `pagedProblems: true`, `implemented: true`.
- `submissions/pagedSubmissions/editorial: false`, `requiresAuth: true`, `supportsAccountHistory: false`.
- `listSubmissions` and `fetchEditorial` probe the anonymous endpoints and return typed failures: HTTP 401 / `errorCode=401` (UserUnloginException) → `auth_required`, 403 → `forbidden`, 429 → `rate_limited` (Retry-After preserved), unfamiliar successful payload → `changed_response`. Never `absent`, never an empty page.
- Authenticated record/editorial shapes are NOT implemented and were not invented; no browser cookies, no challenge solving.

## Commands actually run
- `npm run typecheck` (green)
- `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/platform/luogu.test.ts` (14/14)
- `npm run check` (green: 199 tests + usage + architecture + build)

## Open issues
- Live Luogu metadata/401 behaviour still needs the coordinator's separate live verification.
- No authenticated Luogu submission/editorial adapter; manual import (Stage 3b2) remains the fallback.

## Coordinator repair round 1 (acceptance defects)

Status: all four reported defects fixed; focused Luogu suite 20/20, `npm run check` green (205 tests + 3 usage + architecture + build). No Git actions; all fixtures remain synthetic.

- **Exact full-page boundary.** A cursor no longer advances to `page+1`/`offset 0` while keeping a non-null `lastPid` (which made every normal `pageSize` 50 continuation fail on decode). It now stops on the last visited server page at `offset === perPage`; the next call re-reads, verifies and only then advances. A resume at `offset === perPage` advances instead of throwing, and a last page that is an exact multiple ends with `nextCursor: null`. Regression: `a full server page stays in the cursor and is re-verified before the listing advances` (6 unique items, perPage 2, limit 2 three times, request pages `1,1,2,2,3`).
- **Server-data fingerprint.** Cursor version 2 carries `pageFingerprint`: `luoguServerPageFingerprint` over the parsed page (page number, `perPage`, `count`, and every summary's pid/title/difficulty/tag ids in order), kept for the final page visited in the call and compared against a re-fetch of `cursor.page` before anything is taken or advanced — including the exact boundary. The metadata-only hash is kept as the token checksum (`checksum`, documented as *not* a server fingerprint); version 1 tokens are refused with a restart request. Same-count insert/delete/reorder and an in-page change with an unchanged boundary pid now reject. Each server page must satisfy `items.length === min(perPage, count - (page-1)*perPage)`, the cursor position must lie inside `count`, and repeated pids within a page or across one call reject before any partial result.
- **Dictionary / delegate token checks.** `loadTagDictionary` validates token and limits on every call, cache hit and constructor-supplied dictionary included (result still a fresh clone). `fetchProblem` re-checks the token after the awaited `fetchProblemDetail` before returning.
- **Detail statement.** `parseProblemDetail` requires a non-blank `description`; background, both formats and hint stay legitimately `null`, but input/output-only content is refused instead of being labelled a full statement. The case-insensitive pid comparison is documented and the answered canonical pid is returned.

Files changed in this round: `src/adapters/luogu/cursors.ts`, `src/adapters/luogu/adapter.ts`, `src/adapters/luogu/parsers.ts`, `tests/platform/luogu.test.ts` (14 → 20 tests).

Commands actually run:
- `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/platform/luogu.test.ts` (20/20)
- `npm run typecheck` (green)
- `npm run check` (green: 205 tests + 3 usage + architecture + build)

## Coordinator acceptance
- Independent full gate after repair: 205 behavior tests + 3 accounting tests passed, with typecheck/architecture/build.
- Actual HTTPS adapter verified P3374 statement and live tag names, anonymous editorial/records auth_required, plus two complete 50-item pages with 100 distinct problem IDs.
- Authentication remains explicit; this stage does not claim authenticated Luogu records/editorials.