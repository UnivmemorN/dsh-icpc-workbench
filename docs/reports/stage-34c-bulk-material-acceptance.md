# Stage 34C — bulk platform-material refresh release acceptance

Date: 2026-09-17

## Accepted build

- Package version: `0.1.26` in `package.json`, `package-lock.json` and the bootstrap projection.
- Package: `dsh-icpc-workbench-0.1.26-stage34-20260917200121.tgz`.
- Package size: 3,497,623 bytes; 844 archive entries.
- Package SHA-256: `a95235f9bd9d7f32994ee8775422f2df780e35ec24445d11e44e4a7796937f14`.
- The archive audit found no `.local`, `node_modules`, environment, SQLite or session material.
- The built `dist` and the runtime installed in the isolated profile each contained 814 files. A relative-path plus per-file-SHA manifest comparison found zero differences; both manifests hashed to `d7f6ae44216c31f7dcfd6ced255f6121c8b391653faeb996fa2e0f782146a831`.

## Independent gate

The coordinator ran `npm run check` outside the DSH worker sandbox after the final UI repair:

- TypeScript: passed.
- Architecture boundary check: passed.
- Main test suite: 1,652 tests; 1,651 passed; 0 failed; 1 skipped. The real Windows Credential Manager round trip used a random synthetic secret and passed; the one skip was the non-Windows-only branch.
- Coordinator script tests: 20/20 passed.
- Production build and classic-client verification: passed.

The DSV4.1 Flash max repair worker had separately reported 1,652 tests, 1,650 passed, 0 failed and 2 environment-dependent skips before it reached its request cap while writing the final note. The independent Windows run above is the release result.

## Isolated runtime

- Profile: `icpc-bulk-acceptance`.
- Port: `3082`.
- Process at acceptance: PID 19796; its command line named both the isolated profile and port 3082.
- Data directory: a new Stage 34 acceptance directory under ignored local state; the live bootstrap reported schema 11.
- The existing 3081 backend remained PID 24168 and listening throughout the 3082 startup and acceptance. It was not stopped, reconfigured or upgraded.
- Live acceptance used a fresh schema-11 store. The full gate separately covers a genuine v10 database backup and v10-to-v11 migration, including rollback/refusal cases; this live run does not claim to be a migration run.

## API and platform behavior

Two public Codeforces records, 1A and 2A, were imported into the isolated store only as acceptance inputs.

1. `material.prepare` created a durable two-item `prepared` batch with zero attempts and performed no platform request.
2. The explicit `material.start` action attempted both items in caller order. In this environment Codeforces refused the anonymous reads with `auth_required`; the durable batch became `paused` with two `attention` items, zero pending/running items and no item classified as `absent`.
3. The public projection exposed only status and snapshot metadata. It retained no account identity, Cookie, tutorial URL, response body or provider error text.
4. A second batch was cancelled before its first start and then passed through `material.retryFailed`: it returned to `prepared`, with the item pending and its attempt count still zero. Retry did not start work.
5. `material.list` and `material.detail` reopened the records without platform IO. Later UI-only preparation added another durable prepared record.

The observed Codeforces authentication refusal is therefore an honest per-item operational result, not evidence that those problems lack editorials and not a model failure.

## Browser acceptance

The packaged plugin was opened through the isolated 3082 DSH Web UI.

- With zero selected problems, “批量刷新平台材料” was disabled while the independent “刷新历史与恢复” entry stayed enabled.
- The history surface opened without preparing or starting work and listed the durable batches.
- Selecting a stored batch replaced the current-scope/current-account copy with the stored batch id, creation time, status and size. The page explicitly stated that the current selection and current account do not alter the record and that the historical account is unavailable and is not inferred.
- The paused Codeforces batch displayed both `auth_required` rows as “需处理（可重试）” and explicitly stated that this does not mean the platform has no editorial.
- Selecting both bank rows enabled the bulk-refresh entry. Opening it caused no mutation. Clicking “免费准备刷新批次” created a two-item prepared batch with two pending items, zero attempts and an enabled, separate “开始平台刷新” action.
- After a full page reload, bank selection returned to zero and “刷新历史与恢复” still reopened the newly prepared durable batch.
- A free tag-analysis preparation over the two failed-material snapshots created no analysis batch or job, reported two material errors and zero model-call bound, and exposed the two-item “批量刷新平台材料（不调用 AI）” action. Its panel included only the two `refresh_materials` rows and required its own free prepare and explicit platform start.

The authenticated 3082 browser tab was left open for review.

## No-AI evidence

Before the first material preparation, after the API acceptance, and again after the browser actions, the following tables each had zero rows:

- `model_call_attempts`
- `coaching_attempts`
- `plan_attempts`
- `ability_evaluation_attempts`
- `analysis_batches`
- `jobs`
- `analyses`

For every table the canonical empty-row JSON hash remained `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`. This is the acceptance evidence that preparation, platform refresh, cancellation, retry, history reads, reload recovery and the fully blocked analysis preflight did not create an AI call or analysis task.

## Result

Stage 34 bulk platform-material refresh is accepted for release. Platform success still depends on the target platform and the selected account session; operational refusals remain retryable attention and are never converted to “confirmed no editorial.”
