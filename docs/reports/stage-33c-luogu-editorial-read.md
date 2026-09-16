# Stage 33C — Luogu authenticated editorial reading

Status: implemented and verified against a **sanitized structure capture** with synthetic, offline test
fixtures, and **live-accepted on a real Luogu account on 2026-09-16** within the scope recorded in the
acceptance section at the end of this report — including an offline install of the final gated build
(`dsh-icpc-workbench-0.1.25-20260916130815.tgz`) into the isolated `icpc-acceptance` profile and the
manual-absent note fix (revision 5) closed live at snapshot v4. Package version stays `0.1.25`; the
pinned dsh baseline (`0.1.5-rc.2`) and the SQLite schema are unchanged.

> **Revision 2 note (independent functional review).** A second review round found one P0 and four P1
> defects, and this revision fixes them:
>
> 1. **P0 — the HTTP status was ignored in favour of the body.** The reader accepted HTTP 400/401/403/404
>    and classified them from the payload, so an error status whose body carried a shaped, empty
>    `solutions` block became `absent` (and a shaped non-empty one would have become `found`). The status
>    now decides **before any body is read**: only `200` reaches the payload parser, `401` is
>    `auth_required`, `403` `forbidden`, `404` `unavailable` and `400` a fixed non-`absent` failure —
>    including when a `401` answers an HTML page whose final URL is still the solution path.
> 2. **P1 — `lid` canonicalisation.** The parser stored the raw spelling while deduplicating on it, so
>    `é` and `e` + U+0301 (different strings, one text) could produce two ids for one write-up. The lid is
>    now trimmed and NFC-normalised at the boundary, and that canonical text is what is stored, escaped
>    and compared. Related: `data.problem.pid` is now compared **exactly**, so a padded spelling is a
>    mismatch instead of the same problem.
> 3. **P1 — per-write-up provenance is fail-closed.** `author.name`, `title`, `category`, `time`,
>    `upvote`, `replyCount`, `favorCount` and `status` are all required by the observed shape, so a
>    missing or wrongly typed one now refuses the write-up instead of being silently defaulted to `null`
>    (which previously turned an unattributed write-up into a successful record). The members the capture
>    records as optional or nullable (`categoryOld`, `author.isRoot`, `author.badge`, `collection`,
>    `adminNote`, `voted`) stay compatible precisely because nothing reads them.
> 4. **P1 — the anonymous probe is now body-blind on every shape.** The valid-JSON fallback had already
>    dropped its `sample`, but the HTML, invalid-JSON, non-object and body-level error-envelope paths
>    still went through the shared `jsonRoot`/`bodySnippet`/`luoguData` helpers, which can quote the body
>    or the server's `errorType`. The anonymous editorial read has its own sample-free reader now: fixed
>    `detail` text, mapping by integer `errorCode` alone, and no sample member.
> 5. **P1 — the source-wide gate was bypassed.** The business adapter reached Luogu without the host's
>    `LuoguSourceGate`, so a business read could dispatch on top of a gated sync, a connection probe or
>    another account's read (the two use different transports, hence different quiet-time windows). The
>    business adapter is now wrapped in the host's **own** gate — one gated whole operation per adapter
>    call, anonymous statement/profile/catalog reads included — while the host's already-gated paths are
>    left alone so no floor is nested.
>
> **Revision 3 note (second independent review).** Six further findings were fixed:
>
> 1. **A non-200 refusal body is no longer read at all.** The status-first classification lived in the
>    reader, but `HttpTransport` had already pulled the whole body — so an oversized refusal body or a
>    body stream that throws replaced `401` with a payload/transport failure before classification.
>    `createAuthenticatedLuoguFetch` now returns **every non-200 answer with an empty body**, discarded
>    unread at the earliest point in the stack (and without its declared `content-length`, which the
>    transport checks before the body), so `401` stays `auth_required` whatever that body is.
> 2. **The anonymous probe rebuilds every transport failure.** The HTML/JSON/envelope paths were already
>    body-blind, but a transport failure was forwarded through `detail` (which can quote an injected
>    fetch's message) and `sample` (a bad redirect `Location`). All anonymous editorial failures now use
>    fixed text, keep only the code and retry metadata, and never carry a sample.
> 3. **A redirect to the login wall is `auth_required`.** A followed redirect ending on `/auth/login` or
>    `/login` is the session wall whatever the page says; an inline login page served at the original
>    URL keeps `changed_response`, because no reliable structural signal for it was observed. Both
>    readings now use one exported `isLuoguLoginPath` helper.
> 4. **The hydration element is raw text and must declare its type.** The scanner was HTML-entity
>    decoding the `<script>` body, which silently rewrote write-up text (`&amp;&amp;` → `&&`); a script
>    body is raw text, so it is now parsed verbatim. The observed `type="application/json"` is required
>    (case/space tolerant), so a same-id script of another type is not the payload.
> 5. **A declared `429` is a rate limit and a declared `5xx` is an outage.** Both were previously
>    classified as plain refusals (`forbidden`), which misreported a rate limit and turned a server
>    failure into a permission problem; both now keep the meaning the same status has as a real HTTP
>    answer (`rate_limited`, and `unavailable` + retryable respectively).
> 6. **The report's own claims were corrected**: what is stored (a `ProblemSnapshot` row, not an
>    "`EditorialSolution` table"), how the credential is used (read once per authenticated operation,
>    attached to each guarded paging request, cleared in a `finally`), which `.local` files the *full*
>    suite reads (three pre-existing ones besides the 33C observation), which environments were measured
>    (DSH working environment vs the coordinator's restricted sandbox, with the vault roundtrip passing
>    1/1 when it was later run unrestricted), and how live acceptance reaches `auth_required` without
>    invalidating the stored session.
>
> **Revision 4 note (final bounded close-out).** Two code defects and the remaining factual claims:
>
> 1. **Attribute-name boundary.** The hydration scanner matched attribute names with a word boundary, so
>    `data-id="lentille-context" data-type="application/json"` was read as the real `id`/`type`. The
>    boundary is now start-of-attributes or HTML whitespace (`(?:^|\s)`), with quote styles and case
>    support unchanged, and a regression asserts that `data-id`/`data-type`/`aria-id` cannot impersonate
>    the element while the real attributes (in either order, either quote style, with a decoy `data-`
>    attribute alongside) still work.
> 2. **Forged platform metadata.** `anonymousEditorialFailureFrom` trusted `instanceof PlatformError` at
>    the runtime level: a forged `code` outside the declared vocabulary made it return `undefined` (so
>    `fetchEditorial` returned nothing at all), and a forged non-boolean `retryable` was forwarded into
>    the DTO. It now requires the shared `PLATFORM_ERROR_CODES` allowlist and a real boolean `retryable`,
>    accepting only a safe non-negative integer `retryAfterMs` and dropping anything else; invalid code
>    or retry flag degrades the whole answer to the fixed, non-retryable `unavailable`, and no forged
>    value is ever echoed.
> 3. **Report facts corrected**: the authenticated HTTP `200` unknown-error-code path is
>    `refused`→`forbidden` while an *anonymous* unknown code is `changed_response`; an HTTP `200` HTML
>    answer on the original solution URL without hydration is `changed_response` (only HTTP-status or
>    redirect-level refusals carry the transport's own code); the "no real account" claim is scoped to
>    the 33C Luogu focused set, because the full suite's pre-existing Codeforces test reads
>    `.local/cf-records.response`, which holds public data of the account `tourist`; and the coordinator's
>    complete unrestricted `npm run check` (1,543 total / 1,542 passed / 0 failed / 1 skipped, vault
>    roundtrip passing) is recorded side by side with this environment's run.
>
> Both fixes were falsified before being accepted: reverting the attribute boundary makes the new
> `data-*` regression fail, and disabling the allowlist makes `fetchEditorial` return `undefined` for a
> forged code — exactly the reported defect.
>
> The first report also mis-described what is stored: **the complete retrieved body is stored inside the
> local `ProblemSnapshot`** — the `solutions[].text` of the current snapshot, serialized as canonical
> JSON in the SQLite `snapshots.body` column (there is no `EditorialSolution` table; a snapshot is one
> immutable row). What it never enters is a diagnostic, a log line, the `material.refresh` DTO, a report
> or a synthetic fixture.
>
> **Honest environment note.** During the early debugging of this round the network guard was installed
> *after* `activateHost`, and a default (non-injected) transport therefore fetched the public Luogu
> `P1001` page once over the real network. No credential, account or private data was involved, and no
> other network request was made by this work. Every test written after that discovery injects a
> synthetic transport **and** installs the refusing guard before activation, so a missing seam fails the
> case instead of reaching the platform.

> **Final note fix (revision 5, closed live).** Live acceptance exposed one stored-record defect: an
> explicit `absent` declaration supplies one user sentence as *both* the declaration note and the result
> detail, and the merge joined them, so the single `absent` source note was the sentence twice
> (`X | X`, seen in the first manual-evidence snapshot). `materialNote` in
> `src/application/import-service.ts` now drops fragments that are identical **after trimming**, keeps
> genuinely different declaration/detail fragments in their original order, and still appends the
> `rate_limited` retry hint. Two API-level regressions were added —
> `tests/plugin/business-api.test.ts` (public `material.supplement` explicit absent, read back from the
> real SQLite snapshot) and `tests/import/import-service.test.ts` (trim-identical pair stored once;
> different pair stored as `A | B`) — and both were falsified first: restoring the old join reproduces
> `X | X` in each. Gates: focused 59/59, expanded focused 114/114, `npm run check` exit 0 with
> 1,547 total / 1,545 passed / 0 failed / 2 skipped (environment guards), `git diff --check` exit 0.

## The prerequisite, and what it actually establishes

The previous stage left one hard prerequisite: the Luogu authenticated `/problem/solution/<pid>`
response structure had to be captured on a real account and sanitized into field names, types and
optionality only. That capture now exists at
`.local/observations/luogu-editorial-shape.v1.json` (`classification: sanitized-schema-only`) and is the
sole source this module was written against. It is **not** committed: only this report and the
implementation describe it.

What the capture records, and what it explicitly does not:

| Recorded | Not recorded (and treated as unverified) |
| --- | --- |
| `data.solutions.{perPage,count,result[]}`; `result[]` item fields with types; `author` fields; `data.problem`; `data.errorCode/errorType/errorMessage/errorData`; top-level `instance/template/status/locale/user/time` | any cookie, viewer identity, author value, title, body or error-message text |
| The payload was read from the `#lentille-context` element (`application/json`) of an authenticated `text/html` page | the authenticated **direct** request's HTTP status and content type |
| That an anonymous direct request with `x-lentille-request: content-only` answers `401` with the error envelope | whether an authenticated direct request returns the same shape (listed as an unverified claim) |
| That a missing problem/solution page answers `404` with the error envelope | login-redirect and CAPTCHA response shapes or redirect targets |
| **That page 1 is the unparameterised path and that `?page=2` answers the same shape with a non-empty result, while `count` is the *total* number of write-ups (56 for P1001 at `perPage` 10)** | the `time` field's unit, and the semantics of `category`/`status`/`promoteStatus` |
| `lid` is a **string**; `categoryOld` and `author.isRoot` are optional; `badge` is `string \| null` | whether the platform answers more than the observed page count |

The capture's own `implementationConstraints` are the rules this stage enforces verbatim; the
unverified claims are why the reader accepts **both** body forms rather than assuming one and why no
`publishedAt` or public/private meaning is derived from `time` or `status`.

## What was built

### `src/adapters/luogu/editorial-parser.ts` (new, pure)

Two entry points over one set of rules, so the paged reader and the whole-payload tests cannot
disagree about what a payload means:

- **`parseLuoguEditorialPage(payload, pid)`** reads exactly **one server page** and answers with its
  declared `count`/`perPage` and its own `result[]` items. A page is a recognized success envelope
  only when: root `status === 200`; `data` is an object; an error envelope (its own
  `errorCode`/`errorType`/`errorMessage` members) is classified first, so an error answer carrying a
  fake empty `solutions` block is a typed failure and never an absence; `data.solutions` is an object
  with a bounded safe-integer `count`, a bounded positive safe-integer `perPage` and an array `result`;
  and `data.problem` is an object whose `pid` is exactly the requested problem id. `status !== 200`,
  a missing/wrong `problem` block, an unreadable `count`/`perPage` are each their own closed failure
  kind. The parser deliberately does **not** know the page number, so how long a page must be stays
  the reader's rule.
- **`parseLuoguEditorialPayload(payload, pid, retrievedAt)`** is the whole-payload compatibility
  wrapper used by the shape tests: it adds the one rule only a complete payload can enforce
  (`count === result.length`) and turns an explicit `count: 0` with `result: []` into the absence.
- **`count === 0` together with `result: []` from a recognized positive payload is the only absence.**
  A missing `solutions` block, an unreadable envelope, a non-integer or negative `count`, a non-array
  `result`, a `count`/`result` disagreement, an unreadable item, a blank body and a
  `contentFull !== true` item are each their own failure kind — never an absence.
- **`404` → `not_found`** (which the adapter maps to `unavailable`), **`401` →
  `authentication_required`**, **`403` and anything unrecognized → `refused`**, and none of them can
  become an absence at any HTTP status or payload status.
- **Only the fields this build stores are read.** `author.uid`, `avatar`, `slogan`, `badge`, `color`,
  `ccfLevel`, `xcpcLevel`, `background`, `isAdmin`, `isBanned`, `categoryOld`, `isRoot` and the whole
  `solutionFor` summary are deliberately not read, so no user value and no problem value can reach a
  stored record. `user` (viewer identity) is never read at all.
- **Per-write-up provenance is fail-closed.** Every member the record stores is required by the observed
  shape, so a missing or wrongly typed `author`/`author.name` (an object with a non-empty `name`),
  `title` (a non-empty string), `category`, `time`, `upvote`, `replyCount`, `favorCount` or `status` (a
  safe integer) refuses that write-up as `item_unreadable`; a write-up is never stored with a fabricated
  `null` author, an empty title or a defaulted counter. `contentFull` must be `true`, and a blank body is
  `empty_content`.
- **`lid` is canonicalised and validated as a stored id at this boundary**: trimmed and NFC-normalised
  (so `é` and `e` + U+0301 cannot become two write-ups), then required to be non-empty, bounded,
  control-character-free text the domain's `encodeIdPart` accepts (so a lone surrogate is refused too).
  A value that fails is the closed `lid_unreadable` failure, whose object carries **only** `ok`/`kind`/
  `path` — never the value — and the failure object has no `message`, `detail` or `sample` member at
  all. The canonical text is what is stored and escaped, and it is the key the identity check compares.
- **Failure objects are a closed `kind` plus a structural `path`** (`data.solutions.result[2].lid`) and
  nothing else, so no server-provided value can travel in a diagnostic.
- **`lentilleContextPayload`** extracts the hydration element — the element whose id is
  `lentille-context` **and** whose declared type is `application/json` (either quote style, extra
  attributes, case/space tolerant) — and parses its body as **raw text**, exactly as it appears: a
  `<script>` body is not HTML markup, so `&amp;`/`&lt;`/`&quot;`/numeric entities in it are literal JSON
  characters and decoding them would rewrite a write-up. A page without that element, with another type,
  or with an unparsable payload returns `null`, so the caller classifies an unreadable page instead of
  concluding anything about the editorial.

### Stored identity: one source per write-up

`buildEditorialMaterial(items, pid, retrievedAt)` builds the stored records. Each write-up gets **its
own** `EditorialSource` and its paired `EditorialSolution`, which is what the product's evidence model
requires (verification is always resolved against one specific solution of one specific source):

| Field | Value |
| --- | --- |
| source `id` | `luogu-solution-<pid>-<encodeIdPart(canonical lid)>`, stable and collision-free |
| source `title` | the write-up's own title |
| source `author` | the **public author name** of that write-up (required by the observed shape) |
| source `url` | `https://www.luogu.com.cn/problem/solution/<pid>` — the surface the read really used |
| source `publishedAt` / `language` | `null`: the capture verified neither a `time` unit nor a language field |
| source `text` | a bounded **index** of that one write-up (its `lid`, title and public author) |
| source `note` | the numeric platform state only (`time member … (unit unverified)`, `category`, `status`, `upvote`, `replyCount`, `favorCount`, `author attributed`) |
| solution `text` | **the complete retrieved body, and the only place it exists** |
| solution `ordinal` | the write-up's position in the whole read, so the platform's order survives paging |

The viewer identity and the avatar never reach a source, a note, a solution or a failure. `retrievedAt`
is one clock read for the whole read, so every source of one read carries the same instant.

### `LuoguSessionReader.fetchEditorial` (paged in revision 1, status-first in revision 2)

- the session comes from the injected provider and is normalized to the canonical cookie pair, so a
  missing, malformed or **foreign** session is refused before any request;
- the request goes through the account's own bound transport, so pacing (>= 2 s) is shared with that
  account's other calls, and `x-lentille-request: content-only` is sent because that header is the
  verified one for this endpoint;
- **the HTTP status decides before any body is read.** Only `200` reaches the payload parser:

  | HTTP status | Result |
  | --- | --- |
  | `200` | the payload is parsed; the body decides between material, drift and a body-level error envelope (a declared `429` is `rate_limited`, a declared `5xx` is `unavailable` + retryable, a declared `403` or any unrecognized error code is `forbidden`) |
  | `401` | `auth_required` with fixed text — whether the body is JSON or an inline login page |
  | `403` | `forbidden` with fixed text |
  | `404` | `unavailable` with fixed text (never `absent`) |
  | `400` | `unavailable` with fixed text: the platform rejected the request itself |
  | `429` and anything else | the transport's own typed failure, so a `429` stays `rate_limited` |

  A refusal is therefore never allowed to look like content: an error page carrying a shaped, empty *or*
  non-empty `solutions` block can never become `absent` or `found`. The discard happens at the **raw
  authenticated fetch boundary** (`createAuthenticatedLuoguFetch`), before `HttpTransport` can pull the
  body: a non-200 answer is returned with no body and without its declared `content-length`, so an
  oversized refusal body, a body that is not JSON, or a body whose stream throws cannot replace the
  status's own code;
- **the credential guard is bound per page**: `SessionTarget` is
  `{kind: 'editorial'; pid; page}`. Page 1 must be the exact unparameterised path; page `N > 1` must be
  exactly `?page=N`. A zero-padded `page=02`, a repeated `page`, any additional parameter, a fragment,
  another pid/path/origin/port or URL userinfo is refused **before dispatch** — and the guard runs on
  every dispatch, the manual redirect hops included, so a redirect target cannot receive the cookie
  either. The target is cleared in a `finally` after each request and the cookie in the outer `finally`
  of the whole read. One operation reads the vault **once** and attaches that value to each of its
  guarded page requests;
- the walk reads page 1..`ceil(count / perPage)` and then:
  - reads the **whole** list or fails: a short page, an empty middle page, a page count above the fixed
    ceiling of **20** pages, more than **1,000** write-ups or more than **4,000,000** retrieved
    characters fails the read **after the pages read so far**, and nothing is ever materialized
    partially;
  - requires every page to declare the same `count`/`perPage` as page 1, and every page to be exactly
    `min(perPage, max(0, count - (page - 1) * perPage))` write-ups long;
  - rejects a `lid` repeated inside one page **or across pages** — keyed on the canonical id, so two
    Unicode spellings of one lid collide too — checked page by page, so a broken answer stops at the
    first overlapping page instead of spending every remaining request;
  - keeps `retrievedAt` from **one** clock read, used for every source and for the result;
  - checks the caller's token before and after every await;
- a continuation page that answers `401`/`403`/`404`/`400`/HTML/`429` keeps its own typed discriminant
  and is never `absent`;
- both body forms are handled at status `200`: JSON is parsed directly, and an HTML body is read for its
  hydration element. The login semantics are explicit: a **redirect** to a login path is refused by the
  target guard before the cookie is attached (`auth_required`), an HTTP `401` is `auth_required`
  whatever the body is, an HTTP `200` inline login page at the solution URL carries no reliable
  structural signal and is therefore `changed_response`, and any other unreadable page is
  `changed_response` as well;
- a payload the parser cannot read becomes a fixed sanitized `changed_response` — the parser's
  structural path is dropped and **a `sample` is never taken from an authenticated body**;
- operational failures are **returned** with their own discriminant, matching how every other
  `fetchEditorial` answers, so the material gate can tell an authentication wall from an absence.

### The anonymous probe is body-blind (revision 2)

`LuoguAdapter.fetchEditorial` without an account (or without a reader) probes the anonymous endpoint
through its own reader instead of the shared `jsonRoot`/`luoguData` helpers: an HTML answer, a body that
is not valid JSON, a non-object body and a body-level error envelope are each answered with fixed
`detail` text and `sample: null`, and the envelope is mapped by its integer `errorCode` alone
(`401` → `auth_required`, `403` → `forbidden`, `429` → `rate_limited`, `404`/`5xx` → `unavailable`,
anything else → `changed_response`). No body text, parser message or server-provided `errorType` can
travel into a DTO, a stored note or a log line.

Revision 3 closed the two remaining holes in that probe: a **followed redirect that ends on
`/auth/login` or `/login` is now `auth_required`** (an inline login page at the original URL stays
`changed_response`, since no reliable inline signal was observed), and **every transport failure is
rebuilt too** — the shared transport's `detail` can quote an injected fetch's message and a redirect
failure attaches its `Location` as a `sample`, so the anonymous path now keeps only the typed code and
the retry metadata (`retryable`, `retryAfterMs`) with fixed text and no sample.

### Production composition (revision 1, gated in revision 2, seam-covered in revision 3)

- `createStoredSubmissionsSource` now returns a function that also carries `readerFor(account)`: the
  **same** cached per-account reader the submission sync drives.
- `LuoguHostRuntime.sessionReader(account)` republishes it, so composition can inject it — one
  credential path, one transport, one >= 2 s pacing state and one cookie lifecycle per account.
- `LuoguAdapter` accepts the reader either as an instance or as a per-account factory, and validates
  **both** operations (`listSubmissions` **and** `fetchEditorial`) at construction: an adapter that
  advertised `editorial: true` while unable to serve `fetchEditorial` can no longer be composed.
  `capabilities()` therefore reports the submissions/editorial support the composition really has.
- `activateHost` builds the business Luogu adapter with `sessionReader: luoguHost.sessionReader` (and
  with the composition's transport seam), and registers that adapter with both `business-api` and
  `bootstrap`, so the advertised capability and the served capability are the same object. The
  anonymous metadata adapter remains the source of public problem reads; the sync service keeps its own
  anonymous metadata source.
- **The anonymous transport seam is applied where the anonymous adapter is built** (revision 3), so the
  host's **default** `metadataSource` — the adapter a `runOnStartup` pass repairs missing problem
  metadata with — runs on the injected transport as well. Before this, the seam reached only the business
  adapter, so an activation test with automatic sync disabled could not see that path; the revision adds
  an `runOnStartup` metadata-repair test that fails if the default source is built without the seam.
- **`createGatedLuoguAdapter`** (`src/plugin/luogu-gated-adapter.ts`, revision 2) wraps the business
  adapter in the host's own {@link LuoguSourceGate}: `listProblems`, `listSubmissions`, `fetchProblem`,
  `fetchEditorial` and the optional `fetchAccountProfile`/`fetchProblemDetail` each run as **one whole
  gated operation**, while `capabilities()` and `sourceInstance` pass through untouched and an optional
  method the wrapped adapter lacks stays absent. The host's own paths (the sync service, the connection
  manager) are already gated at their call site and are deliberately not wrapped again, so no floor is
  nested and no call can serialize against itself.
- The anonymous 2xx fallback in `LuoguAdapter.fetchEditorial` returns `sample: null`: if that surface
  ever starts answering bodies, a body can no longer be copied into an error DTO or a stored note.

## Failure semantics

| Observation | Result |
| --- | --- |
| Explicit `count: 0` with `result: []` on page 1 of a recognized payload, over HTTP `200` | `absent` |
| HTTP `400`/`401`/`403`/`404`, whatever the body carries (an empty *or* a shaped non-empty `solutions` block) | `unavailable` / `auth_required` / `forbidden` / `unavailable` — never `absent`, never `found` |
| A `200` payload whose `status` is not `200`, has no usable `data.problem`, answers a padded or foreign pid, or declares an unreadable `count`/`perPage` | `changed_response` |
| `count`/`result` disagreement, missing block, unreadable envelope/item, unreadable provenance (`author`, `title`, a numeric counter), blank or truncated body | `changed_response` |
| A page shorter/longer than the declared total requires, an empty middle page, drifted `count`/`perPage`, a repeated (or NFC-equivalent) `lid`, more pages/write-ups/characters than the fixed bounds | `changed_response` (whole read, no partial material) |
| `404` payload envelope at HTTP `200` | `unavailable` |
| `401` payload envelope at HTTP `200` | `auth_required` |
| `403` payload envelope at HTTP `200` — **authenticated** read | `forbidden` |
| Unrecognized payload error code at HTTP `200` — **authenticated** read | `forbidden` (a declared `429`/`5xx` are the exceptions above) |
| Unrecognized error code in an **anonymous** probe envelope | `changed_response` |
| HTML at HTTP `200` on the original solution URL without a hydration element (inline login page included) | `changed_response` — never `auth_required`: only an HTTP-status or redirect-level refusal carries the transport's own code |
| HTTP `200` HTML challenge/page without a valid hydration payload | `changed_response` |
| Transport/server failure, HTTP `429`, an oversized accepted HTTP `200` body, or timeout | the transport's typed code (`429` stays `rate_limited`); a non-200 body is never read, so it cannot change the code |
| Foreign or missing session | `auth_required` |
| Malformed reference, foreign account, unusable supplied URL, a reader that cannot serve both operations | `invalid_input` (thrown, not returned) |

`absent` is reachable from exactly one row of that table.

## Safety and cost boundaries

- **The credential is read once per authenticated operation, then attached to each guarded request.**
  One `fetchEditorial`/`listSubmissions` call resolves the session from the Windows credential vault
  seam **once**, normalizes it to the canonical `__client_id`/`_uid` pair, and holds it in memory for
  that operation; the transport then attaches it to every paging request of that operation whose target
  the identity guard has bound (page 1 and each `?page=N` continuation of exactly one problem, or each
  record page of exactly one account). It is cleared in a `finally` on every path (success, failure and
  cancellation). It is never written to the SQLite store, a log line, a DTO, a diagnostic or a report,
  and never returned through any port.
- **What is stored, and where.** The complete retrieved body is stored as the
  `solutions[].text` of the local `ProblemSnapshot`, serialized as canonical JSON in the SQLite
  `snapshots.body` column (the schema has no separate editorial table) — that is the product's own
  evidence store. It never enters a diagnostic, a log line, the `material.refresh` DTO, a report, a
  synthetic fixture or a failure message/sample: no cookie, viewer identity, author value *other than the
  public author name stored as the source's attribution*, body or server error message travels those
  paths.
- **No `absent` from a broken request.** The statement-only reasoning path — the expensive one — can
  only be reached through the single explicit signal on page 1 of an HTTP `200` answer.
- **No partial success.** A failure anywhere in the walk leaves nothing stored, and the read reports
  its typed code.
- **One source-wide gate.** Every Luogu HTTP path of one instance — the sync service, the connection
  manager and the business adapter's anonymous and authenticated reads — runs as a whole operation
  through the same gate, so the >= 2 s quiet time holds across transports and accounts.
- **No schema change, no new request budget class.** The read uses the existing per-account transport,
  the documented 2-second gate, the byte cap and the same-origin-only redirect policy, with a fixed
  20-page ceiling per read.
- **Zero model calls.** The whole path is platform IO.

## Verification actually performed

**Scope of the "synthetic" claim.** Everything the *33C focused set* (the two Luogu editorial test files
and the two composition/gate files) reads at runtime is synthetic: invented placeholder payloads, an
in-memory credential vault, a synthetic session cookie, and **temporary SQLite databases created by the
tests themselves**. The focused set reads no `.local` file. The untracked sanitized observation at
`.local/observations/luogu-editorial-shape.v1.json` was a design input for the hand-written fixtures,
not a test dependency. No acceptance database, user database or paid model is touched by these focused
automated tests.

`npm run check` runs the *whole* repository suite, and pre-existing tests in it read these two groups of
`.local` artifacts — this is stated here rather than folded into the claim above:

| `.local` path | Read by | Why |
| --- | --- | --- |
| `.local/cf-api.response`, `.local/cf-records.response` | `tests/platform/codeforces.test.ts` (pre-existing) | captured Codeforces catalog/record bodies used as fixtures. **The record capture contains public Codeforces data of the account `tourist`** — public competitive-programming history, read by a pre-existing test, not by anything this stage wrote |
| `.local/dsh-balance-compat` | `scripts/patch-balance-client.test.mjs` (pre-existing) | the actual local patched package, copied for the patch test |

The credential path in the 33C tests is an in-memory vault with a synthetic session cookie. The
production reader does read a real session value from the OS vault into memory once per authenticated
operation (see the safety section). The automated suites do not read a real Luogu credential, private
account or acceptance database; the whole suite's pre-existing Codeforces test does read the public
`tourist` capture listed above. Separate live acceptance, documented later in this report, used a real
selected account and an isolated acceptance database without recording the account identity or session.

The composition tests replace `globalThis.fetch` with a refusal **before** `activateHost` runs, dispose
the runtime first and restore the guard afterwards; the startup-sync test additionally proves that the
host's *default* anonymous metadata source answers from the injected transport, so a missing seam fails
the case instead of reaching the platform.

As recorded in the revision-2 note above, the network guard in this round's *early* debugging was
installed too late and one public `P1001` page was fetched over the real network before that was fixed;
no credential, account or private data was involved, and no other request left the machine.

Two falsification checks were run, so the new tests are known to be load-bearing rather than decorative:

1. **Gate wiring** — with `createGatedLuoguAdapter` removed from `activateHost`, the two composition
   pacing tests fail with a `0 ms` gap between the anonymous statement operation and the authenticated
   solution operation; with the wrapper in place they pass.
2. **Refusal bodies** — with the non-200 body discard disabled in `createAuthenticatedLuoguFetch`, the
   "a refusal body is never pulled" case fails with `unavailable` instead of `auth_required`; with it
   enabled the case passes.

Commands actually run (PowerShell, one command per invocation — no backslash continuations, which
PowerShell does not support):

```powershell
node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/platform/luogu-editorial-shape.test.ts tests/platform/luogu-editorial-read.test.ts
node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/platform/luogu-session.test.ts tests/platform/luogu.test.ts
node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/plugin/composition.test.ts tests/plugin/luogu-gated-adapter.test.ts tests/plugin/business-api.test.ts
npm run typecheck
npm run check:architecture
git diff --check
npm run check
```

Measured results (the focused rows were measured in the **DSH working environment** on Node 24;
the final full-gate row is the unrestricted Windows pre-commit run recorded below):

| Command | Result |
| --- | --- |
| Focused Luogu platform set (parser, reader, session, adapter) | 134 tests, 134 passed, 0 failed |
| Focused Luogu editorial set (parser + reader only) | 77 tests, 77 passed, 0 failed |
| Focused composition + gate wrapper + business-API set | 54 tests, 54 passed, 0 failed |
| Focused note-dedup set (`business-api` + `import-service`) | 59 tests, 59 passed, 0 failed |
| Expanded focused set (`tests/import/*` + business-API + composition + material gate) | 114 tests, 114 passed, 0 failed |
| `npm run typecheck` | passed (no diagnostics) |
| `npm run check:architecture` | "Architecture imports satisfy the declared layer boundaries." |
| `git diff --check` | exit 0 (line endings only; `core.autocrlf=true` normalises them on commit) |
| `npm run check` | **exit 0**: typecheck, architecture, 1,560 business tests with 1,559 passed / 0 failed / 1 skipped, 20 script tests, ESM build, browser factory/shared React/disposal checks |

The final pre-commit gate ran the complete current tree in an **unrestricted Windows environment**. The
Windows Credential Manager synthetic-secret roundtrip executed and passed; the only skipped test is the
non-Windows capability branch, which does not apply on this host. Earlier restricted and historical runs
remain below as environment and revision evidence, not as the release result:

| Environment | Result |
| --- | --- |
| Coordinator's unrestricted Windows environment (current pre-commit build) | 1,560 business tests: **1,559 passed / 0 failed / 1 skipped**; `npm run check` exit 0. The Windows Credential Manager **synthetic** roundtrip ran and passed; only the non-Windows guard skipped. |
| Earlier restricted DSH run (earlier pre-commit tree) | 1,547 business tests: **1,545 passed / 0 failed / 2 skipped**; `npm run check` exit 0. In addition to the non-Windows guard, the sandbox denied the child process with piped stdio required by the Credential Manager roundtrip. |
| Coordinator's unrestricted Windows environment (historical: the implementation version before the Revision 4 and note-dedup tests) | 1,543 business tests: **1,542 passed / 0 failed / 1 skipped**; `npm run check` exit 0. The Windows Credential Manager **synthetic** roundtrip actually ran there and passed, so only the non-Windows guard skips. |

The 1,543-test run belongs to an earlier implementation version (before the two Revision 4 tests and the
two note-dedup regressions). **The authoritative full-suite result for the code in this repository is the
current unrestricted run: 1,560 / 1,559 passed / 0 failed / 1 skipped.** The restricted 1,547-test run
also belongs to an earlier pre-commit tree and is retained only to document the environment-specific
Credential Manager process restriction; neither result claims that the
platform-specific guard can run on every host. The 1,514-test figure reported in an earlier round also
belonged to an earlier revision.

> The first report claimed "90 tests, 90 passed" for the focused set. That count covered the pre-paging
> test files: it exercised only whole-payload fixtures and never a paginated multi-page answer, and it
> did not include any production-composition case. It was therefore accurate about the commands it ran
> and misleading about the surface they covered; revision 1 fixed the implementation and added the
> missing coverage, revision 2 added the status-order, canonicalisation, provenance, anonymous
> sanitisation and source-gate coverage, and revision 3 adds the refusal-body, transport-failure,
> login-wall, raw-text hydration and declared-error-envelope coverage.

New coverage (revision 3 additions in **bold**):

- `tests/platform/luogu-editorial-shape.test.ts` — the paged parser API: a real page declaring
  `count: 56` at `perPage: 10` with ten items; a page whose content exceeds its declared total;
  `status` missing/not 200; a missing/unreadable/foreign `problem` block; unreadable `count` and
  `perPage` (missing, string, fraction, negative, zero, beyond the bound); the recorded optional
  variations; the viewer identity never read; **a write-up refused whole when any stored member is
  missing or wrongly typed (`author`, `author.name`, `title`, `category`, `time`, `upvote`,
  `replyCount`, `favorCount`, `status`), and the optional/nullable members the capture recorded
  (`categoryOld`, `author.isRoot`, `badge`) still accepted**; **one canonical Unicode identity for a
  precomposed and a decomposed `lid`, plus a refusal of both spellings in one payload**; **a padded
  `data.problem.pid` refused as a mismatch**; **an unreadable `lid` (surrogate half, control character,
  empty, whitespace, non-string, over-long) refused without the value appearing anywhere in the
  failure**; every unreadable variation of the empty case; an error envelope carrying a fake empty
  `solutions` block never read as an absence or a page; **a declared `429` classified as `rate_limited`
  and a declared `5xx` (code or envelope status) as `server_error`, with `403`/`418` still refusals**;
  **the hydration element required to declare `type="application/json"` (either quote style, extra
  attributes, case/space tolerant) while a missing or other type yields nothing, and a raw-text script
  body whose `&amp;`/`&lt;`/`&quot;`/numeric entities survive verbatim**; **`data-id`/`data-type`/
  `aria-id` refused as impostors while the real `id`+`type` pair still resolves in either order, either
  quote style and beside a decoy `data-` attribute**; and the sanitized-fixture guard.
- `tests/platform/luogu-editorial-read.test.ts` — the **production reader and its transport guard over a
  synthetic session** (an in-memory vault and an injected synthetic transport, not real credential
  machinery):
  a 56-write-up, six-page answer read in order with the exact URL sequence
  (`/problem/solution/P1001`, then `?page=2` … `?page=6`), one `retrievedAt` for all 56 sources, 56
  distinct ids and the session on every page; a declared total that disagrees with a page; an empty
  middle page; a server that ignores `page` (caught as repeated write-ups at the first continuation
  page); `count`/`perPage` drift; a `lid` repeated inside a page and across pages; **an NFC-equivalent
  `lid` inside one page and across pages**; a total needing more than 20 pages (only page 1 is
  requested); more retrieved characters than one read may store; a continuation page answering
  `401`/`403`/`404`/HTML/`429`/`5xx`/a fake empty success, each keeping its own code and none of them
  `absent`; **all four HTTP refusal statuses with a fake empty *and* a fake non-empty body, none of them
  `absent` or `found`**; **an HTTP 401 HTML answer at the solution URL as `auth_required`, and an HTTP
  200 inline login page as `changed_response`**; cancellation between pages dispatching nothing further;
  the explicit zero as the only absence; the sensitive-`lid` refusal; the guard accepting exactly the
  canonical page it bound and refusing `page=02`, repeated `page`, extra parameters, a fragment, a
  wrong page, a wrong pid/path, a login path, a foreign origin, a non-default port, URL userinfo, plain
  `http` and a non-URL — each before dispatch; the adapter refusing a reader that cannot serve
  `fetchEditorial`; **the anonymous probe body-blind on every answer shape (HTML, broken JSON,
  non-object JSON, error envelopes with a sentinel in `errorType`/`errorMessage`), with a fixed detail
  and no sample**; **a refusal body that throws when read, declares 999,999,999 bytes, or is not valid
  JSON — with a 1 KiB byte cap installed — still answered as `auth_required`/`forbidden`/`unavailable`
  and never `absent`/`found`**; **a body-level `429` and `5xx` keeping `rate_limited`/`unavailable`**;
  **an HTML script body whose entities survive verbatim, and a same-id script of another type yielding
  `changed_response`**; **every anonymous transport failure (fetch rejection, body-stream error, a
  `Location` that is not a URL, a cross-origin redirect) rebuilt with fixed text, no sentinel and no
  sample**; and **a followed redirect to `/auth/login` or `/login` reported as `auth_required` while an
  inline login page at the original URL stays `changed_response`**; **a forged `PlatformError` (code
  outside the declared vocabulary, a non-boolean `retryable`, or a non-delay `retryAfterMs` carrying a
  sentinel) answered with a complete fixed failure — never `undefined`, never the forged value, and never
  a non-boolean retry flag**.
- `tests/plugin/luogu-gated-adapter.test.ts` (new) — the source-gated business view: one gated whole
  operation per adapter call for `listProblems`, `listSubmissions`, `fetchProblem`, `fetchEditorial`,
  `fetchAccountProfile` and `fetchProblemDetail`; a queued operation that does not reach the adapter
  while another is in flight (**including two different accounts**); the floor after each whole
  operation; a business read that cannot overlap an operation the host already gated; the gate entered
  once for an operation that walks six "pages" internally; a cancelled queued call that dispatches
  nothing (asserted before the head is released, so the test cannot deadlock); a failing operation that
  still releases the queue and keeps its own error; identity/capabilities/optional-method passthrough;
  and a refusal to build without a usable gate.
- `tests/plugin/composition.test.ts` — **the production composition**: a real `activateHost` over a
  temporary SQLite store, the synthetic vault/clock/wait/transport seams and a synthetic Luogu surface,
  with the real `fetch` refused **from before activation** and the runtime disposed before the guard is
  removed. It asserts that bootstrap advertises the business adapter's submissions **and** editorial
  support, that `material.refresh` with an `accountId` fetches the statement anonymously and reads 56
  write-ups across six authenticated pages through the host's own reader, that the source gate separates
  the anonymous statement operation from the authenticated solution operation by >= 2 s **across two
  different transports** while the six pages inside one operation stay transport-paced, that two
  accounts' business reads are serialized with no gap below the floor, that the stored snapshot carries
  56 bodies with 56 distinct attributed sources, and that the DTO carries neither a body nor an author
  value.
- **Note dedup (revision 5)** — `tests/plugin/business-api.test.ts`: an explicit `absent` saved through
  the public `material.supplement` route, read back from the real SQLite snapshot, stores the user's
  sentence **once** (no ` | ` separator). `tests/import/import-service.test.ts`: a declaration note equal
  to its detail after trimming is stored once, while two genuinely different fragments keep the existing
  `A | B` format and order. Both fail against the pre-fix join (`X | X`).

## Live acceptance: what it established, and what remains unverified

The live acceptance run this report called for has now been performed by the coordinator on a real Luogu
account (**2026-09-16**); its observations are recorded in the acceptance section at the end of this
report, and its outcome is that the material path is verified live within that scope. The three checks it
covered, which this report had defined in the order that keeps the stored session usable:

1. **Material is read.** Refresh a problem the platform really has write-ups for and assert
   `editorial.status === 'found'` with **non-zero** `sourceCount`/`solutionCount` and
   `sourceCount === solutionCount`. The `56` recorded for `P1001` is an **observation**, not a constant of
   this build: the expectation is "found, non-zero, and internally consistent", and the numbers
   legitimately differ between problems and as users publish write-ups. **Observed live: P1001 56/56,
   UVA10082 9/9.**
2. **An explicit absence is reported as one.** Refresh a problem the platform reports as having no
   solutions and assert `absent` (with the statement present, this is the reasoning-path case).
   **Observed live: P17462, `absent` from a real `count=0`/`result=[]`.**
3. **The authentication wall, without destroying the session.** Call a read with **no account selected**
   (`accountId` absent on `material.refresh`, or the anonymous probe) and assert `auth_required` — never
   invalidate or log out the stored session to test this. **Observed live: P1001 with no account selected,
   `auth_required`, and not mistaken for `absent`.**

Claims that remain explicitly unverified and are handled defensively rather than assumed:

1. whether an authenticated **direct** `content-only` request returns the same shape as page hydration
   — the reader accepts both forms at HTTP `200`, so either answer works, but which one the live
   endpoint returns is unknown;
2. the live HTTP status and content type of the authenticated direct response — the reader now decides
   by HTTP status first and by payload second, and treats an unexpected status as a non-`absent`
   operational failure;
3. login-redirect and CAPTCHA response shapes — a redirect towards a login path is refused before the
   credential is sent (`auth_required`), an HTTP `401` is `auth_required` whatever its body is, and an
   HTTP `200` inline login page at the solution URL is `changed_response` because no reliable structural
   signal was observed for it;
4. the `time` field's unit, and the numeric semantics of `category`/`status`/`promoteStatus` — no
   `publishedAt`, and no "public/private" meaning, is derived from any of them; they are recorded as the
   numbers the platform reported, in the source note, and no rule branches on them;
5. whether a write-up's `language` is representable — the capture recorded no such field on the item, so
   `language` is `null` rather than inferred from anything else;
6. whether every live write-up carries all the members this build requires (`author.name`, `title`, the
   four counters, `category`, `status`, `time`) and whether the installed hydration element declares
   `type="application/json"`. **The live run confirmed both for the problems it read** (P1001 and UVA10082
   were stored with full provenance); a payload that differs is still reported as `changed_response`
   rather than stored with an invented value.
7. **The authenticated statement path for private/test problems is not covered.** One acceptance-only
   private/test problem (identifier omitted) returned `unavailable` for its automatic editorial fetch — a
   **transport classification, not a platform `absent`** — and its statement still failed with
   `auth_required`. Whether that problem has an editorial was settled **by the user, not by the platform**:
   the user confirmed it has none, and the coordinator recorded that as **manual evidence** in the isolated
   acceptance database. Its final stored record is snapshot **v4** with 1 source / 0 solutions; the earlier
   v3 exposed the duplicated note that revision 5 fixed. The remaining open point is only the
   **authenticated statement read** of a problem that needs a session, which is not a verified path.

Luogu's own authenticated **statement** read is otherwise out of scope here, and cross-site editorial
reuse remains limited to the identifier rule documented in the previous stage.

## 协调者实机验收（2026-09-16）

协调者在真实洛谷账号上完成了本阶段的实机验收（离线安装 + 真实登录态读取）。以下为实际观测到的事实：

| 检查 | 观测 |
| --- | --- |
| 安装一致性 | 当前构建离线安装到 `icpc-acceptance` 后，**安装 `dist` 与仓库 `dist` 均为 794 文件**；逐相对路径 / 大小 / SHA-256 的 `Compare-Object` 差异为 **0**；`client.js`、`plugin/index.js`、`application/import-service.js`、`adapters/luogu/session-reader.js` 的哈希逐一相等 |
| 离线安装包 | `dsh-icpc-workbench-0.1.25-20260916130815.tgz`，SHA-256 `d2b6f39d40fdd909b8b83fc9a4ed28a6eca7f80c857bf355bd2918ffba5fbe8e`；`plugin --profile icpc-acceptance add … --offline` |
| 升级后 bootstrap | `version 0.1.25`、`schema 10`；安装前后**所有表与全部设置保持一致**；`provider=deepseek-official`，analysis / verification / reasoning / coaching 全部为 `deepseek-flash`；四个 companion 依赖（workbench / balanced / deliberate-practice / `@lemcae/dsh-balance`）齐全；服务 **PID 81336** 独占 3081，StartTime 与命令行匹配，stderr **0 bytes** |
| 未选账号 + P1001 | 题面 `fetched`，题解 **`auth_required`**（未误判 `absent`）——无账号时的认证墙 |
| 选择已连接的验收账号（账号标识已匿名化） | **P1001**：题面 `fetched`，题解 `found`，快照 **v3**，**56 sources / 56 solutions**；**UVA10082**：题面 `fetched`，题解 `found`，快照 **v2**，**9 / 9** |
| 真实 `absent` 证据 | **P17462** 原本不在本地题库；通过 UI 的 JSON 预览 / 确认只导入这一个公开题引用后刷新，平台把标题更新为「[GESP202609 八级] 末班车」，题面 `fetched`，题解 **`absent`**，快照 v2，**1 source / 0 solutions** —— 这是明确 `count=0` / `result=[]` 的真实 absent 证据 |
| 错误分类对照 + 人工证据终态 | 一条验收用私有/测试题（题号已匿名化）自动抓取：题解 **`unavailable`**（传输分类，**不是** `absent`），题面 `failed` / `auth_required`（至今未变）。题解是否存在由**用户人工确认**；安装修复构建后在 UI 重新保存人工证据，并用新的匿名来源标题强制替换旧说明。**终态快照 v4**：**1 source / 0 solutions**、`kind=editorial`、`availability=absent`、note **恰好单句**且 `noteSeparatorCount=0`、控制台 0 error —— 人工证据，**不是**平台自动 `absent`；初始 v3 正是暴露重复说明的那一版，修复后以 v4 关闭 |
| 环境与副作用 | 新验收页浏览器控制台 **0 error**；验收后 SQLite `PRAGMA integrity_check = ok`；未点击任何付费 / AI 按钮，本次实机刷新不调用模型 |

结论范围：**真实登录态下的多页题解读取（56 条）、平台 `count=0` 的真实 `absent`、无账号时的 `auth_required`、错误分类不误判、以及经离线安装的修复构建（794/794 文件、0 差异、`PRAGMA integrity_check = ok`、服务独占验收端口、stderr 0 bytes）均已实机通过**。验收用私有/测试题的“没有题解”结论由用户人工确认（题号已匿名化，人工证据，非平台自动 `absent`）；其终态为快照 v4（1 source / 0 solutions、`kind=editorial`、`availability=absent`、note 单句、`noteSeparatorCount=0`），其自动抓取仍为 `unavailable`、题面仍为 `failed`/`auth_required`。剩余未决范围仅为**登录态私有 / 测试题的题面读取**；上文「仍未验证的声明」清单（直连 `content-only` 响应形状、登录重定向 / CAPTCHA 形状、`time` 单位与 `language` 等）同样依然未验证。验收过程未记录账号标识、验收用私有/测试题号、启动 URL、令牌、Cookie、题解正文或任何凭据。
