/**
 * Synthetic storage fixtures.
 *
 * Every record is built through the public domain factories, so the storage tests exercise
 * real identities (source instance + domain + account + external key + snapshot version)
 * instead of hand-rolled shapes. Nothing here talks to a platform or a model: the fixtures
 * are offline and deterministic, and `AT`/`LATER` are fixed timestamps.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adoptPlan,
  createAccount,
  createAiTagSuggestion,
  createAnalysisJob,
  createAnalysisResult,
  createEditorialSolution,
  createEditorialSource,
  createManualTagDecision,
  createModelUsage,
  createNormalizedProblem,
  createProblemSnapshot,
  createRetrospective,
  createSourceInstance,
  createSubmission,
  createSuggestionVerification,
  createTagDecision,
  createTrainingCandidate,
  createTrainingTask,
  deepFreeze,
  problemKey,
  recalcUnmetMinutes,
  trainingPlanIdOf,
  type Account,
  type AnalysisJobState,
  type AnalysisResult,
  type ManualTagAction,
  type ManualTagDecision,
  type NormalizedProblem,
  type ProblemRef,
  type ProblemSnapshot,
  type Retrospective,
  type SourceInstance,
  type SourcePlatform,
  type Submission,
  type SubmissionVerdict,
  type TagDecision,
  type TagDecisionOrigin,
  type TagDecisionStatus,
  type TrainingPlan,
} from '../../src/domain/index.js';

export const AT = '2026-09-12T08:00:00.000Z';
export const LATER = '2026-09-12T09:00:00.000Z';
/** Two minutes after a 60s lease taken at `AT`. */
export const EXPIRED = '2026-09-12T08:02:00.000Z';
/** A batch lease deadline after `LATER`: leases must expire strictly after `updatedAt`. */
export const LEASE_UNTIL = '2026-09-12T10:00:00.000Z';

export const TAXONOMY_VERSION = 'v1';
export const SEGMENT_TREE_TAG = 'data-structure/segment-tree';
export const GREEDY_TAG = 'paradigm/greedy';

const SOLUTION_TEXT = 'The editorial uses lazy propagation: range updates stay O(log n) with a segment tree.';
const EXCERPT = 'lazy propagation';

/** One instance + account + problem scope; the unit the storage tests duplicate. */
export interface Scope {
  readonly instance: SourceInstance;
  readonly account: Account;
  readonly problem: NormalizedProblem;
}

export function makeInstance(platform: SourcePlatform, domain: string): SourceInstance {
  return createSourceInstance({
    platform,
    baseUrl: `https://${domain}`,
    domain,
    displayName: `${platform} ${domain}`,
  });
}

export function makeAccount(instance: SourceInstance, handle: string): Account {
  return createAccount({
    sourceInstanceId: instance.id,
    handle,
    displayName: handle.toUpperCase(),
    profileUrl: `https://${instance.domain}/user/${handle}`,
  });
}

export function makeRef(instance: SourceInstance, externalKey: string, domain: string | null = null): ProblemRef {
  return { sourceInstanceId: instance.id, domain, externalKey };
}

export function makeProblem(
  ref: ProblemRef,
  options: { readonly title?: string; readonly statement?: string; readonly fetchedAt?: string } = {},
): NormalizedProblem {
  return createNormalizedProblem({
    ref,
    title: options.title ?? `Problem ${ref.externalKey}`,
    url: `https://${ref.sourceInstanceId.split(':')[1] ?? 'example.org'}/problem/${ref.externalKey}`,
    statement: options.statement ?? 'Given an array, support range add and range sum queries.',
    fetchedAt: options.fetchedAt ?? AT,
    ratings: [{ dimension: 'rating', value: 1800, scale: { min: 800, max: 3500 }, raw: '1800' }],
    rawTags: ['data structures', 'segment tree'],
  });
}

export function makeScope(
  platform: SourcePlatform,
  domain: string,
  handle: string,
  externalKey: string,
  problemOptions: { readonly title?: string; readonly statement?: string; readonly fetchedAt?: string } = {},
): Scope {
  const instance = makeInstance(platform, domain);
  const account = makeAccount(instance, handle);
  return { instance, account, problem: makeProblem(makeRef(instance, externalKey), problemOptions) };
}

export function makeSubmission(
  account: Account,
  ref: ProblemRef,
  externalId: string,
  verdict: SubmissionVerdict,
  submittedAt: string = AT,
): Submission {
  return createSubmission({
    accountId: account.id,
    ref,
    externalId,
    verdict,
    submittedAt,
    language: 'C++17',
    timeMs: 31,
    memoryKb: 1024,
  });
}

/** Snapshot with one found editorial source and one solution. */
export function makeSnapshot(
  problem: NormalizedProblem,
  options: {
    readonly previous?: ProblemSnapshot | null;
    readonly capturedAt?: string;
    readonly retrievedAt?: string;
  } = {},
): ProblemSnapshot {
  const retrievedAt = options.retrievedAt ?? AT;
  const source = createEditorialSource({
    id: 'editorial-1',
    kind: 'editorial',
    url: `https://editorial.example.org/${problem.ref.externalKey}`,
    title: `Editorial for ${problem.title}`,
    availability: 'found',
    retrievedAt,
    text: SOLUTION_TEXT,
  });
  const solution = createEditorialSolution({
    solutionId: 'solution-1',
    sourceId: source.id,
    ordinal: 0,
    title: 'Segment tree with lazy propagation',
    text: SOLUTION_TEXT,
  });
  return createProblemSnapshot({
    problem,
    sources: [source],
    solutions: [solution],
    capturedAt: options.capturedAt ?? AT,
    previous: options.previous ?? null,
  });
}

