# Stage 20 acceptance — Accounts & Sync page

Release: 0.1.15. Host baseline: dsh 0.1.5-rc.2. Database schema: 8 (unchanged).

## Behavior

- Dedicated 账号与同步 navigation owns account creation, platform synchronization and JSON/CSV imports. The header retains account selection and a management shortcut. The problem bank has one short import/sync link.
- Account creation, credential entry, full instructions, synchronization details, automation settings and recovery controls open on demand. Current connection/history/backlog/automation and the existence of a failure remain visible in the compact Luogu section.
- Credential inputs are password fields. Closing the form or its parent section, changing account/mode, submission or page navigation clears the draft. Existing two-cookie validation, local vault storage and typed API operations are preserved.
- Automation inputs can be edited before the form is dirty; save remains disabled until changed. Disabled automation does not promise scheduled retries in the compact failure summary. Merely revealing sections changes no saved settings.
- Sources follow selected platform accounts; submissions are gated to the account's own source. Anonymous users can choose a public catalog/manual import source. Source changes clear stale import previews.

## Verification

`npm run check` passed: typecheck, architecture, 1,094 main tests (1,093 passed, one environment-conditional skip), 10 worker/usage tests, package/client builds and client lifecycle checks. New behavior tests cover compact truthful status, settings editability and inactive automation. Existing account, session, sync, import and persistence regressions remain in the gate.

Runtime acceptance: installed into the existing local profile after a verified immediate pre-install SQLite backup. All table hashes and settings matched after restart; all 685 installed dist files matched the checked build. Schema and Flash selections were preserved. Companion plugins were retained.

Browser acceptance: default collapsed forms and clean bank navigation, add-account validation, masked Cookie input, clear/unmount after close, parent collapse, navigation and account switch; editable automation toggles with dirty-only save; CF submissions option available only in its proper source context; JSON/CSV text reveal/collapse. Draft changes were reverted and synthetic text cleared. No test account, credential connection, platform sync or saved setting was submitted. The normal browser layout was visually inspected and left on the compact account page.

Coordinator corrections: parent disclosure close clears credentials; compact errors do not claim paused automation/scheduled retries when automation is disabled; selected-account sources use a short label instead of a redundant selector.

Core implementation used DeepSeek Harness with DSV4.1 Flash, max. Coordinator reviewed the changes and owns runtime/browser acceptance recorded with this release. No backend, schema, host-source or model-policy change. See the Stage 20a/20b reports for focused worker checks.

MIT attribution to ZF3373/icpc-workbench and other existing sources remains in THIRD_PARTY_NOTICES.md and licenses/. No private account records, credentials, local runtime files or model transcripts are published.
