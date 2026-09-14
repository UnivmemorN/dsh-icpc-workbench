# AI training plans

> **开发参考** · [开发文档索引](development/README.md) · 日常操作请看[用户手册](user/README.md)。本文保留既有地址，供实现与排错核对。


The workbench prepares an AI training plan from a player's **real** stored data: the problems they have not solved in their own source instance, their aggregate weakness ranking and an identifier-free self-assessment reference plus descriptive practice statistics. The **训练计划** page drives this flow: AI planning is the default mode, the free rule-based preview stays one explicit switch away, and neither mode ever happens behind the user's back.

## The browser flow

The page opens in **AI 计划** mode and says up front that preparing is free while generating is one paid dsh model call. Nothing on mount, on mode/view switching, on preparation, on history loading or on status polling dispatches a paid call: the only paid trigger is the explicit **生成 AI 计划（调用模型）** button.

1. **Free preparation.** The form takes the AI scheduling bounds (days 1–30, minutes per day 1–480, at most 3 tasks per day, estimated minutes 1–the day's minutes; defaults 7 / 60 / 3 / 30). The candidate scope is explicit: **已勾选题目** uses exactly the keys selected in the bank (an empty selection stays an explicit empty list and is refused, never replaced by the automatic pool; more than 100 selected problems are refused with a "reduce the selection" label instead of being truncated), while **当前账号未通过题库（最多 100）** is the bounded automatic pool of the account's own source instance — never a cross-account or site-wide search. The optional reveal switch controls whether candidate tags and provisional raw labels are shown. Pressing **免费准备** generates a fresh request id and calls `plan.aiPrepare`; no model is involved.
2. **The preparation preview.** The answer shows the exact candidate list, how many own solved problems, duplicates and foreign rows were excluded, the applied candidate cap, the provider/model/effort/output cap, the rolling-24h cap and the fixed disclosure text. It also shows the compact ability aggregate (self-reported range and provenance, or uncalibrated status, alongside descriptive samples, quartiles and native medians) and links to the full 能力评估. Candidate platform tags are provisional and only appear when the reveal switch was on for that preparation.
3. **One explicit paid call.** **生成 AI 计划（调用模型）** sends the settings revision the **preparation captured** (`view.settingsRevision`), never a value guessed from the bootstrap record; when the preparation captured no revision the button explains that settings must be saved and the plan re-prepared. One generation is one model call (no automatic retry) and token cost depends on both input and output usage.
4. **Status, results and history.** After the paid start the page follows `plan.aiStatus` only while this instance owns a running operation or the attempt is durably `reserved`; an acknowledgement can arrive before the reservation exists, so the owned flag keeps the first poll alive. A terminal attempt is never polled again and never re-dispatched. When a run settles with a stored plan the page selects that plan in the existing saved-plan list and refreshes the detail. `plan.aiHistory` (newest first, at most 20 here) lets a refreshed browser recover recent prepared/pending/uncertain/completed attempts; because history keeps metadata only, a historical preparation has no restorable parameter preview and is offered for free cancellation or re-preparation, never for a paid resume. The status panel renders only the workbench's spoiler-safe plan projection and never a provider payload or internal error body.
5. **Cancellation.** Cancelling a `prepared` attempt is free and terminal; cancelling a `reserved` or owned running call asks the controller to cancel and states that the real cost is whatever the settlement records — a paid settlement is never rewritten as a free cancellation.
6. **Failure copy.** Stable codes are rendered as Chinese messages: quota (`planning_quota_exhausted`), changed settings, stale preparation, invalid model output, provider error, timeout, cancellation and uncertain outcomes. A known paid failure keeps its retained cost visible and an unknown cost is never shown as zero; polling errors stay visible with a manual refresh and never trigger an automatic paid retry.

Any change of account, candidate selection, scope, schedule, settings revision or reveal invalidates the visible preparation immediately, and a late `plan.aiPrepare` answer of an older snapshot is discarded instead of being adopted. Leaving the page or switching accounts never cancels an owned paid run: the browser abort only stops the HTTP request, while the 202-acknowledged work stays owned by the plugin.

## Prepared first, paid only on request

Preparing is free, durable and idempotent. One preparation is keyed by the caller's request id, records the exact candidate pool, weakness aggregate, ability aggregate, plan settings and the stored settings revision it borrowed, and is stored as a `prepared` attempt. Repeating the same request with the same account, settings and scope returns the stored preparation; reusing the id for a different account, plan settings or candidate scope is refused as a conflict, so an id can never name two different inputs. An account with no usable candidate is refused honestly and stores nothing — no problem is ever invented to fill a plan.

The paid call is a separate, explicit run of an existing preparation. A run of an unknown id refuses before any write. A run of an attempt that already has a durable outcome returns that outcome and never pays twice.

## Candidate scope, aggregates and privacy

A caller may name the exact candidate problems (`candidateProblemKeys`). When it does, only those stored problems of the account's own source instance can enter the plan: unknown or foreign keys are refused, problems the account already solved are excluded and counted rather than replaced, the list is never silently truncated, and an explicitly empty selection is refused instead of falling back to the automatic pool. Without an explicit selection the workbench uses its bounded automatic pool of unsolved problems.

What is sent to the model is only the plan settings, the aggregate weakness ranking, the identifier-free ability aggregate (self-assessment range/source/revision, historical and recent samples, coverage and native difficulty dimensions — no official rating claim) and the prepared candidates' public metadata: title, public link, estimated minutes, effective taxonomy ids and the platform's raw labels marked as explicitly provisional. No account id, handle, submission row, problem statement, editorial body or retrospective note is ever part of the request.

## Defaults and cost

Planning uses the analysis role's fixed `deepseek-official/deepseek-flash` (DSV4.1 Flash) model together with the configured output cap and request timeout, always at `max`. Since 0.1.7 all product roles use Flash; legacy settings migrate once and other selections are refused. The planner still receives only aggregate evidence and candidate metadata, never pasted answer bodies.

The planning quota is independent — it counts only planning attempts — but it borrows the coaching cap value (`coaching.maxCallsPer24Hours`, 10 by default) over a plugin-wide rolling 24-hour window, and only one planning call may be in flight at a time. The Settings page labels that value as `提示与计划各自的 24 小时调用上限` and says the two counters are separate while sharing the one limit value.

Cost reporting is deliberately conservative. A settled attempt records the usage the provider reported; a model answer refused by validation keeps its reported cost and stores no plan; a cancellation after dispatch keeps its cost; and a provider that never reported usage becomes `uncertain`, still counts against the quota and is never retried automatically, because a free retry could hide a call the provider already charged.

## Freshness

Before dispatching, and again after the model answers, the preparation is re-proved against the current store. The account calibration is re-read; a change or withdrawal makes the preparation stale. Practice evidence is recomputed at the current moment: a first accepted submission or a new retrospective recorded after the preparation on a problem that is not itself a candidate makes the preparation stale, while a clock that merely moved does not. A stale preparation is refused before dispatch and costs nothing; a preparation that goes stale while the model is answering settles with its retained cost and stores no plan.

The saved plan evidence summary is derived from the prepared weakness aggregate, including its actual attempted-problem count and sufficient tag IDs. Model text cannot replace that provenance. New results use the corrected summary; previously stored plans remain immutable.

An AI-generated title can reveal a method. Default list/detail/status projections therefore show a generic AI title while any task remains natively unsolved. Explicit reveal restores the original title, without changing the stored record or hash.

## Reading, cancelling and recovering

Status and cancel reads are scoped to one account: another account's request id answers exactly like an unknown one. Cancelling a still-`prepared` attempt is free and terminal — it never dispatched, so it never consumed quota. A reservation whose process died is recovered as `uncertain` and keeps its quota slot; a reservation that is still live is preserved and blocks a second concurrent call. Status/history reads recover expired unowned reservations too, so a restart before lease expiry cannot leave the UI polling forever.

`history` returns a bounded page (at most 50) of one account's most recent attempts, newest first, as metadata only: request id, status, timestamps, usage, typed error, stored plan id/hash and candidate count. It carries no preparation, candidate tags or aggregate evidence, so a refreshed page can recover what it no longer holds without exposing spoilers.

The full backend contract, its defaults, the settlement truth table and the exact checks that were run are described in [the Sprint 11c report](reports/stage-11c-ai-plans.md); the browser flow, the ability-view polish and the checks run for this stage are described in [the Sprint 11e report](reports/stage-11e-planning-ui.md).

Integrated runtime and browser verification: [Stage 11 acceptance](reports/stage-11-acceptance.md).

Since 0.1.10, practice medians never establish the player's level or restrict their training pools. See [personal calibration](ability-calibration.md).

Since 0.1.11, an explicitly synchronized official CF rating is the automatic reference when no self-report is active. The closed competition aggregate supplies current/max rating, contest count, recency class and snapshot revision; it never includes a handle or per-contest records. A rating refresh also invalidates older preparations. See [score sources and rules](ability-scoring.md).
