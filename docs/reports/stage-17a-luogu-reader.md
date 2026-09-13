# Stage 17a — Luogu authenticated submission reader

Scope: the adapter slice of Sprint 17 only. An application-level session-reader port, a narrowly
scoped authenticated Luogu transport, a strict `/record/list` parser with a scope-bound cursor, a
minimal `LuoguAdapter` integration, focused synthetic tests and this report.

Not in this slice: UI, persistence, scheduler, real credential storage, Windows vault, real network
or live-account acceptance, editorial, schema migration, Git, budget or harness changes. No live
authenticated Luogu response was observed; every fixture is synthetic and labelled as such below.
Acceptance of the real shape remains pending until the user connects in the finished local UI.

Contract: `.local/contract-17a-luogu-reader.md` (parent `.local/contract-17-luogu-sync.md`).

## Changed files

New:

- `src/application/luogu-session.ts` — the `LuoguSessionReader` port (normalized inputs/results only).
- `src/adapters/luogu/records.ts` — strict `/record/list` payload parsing and the status→verdict map.
- `src/adapters/luogu/record-cursors.ts` — opaque, scope-bound submission cursors and fingerprints.
- `src/adapters/luogu/session-reader.ts` — session provider seam, authenticated fetch wrapper and the reader.
- `tests/platform/luogu-session.test.ts` — 20 synthetic focused tests.
- `docs/reports/stage-17a-luogu-reader.md` — this report.

Edited:

- `src/adapters/luogu/adapter.ts` — optional `sessionReader` option, delegation in `listSubmissions`,
  capability split, and the previously private instance check exported as `requireLuoguInstance`.
- `src/adapters/luogu/index.ts` — exports for the new modules.

Nothing else was touched: the anonymous transport keeps its blanket cookie prohibition, editorial is
still unavailable, and the existing problem-list behaviour is unchanged (existing Luogu tests pass
unmodified).

## Exact exported interfaces

Application port (`src/application/luogu-session.ts`):

```ts
export interface LuoguSessionReader {
  listSubmissions(request: ListSubmissionsRequest): Promise<Page<Submission>>;
}
```

`ListSubmissionsRequest` is the existing shared shape (`account`, `cursor`, `limit`, `since?`,
`token`, `limits`); `Page<Submission>` is the existing domain page. The port carries no credential,
no cookie and no provider type.

Session seam (`src/adapters/luogu/session-reader.ts`):

```ts
export interface LuoguSession {
  readonly uid: string;    // canonical Luogu UID the session authenticates
  readonly cookie: string; // raw Cookie header value; never logged/echoed/persisted
}

export interface LuoguSessionProvider {
  sessionFor(account: Account, token: CancellationToken): Promise<LuoguSession>;
}

export interface LuoguSessionReaderOptions {
  readonly sourceInstance: SourceInstance;
  readonly sessions: LuoguSessionProvider;
  readonly fetchImpl?: FetchLike;
  readonly clock?: ClockFn;
  readonly wait?: WaitFn;
  readonly setTimer?: SetTimerFn;
  readonly maxResponseBytes?: number; // default 8 MiB
  readonly maxRedirects?: number;     // default 3, same-origin only
}

export const LUOGU_MIN_REQUEST_INTERVAL_MS = 2_000;
export const LUOGU_MAX_SUBMISSION_LIMIT = 500;

export function createAuthenticatedLuoguFetch(options: {
  readonly cookie: () => string | null;
  readonly fetchImpl: FetchLike;
}): FetchLike;

export function requireLuoguSessionCookie(session: LuoguSession | null | undefined, expectedUid: string): string;

export class LuoguSessionReaderAdapter implements LuoguSessionReader {
  readonly sourceInstance: SourceInstance;
  constructor(options: LuoguSessionReaderOptions);
  listSubmissions(request: ListSubmissionsRequest): Promise<Page<Submission>>;
}

export function createLuoguSessionReader(options: LuoguSessionReaderOptions): LuoguSessionReaderAdapter;
```

Reader modules:

