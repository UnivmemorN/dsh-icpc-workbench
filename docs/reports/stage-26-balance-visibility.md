# Stage 26 — balance client compatibility (report)

Contract: `local/contract-26-balance.md`. Scope: a reproducible local compatibility patch for the
unpacked `@lemcae/dsh-balance` package, focused tests, and documentation. No profile installation,
no harness change, no credential access, no Git operations.

## Root cause

The generated ICPC client runtime requires the attachments argument:
`commands.execute(agentId, line, submittedAttachments, signal?)`. The shipped balance client called it
with two arguments, so every balance command was rejected before dispatch; its helper additionally
collapsed every failure into `null` forever, so the Settings card and the header chip stayed on the
loading state. The global Settings → DeepSeek 余额 page is reachable over ICPC, so no new UI surface
and no ICPC core change is needed.

## Changed files

| File | Change |
| --- | --- |
| `scripts/patch-balance-client.mjs` | new: idempotent, validating patch generator for both client variants |
| `scripts/patch-balance-client.test.mjs` | new: 8 focused tests (mechanics, refusals, runtime, rendered UI) |
| `LOCAL-COMPATIBILITY.md` | new: repo-level description of the local compatibility patch |
| `docs/dsh-balance-setup.md` | new: per-profile installation and the surfaces that work over ICPC |
| `docs/reports/stage-26-balance-visibility.md` | new: this report |
| `.local/dsh-balance-compat/LOCAL-COMPATIBILITY.md` | note describing compat.2 (git-ignored scratch package; ships in the archive `files` list) |

The unpacked package itself (`.local/dsh-balance-compat`) is **left at
`0.1.7-icpc-compat.1`** so the coordinator can run the script and pack the patched artifact.

## What the patch changes

1. `commands.execute(sid, line, [])` in `src/client/index.ts` and `lib/client.js`.
2. Empty/missing session → fixed `{ ok: false, error: 'no-session' }`, no transport call.
3. Transport/envelope/invalid-JSON failures → fixed `request` / `envelope` / `payload` codes instead
   of `null`; arbitrary thrown or remote text is never copied into the payload.
4. Parsed payload must be a record with a boolean `ok`; success payloads are unchanged.
5. Failure codes are rendered through the existing localization table; unknown codes fall back to
   fixed copy, so arbitrary host text never reaches the DOM.
6. Failed Settings card result renders a manual retry button; the header chip keeps click-to-refresh
   and now reports the failure instead of a permanent "查询中…" tooltip.
7. `package.version` → `0.1.7-icpc-compat.2`; `author`/`license`/`repository` and all other manifest
   fields preserved.
8. `//# sourceMappingURL=client.js.map` removed from the edited `lib/client.js`; the `.map` files are
   kept (they still contain the pre-patch sources, so the comment was the misleading part).

No model request, session creation, timer rewrite, credential access, network access or host-side
change is involved.

## Commands actually run

```powershell
# focused suite (8 tests)
node --test --experimental-test-isolation=none scripts/patch-balance-client.test.mjs
# -> tests 8, pass 8, fail 0, skipped 0 (242.99 ms)
#    covers: mechanics/version/preservation, upstream 0.1.7, idempotence + version-only resume,
#    refusals without partial writes (name/version/missing file/diverged anchor/mixed state),
#    runCommand argument forwarding + all failure classes, rendered retry button and chip tooltip,
#    and the real .local/dsh-balance-compat copy test (not skipped in this checkout)

# CLI end-to-end on a copy of the real package
Copy-Item -Recurse .local\dsh-balance-compat <tmp>\pkg
node scripts/patch-balance-client.mjs <tmp>\pkg      # exit 0, "patched: src/client/index.ts, lib/client.js, package.json"
node scripts/patch-balance-client.mjs <tmp>\pkg      # exit 0, "already patched; nothing to do"
node scripts/patch-balance-client.mjs <tmp>\missing  # exit 1, "refused: not a package directory"
# -> package.version = 0.1.7-icpc-compat.2, sourceMappingURL removed, lib/client.js.map kept

# patched TypeScript source parses cleanly (syntax only; the dsh peer types are not installed here)
node -e "ts.transpileModule(<patched src/client/index.ts>, {reportDiagnostics:true, ...})"
# -> syntactic diagnostics: 0

# the shared fixture stayed pristine
(Get-Content .local\dsh-balance-compat\package.json -Raw | ConvertFrom-Json).version
# -> 0.1.7-icpc-compat.1
```

Not run in this stage: `npm run check` (the new test file is not in its explicit file list),
a full `tsc` typecheck of the patched package (the `@deepseek-ai/*` peers are not installed in this
checkout), and any browser/profile acceptance — installation belongs to the coordinator.

## Open issues and limitations

* The anchors are tied to the `0.1.7` / `0.1.7-icpc-compat.1` text. A different upstream text is
  refused with exit code 1 rather than half-patched; the anchors then need review.
* The kept `lib/client.js.map` still contains the pre-patch sources; only the automatic
  `sourceMappingURL` association was removed.
* The patched bundle was exercised through a React/render harness with a fake remote (argument
  forwarding, failure payloads, retry button, chip tooltip). A live browser check of the installed
  profile remains for the coordinator's acceptance run.
* `npm run check` lists test files explicitly; wiring `scripts/patch-balance-client.test.mjs` into
  that gate is a coordinator decision.
* The git-ignored `.local/dsh-balance-compat` package-local `LOCAL-COMPATIBILITY.md` was updated for
  the shipped archive; the tracked description lives in the repo-root `LOCAL-COMPATIBILITY.md`.

## Attribution

Original package author **LemCAE**, MIT license — <https://github.com/LemCAE/dsh-balance>. Publication
notices are handled by the coordinator.

## Coordinator acceptance

The client patch was applied and packed as `0.1.7-icpc-compat.2`, then installed into the active ICPC profile and the existing web profile. Installed client bytes match the patched source artifact. The existing ICPC core remains 0.1.20; every business table and every workbench setting was preserved, and all model roles remain official Flash. A fresh offline database backup was verified before restart.

Live browser acceptance passed: the conversation header shows an official balance; the lower-left global Settings dialog contains DeepSeek 余额 and opens over the ICPC panel; the detailed card shows availability, currency, balance and update time; manual refresh returns a balance and subsequent updates advance the timestamp. Balance data remain local and are not included in this report. The balance query itself does not call a model.

Additional coordinator checks cover a corrupted already-patched file, and bounded retry of transient Windows replacement locks without deleting the destination. Other filesystem errors still fail immediately; a persistent lock is never silently ignored. The final `npm run check` passed: 1,304 native tests with one environment skip, all 20 script tests (including 10 balance-patch tests), typecheck, architecture, build and client verification. Public CI omits only the optional real local-package fixture; synthetic behavior tests remain mandatory. The new patch tests are included in the normal check command.

The profile mismatch and missing third RPC argument were separate causes. No new ICPC header widget is advertised: the independent balance plugin provides the global Settings window and the conversation-only header chip.
