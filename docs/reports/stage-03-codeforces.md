# Stage 03 — Codeforces catalog/submission adapter (worker report)

## Changed
- `src/adapters/codeforces/adapter.ts`:
  - Identity uses the shared `problem-index` helpers everywhere: `A`/`B2`/`D10`/`20C` keep their
    letter form, numeric `01`…`14` keep padding and are keyed with an explicit `/` (`921/01`), and
    `92114` is never split. A target may be a canonical key or an official href; an href is an
    identity reference only, so the fetch target is rebuilt on our own origin. Catalog entries with
    a foreign `problemsetName` are refused, and a gym domain or official `/gym/` URL is refused
    before key parsing with an actionable message plus a capability note (main problemset keeps
    `domain: null`).
  - Catalog freshness: `cursor === null` always re-fetches; a continuation reuses a matching
    snapshot only inside a bounded TTL (injectable `clock`/`catalogSnapshotTtlMs`, default 5 min)
    and otherwise re-fetches before the fingerprint check. Cancellation is observed on cache hits
    and before every return. The optional catalog account goes through the canonical account
    factory (foreign instance/id/handle refused); the constructor checks id/domain coherence.
  - Submissions bind `since` into the cursor (normalized ISO or null); memory is exact bytes/1024;
    ids, seconds, millis and bytes must be non-negative safe integers; the requested handle must
    appear in the author's `members` (foreign or malformed authors are `changed_response`).
  - Blog `result.id` must equal the requested blog, the title is converted with `htmlToPlainText`
    (`titleHTML` preferred), and `authorHandle`/`locale` become author/language.
  - Shared `apiFailure`: HTTP 400 is accepted and classified from the body — `Call limit exceeded`
    → `rate_limited` with a bounded 2000 ms hint, `not found` → `unavailable`, anything else or an
    unparseable body → `changed_response`; no independent retry loop.
- `src/adapters/codeforces/cursors.ts`: `CURSOR_VERSION = 2` and submission cursors carry `since`
  (a v1 token, or a v2 token missing the field, is refused so the caller restarts); numeric fields
  are safe-integer bounded. `index.ts` needed no change (no new public symbol).
- `tests/platform/codeforces.test.ts` + `fixtures.ts`: 18 new regressions (index forms, gym
  refusal, refresh/TTL/cancellation/account scope, cursor version+since+overflow, author shapes,
  exact KiB, invalid numbers, blog id/title/author/locale, rate-limit/unknown-body classes, plus
  two capture checks printing counts only) and one stale sup/sub assertion updated.

## Commands actually run
- `npm run typecheck` — pass.
- focused `codeforces.test.ts` run — 37/37 pass; the capture check parses 11 385 problems from the
  private `.local/cf-api.response` and publishes the count only.
- `npm run check` — pass: 184/184 tests, 3/3 usage tests, architecture check, build.

## Open
- Numeric indexes are covered by the private capture plus synthetic records only.

## Coordinator acceptance
- Full independent gate: 185 behavior tests + 3 accounting tests passed; typecheck, architecture and build passed.
- Added guards for zero resume offsets, zero submission IDs, named foreign problemsets and non-root source URLs.
- Real adapter/HTTPS probes succeeded for public catalog, public submission paging and blog4540/189A; only counts/statuses logged. Raw user records and article bodies stay outside Git.
- 23 accessible reference bodies: 19 automatically bounded sections; four ambiguous legacy/bare-letter layouts require explicit manual selection. Synthetic regressions cover the Problem prefix/Author credit formats.
- Optional capture tests are explicitly skipped in clean CI; synthetic behavior tests remain mandatory.