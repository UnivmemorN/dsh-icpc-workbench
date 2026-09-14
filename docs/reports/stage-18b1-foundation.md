# Sprint 18b1 — detachable-method foundation (registry + real companion packages)

Status: implemented and verified. Scope was deliberately bounded to the **extension foundation**; no
planning generation, selector, assessment or performance code was written (that stays in 18b/18c/18d).

## Changed and added files

Foundation review/fix:

- `src/domain/guidance.ts` — source-link rule relaxed to its documented intent (`http(s)`, no
  credentials; a harmless fragment/port is now accepted), `GuidanceMethodError.code` renamed to
  `reason` (the inherited `DomainError.code` is `invalid_input`, so the extra field was a TS2416
  override conflict), `EMPTY_GUIDANCE_HASH` doc corrected, `requireEnum` formatting fixed.
- `src/application/planning-types.ts` — preparation validation now accepts an **optional**
  `guidanceSnapshot` only when the row actually has the key, validates it through
  `validateGuidanceSnapshot`, and folds it into `planPreparationEvidenceHash` only when present. A
  legacy row without the key still hashes exactly like the pre-guidance algorithm; no default `[]`
  is ever added.
- `src/adapters/guidance/registry.ts` — added `clear()` so the owning service can empty in-memory
  host state on unload while outstanding companion disposers stay safe.

Cordis seam and wiring:

- `src/plugin/guidance-service.ts` (new) — `GuidanceService extends Service(ctx, 'icpcGuidance')`
  using the **actual installed** Cordis 4.0.2 signature (the constructor takes `(ctx, name)`, there is
  no third value argument; the value is the service instance itself). Exposes `version`
  (`icpc-guidance-v1`), `catalog` (the application `GuidanceCatalog` port plus sync `snapshot()`/`get()`)
  and `register(definition): () => void`; `size` for diagnostics. `ctx.effect` owns catalogue cleanup,
  and `Service` already provides on the constructing fibre, so unload removes the service. Module
  augmentation types `ctx.icpcGuidance`; `GuidanceServiceApi` documents the seam.
- `src/plugin/index.ts` — `apply()` creates one `GuidanceMethodRegistry`, passes it to `activateHost`
  as the new `ActivationEnvironment.guidance` test seam and publishes it through
  `applyGuidanceService(ctx, {registry})`; `PluginRuntime` now exposes `guidance`. `inject` is
  unchanged and core routes/services are untouched.

Installable companion packages (separate, no harness/workbench imports):

- `packages/dsh-icpc-method-balanced/` — `balanced-dual-axis@1.0.0`: the approved dual-axis method
  (thinking/templates support each other, prerequisite-bottleneck diagnosis, focus then keep
  reinforcing both, insufficient evidence ⇒ `diagnostic`). Cites the project user requirement in its
  text and paraphrases <https://usaco.guide/general/practicing>, with <https://oi-wiki.org/contest/>
  as a resource pointer only. Own `package.json`, `cordis.patch.yml`, `README.md`, `LICENSE` (MIT),
  plain-ESM `index.js` + `index.d.ts`.
- `packages/dsh-icpc-method-deliberate-practice/` — `deliberate-practice@1.0.0`: original short
  paraphrase of the USACO Guide loop (difficulty, attempt, incremental help, reimplement, review),
  with the same independent packaging.

Tests:

- `tests/guidance/foundation.test.ts` (new, 7 tests) — companion validation against the seam; typed
  refusals (`invalid_id`, `text_too_long`, `invalid_url`, `invalid_shape`, `no_capability`) and the
  inert-fragment allowance; registry detached/frozen catalogue, duplicate refusal, disposer ownership
  and idempotence, `clear()` safety; real Cordis lifecycle (`ctx.icpcGuidance`, load two packages,
  unload one, reload, unload all) and fibre-ownership/unload cleanup; companion removal refuses new
  work while a stored capture stays readable; legacy-absence evidence-hash preservation.

## Commands actually run (all from the repository root)

| Command | Result |
|---|---|
| `npm run typecheck` | pass (clean, after the two fixes above) |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/guidance/foundation.test.ts` | pass, 7/7 |
| `node ... tests/plugin/composition.test.ts` | pass, 13/13 (host wiring unchanged) |
| `node ... tests/planning/service.test.ts` | pass, 29/29 |
| `node ... tests/storage/planning-store.test.ts` | pass, 10/10 |
| `npm run check:architecture` | pass |

The full `npm test` suite was **not** run by this worker (focused subsets above only); the coordinator
owns full acceptance. No install, publish, Git, budget or permission change was made.

## Design-report correction

`docs/reports/stage-18a-design.md` no longer claims the host has no native skills facility. The 18
`@deepseek-ai` packages in this project's `node_modules` are the plugin's dependency subset, not the
host; the read-only harness checkout does ship a skill registry
(`source/packages/skill/skill/src/index.ts`). `icpcGuidance` is documented as **intentional
compatibility isolation** — a narrow, versioned method contract that a harness upgrade cannot
reinterpret — not as a claim that no native facility exists.

## Remaining scope (not attempted here)

- 18b proper: `guidanceSnapshot` propagation through prepare/revalidate/settle, per-preparation
  method selection and the typed `guidance.catalog` API route, UI selector/source viewer, plan
  diagnosis and per-task axis fields, prompt/version bump.
- 18c performance data, 18d independent AI assessment.
- Publishing/installing the companion packages in a live profile (explicitly out of scope here).
- `package.json` `files` list does not yet include this report or the companion packages; that is the
  packaging step of the final 18b acceptance.

## Open issues

- The approved user requirement has no public URL, so it is attributed in method text rather than as
  a fabricated link. If a canonical URL appears later, add it as a source and bump the method version.
- `EMPTY_GUIDANCE_HASH` is the kind-independent "no method text" marker; a kind-specific empty
  capture hashes as `guidanceSnapshotHash(kind, [])`. Both are documented and tested; a future
  consumer must not treat them as interchangeable.
- Companion `index.d.ts` files are hand-written type sugar for the plain-JS packages; if the packages
  ever grow logic, they need a real type story (still without importing host internals at runtime).
