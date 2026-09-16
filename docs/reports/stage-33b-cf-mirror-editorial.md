# Stage 33B — Exact Codeforces-mirror editorial reuse

Status: implemented and verified offline. Package version stays `0.1.25`; the pinned dsh baseline
(`0.1.5-rc.2`) and the SQLite schema are unchanged (no migration is required).

## Problem and scope

A Luogu problem whose identifier is `CF<contest><index>` is the *same* problem as the Codeforces
main-problemset problem `<contest><index>`. Luogu frequently publishes no analysable solution for
such a mirror while Codeforces publishes an official tutorial, so the Luogu record stayed at
`editorial_unknown` even though the material existed — on the other site, under the other spelling of
the same identity.

This stage adds the one explicit orchestration that closes that gap:

- the **statement** still comes from Luogu (and so do the raw platform tags, submissions, accepted
  records, retrospectives, manual decisions and bank rows of the target);
- the **editorial** is fetched from the equivalent Codeforces problem through the existing
  Codeforces adapter, and written into the Luogu target's newest material snapshot.

## The identity rule is the only pairing source

Nothing here re-derives equivalence. `cfMirrorIdentity()` in `src/domain/problem-equivalence.ts` is
the single decision point, exactly as the merged bank uses it. It recognizes one pairing and only
when both references carry **no domain** and the identifier is canonical:

| | Accepted | Refused by the rule |
| --- | --- | --- |
| Luogu side | `CF<contest><index>` on `luogu:www.luogu.com.cn` | another instance, a `domain`, `cf1a`, `1a`, `CF01A`, `P1001` |
| Codeforces side | `<contest><index>` on `codeforces:codeforces.com` | Gym, another instance, a `domain`, `1a`, a numeric index (`92101`) |
| Bound | contest `1..99999`, index `[A-Z]+[0-9]*` (suffix preserved exactly) | contest `>= 100000`, an empty or lowercase index |

Two extra directions are enforced on top of the rule:

- **reuse is one-directional.** The rule also recognizes a plain Codeforces reference, so
  `mirrorEditorialRequestOf` additionally requires the target to be the *Luogu* spelling: a
  Codeforces problem never borrows from Luogu.
- **the source problem is built server-side.** The Codeforces reference is constructed from the
  identity (`{ sourceInstanceId: 'codeforces:codeforces.com', domain: null, externalKey }`), never
  from a caller-supplied problem number, contest id or URL. The only caller-supplied identity is the
  problem the user is actually looking at.

No title, tag, rating, statement similarity or model judgement participates, and no model is
reachable from this path at all.

## Module map

`src/application/cf-mirror-editorial.ts` (new) owns the pure rules and the port:

| Export | Role |
| --- | --- |
| `mirrorEditorialRequestOf(target)` | The identity rule plus the two direction checks; returns the derived `cfRef`, or `null`. |
| `selectMirrorEditorial({ target, previous, hasMirrorPort, reuseExisting })` | The total decision: `use` a request, or `skip` with `mirror_not_applicable` / `existing_editorial_reusable` / `cf_source_unavailable`. |
| `hasReusableEditorial(snapshot)` | The same predicate the pipeline uses to call material usable: a `found` source with a referenced, non-blank body. |
| `mirrorEditorialNote(identity, adapterNote)` | The stable provenance note; the adapter's own note is appended, never replaced. |
| `withMirrorProvenance(result, identity)` | Stamps a `found` answer's sources with the mapping; a non-`found` answer passes through **unchanged**. |
| `CF_MIRROR_EDITORIAL_RULE_TAG` | Machine-readable `cf_mirror:luogu_cf_identifier` recorded in every note. |
| `MirrorEditorialPort` | The injected fetch port; the service never imports an adapter. |

`ImportService.refreshMaterial` gained the orchestration; `src/plugin/business-api.ts` supplies the
port; `src/application/workbench-api.ts` projects it; `src/ui/material-view.ts` explains it.

## Interface changes

- `RefreshMaterialRequest` gains `mirrorEditorial?: MirrorEditorialPort | null` (opt-in, so no
  existing caller changes behaviour) and `reuseExistingEditorial?: boolean` (defaults to `true`).
- `RefreshMaterialReport` gains a required `mirror: MirrorEditorialOutcome`
  (`{ status: 'skipped' | 'fetched'; skippedReason; key }`). The ordinary `editorial.skippedReason`
  is untouched: the two facts stay distinguishable.
- `ApiMaterialRefreshResult` gains `mirror: ApiMirrorEditorialView` (same three members). It carries
  no source URL, blog id, title, note or body.
- `src/ui/material-view.ts` (new) maps the member to one Chinese sentence per skip reason.

## Safety and cost boundaries

- **Exactly one editorial request happens per refresh.** When the mirror path is selected the
  target's own adapter is not asked for an editorial at all (its statement fetch is unaffected); when
  it is skipped, the target's own adapter answers as before.
- **An explicit `officialTutorialUrl` wins.** A caller that named a blog keeps it, because an
  attributed fetch must never be silently redirected to another problem.
- **A Codeforces failure is never an absence.** `unavailable`, `rate_limited`, `changed_response`,
  `auth_required` and `forbidden` are stored verbatim as a non-`found` material check. The
  placeholder keeps the target URL and gains a detail naming the equivalent problem that answered.
