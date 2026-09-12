# Development contract

## Product
Build the approved ICPC personal-training plugin. Read docs/architecture.md and docs/handoffs/v1.md first.
The coordinator owns architecture, task contracts, Git commits/pushes, budget accounting, and acceptance.
The dsh worker implements ONLY its assigned task. Do not spawn agents, call other paid models, create goals/loops, change permissions, inspect credentials, or run git commit/push/reset/clean.
Do not edit AGENTS.md, scripts/worker.mjs, task contracts, or budget logs unless explicitly assigned.
Do not modify D:/DeepSeek Harness or D:/C++/NovaPhy. They are read-only references.
Use PowerShell, node and npm; never assume bash is installed.
No scripts may disable TLS verification or expose secrets.

## Architecture
domain has only domain types and pure rules.
application depends on domain and defines storage/platform/model ports.
adapters implement those ports; no application dependency on adapters.
ui uses the typed business API, never platform HTTP, SQL or provider credentials.
plugin composes everything using public Cordis extension points.
Stable snapshots, persisted job state, and per-task scratch have distinct ownership.
Raw platform tags, AI suggestions and manual decisions must remain distinguishable.
Never use empty catch, fabricated data, placeholder success, fake model results in production, or silently skipped behavior.

## Delivery workflow
Each nontrivial task has a Sprint Contract with scope, interfaces, acceptance checks, and explicit non-goals.
Implement one contract at a time. Update the task's report with changed files, commands actually run, and open issues.
A passing command and coherent diff are required; a prose claim of completion is insufficient.
Do not weaken tests or skip gates to make a task pass.
Tests should validate externally meaningful behavior, including cancellation, restoration, version checks, and failure paths.
Run focused checks first. Keep dependency installation and builds self-contained.
All exported APIs and non-obvious behavior need concise documentation.
Keep credentials, sessions, user data, downloaded statements/editorials, artifacts and logs out of Git.