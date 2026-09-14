# Unified Flash policy (0.1.7)

> **开发参考** · [开发文档索引](development/README.md) · 日常操作请看[用户手册](user/README.md)。本文保留既有地址，供实现与排错核对。


Every installed workbench model operation uses DeepSeek V4.1 Flash: dsh provider deepseek-official, model deepseek-flash, effort max. The installed host catalog identifies this model as DeepSeek-V41-Flash. This includes editorial tag analysis, independent verification, no-editorial reasoning, hints/explanations and AI training plans. Flash failure does not trigger Pro or another model.

On activation, legacy settings are read through the existing structural validator and a new CAS revision replaces only provider/model selections. Quotas, timeouts, platform limits and earlier audit/results remain intact. Existing preparations capture settings revisions and may require preparing again after upgrade. Repeated activation with the current policy does not create another revision. New settings that select another provider/model are refused; the UI displays model roles as read-only.

The installed audited client also rejects an out-of-policy provider, model or effort before creating a session, looking up capabilities or opening a provider stream, with known-zero usage. Thus a stale/internal request cannot dispatch Pro. The reusable low-level client's optional policy flag is enabled by the product's composition; historical settings and generic adapter test fixtures remain readable without rewriting their model identity.

No-editorial reasoning remains a distinct budget/workflow role, but uses Flash too and its drafts require review. Authentication, rate-limit and network errors still do not prove editorial absence. A user can instead paste a supplied answer in the problem detail; see [user-provided answers](user-provided-answers.md).