- **A `found` answer with no usable body is demoted**, not stored: it becomes an explicit
  `changed_response` failure, so "reuse succeeded" can never mean "a source row was written that
  still leaves the problem unanalysable".
- **The source is truthful.** The stored source keeps the official Codeforces blog URL and its own
  id (`cf-blog-<id>`); `note` records `editorial mapped from equivalent Codeforces problem
  <key> (official Luogu mirror CF<key>); cf_mirror:luogu_cf_identifier | <adapter note>`. It is never
  presented as a Luogu article.
- **Nothing else crosses.** No Codeforces tag, submission, accepted record, retrospective, manual
  decision or problem row is created or copied for the target.
- **The target head-CAS is unchanged.** The head is captured before any IO and re-read inside the
  commit transaction; a head that changed during the fetch is refused with `invalid_transition` and
  nothing is written. A cancellation likewise refuses the write.
- **Zero model calls.** The whole path is platform IO; no prompt, taxonomy, model selection, budget
  or schema change is involved.

## Skipped, and why it is not a failure

| Situation | `mirror` |
| --- | --- |
| The target is not an official Luogu CF mirror (or the spelling is not canonical) | `skipped` / `mirror_not_applicable` |
| The caller supplied an official tutorial URL | `skipped` / `mirror_not_applicable` |
| Usable editorial material is already stored (default) | `skipped` / `existing_editorial_reusable` |
| The composition has no usable official Codeforces adapter | `skipped` / `cf_source_unavailable` |
| The rule applied and a request was made | `fetched` / `key: <contest><index>` |

The UI states each of these in Chinese and never phrases a skip as "the other site has no
editorial".

## Verification actually performed

All commands were run offline against synthetic snapshots, a temporary SQLite store and scripted
local adapters. No real platform request, credential, private batch or model call was involved.

```
node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none \
  tests/import/cf-mirror-editorial.test.ts tests/ui/material-view.test.ts
npm run typecheck
npm run check:architecture
git diff --check
npm run check
```

Coverage of the contract's required cases, all in `tests/import/cf-mirror-editorial.test.ts` unless
noted:

- **Exact mapping** — the accepted pairing derives `1900A` on the official Codeforces instance from
  `CF1900A`, with the suffix form `1B01` preserved; the Codeforces spelling of the same pair is
  refused as a target.
- **Every rejection boundary** — thirteen refused shapes (Gym, `domain` on either side, non-official
  instances on either side, lowercase key, bare Codeforces spelling on Luogu, zero-padded contest,
  contest `>= 100000`, numeric index, lowercase index, an unrelated Luogu key, a manual record, an
  empty key).
- **Source tracking** — the stored source keeps the official blog URL and its own id, and its note
  carries the rule tag, the equivalent Codeforces key and the Luogu mirror key; the adapter's own
  note survives; a non-`found` answer is byte-identical after the stamp (`deepEqual` over all six
  statuses).
- **Failure keeps the old material** — five operational statuses each stay that status (never
  `absent`), the previously stored user answer survives with its body, and the check record names the
  equivalent problem.
- **CAS** — a concurrent writer publishing a newer head during the fetch makes the commit reject with
  `invalid_transition`; the newer head and its own material are what remain, and the borrowed source
  was never committed.
- **Cancellation** — a token cancelled during the fetch rejects and writes nothing (the head is still
  `null`).
- **Redaction** — the report's `mirror` member and the material summary carry no solution text, blog
  URL, source id or rule tag; the same is asserted over HTTP in `tests/plugin/business-api.test.ts`,
  together with the derived `cfRef` the Codeforces adapter was asked for.
- **Zero AI calls** — the whole path is exercised without a model gateway; the HTTP test also proves
  the Luogu adapter is never asked for an editorial of a mirror, and `tests/ui/material-view.test.ts`
  pins the Chinese wording (a skip never claims absence).

Measured results:

| Command | Result |
| --- | --- |
| Focused suites (`cf-mirror-editorial`, `material-view`, `import-service`, `supplement`, `business-api`, `model-operations`, `material-gate`, `review-view`) | 131 tests, 131 passed, 0 failed |
| `npm run typecheck` | passed (no diagnostics) |
| `npm run check:architecture` | "Architecture imports satisfy the declared layer boundaries." |
| `git diff --check` | exit 0 (line endings only; `core.autocrlf=true` normalises them on commit) |
| `npm run check` | passed: typecheck, architecture, 1424 business tests with 1422 passed / 0 failed / 2 skipped (the existing non-Windows credential-vault cases), 20 script tests, ESM build, browser factory/shared React/disposal checks |

## Historical open issue: Luogu's own editorial retrieval (resolved in Stage 33C)

The following was the boundary when this Stage 33B slice closed; Stage 33C later implemented guarded
authenticated Luogu editorial reading.

This stage did not implement authenticated Luogu editorial fetching, and the mirror path does not
replace it: a mirror problem whose Codeforces tutorial is missing, rate-limited or structurally
changed still has no automatic source of material. That case is reported as `source_unavailable` or
`changed_response` (never `absent`) and the supported free paths remain refreshing the platform
material and pasting a user-provided answer with its own source label.

Automatic reuse is also limited to the identifier rule. A cross-site pair the rule does not
recognize — a different problem number, a `domain`-scoped record, a title-only resemblance — is
deliberately left alone rather than matched by a heuristic.
