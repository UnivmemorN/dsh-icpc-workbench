# Platform observations (2026-09-12)

Coordinator performed anonymous Node fetch requests from this Windows host, with normal TLS verification and 20-second timeouts. Responses are ignored local artifacts, not repository fixtures. Do not infer editorial absence from failures.

| Request | Result | Observed shape |
| --- | --- | --- |
| Luogu /problem/P3374 with x-lentille-request: content-only | 200 JSON | top-level instance/template/status/locale/data/user/time; data.problem |
| Luogu /problem/solution/P3374 with same header | 401 JSON | data.errorCode=401; errorType ends UserUnloginException; errorMessage 请先登录 |
| CF /problemset/problem/20/C | 403 HTML | challenge page; statement/tutorial discovery unavailable on this host |
| CF /api/problemset.problems | 200 JSON | status=OK; result.problems and problemStatistics |

Luogu problem fields observed: pid, type, name, difficulty, tags, totalSubmit, totalAccepted, flag, provider, contenu, content, attachments, showScore, acceptSolution, acceptLanguages, samples, limits.
The statement is problem.content with name/background/description/formatI/formatO/hint/locale, plus samples and limits. data.translations contains en and zh-CN keys. P3374 has raw difficulty 4 and numeric tags 53,523. Preserve unknown IDs; do not map raw difficulty to invented CF ratings.

Official CF API documentation requires at most one request per two seconds:
https://codeforces.com/apiHelp . Enforce this minimum across requests on the same instance, with cancellable queueing and finite timeout/retries.

Authenticated editorial retrieval has not been verified. Never request secrets through logs or store them in the training DB; normal host credential mechanisms or user-supplied manual text can be added without bypassing access controls. Do not claim Luogu editorial or live CF HTML acceptance from synthetic fixtures.

## Additional import probes
- /problem/list?page=1 + Lentille header:200JSON; data.problems={perPage:50,count:17466,result:[...]}; each item has pid/type/name/difficulty/tags/totalSubmit/totalAccepted/flag/provider.
- /_lfe/tags:200JSON with tags/types/_locale/_version. tags is an array of {id,name,type,parent}; negative IDs occur (for example -2), so do not reject all nonpositive platform tag IDs.
- /record/list?user=1&page=1 + Lentille header:401 UserUnloginException. This is authentication required, not an empty submission history. Authenticated record shape has not been verified.
- CF user.status for a public account:200OK with submission array; probe records stay outside Git.
- CF blogEntry.view:23 of24 discovered editorial IDs returned200JSON content (HTML). Blog4634 returned400FAILED Blog entry with id4634 not found both with lang=en and withoutlang, despite a cached web page. Treat a dead referenced link as unavailable; it proves no global editorial absence. Downloaded bodies remain only in.local.
- HTML entities/math markup and contest sections matter: a blog can contain several problems. The target problem's section must be identified before evidence analysis. An ambiguous or missing section is changed_response and needs manual input, not a successful empty editorial.
- Primary parser references: https://github.com/fb55/htmlparser2 and https://csv.js.org/parse/api/sync/ . Registry metadata verified htmlparser2 12.0.0 and domutils4.0.2 (Node>=20.19), csv-parse7.0.2. Our supported Node22.19+ satisfies those engines. Dependencies are not installed yet.

## Boundary choices for adapters
Keep all platform URLs on the configured official origin; user-supplied CF tutorial URLs must identify a Codeforces blog, not become an arbitrary fetch target. A manual import URL is source attribution and is never fetched automatically. All fetched HTML is converted to plain text; never render third-party HTML in the workbench.

Expose a direct fetchProblem request in the platform port for full statements; CF catalog metadata alone does not contain a statement. A blocked HTML detail fetch must stay visible. Numeric ratings/difficulty remain raw, and unknown numeric platform tags remain visible by ID when the dictionary cannot resolve them. Remote page cursors/checkpoints must be account/instance scoped and imports idempotent. All retries obey the same shared rate limiter and finite cancellation/timeout policy.
