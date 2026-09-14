# Stage 25a3/25a4 — Manual recovery of one queued Luogu item

Status: implemented and verified (focused real tests + typecheck). Owner: worker (deepseek-flash).
Scope: plugin repo only. UI wiring is Sprint 25b work (not touched here).

## What was added

One authenticated operation that completes a problem **the platform will not serve** (an explicitly
incomplete personal statement, a deleted problem, ...) with material the **user** typed:

- `luogu.supplementMetadata` — `POST /api/icpc/v1/luogu.supplementMetadata`.
- It reuses the accepted manual-supplement merge/snapshot semantics (`ImportService`) and the
  accepted Luogu durable-lease discipline (`LuoguSyncService.runConnectionOp` + `claim`).
- It performs **no** HTTP request, **no** AI call and no source-gate wait: a disconnected account
  can still complete the items it already knows about. Only the durable source-wide lease is taken,
  so a live lease of this or any other account still refuses as `busy`.

Honest semantics: the result says `outcome: 'supplemented'` and the documentation states the
material is **user supplied local material**. This operation never claims a successful platform
fetch, never invents a rating or a raw platform tag, never creates an editorial `absent`
declaration and never marks a tag reviewed. No domain field or AI-audit field was invented.

## Exact API for Sprint 25b

Request (closed body — an undeclared field is refused, not dropped):

```jsonc
POST /api/icpc/v1/luogu.supplementMetadata
{
  "accountId": "luogu:www.luogu.com.cn|<uid>",  // canonical account of the configured Luogu instance
  "problemKey": "<sourceInstanceId>|<domain>|<externalKey>", // canonical key, must be queued for that account
  "title": "用户填写的题目名称",                  // non-blank, <= 500 chars; used ONLY when no row exists
  "statement": "用户粘贴或手写的完整题面",         // non-blank, <= MAX_SUPPLEMENT_STATEMENT_CHARS (200000)
  "expectedSnapshotId": null                     // the head the form saw; null only when it saw none
}
```

Success `200`:

```jsonc
{
  "accountId": "...",
  "problemKey": "...",
  "snapshot": { "problemKey": "...", "snapshotId": "...", "version": 1,
                "contentHash": "...", "capturedAt": "...", "changed": true },
  "status": { /* ApiLuoguStatusView: updated backlog / resolved counter / leaseActive / ... */ },
  "outcome": "supplemented"
}
```

Notes for the UI:

- The stored problem's title is **not** returned by this operation and is never overwritten; the form
  shows the stored title read-only (`problem.browse` / `luogu.metadataBacklog` already project it).
- `expectedSnapshotId` comes from `luogu.metadataBacklog` items (`expectedSnapshotId`), which is the
  same head the form must send back.
- Recommended flow: read the backlog page for the account, render the stored title (or an input when
  `title === null`), post the form, then re-read `luogu.metadataBacklog`/`luogu.status` from the
  returned `status`.

Failure codes (fixed Chinese sentences; the adapter/service message is never echoed):

- `400 invalid_input` — unknown field (including a smuggled `sessionCookie`), blank/oversized title
  or statement, non-canonical or foreign `problemKey`, malformed `expectedSnapshotId`, bad
  `accountId`.
- `400 invalid_input` — the key is canonical and of this instance but **not currently queued**
  ("problem … is not queued in the metadata backlog").
- `404 not_found` — account not stored.
- `409 conflict` — `busy` (a pass or another source operation holds the source slot), `lease_lost`,
  or **stale snapshot**. The stale-snapshot sentence tells the user to refresh/reopen the form
  (`该题目的已存快照已在别处更新，请刷新页面后重新打开补充表单再提交。`) and is deliberately distinct
  from the settings-CAS message.
- `409 conflict` — unsupported credential backend does **not** apply here: this operation needs no vault.

Atomicity contract (verified):

- Exactly one `store.transaction` commits the problem row, its immutable snapshot, the dequeue of
  exactly the selected key, the clearing of exactly that key's diagnostic and one
  `metadataResolved` increment. No nested transaction is opened (`beforeCommit` re-checks the lease
  with a clock read inside the transaction and mutates state through the ambient transaction).
- Created row identity for a missing problem: canonical `ref` from `parseProblemKey(problemKey)`,
  URL `f"{configured baseUrl}/problem/{externalKey}"`, supplied title, supplied statement,
  `fetchedAt = now`, `ratings: []`, `rawTags: []`.
