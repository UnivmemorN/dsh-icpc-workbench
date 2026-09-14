# Stage 31 — Luogu zero memory limit compatibility

## Problem and change

A complete Luogu problem could fail every metadata retry with `changed_response` because the parser required every memory-limit entry to be positive. The official public response for [UVA10082](https://www.luogu.com.cn/problem/UVA10082), inspected on 2026-09-15 Asia/Shanghai, returned HTTP 200 with complete statement sections and samples, `limits.time: [3000]` and `limits.memory: [0]`. The old parser rejected `data.problem.limits.memory[0]` before importing the otherwise valid problem. This reproduction required no login.

Version 0.1.24 accepts finite non-negative memory entries and preserves the platform array verbatim, including mixed zero/positive entries. Zero is a raw platform value, not an assertion of unlimited memory or a zero-byte constraint. Time limits remain strictly positive, including previously accepted positive fractions. Negative, nonfinite, nonnumeric, missing, empty and malformed limits remain errors; problem identity and nonempty description checks are unchanged. There is no PID-specific exception, schema change, credential change, new network path or AI call in import.

Implementation files: `src/adapters/luogu/parsers.ts` and the synthetic regression suite `tests/platform/luogu-zero-memory.test.ts`. Release metadata and the user troubleshooting guide were updated. The main implementation used dsh official Flash at max; coordinator review corrected the worker's proposed time minimum of 1 to preserve the existing strictly-positive numeric contract, and added a positive-fraction regression.

## Validation actually performed

- Coordinator focused suite: new zero-memory tests plus existing Luogu adapter and authenticated problem-reader tests, 47 passed. Seven new tests cover real adapter imports and detail values, mixed arrays, malformed inputs, positive fractions, invalid time, statement/identity refusals and the authenticated reader.
- `npm run check`: type checking and architecture validation passed; 1,362 business tests with 1,361 passed, no failures and the existing non-Windows-vault test skipped on Windows. All 20 script tests passed. Independent ESM build, browser factory/shared React/disposal, math CSS and font checks passed.
- Installed package version 0.1.24 on the acceptance profile, schema 10. A verified offline SQLite backup preceded restart; every table and runtime setting matched the pre-install baseline. Existing model roles remained Flash and companion plugins were retained.
- Documentation/package audit: 40 documents, 243 file links, zero errors; the package contains 10 user documents and no developer documents.
- The real `luogu.retryMetadata` operation then imported the reported queued problem successfully. Exactly one item left the queue with no new final-failure count. All non-target rows, submissions/AC evidence, completion records, history coverage and checkpoints matched the pre-retry baseline. No model attempts were created.

- Browser acceptance on the installed version: searching the recovered problem returned one local result with its original passed status; the detail panel displayed description, input/output sections and sample.

Fixtures are original synthetic data. Credentials, account identifiers, real fetched statement bodies, databases, backups and execution logs remain local and excluded from Git. Problems with unrelated permissions, verification challenges, absent descriptions or other changed fields can still fail and retain their existing recovery flow.
