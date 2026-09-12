# dsh integration notes (coordinator, 2026-09-12)

Tested baseline: dsh 0.1.5-rc.2, commit fb2c4b9e698e30edb738bca4cf0618587db7d203. The harness checkout remains an external read-only reference. npm has exact baseline versions of the public dsh packages even where the latest dist-tag is older. Use exact baseline peers, not the latest tag.

## Host boundaries
- Connection Fetch registration is exact-path: ctx.connection.fetch.register({path,methods,requestBody,fetch}). It returns an asynchronous disposer. Register fixed /api/icpc/v1/* paths and use query/body identifiers. The host API carrier supplies authentication and origin checks. Never open an independent unauthenticated server.
- ctx.llm.stream(options) accepts provider, model, messages, system, maxTokens, sessionId, purpose and AbortSignal. createUserMessage and BlockAssembler are exported by @deepseek-ai/dsh-llm.
- Dedicated Session logs must contain the actual model input before dispatch and output/usage after settlement. Add typed plugin event names through the public SessionEventMap augmentation. ctx.sessions.create(), session.append(), and await ctx.sessions.flush(session) are available; a flush failure is not success.
- Model stream max-tokens is a failure, not accepted output. Analysis and verification are separate calls. Preserve provider/model/prompt version/session/call IDs for audit; count attempts before dispatch, including retries and uncertain interrupted calls. Never silently retry inside a gateway outside the application budget.
- Unknown/missing full statement is distinct from absent editorial. The reasoning role must not try to solve from title/ID alone.

Relevant read-only reference files under the baseline source:
- packages/session/session-title-llm/src/index.ts: auxiliary LLM request framing and streaming.
- packages/core/session/src/index.ts: create/append/flush.
- packages/client/connection/src/rpc.ts and http-bridge.ts: Fetch registration/carrier contract.
- packages/client/ui-jobs/src/client/index.ts: slots, locale and disposable registration.
- packages/client/ui-layout/src/client/: main keyed panel and layout.selectPanel.
- packages/bundle/web-app/package.json and cordis.patch.yml: bundle + browser roster metadata.

## Client/package
Use a main keyed slot and matching sidebar.panellist entry for ICPC mode. The main panel owns the workbench UI and exits using layout.selectPanel. Browser code calls the typed business API; it must never import SQL, host LLM or credentials. Reference feature imports should be type-only unless supplied by stable shared platform modules/services.

A single package can export its host entry and ./client, with dsh.client metadata and a dsh.bundle.patch YAML file. Its build and clean installation must work without the sibling harness tree. Plugin code must not depend on the coordinator's scripts/worker.mjs.

## Construction corrections
The coordinator originally capped each model output at 32768 tokens. A Flash max invocation spent 32361 reasoning tokens and hit max-tokens before saving any SQLite source. Subsequent invocations use 65536 output tokens, with the CNY100 total budget, CNY90 dispatch stop, 40 requests and 30-minute invocation limits retained. Missing/unsettled usage reserves reflect that larger cap. A truncated response is explicitly recorded as truncated, never acceptance.

The SDK can reuse a session within a running process, but its server creates a fresh agent for an ID in a new process. Do not assume an ID alone restores history across process restarts.

## Acceptance status
Node22/24 × Windows/Linux CI passed for b4fa471 after replacing --test-isolation=none with the compatible --experimental-test-isolation=none. Passing run: https://github.com/UnivmemorN/dsh-icpc-workbench/actions/runs/34672594195 . Later stages require new verification.

## Verified auxiliary-call details
GenerateOptions.purpose only accepts compaction or session-title at this baseline: ICPC calls must omit purpose, not invent a custom value. reasoningEffort uses the public ReasoningEffortId brand. The shipped llm-retry plugin listens to agent/request-error, so direct auxiliary ctx.llm.stream calls do not receive those agent-loop retries. SessionStore.flush returns boolean: false means no durability listener participated and must refuse paid dispatch/adoption. A resolved promise alone is insufficient.
