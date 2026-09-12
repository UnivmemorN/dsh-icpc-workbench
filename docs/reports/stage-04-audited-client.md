# Stage 4a1 — audited dsh model calls

The plugin now has a reusable `DshAuditedModelClient.callJson` over the public dsh LLM and Session APIs. Tag prompts, host composition and the UI are subsequent stages.

- One call invokes one provider stream, without hidden retries. A dedicated UUID audit session correlates actual inputs, exact JSON stream chunks, outputs, raw usage and application attempt IDs.
- Input logging must flush durably before dispatch. Output logging must flush durably before successful adoption. Audit failures are nonretryable.
- A single deadline covers asynchronous dependencies and streaming; cancellation before dispatch costs zero, while cancellation after dispatch retains known or uncertain usage. The coordinator added a final deadline check after synchronous JSON validation, which cannot itself be preempted by a timer.
- Explicit output limits are preserved. Effort defaults to `max`; explicit supported opaque efforts are retained. Known context capacity uses a conservative serialized-byte estimate plus output and framing, refusing oversized input instead of truncating it.
- Input is capped at 750000 serialized UTF-8 bytes. Every raw chunk type counts toward 16 MiB / 100000 chunks. Non-JSON, lossy or oversized stream data cannot be adopted.
- Whole-document JSON and an explicit successful finish are required. Missing finish, token truncation, tools and malformed output fail visibly.
- Quota/rate/auth/config failures use public machine codes and sanitized messages. Unknown usage remains null; the real SQLite pipeline keeps its host correlation and does not retry uncertain-cost failures. Quota pauses the batch.
- Prompt accounting adds uncached, cache-read and cache-write tokens; completion already includes reasoning. Unsafe aggregate sums remain unknown.

Validation: 29 focused model/pipeline tests and coordinator probes cover cancellation at both flush boundaries, ignored abort signals, hanging host dependencies, context/default distinctions, raw output caps, replay metadata, quota persistence and deadline expiry. Full `npm run check`: 285 behavior tests + 3 accounting tests, typecheck, architecture and independent build.

Limits: only fake provider streams have been exercised at this stage; real paid gateway evaluation has not run. A cancelled pre-dispatch refusal gets at most 100 ms for a best-effort result flush; that record may remain unflushed, but no provider call was made. Provider metadata that cannot be faithfully represented as JSON is rejected. The context estimate is conservative rather than a model tokenizer.