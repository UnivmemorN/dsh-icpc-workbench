# Stage 22c — private (U-prefixed) metadata refusals

Scope of this report: the focused verification contract `.local/contract-22c-r1.md`. The production
loop body (`src/application/luogu-sync-service.ts`: `isPrivateProblemRefusal`, stop/deferred/transient
locals, rotation and per-item commitment) was completed by the coordinator after the previous
worker exhausted its request budget. This worker changed **no implementation file**: it added tests,
and updated two documentation artifacts.

## Behavior verified

- `auth_required` or `forbidden` on a `U`-prefixed (user-created) problem is an **item-level** refusal:
  the key is rotated to the end of the durable backlog, counted as one failed item, remembered as a
  **deferred** metadata failure, and the drain keeps processing the keys behind it. The remembered
  failure survives later successes of the same pass.
- The stop priority is `stop` > `deferred` > `transient`, persisted per item. Any later
  `changed_response`, any later rate limit (`429` / `rate_limited`) and any non-private
  `auth_required`/`forbidden` still stops the pass and replaces the deferred failure.
- Each key is attempted at most once per pass, including a backlog that contains only refused `U`
  keys (rotation cannot loop).
- Cancelling while the next (successful) key is in flight preserves the durable private refusal and
  the rotation, keeps the whole queue including the discarded in-flight key, and releases the lease.
- The metadata drain still requests no history page and uses no cookie fallback and no model.

## Changed files

| File | Change |
| --- | --- |
| `tests/sync/luogu-sync-service.test.ts` | Appended 6 synthetic cases (2 parameterized) using the existing `createWorld` / `seedBacklog` / `deferred` / `until` helpers; assertions on `world.metadata.calls`, `status.*`, and the durable `missingMetadata` rotation. |
| `docs/luogu-sync.md` | Appended the anonymous-access note to the `stage: metadata` bullet: private `U` problems may be unreadable anonymously, a limited key stays queued while other keys continue, and a public problem's refusal/limit/page anomaly still pauses. Cites `https://help.luogu.com.cn/manual/luogu/problem/` (checked 2026-09-14; `U` means user-created, not necessarily private) and states the path stays anonymous (no credential fallback, no model). |
| `src/ui/luogu-view.ts` | Doc-comment note only (no copy change) on `LUOGU_METADATA_FAILURE_GUIDANCE`: a `U` refusal is an item-level pending item, while a public refusal/rate limit/unexpected page still stops the drain; no authenticated fallback. |

## Commands actually run

```powershell
node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/sync/luogu-sync-service.test.ts
# 52 tests, 52 pass, 0 fail (includes the 6 new cases; exit 0)

node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/ui/luogu-view.test.ts
# 22 tests, 22 pass, 0 fail (exit 0)

npm run typecheck
# tsc -p tsconfig.json (exit 0)

npm run check:architecture
# Architecture imports satisfy the declared layer boundaries. (exit 0)
```

New test names (all passing):

- `a auth_required refusal of a U-prefixed problem is remembered per item and the drain continues`
- `a forbidden refusal of a U-prefixed problem is remembered per item and the drain continues`
- `a rate limit after a deferred private refusal stops the drain and replaces the failure`
- `a changed_response after a deferred private refusal still stops the drain`
- `a cancel after a deferred private refusal keeps the refusal and the rotation`
- `a backlog of only private U keys attempts every key at most once per pass`

## Open issues

- No real-account acceptance was performed: the refusal path is covered only by synthetic transport,
  matching the existing limitation documented in `docs/luogu-sync.md`.
- Whether a specific `U` problem is private is still only known from the platform's refusal; the
  implementation does not (and does not claim to) read private problems with login credentials.

## Coordinator acceptance

Packaged and live results after these worker checks are recorded in [Stage 22 acceptance](stage-22-acceptance.md). Worker-only pending items above describe the worker invocation, not the final release.
