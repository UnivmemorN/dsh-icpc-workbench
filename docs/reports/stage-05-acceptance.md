# Stage 5 — Live acceptance, 2026-09-12/13

Release status: experimental 0.1.0. The implementation works on the tested dsh baseline; model quality is not a guarantee. Final package/restart and CI results are appended below.

## Environment and separation

Plugin repository: https://github.com/UnivmemorN/dsh-icpc-workbench, workspace `D:/dsh-icpc-workbench`. Harness source remains unchanged at `fb2c4b9e698e30edb738bca4cf0618587db7d203` (`0.1.5-rc.2`). Acceptance uses its own dsh profile and loopback port 3081, with a separate SQLite schema-3 training directory. Daily port 3080 was not changed. No real student account or school OJ data was supplied.

## Real editorial benchmark

The 37-case access cohort and method reference were frozen before paid evaluation. Thirty cases had usable public CF editorials; the other seven remain access failures, not invented text. Model inputs contained only actual captured material and the taxonomy, never expected answers. The user explicitly approved this outbound material. All calls used official DeepSeek Flash with max effort; reasoning calls were disabled for these found editorials.

| Measure | Observed |
| --- | --- |
| Evaluated real problems | 30 |
| Problems with auto-adopted tags | 27 / 30 (90.0%) |
| Unique auto-adopted problem/tag pairs | 51 |
| Exact frozen-reference matches | 39 / 51 (76.5%) |
| Reference-method recall | 39 / 62 (62.9%) |
| Adjudicated precision, frozen taxonomy definitions | 47 / 51 (92.2%) |
| Strict displayed-name sensitivity | 45 / 51 (88.2%) |
| Redundant ancestors (no precision credit) | 2 |
| Pending adjudications / duplicate adoptions | 0 / 0 |
| Unresolved structured-output failures | 510C, 380C, 580D |

The adjudication gives no credit to redundant segment-tree parents even when a parent was in the original reference. It rejects the sliding-window claim for a simple run counter (580A) and modular-inverse claim for Fermat periodicity (456B). Two cumulative maximum/XOR mappings satisfy the frozen prefix-aggregate description, but are broader than the displayed name “prefix sums”; the strict-name sensitivity treats both as incorrect. A misleading Fermat alias in the taxonomy is a known limitation, not an excuse to count the tag as correct.

The >=90% gate passes only under the preregistered taxonomy semantics. It is not an unconditional 90% guarantee: the stricter name-based score fails that threshold. The release stays experimental. A subsequent taxonomy revision should separate prefix sum/XOR/extrema and modular inversion/Fermat before a fresh evaluation; this report does not silently relabel old results.

[Reference](../../benchmarks/reference-cases.v2.json), [individual adjudications](../../benchmarks/adjudications.v1.json), and [machine-readable results](../../benchmarks/results.v1.json) are published without downloaded editorial text or model transcripts. Reviewer was the Codex coordinator, not an independent human expert panel. The sample is small, nonrandom and contains shared contests. Recall uses the union of preregistered alternative methods, not just methods present in a particular captured editorial.

Live failures revealed a missing prompt schema detail. Six early successes used analysis-v1; later attempts used analysis-v2 with the one-evidence-entry-per-source/solution rule. Original failures, all charged attempts and bounded repairs remain in private audit records. Failed rows were not removed from the denominator; exhausted jobs were not reset for more calls.

## P1001 progressive coaching

The real public Luogu P1001 statement was imported with its approved content hash. Levels 1, 2, 3 and explicitly requested full explanation all returned through the actual host API. Level 1 gives conceptual guidance, level 2 observations, level 3 pseudocode, and full includes C++17. All four stable request IDs were replayed and reused the same settled attempts without extra calls. Metadata-only status reads omitted response bodies.

Both unedited C++17 code blocks compiled with the installed MSVC toolchain and each passed 107 cases: the official sample, positive/negative extrema, cancellation, zero, whitespace variants and deterministic random pairs. No online-judge submission was made. This is one very easy coaching case; it does not establish advanced-problem tutoring quality. Prose is verbose and contains overbroad advice about language details; generated text remains visibly labelled as AI content without independent verification.

