# Credential boundary

What the ICPC workbench sends to a model, what it records, and which credentials it never touches.
This document describes the Stage 25c privacy fix; it is not a claim that every possible secret is
detected or that historical data is erased.

## How model calls happen

- Every auxiliary model call goes through the public dsh LLM service (`ctx.llm.stream`) from
  `DshAuditedModelClient`. The plugin does not call a provider over HTTP itself, does not embed a
  provider SDK, and does not read a provider key from its own configuration or settings.
- Plugin configuration and settings carry the provider name, the model name, budgets, limits and
  data-directory choices. They never carry an API key, token or authorization header.
- The dsh host owns the provider credentials and the host's own logs. Where the host stores a key,
  and what the host logs about a request, is outside this plugin's control and visibility.

## What an audited call records

One dedicated, locally created audit session per client records, for each call:

- the exact input the plugin built: `system`, the user message, provider/model, effective options
  and the advisory capability lookup result;
- the streamed output: raw chunk replay (with the one projection below), assembled text and
  reasoning, terminal finish, raw usage and the derived usage;
- local identity: call id, attempt id, snapshot id, prompt version, role and session id.

This is intentional. The audit exists to make a paid call reproducible and accountable, so prompt
and output **material is recorded verbatim**, including anything a user pasted into a statement,
problem note or answer text.

## Upstream diagnostics are projected, not recorded

Upstream exceptions and provider failure payloads are diagnostics that may carry credentials, so
they are replaced by a closed, locally owned projection before they reach an audit event:

- A thrown host exception (capability lookup, session creation, audit flush, stream iterator,
  stream assembly) is recorded as fixed local text naming only an allowlisted mapped failure code.
  Its `name`, `message`, `stack`, `cause` and any attached field are never read for the audit and
  never serialized.
- A finish chunk whose reason is a provider failure (`kind` `error` or `aborted`) is recorded as
  `{ kind, code }` with the allowlisted mapped code. The provider's own message, headers, metadata,
  replay state and arbitrary fields on that chunk are dropped.
- Unrecognized terminal kinds are recorded as `unknown`, never copied as arbitrary text.
- Provider-neutral failure codes route through a fixed allowlist; an unknown code becomes
  `provider_error` instead of being guessed or echoed. Caller-facing messages stay fixed per code.

The provider's original chunk is still serialized and measured against the raw-stream
lossless/size/chunk bounds before projection, so byte and count accounting, usage accounting,
cancellation and fail-closed overflow behave exactly as before. Recognized non-error streams are replayed
byte-for-byte; failure or unrecognized terminal chunks receive the diagnostic projection.

## What users must not do

Because prompt and output material is recorded by design, **do not paste secrets into problem
statements, notes, answer text or any other material the plugin sends to a model**. The plugin does
not scan that material for credentials and does not promise to recognize an arbitrary secret typed
into it; it must not silently alter model input or output. The diagnostic projection covers upstream
failure channels only.

A Luogu session cookie is a **different** credential: it is stored through the Windows credential
vault and the database keeps only an opaque reference. It never enters a model request or a model
audit event.

## Limits

- No claim is made about deleting, rewriting or inspecting previously persisted audit sessions or
  host logs; this change alters what new events contain, not what old records hold.
- No general secret detection: only the upstream diagnostic channels named above are projected.
- No raw host error log is read, altered or reproduced by the plugin.
- Provider key storage, rotation and host-side logging remain the dsh host's responsibility.
