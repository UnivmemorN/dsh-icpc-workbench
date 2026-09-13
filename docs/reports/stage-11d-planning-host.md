# Stage 11d — owned AI planning host and API

AI plan generation now uses the plugin's audited dsh client and an owned background operation. Five additive authenticated endpoints prepare, start, inspect, cancel and list account-scoped attempts. The existing free rule preview and plan adoption/edit/checkoff remain available.

The host injects PlanningService and DshPlanGenerator with the same audited client used by analysis and coaching. The preparation port binds WorkbenchService methods; completed plans are projected through the existing spoiler-aware plan view. Startup recovers expired reservations. The controller's start/save gate, persisted reservation checks and close/drain lifecycle include planning. HTTP abort after acknowledgement does not cancel paid work; explicit cancellation retains reported usage. These are per-host-instance coordination guarantees with persisted checks, not a cross-process atomic mutex claim.

The coordinator's independent checks caught and fixed a real boundary defect: forwarding the run request (including settings revision) to the identity-only status API caused a strict-shape rejection. Public run types now require the revision, and model routes have a separate operation list from business routes. The configurable daily task limit is preserved (1–3, default 3) instead of ignored. New test fixtures were corrected to use the accepted service signatures and strip-compatible TypeScript. Race assertions now observe reservation after dispatch and require fresh preparation after settings change.

Validation actually run:

- `npm run typecheck` — passed.
- `npm run check:architecture` — passed.
- `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none "tests/plugin/**/*.test.ts" "tests/planning/**/*.test.ts"` — 152 passed, no failures/skips.

Coverage includes free preparation/cancellation, exact selection and limits, real SQL plan writes, account isolation and spoilers, idempotent replay, model/settings refusals, settings race, reciprocal planning conflicts, restart reservations and bounded shutdown with retained paid usage. Full package checks, UI and real-model acceptance belong to the final Stage 11 acceptance report.
