# Stage 18c2 — virtual performance UI and host guidance wiring

Worker report for Sprint Contract `.local/contract-18c2.md`. Backend 18c1 (`performance.list` /
`performance.save` / `performance.delete`) is accepted and unchanged; this stage adds the browser
slice over it plus two coordinator-found production repairs.

## Changed files

| File | Change |
| --- | --- |
| `src/ui/virtual-performance-view.ts` | **New.** Pure form parser, field refusals and reading helpers (no React, no API, no clock of its own). |
| `src/ui/VirtualPerformance.tsx` | **New.** Ledger panel: list, counts, edit/delete, CAS form, conflict guidance. |
| `src/ui/Ability.tsx` | Mounts `<VirtualPerformance>` next to the ability panel, keyed by `accountId`. |
| `src/ui/GuidancePicker.tsx` | Selection capped at the domain bound (4): a fifth choice is impossible and explained. |
| `src/plugin/index.ts` | `WorkbenchService` now receives the shared `guidance` catalogue. |
| `tests/ui/virtual-performance.test.ts` | **New.** 10 cases over the parser and reading helpers. |
| `tests/plugin/composition.test.ts` | One activation/integration test proving the guidance wiring in production composition. |
| `docs/reports/stage-18c2-ui.md` | This report. |

No domain, application-service, adapter, storage, API-contract or 18c1 document was modified.

## Virtual performance UI

`VirtualPerformance` is Codeforces-only: another platform renders nothing and issues no request.
It uses `useRequest('performance.list', …)` for the read and `useAction()` for writes, so an
unmounting component aborts the in-flight HTTP request (an already acknowledged durable write stays
committed). The response is the only ledger the UI knows: it renders `entries`, `counts`, the
server-injected `disclosure` and the revision the next write must name. There is no local model, no
optimistic row and no fabricated data; no CRUD path can reach a model, a platform or a credential.

Form fields: contest id, **actual virtual participation date/time** (`datetime-local`, local wall
clock, seconds precision), performance, calculation method/tool, reference URL, independence,
prior exposure, optional rank and optional note. Copy states that the date is when the user really
ran the virtual contest — not the official contest date — and that a method label is mandatory
because different tools are not comparable.

Rules enforced by the pure parser (and re-validated by the server):

- an empty numeric field is a refusal, **never `0`**: an empty `performance` is refused with
  "留空不会被当作 0 分", and a refused form returns no submittable values at all;
- an entered `0` or negative performance is legitimate (bounds `-1000..5000`);
- an omitted rank is `null` and renders `未记录`, never rank `0`; an omitted note is `null`;
- an empty ledger renders the explicit missing-evidence note, never a zero score;
- `participatedAt` must be a real local date-time (a date-only value, an impossible date and a DST
  gap are refused instead of silently becoming another instant) and may not lie in the future;
- the reference URL must be an absolute, credential-free http(s) URL; it is rendered through the
  existing `ExternalLink`, which renders non-http(s) values as inert text and never fetches;
- independence must be chosen explicitly (`independent` / `assisted` / `unknown`) and `unknown` is
  never promoted to independent evidence; the count line names every group.

Write behaviour: explicit edit loads one stored row, explicit delete asks for confirmation, and
every save/delete carries `expectedRevision` from the last server answer (compare-and-set). A
refused write keeps every typed value, shows the mapped readable error, and — on `conflict`
(stale revision or duplicate contest id) — tells the user to refresh and retry without losing the
form. Inputs are cleared only after a **confirmed** save/delete, and the parent `onSaved` runs after
every confirmed save/delete. The form is keyed by `accountId`.

## Guidance wiring repair

`activateHost` already builds one `GuidanceMethodRegistry` shared with the public `icpcGuidance`
service, but `new WorkbenchService({…})` did not receive it, so production AI plan preparation with
an explicit `guidanceMethodIds` selection refused with `guidance_unavailable` even though a
companion package was installed. The catalog is now passed as `guidance`, which is the same
application port the accepted guided tests use. `tests/plugin/composition.test.ts` adds one
activation assertion: a method registered through the activation seam is captured by a real
`plan.aiPrepare` call through the registered route (`view.guidanceMethodIds` and the captured
`methods[0].methodId`), with no paid call dispatched.

`GuidancePicker` now caps the selection at `MAX_GUIDANCE_SELECTION` (4): at the bound every
unchecked checkbox is disabled and points at an explanation, the change handler refuses a fifth id,
and the hook refuses a selection longer than the bound (`ready` is true only for 1..4 selected
methods with no missing id). Explicit empty selections and
missing/uninstalled selected ids keep their previous behaviour (preserved, never substituted).

## Commands actually run

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass (no output) |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/ui/virtual-performance.test.ts tests/ui/ability.test.ts tests/plugin/composition.test.ts` | 29 pass / 0 fail |
| `node … tests/planning/guidance-service.test.ts tests/guidance/foundation.test.ts` | 12 pass / 0 fail (the guided model/storage tests) |
| `npm run check:architecture` | "Architecture imports satisfy the declared layer boundaries." |
| `npm test` | 1024 tests, 1022 pass, 2 skipped, 0 fail |
| `npm run typecheck` + `tests/ui/planning.test.ts tests/ui/virtual-performance.test.ts` (after the final `ready` bound edit) | pass; 20 pass / 0 fail |

## Non-goals and open issues

- No evaluation API or ability-evaluation backend (a later stage); the ledger is stored and shown,
  never converted into a rating, and `estimation` stays `not_estimated`.
- No main-version, Git, install or budget edits, and the existing 18c1 document was not rewritten.
- DST-gap participation times are refused rather than adjusted; a user in that situation enters the
  nearest real local time.
- Editing a row re-stores `participatedAt` at seconds precision (a stored millisecond component is
  dropped when the user saves that row).
