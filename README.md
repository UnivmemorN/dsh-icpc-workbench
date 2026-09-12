# dsh ICPC Workbench

ICPC personal-training plugin for DeepSeek Harness. Development is in progress; no release is available yet.

Planned first release: Codeforces/Luogu/manual import, evidence-backed hierarchical tags, weakness analysis, training plans, and progressive hints in a dsh panel.

## Current implementation

The domain rules, SQLite storage and migrations, cancellable analysis batches, CF/Luogu/manual adapters, editorial imports, audited dsh model calls, strict tag verification, settings, progressive coaching, bank/manual review, distinct-problem weakness statistics and real-candidate training plans are implemented and tested. The host API, browser workbench, packaged installation, and paid tag benchmark are still being built. This checkout is not yet a finished installable workbench.

Platform access failures remain visible: anonymous Luogu editorial/history access can require login, and Codeforces HTML can return a challenge. Manual material import is supported; these failures never trigger the expensive missing-editorial fallback automatically. Hydro school-OJ integration remains future work.

Use Node 22.19+ on major 22, or Node 24+. Run `npm ci` and `npm run check`; the package builds independently of a harness source checkout. Live model accuracy is a separate release check, not implied by passing local tests.

## Development

The plugin has its own repository, dependencies, and data directory. DeepSeek Harness is an external host; never place this package inside its source tree.

Implementation uses dsh with `deepseek-flash` at `max` reasoning. The coordinator owns scope and acceptance. Read [the architecture](docs/architecture.md) and [the delivery contract](docs/handoffs/v1.md).

## Attribution

Inspired by [ZF3373/icpc-workbench](https://github.com/ZF3373/icpc-workbench), MIT, copyright 2026 ZF3373; reference commit `781e9f1981dba2822617e2cd13e92d6516f11b23`. Any reused implementation must be recorded in THIRD_PARTY_NOTICES.md and retain its license.

Architecture and development workflow are informed by [NovaPhy](https://github.com/UnivmemorN/NovaPhy): explicit data ownership, interchangeable implementations, and contract-based acceptance.

This is an independent community project, not an official DeepSeek product.