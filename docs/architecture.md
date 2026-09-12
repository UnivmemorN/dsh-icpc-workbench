# Architecture

## Runtime
TypeScript ESM, React and node:sqlite. Deliver one installable Cordis bundle with host and client halves.
Support baseline: dsh 0.1.5-rc.2, source commit fb2c4b9e698e30edb738bca4cf0618587db7d203.

Dependency direction:
- domain: immutable problem snapshots, submissions, evidence, tag decisions and training plans; pure rules.
- application: use cases and PlatformAdapter / ModelGateway / TrainingStore interfaces.
- adapters: CF, Luogu, SQLite and dsh implementations.
- ui: workbench rendering through the versioned API.
- plugin: validates configuration, injects services and registers disposable effects.

An explicit pipeline gathers normalized material, freezes a versioned problem snapshot, analyzes it, verifies evidence, and transactionally adopts a result.
Job progress, quotas and cancellation are persisted separately. Changed input or manual decisions make old results stale.
Storage is independent of dsh internals. IDs include source instance, domain and external key; submissions additionally identify the account.
Do not infer mastery of every possible solution from an AC submission.

## Integration
Use dsh Connection Fetch registrations below /api/icpc/v1/ to retain authentication and origin checks.
Register sidebar.panellist and a keyed main panel; use layout.selectPanel for entry/exit.
Model requests go through ctx.llm and are reconstructed from dedicated Session logs.
Platform/model/store implementations expose capabilities. Hydro is planned, never advertised as implemented.
Use validated runtime configuration for model roles, budgets, data directory, timeouts and concurrency.

## Compatibility
Pin the tested host and SDK versions. Refuse unsupported versions/capabilities before activation.
Build the bundle without needing a sibling harness source checkout.
Use SQLite schema versions, backup before migrations, reject databases from newer versions.
Uninstall preserves user data. Test in an isolated profile before installing in the existing Web profile.

## Reference
NovaPhy supplies the ideas of explicit data ownership, immutable model inputs, caller-owned state and capability-bearing interchangeable backends.
Do not mechanically translate its physics-specific classes or C++ build layout.