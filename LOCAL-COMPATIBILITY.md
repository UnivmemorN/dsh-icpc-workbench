# Local compatibility patches

This repository consumes third-party plugins that were published against an earlier `dsh` baseline.
When such a package needs a local fix, the fix is produced by a small reproducible script that
patches an **unpacked package directory**; the edited sources are never hand-modified in place.

Local compatibility patches are not upstream releases. They never change credentials, account data,
network destinations, model calls or security policy, and they are never installed by a script — the
coordinator packs and installs the patched package into a profile explicitly.

## @lemcae/dsh-balance — 0.1.7-icpc-compat.2

Generator: `scripts/patch-balance-client.mjs <package-directory>`
Package-local note: `LOCAL-COMPATIBILITY.md` inside the unpacked package (shipped via its `files`
list).

### Root cause
The current ICPC client runtime types the business command call as
`commands.execute(agentId, line, submittedAttachments, signal?)` — the attachments argument is
required. The published client (`0.1.7` and the previous local `0.1.7-icpc-compat.1`) called it with
two arguments, so every balance RPC was rejected before dispatch; the old helper also collapsed every
failure into `null` forever, which left the Settings card and the header chip stuck on "loading".

### What the patch changes
1. Every `commands.execute` call passes the required empty `[]` attachments list. The plugin attaches
   no files, so the list is always empty.
2. A missing or empty session id returns a fixed `{ ok: false, error: 'no-session' }` payload and does
   not reach the transport at all.
3. Transport errors, missing/failed envelopes and invalid JSON resolve to fixed local codes
   (`request`, `envelope`, `payload`) instead of `null`. Arbitrary thrown text and arbitrary remote
   text are never copied into those payloads.
4. The parsed payload must be a record with a boolean `ok`; successful payloads pass through
   unchanged, so the existing success rendering is untouched.
5. The failure codes are rendered through the existing localization mechanism. Unknown codes fall back
   to fixed localized copy, so no arbitrary host text can reach the DOM.
6. A failed result in the Settings card renders a manual retry button (the header chip keeps its
   existing click-to-refresh), so a failed lookup can never be stranded.
7. `package.version` becomes `0.1.7-icpc-compat.2`.
8. The stale `//# sourceMappingURL=client.js.map` comment is removed from the edited `lib/client.js`
   so the kept `.map` file cannot pretend to describe edited code. The `.map` files are not deleted.

No model request, session creation, timer rewrite, host-side change, credential access or network
access is involved. `author`, `license`, `repository` and every other manifest field are preserved
(the script only rewrites the version string and refuses if any checked field would change).

### Generated files
| File | Change |
| --- | --- |
| `src/client/index.ts` | error table + helper, guarded `runCommand`, three-argument `execute`, retry button |
| `lib/client.js` | the same changes in the shipped classic-script bundle, minus the sourcemap comment |
| `package.json` | `version` only |
| `lib/client.js.map` | untouched |

### Safety model
* Validates the package name (`@lemcae/dsh-balance`), the incoming version (`0.1.7` or
  `0.1.7-icpc-compat.1`; `0.1.7-icpc-compat.2` is an idempotent no-op) and every source anchor before
  anything is written. Anchors are matched on trimmed line content, so build indentation differences
  do not matter while content divergence is still refused.
* All three outputs are prepared in memory, then written as sibling temp files and renamed. A refusal
  (wrong package, unknown version, missing file, diverged source, inconsistent patch state) exits `1`
  and leaves every file untouched.
* Running it twice reports `already patched; nothing to do` and writes nothing.
* If a package is fully patched but the manifest still carries an older accepted version, the script
  completes the interrupted run as `version-only` (version bump only, client files untouched).

### Usage and verification
```powershell
# patch an unpacked package directory (idempotent)
node scripts/patch-balance-client.mjs <package-directory>

# focused tests (synthetic fixtures + a copy of .local/dsh-balance-compat when present)
node --test --experimental-test-isolation=none scripts/patch-balance-client.test.mjs
```
The tests cover argument forwarding (three arguments, empty `[]` list), the no-session guard, every
failure class, absence of echoed text, both source variants, idempotence, refusals without partial
writes, the rendered localized retry button and the header-chip failure tooltip. See
`docs/reports/stage-26-balance-visibility.md` for the recorded run results.

### Limitations
* The anchors are tied to the `0.1.7` / `0.1.7-icpc-compat.1` client text. A future upstream release
  with different lines is refused, not silently half-patched; the anchors then need review.
* The kept `lib/client.js.map` still contains the pre-patch sources. Only the automatic
  `sourceMappingURL` association is removed.
* The script never installs into a profile and never packs an archive; those steps stay with the
  coordinator.

### Attribution
Original package author: **LemCAE**, MIT license —
<https://github.com/LemCAE/dsh-balance>. This local compatibility patch retains the original license
and attribution; publication notices are handled by the coordinator.
