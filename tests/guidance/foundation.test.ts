/**
 * Sprint 18b1 foundation: companion-method validation, registry/service ownership and the
 * hash-preserving legacy absence rule. No plan generation, selector, assessment or performance code
 * runs here — this suite pins the extension seam the later 18b stages build on.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Context} from '@deepseek-ai/cordis';
import {
  DomainError,
  EMPTY_GUIDANCE_HASH,
  GUIDANCE_ACTIVATION_SCOPE,
  GUIDANCE_SEAM_VERSION,
  GuidanceMethodError,
  captureGuidanceSnapshot,
  contentHashOf,
  guidanceSnapshotHash,
  isDeeplyFrozen,
  validateGuidanceMethodRegistration,
  validateGuidanceSnapshot,
  type AbilityPlanningAggregate,
  type JsonValue,
} from '../../src/domain/index.js';
import {GuidanceMethodRegistry} from '../../src/adapters/guidance/index.js';
import {resolveGuidance} from '../../src/application/guidance-catalog.js';
import {planPreparationEvidenceHash} from '../../src/application/planning-types.js';
import {applyGuidanceService, type GuidanceService} from '../../src/plugin/guidance-service.js';
import * as balanced from '../../packages/dsh-icpc-method-balanced/index.js';
import * as deliberate from '../../packages/dsh-icpc-method-deliberate-practice/index.js';

/** Mutable deep copy of a frozen companion contribution, so one field can be corrupted per case. */
function mutable(value: unknown): any {
  return JSON.parse(JSON.stringify(value)) as any;
}

/** Stable reason of a refused definition: `GuidanceMethodError.reason` or `DomainError.details.reason`. */
function refusal(value: unknown): string | undefined {
  try {
    validateGuidanceMethodRegistration(value);
    return undefined;
  } catch (error) {
    if (error instanceof GuidanceMethodError) {
      return error.reason;
    }
    if (error instanceof DomainError) {
      const details = error.details as unknown as Record<string, unknown>;
      return 'reason' in details ? String(details['reason']) : undefined;
    }
    throw error;
  }
}

test('both companion packages validate against the documented seam', () => {
  assert.equal(GUIDANCE_SEAM_VERSION, 'icpc-guidance-v1');
  assert.equal(balanced.name, 'dsh-icpc-method-balanced');
  assert.equal(deliberate.name, 'dsh-icpc-method-deliberate-practice');
  assert.deepEqual(balanced.inject, ['icpcGuidance']);
  assert.deepEqual(deliberate.inject, ['icpcGuidance']);

  const dual = validateGuidanceMethodRegistration(balanced.balancedMethod);
  assert.equal(dual.methodId, 'balanced-dual-axis');
  assert.equal(dual.version, '1.0.0');
  assert.equal(dual.seamVersion, GUIDANCE_SEAM_VERSION);
  assert.deepEqual(dual.capabilities, {plan: true, assessment: true});
  assert.equal(isDeeplyFrozen(balanced.balancedMethodDefinition), true);
  assert.equal(isDeeplyFrozen(dual), true);
  assert.ok(dual.sources.some((source) => source.url === 'https://usaco.guide/general/practicing'));
  assert.ok(dual.sources.some((source) => source.url === 'https://oi-wiki.org/contest/'));
  // The approved user requirement has no public URL, so it is attributed in the text, not faked.
  assert.ok(dual.planGuidance.sections.some((section) => section.text.includes('用户批准')));

  const practice = validateGuidanceMethodRegistration(deliberate.deliberatePracticeMethod);
  assert.equal(practice.methodId, 'deliberate-practice');
  assert.equal(practice.planGuidance.trainingSteps.length, 5);
  assert.equal(practice.sources[0]?.url, 'https://usaco.guide/general/practicing');
});

