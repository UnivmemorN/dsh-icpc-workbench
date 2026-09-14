# Stage 18e — independent AI assessment UI

Worker report for Sprint Contract `.local/contract-18e.md`. The accepted typed assessment API
(`assessment.config` / `prepare` / `run` / `status` / `cancel` / `history`, Stage 18d) is used as-is:
this stage adds the browser slice only. No backend, API contract, domain, service, adapter, host or
route was changed.

## Changed files

| File | Change |
| --- | --- |
| `src/ui/assessment-view.ts` | **New.** Pure reading/formatting/gating rules (no React, no DOM, no clock, no network). |
| `src/ui/AiAssessment.tsx` | **New.** Free preparation → explicit paid generate → owned status polling → cancel → paginated history/report. |
| `src/ui/Ability.tsx` | Mounts `<AiAssessment key={ability.accountId} accountId={ability.accountId} />` after the official rating; every existing panel (official rating, calibration, history, native distribution, virtual performance) is unchanged. |
| `tests/ui/assessment-view.test.ts` | **New.** 7 cases over the real edge behaviour: unknown usage, official `0`/negative vs missing, no-anchor estimate, paid-run gate, prepare refusals, citation resolution, poll/acknowledgement copy. |
| `docs/reports/stage-18e-assessment-ui.md` | This report. |

## Flow

Mount performs only free reads: `assessment.config`, `guidance.catalog` (through
`useGuidance('assessment', accountId)`) and `assessment.history` (page 1). No model call is reachable
on mount, on method selection, on history navigation or on polling.

1. **Free prepare.** `GuidancePicker` selects 1..4 assessment-capable methods; the button is enabled
   only when the catalogue loaded, 1..4 methods are selected and no selected id is missing. The
   request is `assessment.prepare` with a UI-owned `crypto.randomUUID()` request id; a refusal keeps
   the form and shows fixed assessment copy.
2. **Frozen preparation.** The answer is shown exactly as stored: request id, preparation instant,
   frozen `settingsRevision`, provider/model, `GuidanceSources` over the captured
   `GuidanceSnapshot` (method text, version and sources, so an uninstalled or upgraded companion
   still renders the original citation), the anchor diagnostic, the official-rating evidence line and
   a collapsed, scrollable JSON preview of the exact identifier-free payload (`view.evidence`) plus
   the model / max effort / output-token / timeout / rolling-24h-quota line.
3. **Explicit paid generate.** `assessment.run` is sent with the **prepared** request id and the
   visible account. The server reserves the single call; the answer already carries the durable
   attempt.
4. **Owned status polling.** `usePollAfterSettle` refreshes `assessment.status` every 2 s only while
   the displayed status is `reserved`, only after the previous read settled, and never after a
   terminal status or unmount. A `reserved → settled|uncertain|cancelled` transition refreshes the
   history page so the persisted report appears without any further user action.
5. **Cancel.** `assessment.cancel` is available for a `prepared` row (known-zero, free) and for an
   `reserved` row (signals the owned call; the settlement is the authority). Copy separates the two.
6. **History.** 10 or 20 rows per page, cursor navigation (`更早的记录`, `上一页（较新）`,
   `回到最新`), per-row `查看` and `取消`. Selecting a row only sets the focus and triggers the free
   `assessment.status` read — never a model call.

## Rules the page exists to enforce

- **AI ≠ official.** Every estimate line says the range is an AI inference, and the official rating
  is rendered from its own captured `CompetitionSummary`.
- **`0` is a value, missing is not.** `officialRatingText` prints `rating 0` / `rating -12` for a
  rated profile, while `unrated` and `not_loaded` say "缺失/未知，不是 0 分"; usage lines print real
  tokens or name the unknown, and only a `prepared`/`cancelled` row is called confirmed zero-cost.
- **No anchor, no number.** `assessmentRangeText` renders a `null` estimate as an explanation (no
  objective anchor, or the model declined) and never as `0`.
