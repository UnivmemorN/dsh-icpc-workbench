# Stage 21 acceptance — Luogu raw tag names

Release: 0.1.16. Scope: readable names for platform raw tag identifiers in existing local records, with the original identifiers retained as provenance.

## Evidence and boundaries

The coordinator retrieved the public [Luogu tag dictionary](https://www.luogu.com.cn/_lfe/tags) on 2026-09-14 (HTTP 200, 505 entries) and compared every bundled ID/name pair with that response: exact match. For example, `luogu-tag:3` names `动态规划 DP`, `luogu-tag:7` names `贪心`, and `luogu-tag:53` names `树状数组`. Region, year and contest tags retain their platform meaning.

The dictionary supplies presentation labels only. Stored raw tags, snapshots, analysis hashes, taxonomy mappings, statistics and accepted decisions are not rewritten. No runtime dictionary request, reimport or model call is needed to display an existing record. Unknown future IDs remain explicitly unnamed until the bundled dictionary is updated. See [behavior and provenance](../luogu-tag-names.md).

DeepSeek Harness Flash / max implemented the UI changes and focused tests. The coordinator owns review, source-data comparison, the full verification gate, packaged upgrade and browser acceptance. Worker notes: [stage 21a](stage-21a-luogu-tag-names.md).

## Validation status

- Public dictionary comparison: passed, all 505 ID/name pairs.
- Focused raw-tag tests: 21/21 passed. Full `npm run check`: typecheck and architecture passed; 1,114 main tests passed, one existing conditional test skipped; 10 worker/accounting tests passed; independent ESM build and classic browser factory checks passed.
- Packaged local upgrade: passed on dsh 0.1.5-rc.2, plugin 0.1.16, schema 8. A fresh offline SQLite backup was verified before installation. Every business table and setting matched its pre-install baseline afterward; all configured AI roles remain Flash. All 693 installed distribution files match the reviewed build byte for byte.
- Browser acceptance: existing ID-only records display names without reimport; collapsed details retain exact raw IDs and linked dictionary/date; platform statistics show readable names, including 动态规划 DP and 贪心; source-mapping diagnostics retain IDs and their prior relation while adding names. Anonymous problem detail still hides tags until explicit reveal. The original selected account was restored.
- Training candidate rendering was reviewed with the shared label helper and existing spoiler gate; no paid plan generation or new account-history import was performed for this display change.
- Coordinator polish: put table provenance on a separate small-text line and shorten the platform-table explanation.
- Public CI: pending publication.

This report contains aggregate checks and public metadata only; local account records, database backups, credentials and runtime logs are excluded.
