/**
 * Immutable problem snapshots.
 *
 * A snapshot is the frozen model input for analysis: problem metadata plus the editorial
 * material retrieved at one moment. Three properties matter for the rest of the product:
 *
 * - **Ownership** — the snapshot owns everything it freezes. Caller-owned arrays and
 *   objects are cloned first, so freezing a snapshot can never freeze (or mutate) the
 *   adapter's own state, and a later adapter-side mutation cannot change a stored snapshot.
 * - **Immutability** — everything is deeply frozen at creation, so an analysis that ran
 *   against a snapshot can never observe it changing underneath.
 * - **Version + content hash** — `contentHash` covers the *semantic* content only
 *   (identity, titles, urls, ratings, tags, solution bodies, availability). Observation
 *   timestamps (`fetchedAt`, `retrievedAt`, `capturedAt`) are deliberately excluded, so
 *   refetching unchanged material does not create a new version, while any real change
 *   does. The snapshot id embeds the content hash *and* the version, so content that
 *   changes `A -> B -> A` produces a different id for the third snapshot even though its
 *   hash equals the first one's. Staleness compares identity, hash *and* version, so an
 *   analysis produced against the first `A` stays stale.
 */
import { DomainError, invariant } from './errors.js';
import { assertIsoTimestamp, snapshotIdOf } from './ids.js';
import { deepFreeze } from './immutable.js';
import { contentHashOf } from './hash.js';
import { createNormalizedProblem, type NormalizedProblem } from './problem.js';
import { createEditorialSolution, type EditorialSolution, type EditorialSource } from './editorial.js';

export const PROBLEM_SNAPSHOT_SCHEMA_VERSION = 1;

/** Identifies the snapshot a result was produced against. */
export interface SnapshotHead {
  readonly snapshotId: string;
  readonly contentHash: string;
  readonly version: number;
}

export interface ProblemSnapshot {
  /** `problemKey@contentHash:v<version>` — identity includes the version (see `snapshotIdOf`). */
  readonly snapshotId: string;
  readonly schemaVersion: number;
  /** Monotonic per problem; increases only when content actually changed. */
  readonly version: number;
  readonly contentHash: string;
  readonly capturedAt: string;
  readonly problem: NormalizedProblem;
  readonly sources: readonly EditorialSource[];
  readonly solutions: readonly EditorialSolution[];
}

export interface CreateProblemSnapshotInput {
  readonly problem: NormalizedProblem;
  readonly sources?: readonly EditorialSource[];
  readonly solutions?: readonly EditorialSolution[];
  readonly capturedAt: string;
  /** Previous snapshot of the same problem, if any (drives version numbering). */
  readonly previous?: ProblemSnapshot | null;
}

/** Semantic content used for hashing: stable fields only, key order independent. */
function hashableContent(
  problem: NormalizedProblem,
  sources: readonly EditorialSource[],
  solutions: readonly EditorialSolution[],
): unknown {
  return {
    problem: {
      key: problem.key,
      title: problem.title,
      url: problem.url,
    statement: problem.statement,
      ratings: problem.ratings.map((rating) => ({
        dimension: rating.dimension,
        value: rating.value,
        raw: rating.raw,
        scale: rating.scale,
      })),
      rawTags: problem.rawTags.map((tag) => ({ raw: tag.raw, sourceInstanceId: tag.sourceInstanceId })),
    },
    sources: sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      url: source.url,
      title: source.title,
      author: source.author,
      language: source.language,
      publishedAt: source.publishedAt,
      availability: source.availability,
      contentHash: source.contentHash,
    })),
    solutions: solutions.map((solution) => ({
      solutionId: solution.solutionId,
      sourceId: solution.sourceId,
      ordinal: solution.ordinal,
      title: solution.title,
      contentHash: solution.contentHash,
      language: solution.language,
    })),
  };
}

/** Content hash of a candidate snapshot body. */
export function computeSnapshotContentHash(
  problem: NormalizedProblem,
  sources: readonly EditorialSource[] = [],
  solutions: readonly EditorialSolution[] = [],
): string {
  return contentHashOf(hashableContent(problem, sources, solutions));
}

/**
 * Clone a problem into snapshot-owned memory. Rebuilt through the public constructor so a
 * snapshot never freezes state the adapter still holds a reference to.
 */
function cloneProblem(problem: NormalizedProblem): NormalizedProblem {
  return createNormalizedProblem({
    ref: problem.ref,
    title: problem.title,
    url: problem.url,
    statement: problem.statement,
    fetchedAt: problem.fetchedAt,
    ratings: problem.ratings.map((rating) => ({
      dimension: rating.dimension,
      value: rating.value,
      scale: rating.scale ? { min: rating.scale.min, max: rating.scale.max } : null,
      raw: rating.raw,
    })),
    rawTags: problem.rawTags.map((tag) => tag.raw),
  });
}

/**
 * Clone a source record into snapshot-owned memory.
 *
 * Unlike the problem, a source keeps its retrieved body out of the snapshot: only the
 * content hash travels with it. The clone is therefore a field-by-field copy (never a
 * shared reference) plus a consistency check that a `found` source really carries a body
 * hash — an adapter cannot smuggle in "found but empty" through the snapshot path.
 */
function cloneSource(source: EditorialSource): EditorialSource {
  invariant(
    source.availability !== 'found' || source.contentHash !== null,
    'invalid_input',
    `found editorial source ${source.id} must carry a content hash`,
    { id: source.id },
  );
  return deepFreeze({
    id: source.id,
    kind: source.kind,
    url: source.url,
    title: source.title,
    author: source.author,
    language: source.language,
    publishedAt: source.publishedAt,
    retrievedAt: source.retrievedAt,
    availability: source.availability,
    contentHash: source.contentHash,
    note: source.note,
  } satisfies EditorialSource);
}