- **Frozen selection or re-prepare.** `assessmentRunProblem` blocks the paid button while the frozen
  `methodIds` differ from the current selection, while a frozen `methodId` is no longer installed, or
  while its captured `methodHash`/version differs from the catalogue; it also blocks when the stored
  settings revision moved or when the config read itself failed. The refusal names the method and the
  action; nothing is substituted or truncated.
- **Recovery without double charging.** Prepare/run/cancel acknowledgements and terminal transitions
  refresh the history page; config, catalogue, status and history all have explicit refresh controls.
  A lost `assessment.run` answer is recovered by refreshing the status of the same request id — the
  row then reads `reserved`, the generate button is gone, and the response's `started:false` is
  rendered as "no new call, no second charge".
- **Report rendering.** Summary, `estimatedRange | null` with the anchor diagnostic, confidence with
  reasons and citations, both axes (`AXIS_LABELS`) with uncertainties and citations, priority
  (`PRIORITY_LABELS`), bottleneck reason, readiness check and next steps; every `evidenceRef` is
  resolved through `assessmentEvidenceRefText` to the **human label captured next to it**, and an
  unknown reference is reported as unknown instead of guessed. The stored disclosure,
  `verification: 'unverified_ai'` and a settlement failure (when present) stay visible.
- **Safe rendering only.** The only external links are guidance source URLs, rendered by the existing
  `GuidanceSources` → `ExternalLink` (http/https only, no fetch). No host session/call id, raw
  provider payload or provider message is renderable: the projection carries none, and stored errors
  are mapped from their stable code to fixed copy.
- **Account isolation.** The mount site keys the component by `accountId`, so a switch unmounts the
  form, its focus and its polling; `useRequest`/`useAction` abort the in-flight HTTP reads on unmount,
  while the durable attempt the server already owns keeps settling. One `useAction` serves
  prepare/generate/cancel, so at most one mutation is ever in flight.

## Commands actually run

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass (no output) |
| `npm run check:architecture` | "Architecture imports satisfy the declared layer boundaries." |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/ui/assessment-view.test.ts tests/ui/api.test.ts tests/ui/ability.test.ts` | 17 pass / 0 fail |
| same runner with `tests/ui/planning.test.ts tests/ui/virtual-performance.test.ts` added | 37 pass / 0 fail |
| `npm run build` | ESM package and classic browser factory built |
| `node scripts/check-client.mjs` | "Classic client factory, shared modules and disposal verified." |
| `npm test` | 1064 tests: 1060 pass, 2 skipped, **2 fail** — both pre-existing (`tests/plugin/composition.test.ts`), see below |

## Open issues

1. **Pre-existing full-suite failures (not caused by this stage).** `tests/plugin/composition.test.ts`
   asserts `routes.size === 53` at lines 36 and 165 ("43 business/model/bootstrap + 7 typed Luogu + 3
   virtual-performance operations"), but `activateHost` now also registers the 6 accepted assessment
   routes (`src/plugin/index.ts:138` → `registerAssessmentApi`), so the real count is 59. The UI half
   cannot influence this: the architecture check forbids `plugin → ui`, and the plugin composition
   path imports no UI module. The owning stage's fix is to update both assertions to 59 and extend the
   comment with "6 assessment operations"; this contract forbids host/test-registration changes, so it
   was left for the coordinator.
2. **History rows carry no evidence projection.** `assessment.history` projects items with
   `includeEvidence: false` (accepted Stage 18d behaviour), so a report opened from a history row
   resolves its citations through the follow-up `assessment.status` read. If that read fails, the
   report still renders and citations show the honest "not in this capture" fallback instead of a
   label.
3. **No new paid-loop protection beyond the server.** The UI never retries automatically, but a user
   can always prepare a new request id and spend another allowed call; the rolling-24h quota remains
   the only hard ceiling (as designed in 18d2).

No main-version, dependency, Git or budget change was made; no domain/application/adapter/plugin file
was touched.

## Final integration update

The composition assertions were corrected and the six routes explicitly checked in Stage 18f. The coordinator added a status refresh after run/cancel acknowledgements and failed HTTP replies so an older prepared response cannot prevent polling. The complete 0.1.13 checks and real browser flow pass; see stage-18-acceptance.md.
