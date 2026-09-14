# Stage 19 acceptance — Luogu two-cookie connection

Release: 0.1.14. Database schema: 8 (unchanged). Tested host baseline: dsh 0.1.5-rc.2.

## User-visible change

The connection form defaults to the __client_id value from F12 → Application → Cookies. The selected account supplies the readonly _uid. Optional full-Cookie input and legacy credentials are normalized to `__client_id=…; _uid=…` before storage or dispatch. Missing, ambiguous, foreign-account or unsafe values are refused without echoing secrets. Unrelated cookies no longer consume the credential store's capacity.

Sync failures record whether the authenticated history read or anonymous problem-data completion failed. Old records remain readable without guessing a stage. A successful later login probe is shown separately and does not erase the failed sync or its backlog. Credentials are still limited to the existing official record endpoint.

## Verification

- `npm run check`: passed typecheck, architecture, 1,088 main tests (1,087 passed; one environment-conditional skip), 10 worker/usage tests, package/client builds and client lifecycle checks.
- Regression coverage: two-cookie header and full input, normalized stored legacy credentials, oversized unrelated cookies, UID binding, repeated required fields, raw control characters, exact authorized destinations, failure stages, old/new persistence roundtrips, preserved history/backlog, and later successful probes.
- Core implementation used DeepSeek Harness with DSV4.1 Flash, max. Coordinator reviewed the changes and ran the complete gate. The two bounded worker runs reached their request cap after implementation and focused checks; completeness is established by reviewed code and passing checks.
- Installed into the existing local acceptance profile; immediate pre-install SQLite backup was verified. All table hashes and settings matched after restart; schema 8 and Flash model selections were preserved. All 681 installed dist files matched the verified build.
- Native luogu.probe succeeded with an existing stored legacy session after the installed reader normalized it to the two-cookie header. The connection check advanced, while the old sync failure, history coverage and metadata backlog stayed intact. No raw credential was read or printed by the acceptance script.
- Browser acceptance: default password field, readonly UID, Application/Cookies guidance, optional full-Cookie mode, cleared drafts on mode switches, disabled empty/foreign-UID submission, and later successful login check beside the preserved legacy sync error. Synthetic inputs were cleared without submitting them.

## Boundaries and attribution

A successful login probe verifies one authenticated record read at that time. It does not establish metadata availability or future platform access. Metadata still uses the existing anonymous adapter, and platform verification is not bypassed. No model is used for login or Cookie handling.

No schema migration or database rewriting is needed. No Harness source change. MIT attribution to ZF3373/icpc-workbench remains in THIRD_PARTY_NOTICES.md and licenses/. This repair is independently implemented from the user requirement and this repository's existing connection design. No runtime secrets, private records or model transcripts are published.
