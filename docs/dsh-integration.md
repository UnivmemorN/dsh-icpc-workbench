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

Further source checks for the LLM gateway: BlockAssembler.finish defaults to stop when no finish chunk arrived. Track an actual terminal finish chunk separately and reject a truncated/missing-finish stream. SessionStore.create() defaults to process-local session-<n> IDs; supply SessionId(randomUUID-derived value) for dedicated audit sessions across restarts. Persist the real stream chunks and raw TokenUsage for accounting; domain promptTokens aggregates uncached plus cache-read/cache-write input, whereas outputTokens already includes reasoning. Preserve unknown usage as unknown instead of fabricating a free request. Do not append ordinary user/message events solely to log auxiliary model input (that may activate unrelated host features); use typed ICPC audit events with exact options/messages.
## Browser artifact format (important)
The baseline browser does NOT load plugin ./client as ordinary ESM. Its public module table consumes a single classic-script closure-factory registration:
window.__ModuleLoader__.load({ id: 'dsh-icpc-workbench', factory: (require) => { const module = { exports: {} }; const exports = module.exports; /* bundled CJS here */ return module.exports; } });
External React/react-jsx-runtime resolve through that injected require; no import map or independent React copy. Verified source: packages/client/tsdown.client.ts; deployed example packages/client/ui-jobs/lib/client.js. Build a standalone client bundle with that protocol, plus separate ESM host/declarations. Do not import the harness checkout's build helper. CSS can be an owned scoped style string attached/disposed by the client apply effect. Browser registration and clean install must be tested against the actual loader, not just an ESM test page.
Further verified baseline notes: shipped web bundle YAML rows are plain id/name; browser membership is discovered from each package.json dsh.client metadata (do not invent a YAML dsh.client flag). Custom isolated Web profile initialization is `dsh --profile icpc-acceptance --from-default-profile web --help` once, before `dsh plugin --profile icpc-acceptance add <tgz>`. The template profile manifest declares base+web-app bundles, nodeLinker hoisted. The browser platform module table preloads React, react/jsx-runtime, react-dom/client and Cordis; React should resolve as an external in the classic factory bundle. Browser authentication exchanges the launch-token root URL for an authority-bound signed cookie and redirects to clean `/`; ordinary same-origin fetch sends this cookie. Do not disable authentication for acceptance; test both unauthenticated rejection and normal cookie-authenticated API.
## Coordinator-supplied worker context
Later construction tasks may attach a bounded allowlist of current source/contract snapshots through scripts/worker-context.mjs. This reduces repeated discovery requests while keeping the same request/time/cost caps; it does not expose credentials, arbitrary scratch files or paths outside the plugin checkout. The public SDK prompt method queues next-turn input, so it is not a mid-step steering control and is not used as one.
Further API boundary checks: ConnectionFetchRoute supports requestBody='streaming'; use it for plugin-owned 8MiB manual interchange and enforce byte/deadline/cancellation bounds in the handler, since buffered routes first inherit the host's JSON cap. Authentication and Origin checks still belong to the same shared carrier. LlmModelInfo catalog membership is explicitly advisory in the public types; an opaque user-configured model absent from listModels is not automatically invalid. Use resolveModelInfo for known capabilities and show unknown metadata honestly.The host edit tool additionally requires an actual in-session file read to establish its observed version, even when complete source is attached in the prompt. Workers must batch those required reads for existing edit targets before editing; supplied context reduces discovery, but cannot replace that precondition. Source: public tool-fs read/edit behavior at the pinned baseline. The coordinator does not change or bypass the host policy.