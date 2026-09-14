# Stage 25c — upstream diagnostic credentials out of model audit logs

Status: implemented; focused model audit/gateway tests and typecheck pass. The full offline suite
shows two pre-existing composition failures from uncommitted Stage 25a/25b work (see Open issues).

## Scope

Only upstream diagnostic leakage was addressed. Model input/output auditing, the raw-replay
contract, usage accounting, cancellation, the stream byte/chunk bounds and the Flash-only policy
are unchanged.

## Changed files

- `src/adapters/dsh/audited-client.ts`
  - `auditErrorDetail` no longer reads an exception's `name`/`message`/`stack`/`cause` or
    stringifies any value. It returns fixed local text plus the allowlisted mapped code.
  - `thrownFailure`, `stopFailure` (session creation, input/output flush, raced dependencies) and
    the capability-lookup catch now record only that projection.
  - `providerDetail` no longer interpolates the provider's `code`/`message`; it names only the
    allowlisted mapped code. `finishFailure`'s `error` and `aborted` branches use it, and its
    unknown-kind branch no longer echoes the upstream reason kind.
  - New `mappedFailureCode` centralizes the closed allowlist (`MAPPED_FAILURE_CODES`); unknown codes
    stay `provider_error`.
  - The assembler catch records fixed text instead of the caught exception.
  - New `auditChunkReplay` projects a `finish` chunk whose reason is a provider failure (`error` or
    `aborted`) to `{ type: 'finish', reason: { kind, code } }`. The original chunk is still
    serialized and measured against `MAX_AUDIT_STREAM_BYTES` / `MAX_AUDIT_STREAM_CHUNKS` first, so
    accounting is unchanged. Every other chunk stays byte-exact.
  - Documentation updated: module header, failure-message comment, `IcpcModelCallResultAudit.detail`
    and `.chunks` describe the diagnostic-only projection.
- `tests/model/audited-client.test.ts`
  - Updated the two existing assertions that intentionally expected upstream text in
    `audit.detail` (the `upstream exploded` provider-failure case and the capability-lookup case),
    plus the typed-provider-code case that expected the provider's own code text. These are the
    privacy requirement, not a weakened check: they now assert omission and the fixed safe
    diagnostic.
  - Added six offline tests with synthetic canaries (fake `CANARY-SECRET-BEARER-9f2c` and
    `sk-canary-0000000000000000`, never real credentials) covering: a capability-lookup exception
    carrying canaries in name/message/cause/`apiKey`/`authorization`/`headers`/`metadata`; a
    `finish.reason.kind='error'` payload with canaries in `failure.message`, nested headers/metadata
    and `replayState`; a thrown `LlmError` during streaming; an uncreatable audit session; a
    throwing audit flush; and a successful stream whose chunk replay stays byte-identical while
    user-provided material is still audited (the documented limit).
- `docs/credential-boundary.md` (new): the ICPC/dsh credential boundary, what audit sessions store,
  the diagnostic projection, the user obligation not to paste secrets into recorded material, and
  the limits of this change.

## Acceptance checks actually run

1. `npm run typecheck` — pass (no output, exit 0).
2. `node --experimental-strip-types --import ./tests/loader.mjs --test
   --experimental-test-isolation=none tests/model/audited-client.test.ts
   tests/model/durable-audit.test.ts tests/model/gateway.test.ts` — 74 tests, 74 pass, 0 fail. This
   includes the 28 audited-client tests (6 new), the durable-audit integration tests and the
   gateway/analysis tests that assert the exact audited input.
3. `node -e "…BlockAssembler probe…"` (offline discovery): `BlockAssembler.push` tolerates the
   malformed chunk shapes tried (unmatched delta, unmatched block-end, unknown block type), so no
   deterministic assembler-throw test was added. That branch now records a constant string and does
   not read the caught value at all; it is covered by inspection, not by a test.
4. `npm run test` (full suite) — 1300 tests, 1296 pass, 2 fail, 2 skipped. Both failures are
   `tests/plugin/composition.test.ts` asserting 63 registered routes while 66 exist (lines 36 and
   169). They are unrelated to this change (see Open issues).

## Exact behavior and limits

- Recorded now: closed reason kinds (`error`, `aborted`), allowlisted mapped failure codes, fixed
  local detail sentences, actual usage, call/attempt/session identity, and the full successful
  stream replay.
- Never recorded now: upstream exception `name`/`message`/`stack`/`cause`/attached fields, the
  provider's own code text, failure messages, headers, metadata, replay state on a failure finish
  chunk, and arbitrary fields added to such a chunk.
- Unchanged: user-provided material is still audited verbatim; raw-chunk lossless/byte/chunk bounds;
  usage accounting; cancellation; context-window refusal; Flash-only enforcement; the caller-facing
  typed error contract (`code`, fixed `message`, `retryable`, usage).
- Not claimed: detection of arbitrary secrets pasted into user material; deletion or rewriting of
  previously persisted audit events; any change to dsh host logs or provider key storage. Existing
  persisted audit sessions may still contain upstream text written before this build.
- Deployment note: `docs/credential-boundary.md` is not yet listed in `package.json` `files`; the
  contract forbade package edits, so the coordinator must add it if the doc should ship in the
  tarball.

## Open issues

- `npm run test` has 2 failures in `tests/plugin/composition.test.ts` (expected route count 63 vs
  actual 66). `git status` shows a large uncommitted Stage 25a/25b working tree
  (`src/plugin/luogu-api.ts`, `src/application/workbench-api.ts`, schema/UI changes) whose new
  routes are ahead of that expectation. This is outside Stage 25c scope; the coordinator owns the
  route-count expectation and the commit.
- The assembler-throw branch is fixed to a constant but has no deterministic regression test,
  because the installed `BlockAssembler` did not throw for the malformed shapes probed offline.

## Coordinator integration review

The three new recovery routes are now asserted explicitly in the composition tests (66 routes total). The credential guide is included in the package. The failure-code allowlist now checks own properties, and unknown terminal kinds are projected to a fixed `unknown` value. Additional synthetic tests cover inherited failure-code names, unknown terminal canaries, and byte-exact replay for a recognized `max-tokens` terminal. The final combined gate and installed-runtime checks are recorded in [stage 25 acceptance](stage-25-acceptance.md); earlier failures above describe the worker-stage result, not the release gate.
