# Host composition acceptance

The Cordis entry checks dsh 0.1.5-rc.2/public services and data-directory separation before opening SQLite. It composes the actual adapters, import/workbench services, audited model client, coaching and owned pipelines; startup seeds only missing settings/source metadata and never starts a model or platform crawl.

Bootstrap, model catalog and local backup are implemented. Catalog membership is advisory, known negative text/max capabilities block starts, unknown metadata remains visible, queries have ten-second bounds. Disposal unregisters routes and keeps SQLite open until owned model settlement finishes.

Seven composition/catalog tests passed, including restart preservation, real backup restoration, incompatible-host refusal before data creation, partial cleanup, missing provider and ignored-abort timeouts. Full check: 525 behavior + 7 script tests, typecheck, architecture and independent build pass.

Actual local package inspection: 323 files, 2,741,676 unpacked bytes before the GET compatibility repair; no local inputs/databases/logs/credentials. Installed in the separate icpc-acceptance profile with source CLI at the pinned baseline. Real localhost:3081 bootstrap reports plugin0.1.0/host0.1.5-rc.2/schema3, independent dataDir, deepseek-official and no blocking model diagnostics. Unauthenticated API access returns401; normal launch-cookie authentication succeeds.

Integration exposed the baseline bridge attaching a body to every streaming route. GET now registers buffered, while POST retains bounded streaming. The focused transport/composition check passed34 tests and actual authenticated GET succeeded after reinstall. A new local tarball filename was needed because pnpm reused the same-path development archive. pnpm reports missing host peers in the profile manifest; dsh's own module fallback supplies them, confirmed by actual activation rather than installing a second host tree.

Browser UI and paid accuracy/coaching acceptance remain pending. Automatic approval review blocked the attempted paid benchmark before execution; no benchmark call was made. The configured/daily3080 profile and harness source remain unchanged.