test('validation refuses malformed methods with typed reasons and allows inert fragments', () => {
  const corrupt = (mutate: (copy: any) => void): string | undefined => {
    const copy = mutable(balanced.balancedMethod);
    mutate(copy);
    return refusal(copy);
  };

  assert.equal(refusal(balanced.balancedMethod), undefined);
  assert.equal(corrupt((copy) => { copy.methodId = 'Bad Id'; }), 'invalid_id');
  assert.equal(corrupt((copy) => { copy.planGuidance.sections[0].text = 'x'.repeat(4001); }), 'text_too_long');
  assert.equal(
    corrupt((copy) => { copy.sources = [{title: 'leak', url: 'https://user:pass@example.com/a', license: null}]; }),
    'invalid_url',
  );
  assert.equal(
    corrupt((copy) => { copy.sources = [{title: 'plain', url: 'ftp://example.com/a', license: null}]; }),
    'invalid_url',
  );
  assert.equal(corrupt((copy) => { copy.assessmentGuidance = null; }), 'invalid_shape');
  assert.equal(corrupt((copy) => { copy.kind = ['plan']; }), 'invalid_shape');
  assert.equal(corrupt((copy) => { copy.extra = true; }), 'invalid_shape');
  assert.equal(corrupt((copy) => { copy.capabilities = {plan: false, assessment: false}; copy.kind = []; }), 'no_capability');

  // A harmless fragment (or explicit port) is an inert citation, not a credential.
  const fragment = mutable(balanced.balancedMethod);
  fragment.sources = [
    {title: 'guide section', url: 'https://usaco.guide/general/practicing#how-to-practice', license: null},
  ];
  assert.equal(refusal(fragment), undefined);
});

test('registry disposers own exactly their registration and the catalogue is detached', async () => {
  const registry = new GuidanceMethodRegistry();
  const dispose = registry.register(balanced.balancedMethod);
  assert.equal(registry.size, 1);
  assert.equal(registry.get('balanced-dual-axis')?.definition.version, '1.0.0');

  const catalog = await registry.catalog();
  assert.equal(isDeeplyFrozen(catalog), true);
  assert.equal(isDeeplyFrozen(catalog[0]?.definition), true);
  assert.throws(() => { (catalog as unknown as unknown[]).push('no'); }, TypeError);
  assert.throws(
    () => registry.register(balanced.balancedMethod),
    (error: unknown) => error instanceof GuidanceMethodError && error.reason === 'duplicate_id',
  );

  dispose();
  assert.equal(registry.size, 0);
  dispose();
  const newer = registry.register({...balanced.balancedMethodDefinition, version: '1.0.1', kind: ['plan', 'assessment']});
  dispose(); // Idempotent and stale: it must not remove the newer registration it does not own.
  assert.equal(registry.size, 1);
  assert.equal(registry.get('balanced-dual-axis')?.definition.version, '1.0.1');
  newer();
  assert.equal(registry.size, 0);

  const pending = registry.register(deliberate.deliberatePracticeMethod);
  registry.clear();
  assert.equal(registry.size, 0);
  pending();
  assert.equal(registry.size, 0);
});

test('the Cordis service exposes icpcGuidance and companion unload removes exactly its method', async () => {
  const ctx = new Context();
  const service = applyGuidanceService(ctx);
  assert.equal(service.version, GUIDANCE_SEAM_VERSION);
  // Cordis hands out a traced proxy of a provided service, so the published API is asserted, not identity.
  assert.equal(ctx.icpcGuidance.version, GUIDANCE_SEAM_VERSION);
  assert.equal(typeof ctx.icpcGuidance.register, 'function');
  assert.equal(ctx.get('icpcGuidance')?.version, 'icpc-guidance-v1');
  assert.equal(service.size, 0);

  const balancedFiber = ctx.plugin(balanced);
  await balancedFiber;
  const deliberateFiber = ctx.plugin(deliberate);
  await deliberateFiber;
  assert.deepEqual(
    (await service.catalog.catalog()).map((entry) => entry.definition.methodId),
    ['balanced-dual-axis', 'deliberate-practice'],
  );

  await balancedFiber.dispose();
  assert.deepEqual(
    (await service.catalog.catalog()).map((entry) => entry.definition.methodId),
    ['deliberate-practice'],
  );
  const reloaded = ctx.plugin(balanced);
  await reloaded;
  assert.equal(service.size, 2, 'uninstall then reinstall registers cleanly');
  await reloaded.dispose();
  await deliberateFiber.dispose();
  assert.equal(service.size, 0);
  assert.equal(ctx.get('icpcGuidance')?.version, GUIDANCE_SEAM_VERSION, 'the providing fibre still owns the service');
});

