# Stage 12 acceptance — 0.1.7

Accepted locally on 2026-09-13 against dsh 0.1.5-rc.2. This release makes every installed workbench model role use DeepSeek V4.1 Flash at max and adds a dedicated entry for answers pasted from another model, a teacher or the user's own notes.

## Behaviour

- Default settings and legacy settings converge on deepseek-official/deepseek-flash, including no-editorial reasoning. The active dsh catalog identifies this ID as DeepSeek-V41-Flash. Upgrade writes one new settings revision and preserves all limits; repeated activation does not increment it again. The Settings page displays fixed roles. Non-Flash selections are refused by the save/start path, and the installed audited client refuses an out-of-policy provider/model/effort before audit creation or provider IO. Failure never falls back to Pro.
- Problem detail offers **粘贴外部答案 / 用户提供解析** before the spoiler reveal controls are used. A short source label and body are required; an attribution URL is optional and is never fetched. Text and code remain literal text. Saving is local and free, followed by an explicit action to select that problem for tag review; analysis preparation is also free. Actual analysis/verification/coaching is still an explicit paid action.
- Each paste is a separately attributed user-provided source, preserving platform material, prior pasted answers, raw tags and manual choices. With no URL, the stored link is explicitly the associated problem, not the answer's origin. Identical content reuses the snapshot despite observation-time changes; different content creates a new immutable snapshot. Stale writes are refused. Saving does not certify correctness or adopt tags.
- Analysis, independent verification (including an empty first suggestion list), and coaching receive the exact provided solution text and provenance note as task data. The fixed prompts treat that data as untrusted material, not instructions. Planning retains its aggregate/candidate-only payload and excludes full solution bodies. Existing evidence and manual-review rules remain in force.

## Verification

| Check | Observed result |
| --- | --- |
| Full npm run check | 812 functional tests and 9 worker/accounting tests passed, zero failures/skips. Type checking, architecture boundaries, ESM build, classic browser factory/shared React and disposal checks passed. |
| Policy regressions | Legacy provider/analysis/reasoning/coaching selections migrate once; quotas survive; other provider/model settings fail without changing revision. Every analysis/verification/reasoning/coaching/planning request using Pro, an unrelated model/provider or lower effort is refused with known-zero usage. Flash/max still dispatches through the fake audited host for every role. |
| Paste regressions | Real temporary SQLite/API tests cover URL-free and cited answers, exact body, repeated identity, multiple sources, changed snapshot, CAS rejection, invalid fields/length/URLs, raw/manual preservation and spoiler-safe responses. Model tests inspect actual assembled request payloads through fake transports. |
| Installed upgrade | A local backup was created first. Schema remains 4. Only the singleton settings row changed during upgrade; canonical row counts/hashes of every other table matched. Settings advanced from revision 18 to 19 and retained all limits. A Pro settings submission returned 400 without another revision. |
| Installed artifact | All 489 installed dist files matched the current build by SHA-256; plugin version 0.1.7. Plugin workspace/data and harness workspace remain separate; harness source was not edited. |
| Browser workflow | On the labelled synthetic account, opened the dedicated paste panel, entered multiline text/code without a URL, saved, saw the success and source note, navigated directly to one-problem review, and prepared one ready job. All three batch roles displayed Flash/max. The free batch was cancelled with zero calls. Revealed material showed the literal body and associated-problem link correctly. The real account was restored and fixed Flash settings were inspected. |
| Installed data checks | The saved body exactly matched the browser input; another identical paste reused snapshot v2; the old head returned 409. Hidden detail omitted text/source notes. Raw/effective tags and existing model-attempt/tag-decision table hashes were unchanged. |

No new paid runtime acceptance call was made. The observed model payload checks use fake transports; they prove what is passed to dsh, not the mathematical quality of a generated answer. Earlier real Flash calls and quality results remain in [Stage 11](stage-11-acceptance.md) and [Stage 05](stage-05-acceptance.md); they were not rerun for this release. The two bounded Flash construction invocations stopped at their request caps; the coordinator finished review and validation. Unsettled construction reserves remain in the private ledger, and new paid construction stopped at the existing threshold.

GitHub CI runs the same checks and package dry-run on Ubuntu/Windows with Node 22/24. The check attached to a commit is the authoritative result for that commit.

## Scope and attribution

This does not add a GPT6 connector or browse shared-chat links. Source labels are user assertions, and an external answer is not automatically a verified proof. Provided content remains local until an explicit relevant model call; the public repository/package contains no pasted user material, database, credentials or model logs. Changing a problem invalidates the paste form's transient draft; a failed save retains it.

The separate model and material workflows are documented in [Flash policy](../flash-only-policy.md) and [user-provided answers](../user-provided-answers.md). Existing [icpc-workbench](https://github.com/ZF3373/icpc-workbench), NovaPhy, Nowcoder and OI Wiki references and license notices remain in [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md). This release adds no third-party article or code copy.
