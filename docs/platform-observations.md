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