```ts
// records.ts
export const LUOGU_MAX_SERVER_PAGE_SIZE = 5_000;
export const LUOGU_MIN_SUBMIT_TIME_SECONDS = 946_684_800;  // 2000-01-01Z
export const LUOGU_MAX_SUBMIT_TIME_SECONDS = 4_102_444_800; // 2100-01-01Z
export const LUOGU_MAX_RECORD_COUNT = 1_000_000_000;
export const LUOGU_STATUS_VERDICTS: ReadonlyMap<number, SubmissionVerdict>;
export function luoguStatusVerdict(status: number): SubmissionVerdict;
export interface LuoguRecord {
  readonly id: string; readonly pid: string; readonly status: number;
  readonly submitTimeSeconds: number; readonly submittedAt: string; readonly language: string | null;
}
export interface LuoguRecordPage {
  readonly records: readonly LuoguRecord[];
  readonly perPage: number | null; readonly count: number | null;
}
export function parseRecordPage(root: Record<string, unknown>, expectedUid: string,
  operation?: PlatformOperation): LuoguRecordPage;

// record-cursors.ts
export const LUOGU_RECORD_CURSOR_VERSION = 1;
export interface LuoguRecordCursorScope {
  readonly sourceInstanceId: string; readonly accountId: string;
  readonly handle: string; readonly since: string | null;
}
export interface LuoguRecordCursor extends LuoguRecordCursorScope { /* page, offset, perPage, count,
  delivered, boundaryId, pageFingerprint, checksum, version */ }
export type LuoguRecordCursorInput = Omit<LuoguRecordCursor, 'version' | 'checksum'>;
export function luoguRecordCursorFingerprint(input: LuoguRecordCursorInput): string;
export function luoguRecordPageFingerprint(pageNumber: number, page: LuoguRecordPage): string;
export function encodeLuoguRecordCursor(input: LuoguRecordCursorInput): string;
export function decodeLuoguRecordCursor(raw: string, scope: LuoguRecordCursorScope): LuoguRecordCursor;

// adapter.ts (integration)
export interface LuoguAdapterOptions { /* … existing … */ readonly sessionReader?: LuoguSessionReader | null; }
export function requireLuoguInstance(instance: SourceInstance, operation?: PlatformOperation): void;
```

`LuoguAdapter.capabilities()` now reports `submissions`/`pagedSubmissions`/`supportsAccountHistory`
as `true` **only** when a reader is injected, with a note that the record envelope was never
verified against a live authenticated response. Without a reader the previous honest probe of the
anonymous endpoint is unchanged.

## Supported payload shape (synthetic fixtures only)

The only accepted envelope is the Lentille list shape observed for the anonymous list endpoints:

```
{ data: { records: { result: [ { id, status, submitTime, problem: { pid }, user?, language? } ],
                      perPage?, count? },
          uid?, user? { uid }, filter? { user? , uid? } } }
```

Validation rules, all rejecting the page atomically (`changed_response`, no sample):

- `data.errorCode` is translated by the shared `luoguData` (401 → `auth_required`, 403 → `forbidden`,
  429 → `rate_limited`, 5xx → `unavailable`, anything else → `changed_response`).
- `id`: positive safe integer (canonical decimal string identity). `status`: safe integer, mapped by
  the table below. `submitTime`: integer Unix **seconds** in [2000-01-01, 2100-01-01]; no fallback date.
  `problem.pid`: official Luogu pid. `language`: only a string label is imported (trimmed, bounded);
  numeric ids become `null`. `time`/`memory` are not read at all (units unverified).
- Any exposed identity (`data.uid`, `data.user.uid`, `data.filter.user`/`uid`, per-record
  `user.uid`) must equal the account UID; a present identity with an unusable shape is refused.
- Records must be strictly descending by `id` and non-increasing by `submitTime`.
- `perPage`/`count` are optional; when present they are range-checked and used as drift signals.
- The older `currentData` envelope is deliberately unsupported and refused as `changed_response`.

The reference `/record/list?user=UID&page=N` request is built internally with
`x-lentille-request: content-only`; a caller cannot redirect `user`.

## Cursor and scan semantics

- `limit` is exact; a call slices across server pages and returns at most `limit` submissions.
- `since` is inclusive. Because the list is newest-first, the first older record ends the window and
  the page reports `nextCursor: null` (a checkpoint is never marked complete by a partial scan).
- Termination uses structure, never a possibly-misread total: a short page ends the listing when the
  server declared `perPage`; when it declares nothing, the next empty page ends it.
