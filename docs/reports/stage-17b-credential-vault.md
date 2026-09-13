# Stage 17b — OS-protected local credential vault (repair 1)

Scope: the two review findings on the hidden PowerShell credential bridge and the missing Stage 17b
report. Fix 1: termination is confirmed by the child's `close` event and never by a timer. Fix 2:
the stdout hard cap is enforced before any chunk is retained. Nothing else in Sprint 17b changed.

Contract: `.local/contract-17b-r1.md` (parent `.local/contract-17b-credential-vault.md`).

Not in this slice: vault adapter/port behavior, the 17a Luogu reader, UI, schema, scheduler,
persistence, package metadata, Git, budget or harness changes. No real credential was read, written
or inspected; every value in the tests is synthetic.

## Changed files

Edited:

- `src/adapters/windows/credential-bridge.ts` — the two fixes below, plus corrected lifecycle and
  stdout-bound documentation.
- `src/adapters/windows/index.ts` — dropped the export of the removed kill-grace constant.
- `tests/vault/fixtures.ts` — the fake child can now refuse or throw on `kill`
  (`killOutcome: 'delivered' | 'refused' | 'throw'`), keeps the exact stdin buffers it was handed
  (`rawChunks`) and can deliver a caller-owned stdout buffer (`sendStdoutBuffer`).
- `tests/vault/credential-bridge.test.ts` — 19 portable tests: the affected ones were rewritten and
  three new process/output regressions were added (see below).

New:

- `docs/reports/stage-17b-credential-vault.md` — this report.

Untouched: `src/adapters/windows/credential-vault.ts`, `src/application/local-credential-vault.ts`,
`tests/vault/credential-vault.test.ts`, `tests/vault/credential-vault-windows.test.ts`, and all 17a
reader/UI/schema/scheduler/package/Git/budget/harness files.

## Fix 1 — termination is confirmed by `close`, not by elapsed time

- `DEFAULT_BRIDGE_KILL_GRACE_MS` and the `killGraceMs` option are gone. There is no timer whose
  expiry can complete, or appear to complete, an invocation.
- `terminate()` requests `SIGKILL` at most once. A `false` return or a throw is recorded as an
  unconfirmed termination (`childFailed`) and nothing else: it is explicitly not treated as proof
  that no process exists.
- An `error` event before the asynchronous `spawn` event no longer settles the call either; the
  bridge requests termination and still waits for `close`. Only a synchronous throw from `spawn`
  (the documented no-child case) resolves without a child.
- `close` is the only event that settles an invocation, so a cancellation or timeout rejects with
  the sanitized `cancelled`/timed-out error only once the process is confirmed gone. Cancellation
  still never claims rollback; the timeout only bounds how long the child may run.
- Timers stay bounded and are cleared in `finish()` once `close` arrives.

New/rewritten portable regressions: refused `kill` (returns `false`) and throwing `kill` both leave
the promise pending after the former grace duration elapses and reject with the sanitized
timeout/cancellation error only after `close`; an error before `spawn` leaves the call pending until
`close`; a child that ignores the kill stays pending until it closes.

## Fix 2 — the stdout cap is enforced before retention

- The stdout handler compares the incoming chunk against the remaining allowance **before** keeping
  anything. The chunk that would cross `MAX_BRIDGE_STDOUT_BYTES` is discarded and wiped, and every
  later chunk is wiped as it arrives; nothing after an overflow is retained or counted, so a child
  that ignores termination cannot grow the buffer. stderr counting also stops after an overflow.
- Errors still carry no stdout/stderr content: the child's bytes are never parsed into an error and
  never surfaced.
- Cleanup (payload buffer, retained chunks, timers, cancellation listener) still happens only in
  `finish()`, i.e. only after `close`. The new regression delivers three post-overflow chunks while
  close is delayed, proves each was wiped, proves the promise stays pending, and proves the timeout
  timer is cleared only once `close` arrived.
- Per-request payload bytes are still zeroed after use; the write test now asserts it directly
  through the fake child's reference to the exact stdin buffer.

## Commands actually run (worker, Windows, workspace-write sandbox)