test('a fibre that provides the service loses it, and its catalogue, on unload', async () => {
  const ctx = new Context();
  let service: GuidanceService | undefined;
  const host = ctx.plugin({
    name: 'icpc-guidance-lifecycle-host',
    apply: (inner: Context) => { service = applyGuidanceService(inner); },
  });
  await host;
  ctx.icpcGuidance.register(balanced.balancedMethod);
  assert.equal(service?.size, 1);
  await host.dispose();
  assert.equal(service?.size, 0, 'the owned effect empties the catalogue');
  assert.equal(ctx.get('icpcGuidance'), undefined, 'the providing fibre owns the registration');
});

test('removing a companion refuses new work while a stored capture stays readable', async () => {
  const ctx = new Context();
  applyGuidanceService(ctx);
  const balancedFiber = ctx.plugin(balanced);
  await balancedFiber;

  const resolved = await resolveGuidance(ctx.icpcGuidance.catalog, {
    kind: 'plan',
    methodIds: ['balanced-dual-axis'],
    missing: true,
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const stored = resolved.snapshot;
  assert.deepEqual(stored.selectedMethodIds, ['balanced-dual-axis']);
  const captured = stored.methods[0];
  assert.ok(captured);
  assert.equal(captured.version, '1.0.0');
  assert.equal(captured.activationScope, GUIDANCE_ACTIVATION_SCOPE);
  assert.equal(captured.methodHash.length, 64);
  assert.equal(captured.sources.length, 2);

  const again = await resolveGuidance(ctx.icpcGuidance.catalog, {
    kind: 'plan',
    methodIds: ['balanced-dual-axis'],
    missing: true,
  });
  assert.equal(again.ok && again.snapshot.hash === stored.hash, true, 'unchanged text captures the same hash');

  await balancedFiber.dispose();
  const missing = await resolveGuidance(ctx.icpcGuidance.catalog, {
    kind: 'plan',
    methodIds: ['balanced-dual-axis'],
    missing: true,
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.refusal.reason, 'missing_method');
  assert.equal(
    validateGuidanceSnapshot(JSON.parse(JSON.stringify(stored)) as unknown).hash,
    stored.hash,
    'history keeps the removed method readable',
  );

  // The free baseline needs no companion at all.
  const free = await resolveGuidance(ctx.icpcGuidance.catalog, {kind: 'plan', methodIds: [], missing: false});
  assert.equal(free.ok, true);
});

test('a legacy preparation without a guidance capture keeps its exact evidence hash', () => {
  // The hash function is content-agnostic, so this stand-in isolates *key presence* — the whole
  // legacy-absence rule — without fabricating a production ability aggregate.
  const base = {
    accountId: 'codeforces:alice',
    sourceInstanceId: 'codeforces',
    requestedCandidateKeys: null,
    settings: {horizonDays: 7, minutesPerDay: 90, maxTasksPerDay: 2, estimatedMinutes: 45},
    candidates: [],
    weakness: {attemptedDistinctTotal: 0, sufficientTagIds: [], ranking: []},
    ability: {version: 'ability.4', platform: 'codeforces'} as unknown as AbilityPlanningAggregate,
  };
  assert.equal(Object.hasOwn(base, 'guidanceSnapshot'), false);
  const legacy = planPreparationEvidenceHash(base);
  assert.equal(
    legacy,
    contentHashOf(base as unknown as JsonValue),
    'absence hashes exactly like the pre-guidance algorithm, so old rows are never rewritten',
  );

  const emptyCapture = captureGuidanceSnapshot('plan', []);
  assert.equal(emptyCapture.hash, guidanceSnapshotHash('plan', []));
  assert.notEqual(emptyCapture.hash, EMPTY_GUIDANCE_HASH, 'a kind-specific empty capture is not the legacy marker');
  assert.equal(EMPTY_GUIDANCE_HASH, contentHashOf({methods: [], kind: 'none'}));
  assert.notEqual(planPreparationEvidenceHash({...base, guidanceSnapshot: emptyCapture}), legacy);

  const stored = validateGuidanceSnapshot(JSON.parse(JSON.stringify(emptyCapture)) as unknown);
  assert.equal(stored.hash, emptyCapture.hash);
  assert.deepEqual(stored.selectedMethodIds, []);
});