## Actual browser and data workflows

Observed through the installed workbench in the Codex browser:

- Sidebar entry and return-to-conversation navigation; all six pages. Empty search and normal problem search work. Unsolved tags and editorials remain hidden until explicit reveal; missing statements disable hint actions.
- JSON preview then content-hash-confirmed import created seven clearly labelled synthetic acceptance problems, one synthetic account and six submission records. These records are local fixtures, not student data, and were never sent to a model.
- Browser manual tag acceptance persisted. Browser retrospective saved an assisted completion with the actual chosen algorithm. Statistics reported six distinct attempted problems, two accepted, one assisted retrospective and zero independently confirmed skills.
- After fixture tags were supplied, the minimum-five-samples rule produced the expected binary-search weakness row. Untagged records did not become mastery evidence.
- Selected an existing candidate, previewed and adopted a rule plan, changed its duration from 30 to 25 minutes, and checked it off. Today reflected completion while the source submission verdict remained unchanged. Unfilled plan time was explicitly displayed.
- Browser backup wrote an independent SQLite backup in the plugin data directory. Light-theme layout was visually inspected at the browser's approximately 650-pixel width; no claim of a full cross-browser/mobile matrix.

Offline coverage separately exercises CSV field/row failures, cancellation, cursor recovery, idempotence, stale snapshots, unknown usage, settings revisions, unsafe paths, auth/origin rejection, schema migration/backup, mismatch refusal and disposal. Live CF access was constrained by public-site protections; authenticated Luogu editorial access and Hydro school-account integration remain unverified/unimplemented respectively.

## Audit and budget

Live integration found that sessions.flush alone did not guarantee durable external audit logs. The accepted adapter now owns a detached public Session and persistence handle, serializes appends/flushes, and marks its informational events as ignorable for host conversation replay. Business data remain separately persisted in SQLite. A zero-paid scripted probe verified the mounted backend.

The first 21 paid benchmark calls preceded that fix: their 45 in-memory events were captured locally before restart, but they did not originally have a durable host-session log. This is a historical acceptance gap, not retroactively claimed as durable. Later paid calls use the corrected storage path; restart checks are recorded below.

The user reported approximately CNY30 of actual platform consumption. The coordinator reconciled the older conservative ledger to that report plus CNY5 contingency, preserving all 48 covered historical run records. Subsequent 30-case and coaching acceptance adds CNY3.094746 at conservative uncached input prices. The resulting conservative total is CNY38.094746, not a fresh provider billing reading. The CNY100 ceiling and CNY90 stop-new-dispatch threshold remain unchanged. No paid operation is left running.

## Validation

`npm run check`: typecheck, architecture check, 532 behavior cases, 9 accounting/context cases, independent package build and shared-React/classic-factory/disposal smoke all passed after the final UI wording and bundled-license changes.

MIT references for icpc-workbench and dsh are retained. The bundled @noble/hashes MIT text is included both in the browser factory and the packaged licenses directory. Dependencies and exact tested host versions are recorded in package-lock.json and THIRD_PARTY_NOTICES.md.

Packaged restart checks passed on the final runtime build: the public persistence backend read 102 events (51 input/result pairs) from two paid audit sessions after process restart; no paid call was made by the reader probe. All four P1001 responses and the edited/adopted/checked-off plan survived restart. The browser-created backup passed SQLite integrity_check with schema 3. Unauthenticated bootstrap still returned 401. Package inspection found no private inputs, databases, transcripts or test files. The two failed zero-paid probe directories were moved to a private reversible archive; the temporary acceptance reader plugin was removed from the isolated profile.

Windows CI found a backup-path inconsistency that was absent on the local account: the Windows runner uses the 8.3 alias RUNNER~1, while asynchronous native realpath expands it to runneradmin. Configuration now uses the same native canonicalization as backup containment. CI confirmed the backup workflow passed after this correction; the five configuration assertions were updated to require the native canonical path as well. Directory isolation and symlink checks remain intact.
