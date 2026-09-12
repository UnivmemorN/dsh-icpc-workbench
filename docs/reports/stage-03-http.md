# Stage 3a — HTTP lifecycle / rate-limit repair (round 1)

Implementation worker report (dsh / deepseek-flash), 2026-09-12. Scope: `src/adapters/platform/http.ts`,
`src/adapters/codeforces/adapter.ts` (constructor + `httpLimits` only), one JSDoc line in `src/application/platform-errors.ts`, `tests/platform/http.test.ts` + `fixtures.ts`, two constructor regressions in `tests/platform/codeforces.test.ts`, this report.
Editorial extraction, normalization, UI and Git stay outside this contract.

## Repairs

- **Retry-After.** Parsing preserves the declared delay and exposes it as `retryAfterMs`; a delay above `maxRetryAfterMs` fails with the status-derived code (`rate_limited` 429 / `unavailable` otherwise), keeps `retryable`, and is never retried early, while a delay that fits is still honoured.
- **Queued cancellation.** `request()` settles through `rejectWhenCancelled`: a token cancelled while queued rejects at once with the stable `cancelled` DomainError, the task keeps its FIFO slot and sees the cancelled token before dispatch, and non-cancellation failures pass through.
- **Async safety.** `fetchAttempt` races the fetch against the abort, so an injected fetch that ignores its signal cannot hang timeout/cancellation and a late response's body is cancelled; `readBody` never awaits teardown, cancelling the reader best-effort behind a deferred catch (byte cap or abort).
- **Attempts.** `AttemptCounter` counts every dispatched request, so `attempts` on a response and on a failure includes redirect hops, not only outer retries.
- **Timers.** `defaultWait`/`defaultSetTimer` no longer `unref`: an owned timer for a pending request keeps a standalone Node process alive until it completes or is cancelled.
- **Codeforces constructor.** `...options.http` is spread before the derived defaults, the floor is forced to `max(caller, 2000)`, and `httpLimits()` applies `max(per-request, 2000)`, so even a shared floor-zero transport is driven at two seconds; a foreign-origin transport, or an instance that is not plain `https://codeforces.com` (port/userinfo), is refused, and `limits` is detached.
- **URL form.** Origin, request URL and every redirect target reject embedded credentials (hidden by `URL.origin`) and non-default HTTPS ports.

## Tests added (36/36 focused passes)

Queued cancel rejects before the deferred first request ends and is never dispatched; an ignored-signal fetch
times out with its late body cancelled; a never-settling body `cancel` cannot hang the byte cap; a 99999 s
`Retry-After` dispatches once, exposes 99_999_000 ms and waits nothing; two redirect hops count as 3 attempts;
credentials/non-443 ports are refused on origin, request and redirect; the CF floor survives `http` override 0
and a floor-zero shared transport; a foreign-origin transport is refused.

## Commands actually run

`npm run typecheck` clean; focused platform run 36/36; standalone paced-request check with default timers (2 calls, elapsed >= 1900 ms); `npm run check` exit 0 — typecheck, architecture, 152/152 tests, 3/3 accounting, `Built independent ESM package in dist.`

## Open issues

- `maxRetryAfterMs` (default 30 s) is the only bound: a longer declared wait fails the request instead of scheduling a delayed retry; callers read `retryAfterMs` and decide.
- Teardown of a body owned by an injected fetch that ignores its signal is best-effort: the real `globalThis.fetch` is aborted, an uncooperative fake only has its body cancelled once it resolves.

## Coordinator follow-up
Independent review found that rejecting an oversized Content-Length occurred before reader cleanup. The coordinator added unread-body cancellation and aborts the underlying request on local read/validation failure. An original regression asserts the oversized body is never read, its cancel hook runs, and the request signal is aborted. Independent HTTP suite: 18/18 passed. Full combined acceptance follows the CF parsing repairs.