function cloneSolution(solution: EditorialSolution): EditorialSolution {
  return createEditorialSolution({
    solutionId: solution.solutionId,
    sourceId: solution.sourceId,
    ordinal: solution.ordinal,
    title: solution.title,
    text: solution.text,
    language: solution.language,
  });
}

function validateEditorial(
  problem: NormalizedProblem,
  sources: readonly EditorialSource[],
  solutions: readonly EditorialSolution[],
): void {
  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (sourceIds.has(source.id)) {
      throw new DomainError('duplicate_id', `duplicate editorial source id ${source.id}`, { id: source.id });
    }
    sourceIds.add(source.id);
  }
  const solutionIds = new Set<string>();
  for (const solution of solutions) {
    if (solutionIds.has(solution.solutionId)) {
      throw new DomainError('duplicate_id', `duplicate solution id ${solution.solutionId}`, {
        solutionId: solution.solutionId,
      });
    }
    solutionIds.add(solution.solutionId);
    if (!sourceIds.has(solution.sourceId)) {
      throw new DomainError(
        'missing_reference',
        `solution ${solution.solutionId} references unknown source ${solution.sourceId}`,
        { solutionId: solution.solutionId, sourceId: solution.sourceId },
      );
    }
  }
  invariant(problem.key.length > 0, 'invalid_input', 'snapshot problem must have a key');
}

/**
 * Create a frozen snapshot. The version is `previous.version` when the semantic content is
 * unchanged, otherwise `previous.version + 1`; a first snapshot starts at 1.
 *
 * A `previous` snapshot from a *different* problem is rejected: version numbering is
 * per problem, and silently continuing another problem's sequence would make stale-result
 * checks meaningless.
 *
 * The returned `snapshotId` includes that version (see {@link snapshotIdOf}), so snapshots
 * that merely return to an earlier content hash are still distinct persisted objects with
 * distinct analysis jobs.
 */
export function createProblemSnapshot(input: CreateProblemSnapshotInput): ProblemSnapshot {
  const previous = input.previous ?? null;
  if (previous && previous.problem.key !== input.problem.key) {
    throw new DomainError('invalid_input', 'previous snapshot belongs to a different problem', {
      previous: previous.problem.key,
      problem: input.problem.key,
    });
  }
  const problem = cloneProblem(input.problem);
  const sources = (input.sources ?? []).map(cloneSource);
  const solutions = (input.solutions ?? []).map(cloneSolution);
  validateEditorial(problem, sources, solutions);
  const contentHash = computeSnapshotContentHash(problem, sources, solutions);
  const version = nextSnapshotVersion(previous, contentHash);
  const capturedAt = assertIsoTimestamp('capturedAt', input.capturedAt);
  return deepFreeze({
    snapshotId: snapshotIdOf(problem.ref, contentHash, version),
    schemaVersion: PROBLEM_SNAPSHOT_SCHEMA_VERSION,
    version,
    contentHash,
    capturedAt,
    problem,
    sources,
    solutions,
  });
}

/** Version rule for a new snapshot body given the previous snapshot. */
export function nextSnapshotVersion(previous: ProblemSnapshot | null, contentHash: string): number {
  if (!previous) {
    return 1;
  }
  if (previous.contentHash === contentHash) {
    return previous.version;
  }
  return previous.version + 1;
}

/** Head descriptor for staleness comparisons. */
export function snapshotHead(snapshot: Pick<ProblemSnapshot, 'snapshotId' | 'contentHash' | 'version'>): SnapshotHead {
  return { snapshotId: snapshot.snapshotId, contentHash: snapshot.contentHash, version: snapshot.version };
}

/**
 * True when `head` no longer describes the current snapshot of its problem.
 *
 * All three of id, hash and version must match. The version is compared explicitly as well
 * as being part of the id, so `A -> B -> A` is stale under every comparison a caller may
 * make: the third snapshot has the same content hash as the first but a higher version.
 */
export function isSnapshotStale(head: SnapshotHead, current: SnapshotHead | null | undefined): boolean {
  if (!current) {
    return true;
  }
  return (
    head.snapshotId !== current.snapshotId ||
    head.contentHash !== current.contentHash ||
    head.version !== current.version
  );
}

/** True when the stored snapshot still matches the given head. */
export function isSnapshotCurrent(
  snapshot: Pick<ProblemSnapshot, 'snapshotId' | 'contentHash' | 'version'>,
  current: SnapshotHead | null | undefined,
): boolean {
  return !isSnapshotStale(snapshotHead(snapshot), current);
}

/** Find a solution by id. */
export function findSolution(snapshot: ProblemSnapshot, solutionId: string): EditorialSolution | null {
  return snapshot.solutions.find((solution) => solution.solutionId === solutionId) ?? null;
}

/** Find a source by id. */
export function findSource(snapshot: ProblemSnapshot, sourceId: string): EditorialSource | null {
  return snapshot.sources.find((source) => source.id === sourceId) ?? null;
}

/** All solutions belonging to one source, ordered by `ordinal`. */
export function solutionsForSource(snapshot: ProblemSnapshot, sourceId: string): readonly EditorialSolution[] {
  return snapshot.solutions.filter((solution) => solution.sourceId === sourceId).sort((a, b) => a.ordinal - b.ordinal);
}

/** Sources that actually yielded editorial text. */
export function availableSources(snapshot: ProblemSnapshot): readonly EditorialSource[] {
  return snapshot.sources.filter((source) => source.availability === 'found');
}
