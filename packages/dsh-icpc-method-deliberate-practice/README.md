# dsh-icpc-method-deliberate-practice

Optional companion method for `dsh-icpc-workbench`: a small, independent package that contributes one
deliberate-practice loop, usable for planning and for assessment.

The loop: choose a suitable difficulty, attempt first, take incremental help only when needed,
reimplement from scratch after understanding, then review. It is an original short paraphrase of the
USACO Guide "Practicing" points — no article text is copied.

## What it contributes

- One method: `deliberate-practice`, version `1.0.0`, registered through the host's public
  `icpcGuidance` Cordis service (seam `icpc-guidance-v1`).
- Plan guidance (five ordered training steps plus instructional sections) and assessment guidance.
- Frozen, self-owned text; source links are inert citations, not fetch targets.

## Install and uninstall

Pack this folder with `npm pack`, then install the resulting archive into the same dsh profile as the workbench:

```powershell
dsh plugin --profile web add ./dsh-icpc-method-deliberate-practice-0.1.0.tgz
```

Use `dsh plugin --profile web remove dsh-icpc-method-deliberate-practice` to uninstall. The package waits for the workbench's `icpcGuidance` service through Cordis injection.

It installs and uninstalls separately from `dsh-icpc-method-balanced`: the workbench stays usable with
no method installed at all, and a removed method is never silently substituted — earlier plans keep
their captured snapshot.

## Sources and licensing

- Original short paraphrase of the USACO Guide "Practicing" page
  (<https://usaco.guide/general/practicing>); the referenced work remains under its own terms.
- Registration code and packaging: MIT, see `LICENSE`. Adapted teaching text: CC BY-NC-SA 4.0, see `NOTICE.md` and `LICENSE.method-text`.
