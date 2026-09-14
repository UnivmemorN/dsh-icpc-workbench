# Completeness review and rerunnable analysis

> **开发参考** · [开发文档索引](development/README.md) · 日常操作请看[用户手册](user/README.md)。本文保留既有地址，供实现与排错核对。


This document describes the user-visible behaviour of the completeness check introduced in
Sprint 11b. The implementation report is `reports/stage-11b-completeness.md`.

## What the check is

A problem's tags are "checked" when a successful editorial analysis was followed by an
**independent verification pass that answered the omissions question** against the same frozen
snapshot and the same taxonomy version. The recorded proof is the optional `completeness` record
of an analysis result (`version`, `taxonomyVersion`, `snapshotId`, `snapshotVersion`,
`checkedAt`, `omissionsChecked`).

* Checked ≠ mathematically exhaustive. It means the two-pass workflow really ran at the current
  audit version.
* Results recorded before this contract (or produced by reasoning-only / failed / cancelled
  runs) carry **no** record. They stay readable and are shown as "no completeness record — not
  checked", never as "checked clean".

## The independent pass

The verification prompt (`verification-v2`) asks the model to read the editorial itself, to
judge every suggestion it was given, and to scan the whole material for methods the first pass
missed — independently of the platform raw tags. Its answer must contain `missingSuggestions`
(possibly `[]`). The strict parser refuses an answer without it; only an explicitly recorded
legacy prompt identity may be replayed, and such a replay is never treated as an omissions
answer.

Omissions discovered by the verifier are shown as suggestions from the verification pass. They
are **never** verified by the pass that produced them, so they always land in the manual-review
queue; a human accept/reject still wins. A missing suggestion that repeats a tag the analysis
already proposed, names an unknown taxonomy id, cites a foreign solution or repeats itself fails
the whole call.

An empty analysis still triggers the verification call, and that call counts against the batch's
analysis budget.

## Rerunning

* Default (仅补查未经完整性检查): a problem is skipped only when its stored success already
  carries the current check for the current snapshot and taxonomy. Legacy successes, cancelled
  runs and unchecked results get fresh work.
* 重新分析（保留旧结果）: always creates a new run identity. The old job, its analysis and its
  decisions are historical records and are never rewritten.
* A rerun's effective corrections are visible in the tag history: an old automatic adoption the
  new check no longer supports is recorded as a current `needs_review` decision
  (`stale_analysis`), so the tag stops counting. Manual accept/reject decisions are never
  overridden, and raw platform tags are never deleted.

## Missing material

A selected problem without a material snapshot is reported as blocked
(`material_missing` → action `refresh_materials`): no job and no model call is created for it,
the rest of the selection is prepared normally, and the UI links the user to the problem detail
to refresh or paste real material first.
