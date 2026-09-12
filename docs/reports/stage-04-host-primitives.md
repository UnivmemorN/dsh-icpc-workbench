# Stage 4h0 — host compatibility and HTTP transport

Accepted by the coordinator on 2026-09-12 after one repair round.

- Added `src/plugin/config.ts`, `compatibility.ts`, `api-transport.ts` and two plugin test files.
- Configuration accepts only an optional absolute data directory. Native OS defaults stay independent of dsh; nearest existing ancestors are resolved before use. Real child names such as `..training` cannot bypass installation/home separation. No directories are created by these checks.
- Filesystem probes treat only ENOENT/ENOTDIR as missing; unreadable paths cause typed refusal.
- The nearest launcher package must be `@deepseek-ai/dsh@0.1.5-rc.2`; a recognized source-root marker must have the same version and `private: true`. Required public services and Node 22.19+ / 24+ are checked before activation.
- Exact authenticated-carrier routes use `/api/icpc/v1/`, streaming request bodies, strict JSON input, an 8 MiB byte cap and a 30-second body deadline.
- Body accumulation copies into bounded storage. Cancellation observes abandoned promise rejection; hung cancellation is never awaited. Normal EOF releases the reader.
- API responses are versioned, no-store, status 200/202 or typed failure. Output must be plain JSON; non-finite numbers, undefined members, accessors, classes and cycles fail visibly rather than changing data.
- Unexpected validator/handler errors become sanitized 500 responses and reach the diagnostic observer. A failing observer emits one fixed warning without error contents.

Validation: worker full `npm run check` passed (477 behavior tests, 7 accounting/context tests, typecheck, architecture check, build). Coordinator separately reran all 55 plugin tests: passed, no skips.

The first implementation reached the request limit: 40 settled main calls plus one unsettled start event, conservatively reserved in the private ledger. Repair used 15 settled main calls; worker prose mistakenly compared tool invocations with the main-request limit. No second repair was needed.

These are integration primitives, not a complete plugin activation. Actual business registration, packaged host installation and browser verification remain subsequent stages. Composition must always supply both the validated installation root and actual dsh home to the data-directory guard.