- On resume the reader re-fetches the cursor's page and verifies, in order: scope (instance, account
  id, canonical UID, `since`), declared `perPage`/`count`, the stored page identity fingerprint, the
  record at `offset - 1` against `boundaryId`, and the position/`delivered` invariant. Any mismatch is
  `changed_response` with "restart the submission listing".
- A page that is shorter than the declared total requires, or longer than the declared page size, is
  refused; an empty page before the declared total is refused; a next page whose first record is not
  strictly older than the last delivered one is refused (this is what turns an insertion-shifted
  boundary into a safe restart instead of a duplicate delivery).
- The page fingerprint covers ordered record identity (`id`, `pid`, `submitTime`) and excludes
  `status`, so a normal rejudge does not invalidate a resumable cursor (tested).

Status map (`LUOGU_STATUS_VERDICTS`): `2` compile_error, `4` memory_limit_exceeded, `5`
time_limit_exceeded, `6` wrong_answer, `7` runtime_error, `12` accepted. Every other code —
including `0`/`1` (waiting/judging), negative and future codes — is `unknown`. Pending records can
never become accepted.

## Transport and secret properties (each pinned by a test)

- One `HttpTransport` per account (cached), so the >= 2000 ms pacing floor is shared across pages and
  calls; the caller's `minRequestIntervalMs` can never lower it.
- The session cookie is attached only by `createAuthenticatedLuoguFetch`, only after an exact
  `https://www.luogu.com.cn` origin/protocol/no-userinfo/no-port check, and never merged with a
  caller-supplied `cookie` header. Inherited from `HttpTransport`: FIFO pacing, whole-response
  timeout, retries, streaming byte cap, `credentials: 'omit'`, `redirect: 'manual'`, and refusal of
  any cross-origin redirect **before** it is fetched (so the cookie is never sent elsewhere). A
  same-origin redirect is followed and keeps the session, which is what distinguishes "session
  expired, answered by `/auth/login`" (`auth_required`) from an HTML challenge (`changed_response`).
- The session is validated against the selected account before any request: provider UID, cookie
  `__client_id`, cookie `_uid` when present, header safety (no CR/LF/control characters, no
  surrounding whitespace, length bound). Failures are `invalid_input` and contain no cookie bytes.
- A provider failure whose message could contain secret material is replaced with a fixed
  `unavailable`; a fetch rejection is replaced with a sanitized retryable `unavailable`; malformed
  JSON is reported without V8's body-quoting parser message. Authenticated reader errors never carry
  a `sample`.
- `accountId`, `sourceInstanceId`, canonical UID, `limit`, `limits` and `since` are validated before
  the provider call or any request.

## Commands actually run

All from `D:\dsh-icpc-workbench` on Windows (PowerShell), node from the repo toolchain:

| Command | Result |
| --- | --- |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none "tests/platform/luogu-session.test.ts" "tests/platform/luogu.test.ts"` | 40 tests, 40 pass, 0 fail (20 new + 20 existing Luogu) |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none "tests/platform/*.test.ts" "tests/import/*.test.ts"` | 177 tests, 177 pass, 0 fail |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none "tests/plugin/*.test.ts"` | 135 tests, 135 pass, 0 fail |
| `npm run typecheck` | clean |
| `npm run check:architecture` | `Architecture imports satisfy the declared layer boundaries.` |

Coverage of the required failure paths: multiple pages and within-server-page slicing; inclusive
lower bound; cursor replay idempotency; cancellation before dispatch, during IO and after the session
resolves; account/session mismatch (provider UID, cookie `__client_id`, `_uid`, non-numeric and
non-canonical handles, foreign instance, foreign envelope/record identity); cursor drift (changed page
content, moved boundary, changed total, shifted next page); malformed JSON, HTML challenge, 401,
`errorCode` 401, 403, 429 with `Retry-After`, timeout, oversized body, sanitized fetch rejection;
cross-origin and same-origin redirects; secret absence in every surfaced error; a rejudge delivered as
the updated verdict without invalidating the cursor; plain adapter vs. composed capability split;
adapter re-check of cancellation after the delegate settles; existing anonymous tests unchanged.

`npm run check`, package inspection, installed browser checks, real credential composition and live
account acceptance remain with the coordinator.

## Remaining limits and open issues

1. **The live authenticated shape is unverified.** All fixtures are synthetic. The `data.records`
   envelope, the `perPage`/`count` semantics, the optional identity fields and the status codes are
   assumptions consistent with the observed Lentille list pattern; the first live connection may
   require narrowing (most likely candidates: `data.user`/`data.filter` not being identity objects,
   `submitTime` arriving as a string, or `count` not meaning "total records").
2. **Deletions are only detectable when the payload declares `count`.** With offset paging, a record
   deleted between two page reads of one call can shift a later record into an already-read page.
   When `count` is declared the change is caught; when it is not, the 17b overlap window and the
   user-visible full reconciliation are the mitigation. Insertions and reorders are always caught.
3. **`count` is used as a drift signal, never for termination.** If the live meaning differs, the
   reader reports a visible restart error rather than skipping records; that is deliberate.
4. **Not imported:** `time`/`memory` (units unverified), numeric language ids (no invented names),
   the older `currentData` envelope, editorial (unchanged, still unavailable).
5. **17b seams to build against:** `LuoguSessionProvider` (OS credential storage) and
   `LuoguSessionReader` (port). The reader caches one transport per account and refreshes the cookie
   from the provider on every call; disposal of those transports is not part of 17a. The parent
   contract's connection/disconnect lifecycle, scheduler and durable sync state are untouched here.
6. `package.json#files` was intentionally not edited (the coordinator owns packaging); this report is
   therefore not yet listed for publication.

## Repair 2 — transient-failure retries and typed-error discriminant allowlist

Final bounded repair of `src/adapters/luogu/session-reader.ts` and
`tests/platform/luogu-session.test.ts`; every accepted reader behaviour above is unchanged.
Contract: `.local/contract-17a-r2.md`.

- **Context-specific unknown-failure fallback.** `sanitizeAuthenticatedFailure` now takes the
  untrusted boundary it sanitizes. A cause with no usable discriminant at the fetch or
  response-body boundary becomes a fixed `unavailable` with `retryable: true`, so a real `TypeError`
  or mid-body disconnect keeps the configured retry budget and stays eligible for automatic sync
  backoff; an unknown credential-provider (`session`) or payload-parser (`shape`) failure is
  terminal (`retryable: false`). A typed failure that does carry a known code is unchanged: it keeps
  its code, `retryable` flag and `Retry-After`.
- **Runtime discriminant allowlist.** `PlatformError` validates neither `code` nor `retryable` at
  runtime, so a typed cause is rebuilt only when `code` is in `PLATFORM_ERROR_CODES` **and**
  `retryable` is a real boolean; `retryAfterMs` is re-normalized to a finite non-negative integer
  (or `null`). Any other typed cause — including a cast object whose `code` is a secret marker —
  becomes the fixed context fallback with the shared `unavailable` wording, so no forged code,
  message, sample or delay survives into the surfaced error, its `JSON.stringify` projection or its
  `message`.
- **Tests** (`tests/platform/luogu-session.test.ts`, +2 → 28 in the file, 48 with the adapter
  suite): a transient first-attempt `TypeError` retried to success with `maxRetries: 1` (two
  dispatches, one 2 000 ms pacing wait, the session re-attached and never in the target URL), the
  same for a mid-body disconnect (a partially read body that then fails), the persistent variants
  staying `unavailable`/`retryable: true` with no secret in any projection, and forged typed
  failures through the provider and fetch boundaries (unknown code, non-boolean `retryable`,
  negative and rounded `retryAfterMs`) collapsing to a fixed failure with no forged text anywhere.
  `assertNoSecret` now checks the JSON projection as well as the leaked text fields.

Commands actually run (from `D:\dsh-icpc-workbench`, PowerShell):

| Command | Result |
| --- | --- |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none "tests/platform/luogu-session.test.ts" "tests/platform/luogu.test.ts"` | 48 tests, 48 pass, 0 fail |
| `npm run typecheck` | clean |
| `npm run check:architecture` | `Architecture imports satisfy the declared layer boundaries.` |

No other file changed. The open issues 1–6 above (live authenticated shape unverified, `count`-only
deletion detection, `time`/`memory` not imported, packaging) are unchanged.