- Existing row: stored title, url, ratings, raw tags, editorial sources/solutions, manual tag
  decisions and retrospective completions are preserved; statement is replaced; a new immutable
  snapshot version is appended (the previous body stays stored).
- CAS on `expectedSnapshotId` against the actual head happens **before** the first write; a claimed
  snapshot that does not exist (or `null` for an absent head, or a claim when no row exists) writes
  nothing and keeps the key queued.
- Cancellation, lease expiry, lease takeover and stale snapshot all roll everything back.
- A stored failure is cleared only when it explicitly names this key (metadata-stage, this key);
  unrelated/history/legacy failures survive, as do sibling queue order, diagnostics, checkpoint,
  submissions and counters.

## Changed files

- `src/application/import-types.ts` — `MAX_SUPPLEMENT_TITLE_CHARS`, `LocalProblemSeed`,
  `SupplementLocalProblemRequest`, `SupplementLocalProblemReport`.
- `src/application/import-service.ts` — shared private `commitSupplement` transaction used by the
  existing stored-only `supplementMaterial` (public endpoint unchanged and still stored-only) and by
  the new internal `supplementLocalProblem` (optional absent-problem seed + `beforeCommit` hook);
  validation `validateLocalSupplementRequest`; the stale-snapshot error now carries
  `details.reason = 'stale_snapshot'`.
- `src/application/luogu-sync-service.ts` — `supplementMetadata(request, token)` (prevalidation,
  queued-membership pre-check, `runConnectionOp` + `claim({purpose:'repair'})`, no gate/HTTP),
  private `commitSupplementedItem` (dequeue + issue clear + `metadataResolved + 1` + key-scoped
  failure clear, inside the import transaction) and `problemUrlOf`.
- `src/application/workbench-api.ts` — `LUOGU_API_OPERATIONS.supplementMetadata`, request/result DTOs
  and the `WorkbenchApiMap` entry.
- `src/plugin/luogu-api.ts` — strict no-IO validator, the route (200), the stale-snapshot
  translation, `MAX_LUOGU_SNAPSHOT_ID_CHARS`.
- `src/ui/api.ts` — browser transport entry for the new operation.
- `tests/sync/luogu-manual-recovery.test.ts` — new real-SQLite recovery suite (9 cases).
- `tests/plugin/luogu-api.test.ts` — route map count 11, 9 malformed-input cases (incl. secret-extra
  and body length) and one positive route case with a stale-head refusal. (Not one of the
  coordinator-owned files.)

## Commands actually run

```text
node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none \
  tests/sync/luogu-manual-recovery.test.ts tests/plugin/luogu-api.test.ts \
  tests/import/supplement.test.ts tests/sync/luogu-sync-service.test.ts
=> tests 99, pass 99, fail 0, cancelled 0, skipped 0 (duration 13054 ms)

npm run typecheck
=> tsc -p tsconfig.json, exit 0
```

Cases proven by the new suite: absent queued key creates the exact identity, empty ratings/tags, a
statement snapshot and dequeues only that key while preserving sibling order/resolved counter; an
existing row keeps title/url/platform tags/ratings/editorial/manual decisions/completions and keeps
the previous snapshot body; stale/`null`/premature head claims write nothing; cancellation, lease
expiry and lease takeover roll the problem, snapshot and dequeue back; unqueued and foreign keys and
a live foreign lease are refused; a disconnected account succeeds; the connection manager, source
gate, submissions source and metadata adapter all throw if touched (and no call is observed).

## Remaining gaps (honest)

- Sprint 25b UI is not implemented: no form, no readonly-title rendering, no refresh-after-conflict
  flow. The API above is the whole contract.
- The route exists only where the Luogu service is composed and registered (same as the other
  `luogu.*` operations); an older bundle without this operation answers an unknown-route/`invalid_operation`
  response, which the UI must surface as "update the plugin".
- No explicit statement-provenance column was added (per contract): provenance is "user supplied"
  only by construction of this path. If a later stage needs to distinguish statement origins in the
  schema, that is a separate migration.
- A recovered problem has no difficulty rating and no raw platform tag by design; tag review and
  analysis treat it as untagged, and the UI must not present it as platform metadata.
- The operation cannot correct a wrong stored title (by design) and cannot repair a problem that is
  no longer queued; both require the normal import/refresh paths.