export function makeAnalysis(
  problem: NormalizedProblem,
  snapshot: ProblemSnapshot,
  options: { readonly createdAt?: string; readonly rationale?: string; readonly taxonomyId?: string } = {},
): AnalysisResult {
  const createdAt = options.createdAt ?? AT;
  const suggestion = createAiTagSuggestion({
    problemRef: problem.ref,
    snapshotId: snapshot.snapshotId,
    taxonomyId: options.taxonomyId ?? SEGMENT_TREE_TAG,
    role: 'analysis',
    rationale: options.rationale ?? 'The editorial solution cites a lazy segment tree.',
    evidence: [{ sourceId: 'editorial-1', solutionId: 'solution-1', excerpt: EXCERPT }],
    createdAt,
  });
  const verification = createSuggestionVerification({
    suggestionId: suggestion.suggestionId,
    problemRef: problem.ref,
    snapshotId: snapshot.snapshotId,
    verdict: 'support',
    verifierRole: 'verification',
    evidenceOk: true,
    checkedAt: createdAt,
  });
  return createAnalysisResult({
    problemRef: problem.ref,
    snapshotId: snapshot.snapshotId,
    snapshotVersion: snapshot.version,
    taxonomyVersion: TAXONOMY_VERSION,
    createdAt,
    status: 'completed',
    suggestions: [suggestion],
    verifications: [verification],
    usage: createModelUsage({ calls: 2, promptTokens: 120, completionTokens: 40 }),
  });
}

export function makeJob(
  problem: NormalizedProblem,
  snapshot: ProblemSnapshot,
  options: { readonly at?: string } = {},
): AnalysisJobState {
  return createAnalysisJob({
    problemRef: problem.ref,
    snapshotId: snapshot.snapshotId,
    at: options.at ?? AT,
  });
}

export function makeTagDecision(
  problem: NormalizedProblem,
  options: {
    readonly taxonomyId?: string;
    readonly status?: TagDecisionStatus;
    readonly origin?: TagDecisionOrigin;
    readonly decidedAt?: string;
    readonly analysisId?: string | null;
    readonly snapshotId?: string | null;
    readonly snapshotVersion?: number | null;
  } = {},
): TagDecision {
  return createTagDecision({
    problemKey: problem.key,
    taxonomyId: options.taxonomyId ?? SEGMENT_TREE_TAG,
    status: options.status ?? 'auto_adopted',
    origin: options.origin ?? 'ai',
    decidedAt: options.decidedAt ?? AT,
    reasons: ['evidence_verified', 'verification_support'],
    analysisId: options.analysisId ?? null,
    snapshotId: options.snapshotId ?? null,
    snapshotVersion: options.snapshotVersion ?? null,
    evidence: [{ sourceId: 'editorial-1', solutionId: 'solution-1', excerpt: EXCERPT }],
  });
}

export function makeManualDecision(
  problem: NormalizedProblem,
  taxonomyId: string,
  action: ManualTagAction,
  decidedAt: string = AT,
  note: string | null = null,
): ManualTagDecision {
  return createManualTagDecision({
    problemRef: problem.ref,
    taxonomyId,
    action,
    decidedAt,
    note,
  });
}

export function makeRetrospective(
  problem: NormalizedProblem,
  accountId: string,
  options: { readonly recordedAt?: string; readonly note?: string | null } = {},
): Retrospective {
  return createRetrospective({
    problemRef: problem.ref,
    accountId,
    mode: 'independent',
    recordedAt: options.recordedAt ?? AT,
    taxonomyIds: [SEGMENT_TREE_TAG],
    note: options.note ?? null,
  });
}

export function makePlan(
  accountId: string | null,
  problem: NormalizedProblem,
  options: { readonly createdAt?: string; readonly adopted?: boolean } = {},
): TrainingPlan {
  const createdAt = options.createdAt ?? AT;
  const candidate = createTrainingCandidate({
    candidateId: 'candidate-1',
    problemRef: problem.ref,
    title: problem.title,
    sourceUrl: problem.url,
    estimatedMinutes: 30,
    taxonomyIds: [SEGMENT_TREE_TAG],
    origin: 'weakness',
  });
  const planId = trainingPlanIdOf({
    accountId,
    now: createdAt,
    horizonDays: 7,
    minutesPerDay: 60,
    candidateIds: [candidate.candidateId],
  });
  const task = createTrainingTask({
    planId,
    candidate,
    day: 1,
    order: 0,
    minutes: 30,
    kind: 'solve',
    rationale: 'weakest tag pool',
  });
  const plan: TrainingPlan = deepFreeze({
    planId,
    title: 'Weekly practice',
    source: 'rule',
    status: 'draft',
    createdAt,
    adoptedAt: null,
    accountId,
    horizonDays: 7,
    minutesPerDay: 60,
    tasks: [task],
    evidence: {
      level: 'insufficient_history',
      reasons: ['no_sufficient_tag_samples'],
      attemptedDistinctTotal: 1,
      sufficientTagIds: [],
    },
    unmetMinutes: recalcUnmetMinutes([task], 7, 60),
  });
  return options.adopted ? adoptPlan(plan, { adoptedAt: LATER }) : plan;
}

/** Key of one problem reference, for assertions about scoped identities. */
export function keyOf(ref: ProblemRef): string {
  return problemKey(ref);
}

/** Fresh temp directory + database path; the caller removes the directory. */
export function tempDatabase(): { readonly path: string; readonly dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'icpc-storage-'));
  return { path: join(dir, 'store.sqlite'), dir };
}

export function removeDirectory(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
