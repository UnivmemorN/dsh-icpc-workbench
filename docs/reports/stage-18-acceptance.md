# Stage 18 — 0.1.13 acceptance

Validated 2026-09-14 on Windows / Node 24 with dsh 0.1.5-rc.2 (fb2c4b9e698e30edb738bca4cf0618587db7d203). Plugin source, training database and Harness installation remain independently owned. Implementation and most tests were produced using dsh / deepseek-official/deepseek-flash at max effort; the coordinator reviewed integration, repaired demonstrated defects and performed delivery checks.

## Result

- Two separate installable method packages register through icpc-guidance-v1: balanced thinking/templates (default when installed), and optional deliberate practice. Captures retain text, version, hash and citations; uninstall/replacement invalidates unpaid preparations and preserves history.
- Guided AI plans carry a diagnosis, priority and readiness condition, plus each task's thinking/templates axis and objective. Unrevealed plans expose only generic axes; free-form objectives and diagnosis stay hidden until explicitly revealed. Old plans and rule plans remain readable.
- Virtual CF performance is entered with calculation method, source, date and independence/exposure information. Its versioned account ledger deduplicates contests and remains separate from official rating. Only identifier-free summaries reach AI plans/assessment.
- Independent AI assessment has free preparation, explicit paid start, cancellation, status polling and paginated history. It combines official-rating evidence, eligible virtual performance, historical/recent/earlier practice and knowledge evidence by native difficulty. Report ranges are AI inference and never overwrite official rating or self-assessment.

## Offline checks

Command: npm run check. TypeScript, architecture boundaries, package/client build and lifecycle checks passed. Application test suite: 1077 tests, 1076 pass, 0 fail, 1 conditional skip (non-Windows OS-vault case on a Windows host). The real Windows credential-vault roundtrip passed. Worker/context accounting suite: 10 pass, 0 fail.

Integration regression coverage includes the real Workbench capture, real SQLite transactions and actual route handlers, with only provider output simulated. Fixes proved by these tests: joined evidence reads inside reservation/settlement transactions; source revalidation within the reservation transaction; draining admitted calls during shutdown; discarding successful late answers after cancellation while retaining actual usage. API projections omit source snapshots and host audit identities.

## Installed runtime and data preservation

Core 0.1.13 / schema 8 and both companion 0.1.0 packages were packed and installed into the isolated ICPC profile. Every pre-existing table matched the verified immediate pre-migration v7 backup by row count and complete sorted-row hash, including records added during development after the earlier manual backup. That earlier backup was retained. Existing settings revision and platform/model limits were preserved; attempts to select Pro were refused.

All 677 installed dist files matched the freshly built source distribution by SHA-256. The runtime bootstrap reported the expected plugin, host and schema versions.

Actual CLI uninstall/reinstall acceptance: removing the optional method left only the balanced method in the runtime catalogue, refused an already prepared assessment before cost, and kept the settled report and captured citations unchanged. Reinstall restored both catalogue entries; the historical report and guidance snapshot were still identical. No model was called during this lifecycle check.

## Real model and browser acceptance

Only explicitly labelled synthetic local records were used for the two new live model calls; no real account history was sent. Both calls went through the installed authenticated workbench API and dsh's audited Flash max path.

| Flow | Observed result | Actual usage |
| --- | --- | --- |
| Guided plan | 6 real fixture candidates, both axes present, per-task objectives, diagnostic priority, persisted plan and method snapshots | 1 call; 5179 input / 11925 output tokens |
| Independent assessment | Persisted report, low confidence, diagnostic priority, synthetic 1400–2200 range with explanation of insufficient and synthetic evidence | 1 call; 4305 input / 4833 output tokens |

The synthetic range is a transport/validation check, not a claim about a real user's strength or prediction accuracy. Replaying the same request did not dispatch a second call.

Browser checks on localhost: methods load with balanced selected; free preparation and history open without AI calls; changing methods disables the old preparation's paid button; free cancellation immediately displays the terminal state; the saved report shows confidence, both axes, evidence citations and next-stage conditions; the plan reveals diagnosis and task objectives only after the explicit spoiler checkbox. Layout was inspected visually.

## Boundaries and sources

Automatic virtual-performance calculation is not implemented. Imported performance is not verified by CF; its method/source remain visible. Numeric AI inference is allowed only with official rating or explicitly independent, unexposed virtual evidence, and is not calibrated against an external population. Knowledge prompts retain at most 80 rows and explicitly disclose omitted counts. Live tests validate integration, not broad model quality.

The core and balanced method remain MIT. The optional deliberate-practice text adapts USACO Guide teaching ideas under CC BY-NC-SA 4.0, with separate source attribution, change notes and full license; its registration code is MIT. The original icpc-workbench attribution and license, NovaPhy architecture reference, OI Wiki and other source notices remain intact. See [third-party notices](../../THIRD_PARTY_NOTICES.md), [method packages](../guidance-plugins.md), and [AI assessment guide](../ai-ability-assessment.md).