```
node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none "tests/vault/credential-bridge.test.ts" "tests/vault/credential-vault.test.ts"
  → tests 32, pass 32, fail 0, cancelled 0, skipped 0, todo 0 (duration 134.68 ms)
    (19 in credential-bridge.test.ts, 13 in credential-vault.test.ts)

npm run typecheck    → exit 0
npm run check:architecture → "Architecture imports satisfy the declared layer boundaries." exit 0
```

No whole-project suite, build or Windows-only test was run in this repair, per contract. No worker
sandbox skip was observed (skipped 0). The Windows-only native test was deliberately not executed
by the worker, so no EPERM/limitation result is reported from the worker side.

## Native Windows integration evidence (coordinator, not the worker)

The coordinator independently ran the real Node → PowerShell → Windows Credential Manager path on
this Windows host: `tests/vault/credential-vault-windows.test.ts` passed 1, failed 0, skipped 0 in
3.18 seconds, with output in `.local/17b-windows-coordinator.log` (coordinator-owned; not generated
by the worker). That evidence is attributed to the coordinator and remains the acceptance basis for
the native path; the coordinator will rerun it after these bridge changes.

## Open issues

- The worker sandbox cannot host the native credential roundtrip; acceptance of the bridge against
  the real Credential Manager depends on the coordinator's rerun.
- The bridge still waits for `close` indefinitely if an OS-level child object never reports `close`
  after a kill. This is intentional per the contract (only `close` proves the process is gone) and
  the timeout timer remains armed; no fallback such as `taskkill` was added.

## Sprint 17f — CI portability of the real-directory vault test (this invocation)

Contract: `.local/contract-17f.md`. CI run
[34768766956](https://github.com/UnivmemorN/dsh-icpc-workbench/actions/runs/34768766956), commit
`404ad5f`: Windows Node 22/24 passed, Ubuntu Node 22/24 failed exactly one portable test —
`tests/vault/credential-vault.test.ts` "the vault writes no file …", with
`LocalCredentialVaultError invalid_input 'the credential vault data directory must be an absolute
Windows path'`. The test forced `platform: 'win32'` while passing a real POSIX temporary directory,
so the test — not the production validation — was wrong. No production file, path rule or error code
changed; the Windows path validation is untouched and no plaintext fallback was added.

Changed (tests/docs only):

- `tests/vault/credential-vault.test.ts` — the single unconditional real-directory test is split at
  the platform seam into two branches, and the file header records the seam:
  - native Windows (`skip` when `process.platform !== 'win32'`): the successful
    write/read/remove through the injected bridge against a real Windows temporary directory, with
    the directory still empty afterwards. If a Windows host's temporary directory were not
    drive-absolute (UNC-rooted), the branch fails with an explicit message instead of skipping, so
    the coverage gap can never be silent;
  - non-Windows (skipped on Windows, so it runs on the Ubuntu CI job): the vault reports
    `implemented: false`, `write`/`read`/`remove` all reject with `unsupported`, the injected bridge
    records zero calls, and the real temporary directory stays empty.
  The unused `resolve` import was removed.
- `docs/reports/stage-17-acceptance.md` — one CI note; the Linux result is claimed only as the
  contract's intent, to be confirmed by the coordinator's CI run (no Linux execution was performed
  here).

### Commands actually run (worker, Windows, workspace-write sandbox)

```
node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none "tests/vault/credential-vault.test.ts" "tests/vault/credential-vault-windows.test.ts"
  → tests 15, pass 13, fail 0, cancelled 0, skipped 2, todo 0 (duration 120.25 ms)

npm run typecheck    → exit 0
```

The two skips are explicit and reported, not silent: the Windows-native branch of the split test
runs and passes here; the non-Windows branch correctly skips on Windows with its reason; the real
Credential Manager roundtrip in `credential-vault-windows.test.ts` skipped as documented above
(worker sandbox denies a child process with piped stdio, `spawn EPERM`). The Windows branch of the
portable test executed against a real temporary directory, so the no-file-fallback behavior is
verified on this host without weakening any path validation.

### Open issue for the coordinator

- The non-Windows branch was **not** executed locally (this host is Windows). Its correctness on
  Ubuntu Node 22/24 must be confirmed by the coordinator's CI run; CI must be the basis for any
  statement that Linux passes.
