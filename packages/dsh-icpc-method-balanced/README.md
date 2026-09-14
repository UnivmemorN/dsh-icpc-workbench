# dsh-icpc-method-balanced

Installable companion method for `dsh-icpc-workbench`: the approved **dual-axis** training method.

Thinking (modelling, reasoning, proofs) and templates (algorithm knowledge, patterns, implementation)
support each other. The method diagnoses the prerequisite bottleneck, focuses training on it until it
supports the other axis, and keeps reinforcing both. When the available evidence is insufficient it
answers `diagnostic` / unknown instead of inventing a split from AC counts.

## What it contributes

- One method: `balanced-dual-axis`, version `1.0.0`, registered through the host's public
  `icpcGuidance` Cordis service (seam `icpc-guidance-v1`).
- Plan guidance (training steps plus instructional sections) and assessment guidance, so it is
  selectable for planning and for self-assessment.
- Frozen, self-owned text. Nothing is downloaded, executed or refreshed at runtime; the source links
  are inert citations, not fetch targets.

## Install and uninstall

Pack this folder with `npm pack`, then install the resulting archive into the same dsh profile as the workbench:

```powershell
dsh plugin --profile web add ./dsh-icpc-method-balanced-0.1.0.tgz
```

Use `dsh plugin --profile web remove dsh-icpc-method-balanced` to uninstall. The package waits for the workbench's `icpcGuidance` service through Cordis injection.

Uninstalling the package removes exactly this method. Training plans and history keep their captured
snapshot (method id, version, hash and text), so a removed method stays readable but is never
silently substituted.

## Sources and licensing

- The dual-axis stance is this project's approved user requirement and is attributed in the method
  text. No public URL exists for it, so no link is fabricated.
- Practice-related concepts are an original short paraphrase of the USACO Guide "Practicing" page
  (<https://usaco.guide/general/practicing>); the OI Wiki contest page is cited as a resource pointer
  only (<https://oi-wiki.org/contest/>). No article text is copied, and the referenced works remain
  under their own terms.
- This package's own code, text and packaging: MIT, see `LICENSE`.
