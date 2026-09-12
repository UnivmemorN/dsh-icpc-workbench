# dsh ICPC Workbench

ICPC personal-training plugin for DeepSeek Harness. Development is in progress; no release is available yet.

Planned first release: Codeforces/Luogu/manual import, evidence-backed hierarchical tags, weakness analysis, training plans, and progressive hints in a dsh panel.

## Development

The plugin has its own repository, dependencies, and data directory. DeepSeek Harness is an external host; never place this package inside its source tree.

Implementation uses dsh with `deepseek-flash` at `max` reasoning. The coordinator owns scope and acceptance. Read [the architecture](docs/architecture.md) and [the delivery contract](docs/handoffs/v1.md).

## Attribution

Inspired by [ZF3373/icpc-workbench](https://github.com/ZF3373/icpc-workbench), MIT, copyright 2026 ZF3373; reference commit `781e9f1981dba2822617e2cd13e92d6516f11b23`. Any reused implementation must be recorded in THIRD_PARTY_NOTICES.md and retain its license.

Architecture and development workflow are informed by [NovaPhy](https://github.com/UnivmemorN/NovaPhy): explicit data ownership, interchangeable implementations, and contract-based acceptance.

This is an independent community project, not an official DeepSeek product.