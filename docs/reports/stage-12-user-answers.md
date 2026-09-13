# Stage 12 user-provided answers

The dsh Flash max worker implemented the additive API/provenance path, dedicated paste panel and model-input tests in two bounded invocations. Each reached its request limit before final review; the coordinator completed integration, corrected two test fixtures that submitted stale null snapshot IDs, verified source-link provenance with the actual stored note, fixed nested block markup, locked inputs during saving, and added a direct route to select the problem for review.

Delivered files cover the material.supplement answer DTO/validator/builder, source-note projection, UserAnswer component and helpers, analysis/verification/coaching material payloads, and focused API/model/UI tests. The separate coordinator model policy is documented in [Flash policy](../flash-only-policy.md).

Coordinator focused checks: 111 tests passed before the additional independent-verification regression; typecheck passed. Cases cover optional URLs, exact text, source separation, stable duplicate identity across changed timestamps, new snapshot and prior-source preservation, stale-head refusal, invalid input, spoiler-safe responses and bounded model payloads. These use fake model transports and real temporary SQLite stores, with no paid runtime calls.

Integrated final checks and installed/browser results are recorded in [Stage 12 acceptance](stage-12-acceptance.md). No private account data, pasted user material, downloaded editorial bodies or provider logs belong in the public repository.
