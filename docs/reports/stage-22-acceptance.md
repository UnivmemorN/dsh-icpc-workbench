# Stage 22 acceptance — Luogu backlog and account names

Release: 0.1.17. Luogu account synchronization directly reads platform data and invokes no AI model. Paid tag analysis, hints and training planning remain separate operations.

## Resulting behavior

- Ordinary synchronization repairs up to 100 metadata items per pass, increased from 10. The explicit metadata-only action processes every key in its starting queue once, bounded by the existing 2,000-key capacity. It reads no submission history and leaves history coverage and checkpoints unchanged.
- Requests remain serialized with at least two seconds between them. Progress is committed per item. Pausing preserves completed work; loss of the source lease stops further requests.
- A U/T-prefixed problem that refuses anonymous access remains queued while other problems continue. The refusal remains visible and survives cancellation. A public problem access failure, rate limit or unexpected response still stops the run. This does not add authenticated private-problem retrieval.
- Luogu nickname lookup reads only the requested profile's UID and name from the official public profile endpoint. New bindings try it automatically; old UID-only bindings try when selected on the account page; manual refresh is available. A failed lookup preserves the binding and previous nickname. Stable UID identity and all associated records are retained.
- The selector, account list and synchronization summary show nickname and UID separately. Automatic and manual nickname reads cannot overlap through the refresh control; stale or cancelled results cannot switch the selected account.

## Verification

- Final full gate: npm run check passed — 1174 application tests, 1173 passed, 1 skipped; 10 worker/accounting checks passed. Type checking, architecture checks, package build and browser-factory disposal checks passed.
- Focused checks included the 100-item ordinary limit, larger metadata-only queues, per-item progress, cancellation, source lease expiry/takeover, private-key deferral, global failure priority, anonymous nickname parsing, wrong-UID refusal, safe errors and repeated account creation.
- Fresh offline backups were verified before both local installations. Every table and setting matched the pre-install baseline before intentional live nickname/sync actions. Schema remains 8 and all configured AI roles remain Flash.
- Final installed runtime: 697 distribution files matched the local build byte for byte; client SHA-256 c9ecf19198c1f8dea89c2fe0691631a4226627c1108fd6731b1ec53000e0ea36. Host 0.1.5-rc.2.
- Live public-profile read resolved a distinct nickname. UID/source/profile identity was unchanged; protected tables and synchronization status were unchanged. Browser checks confirmed separate nickname/UID display, manual refresh success, no-AI copy and the metadata-only control.
- Initial live queue verification exposed a private-problem refusal that stopped all progress. The final implementation defers such items. The resumed live task decreased the backlog while preserving submission/history counters; running at the recorded check: true. Full backlog completion is not claimed.
- GitHub verification runs Windows/Ubuntu × Node 22/24 in the repository [verify workflow](https://github.com/UnivmemorN/dsh-icpc-workbench/actions/workflows/ci.yml).

## Sources and ownership

Public interface facts were checked on 2026-09-14: [Luogu profile](https://www.luogu.com.cn/user/1), [personal/private problem guide](https://help.luogu.com.cn/manual/luogu/problem/). The profile's data.user is used, never the separate viewer object. No profile body or third-party code was copied.

DeepSeek Harness DSV4.1 Flash / max implemented the bounded source tasks. The coordinator defined contracts, reviewed and completed boundary fixes, ran acceptance, and handled release. See [backlog report](stage-22a-luogu-backlog.md), [nickname report](stage-22b-luogu-nickname.md), [private-metadata report](stage-22c-private-metadata.md), [sync guide](../luogu-sync.md), and [account-name guide](../luogu-account-names.md). Existing project attribution and licenses remain in THIRD_PARTY_NOTICES.md.

This public report contains aggregate verification and interface facts. Real account identities, problem history, balances, credentials, database backups and runtime/model logs remain local.
