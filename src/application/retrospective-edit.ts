/**
 * Batch completion editing (Sprint 23a): `retro.list`, `retro.editPreview`, `retro.editApply`.
 *
 * Editing a recorded completion must never silently erase what the solver already recorded, so the
 * *latest* retrospective of one (account, problem) is the base of every edit: the completion mode
 * may change and explicitly confirmed skills may be added, but the note, the previously confirmed
 * taxonomy ids and the consulted solution ids are carried over. Adding skills is a union, never a
 * replacement, and switching to `independent` clears the consulted solution ids (reported as a count
 * before the write). Nothing here infers tags from platform labels or AI output, validates solution
 * ids against a snapshot, touches accepted submissions, or calls a model or a platform.
 *
 * Every read is batched: one account read, at most {@link MAX_RETROSPECTIVE_EDIT_KEYS} problem reads
 * and exactly one retrospective-history read, all inside one store transaction with a cancellation
 * check after every awaited call. The apply path regenerates the preview inside its own transaction
 * and refuses a hash that moved before the first write, so a stale screen can never overwrite a
 * newer completion record.
 */
import {
  COMPLETION_MODES,
  DomainError,
  assertKnownTag,
  contentHashOf,
  createRetrospective,
  invariant,
  latestRetrospectiveByProblem,
  problemKey as canonicalProblemKey,
  type Account,
  type CancellationToken,
  type CompletionMode,
  type NormalizedProblem,
  type Retrospective,
  type TaxonomyIndex,
} from '../domain/index.js';
import type { TrainingStore } from './ports.js';

/** Maximum distinct problem keys one batch read or edit accepts. */
export const MAX_RETROSPECTIVE_EDIT_KEYS = 100;

/**
 * Maximum accepted ids of one add intent.
 *
 * It mirrors `MAX_RETROSPECTIVE_IDS` of the service boundary (the focused test asserts the two are
 * equal) so the edit path can never accept a longer list than `retro.record`.
 */
export const MAX_RETROSPECTIVE_EDIT_IDS = 500;

/**
 * How explicitly confirmed skills of an edit are applied.
 *
 * `preserve` (the default) keeps exactly the taxonomy ids of the previous record; `add` unions the
 * caller-confirmed ids into them. Raw platform tags and AI suggestions are never a source here: the
 * `add` list is the user's own statement of skills used on *every* selected problem.
 */
export type RetrospectiveKnowledgeIntent =
  | { readonly kind: 'preserve' }
  | { readonly kind: 'add'; readonly taxonomyIds: readonly string[] };

export interface RetrospectiveEditListRequest {
  readonly accountId: string;
  readonly problemKeys: readonly string[];
}

/** One problem's latest completion record; `null` fields mean "no record yet". Never a spoiler. */
export interface RetrospectiveEditListEntry {
  readonly problemKey: string;
  readonly title: string;
  readonly mode: CompletionMode | null;
  readonly retrospectiveId: string | null;
  readonly recordedAt: string | null;
}

export interface RetrospectiveEditListResult {
  readonly accountId: string;
  readonly items: readonly RetrospectiveEditListEntry[];
}

/** One intended completion edit: mode plus how the existing skills are treated. */
export interface RetrospectiveEditRequest {
  readonly accountId: string;
  readonly problemKeys: readonly string[];
  readonly mode: CompletionMode;
  readonly knowledge?: RetrospectiveKnowledgeIntent | null;
}

/** Same intent, bound to the hash of the preview the caller actually saw. */
export interface RetrospectiveEditApplyRequest extends RetrospectiveEditRequest {
  readonly expectedPreviewHash: string;
}

/**
 * What one selected problem would become.
 *
 * Only counts and the caller's own added ids travel: the previous taxonomy ids, the note and the
 * consulted solution ids are deliberately not exposed, so the preview cannot leak worked material.
 */
export interface RetrospectiveEditPreviewEntry {
  readonly problemKey: string;
  readonly title: string;
  readonly previousMode: CompletionMode | null;
  readonly nextMode: CompletionMode;
  readonly changed: boolean;
  readonly existingTaxonomyCount: number;
  readonly addedTaxonomyIds: readonly string[];
  readonly clearedSolutionCount: number;
}

export interface RetrospectiveEditPreviewResult {
  readonly accountId: string;
  readonly mode: CompletionMode;
  /** Content hash of the exact intent and records this preview was computed from. */
  readonly previewHash: string;
  readonly items: readonly RetrospectiveEditPreviewEntry[];
  readonly changedCount: number;
  readonly unchangedCount: number;
}

/** One applied (or deliberately untouched) problem after the batch write. */
export interface RetrospectiveEditApplyEntry {
  readonly problemKey: string;
  readonly mode: CompletionMode;
  readonly retrospectiveId: string | null;
  readonly recordedAt: string | null;
  readonly changed: boolean;
}

export interface RetrospectiveEditApplyResult {
  readonly accountId: string;
  readonly changedCount: number;
  readonly unchangedCount: number;
  readonly items: readonly RetrospectiveEditApplyEntry[];
}

/** Injected dependencies; `WorkbenchService` passes its own store, vocabulary and clock. */
export interface RetrospectiveEditDeps {
  readonly store: TrainingStore;
  readonly taxonomy: TaxonomyIndex;
  readonly now: () => string;
}

const PRESERVE_KNOWLEDGE: NormalizedKnowledge = { kind: 'preserve', taxonomyIds: [] };

interface NormalizedKnowledge {
  readonly kind: 'preserve' | 'add';
  /** Deduplicated, sorted, known, non-category ids; empty for `preserve`. */
  readonly taxonomyIds: readonly string[];
}

interface ParsedEditRequest {
  readonly accountId: string;
  readonly problemKeys: readonly string[];
  readonly mode: CompletionMode;
  readonly knowledge: NormalizedKnowledge;
}

interface EditBatch {
  readonly account: Account;
  readonly problems: readonly NormalizedProblem[];
  /** Latest retrospective per `accountId|problemKey`, from one history read. */
  readonly latest: ReadonlyMap<string, Retrospective>;
}

interface PlannedItem {
  readonly problem: NormalizedProblem;
  readonly latest: Retrospective | null;
  readonly nextMode: CompletionMode;
  readonly taxonomyIds: readonly string[];
  readonly solutionIds: readonly string[];
  readonly addedTaxonomyIds: readonly string[];
  readonly clearedSolutionCount: number;
  readonly changed: boolean;
}

interface BuiltPreview {
  readonly result: RetrospectiveEditPreviewResult;
  readonly planned: readonly PlannedItem[];
}

/** Latest completion record of up to 100 same-source problems of one account, in one read. */
export async function listRetrospectiveEdits(
  deps: RetrospectiveEditDeps,
  request: RetrospectiveEditListRequest,
  token: CancellationToken,
): Promise<RetrospectiveEditListResult> {
  requireToken(token);
  token.throwIfCancelled();
  const parsed = parseListRequest(request);
  return deps.store.transaction(async (): Promise<RetrospectiveEditListResult> => {
    token.throwIfCancelled();
    const batch = await readEditBatch(deps, parsed.accountId, parsed.problemKeys, token);
    return {
      accountId: batch.account.id,
      items: batch.problems.map((problem) => {
        const latest = batch.latest.get(latestKey(batch.account.id, problem.key)) ?? null;
        return {
          problemKey: problem.key,
          title: problem.title,
          mode: latest?.mode ?? null,
          retrospectiveId: latest?.retrospectiveId ?? null,
          recordedAt: latest?.recordedAt ?? null,
        };
      }),
    };
  });
}

/** Pure preview of one batch edit; writes nothing and persists no preview state. */
export async function previewRetrospectiveEdits(
  deps: RetrospectiveEditDeps,
  request: RetrospectiveEditRequest,
  token: CancellationToken,
): Promise<RetrospectiveEditPreviewResult> {
  requireToken(token);
  token.throwIfCancelled();
  const parsed = parseEditRequest(deps.taxonomy, request);
  return deps.store.transaction(async (): Promise<RetrospectiveEditPreviewResult> => {
    token.throwIfCancelled();
    const batch = await readEditBatch(deps, parsed.accountId, parsed.problemKeys, token);
    return buildEditPreview(batch, parsed).result;
  });
}

/**
 * Apply one previewed batch edit inside a single transaction.
 *
 * The preview is regenerated from a fresh one-history read inside this transaction; a hash that no
 * longer matches throws {@link DomainError} `invalid_transition` with reason `stale_preview` before
 * any row is written. Only changed problems get an appended row, so a no-op input writes no duplicate.
 */
export async function applyRetrospectiveEdits(
  deps: RetrospectiveEditDeps,
  request: RetrospectiveEditApplyRequest,
  token: CancellationToken,
): Promise<RetrospectiveEditApplyResult> {
  requireToken(token);
  token.throwIfCancelled();
  const expectedPreviewHash = requirePreviewHash(request);
  const parsed = parseEditRequest(deps.taxonomy, request);
  return deps.store.transaction(async (): Promise<RetrospectiveEditApplyResult> => {
    token.throwIfCancelled();
    const batch = await readEditBatch(deps, parsed.accountId, parsed.problemKeys, token);
    const preview = buildEditPreview(batch, parsed);
    token.throwIfCancelled();
    if (preview.result.previewHash !== expectedPreviewHash) {
      throw new DomainError('invalid_transition', 'the completion edit preview is stale', {
        reason: 'stale_preview',
        accountId: batch.account.id,
        expectedPreviewHash,
        actualPreviewHash: preview.result.previewHash,
      });
    }

    const items: RetrospectiveEditApplyEntry[] = [];
    let changedCount = 0;
    for (const planned of preview.planned) {
      token.throwIfCancelled();
      const latest = planned.latest;
      if (!planned.changed && latest !== null) {
        items.push({
          problemKey: planned.problem.key,
          mode: latest.mode,
          retrospectiveId: latest.retrospectiveId,
          recordedAt: latest.recordedAt,
          changed: false,
        });
        continue;
      }
      const retrospective = createRetrospective({
        problemRef: planned.problem.ref,
        accountId: batch.account.id,
        mode: planned.nextMode,
        recordedAt: monotonicInstant(latest?.recordedAt ?? null, deps.now()),
        taxonomyIds: planned.taxonomyIds,
        solutionIds: planned.solutionIds,
        note: latest?.note ?? null,
      });
      await deps.store.saveRetrospective(retrospective);
      token.throwIfCancelled();
      changedCount += 1;
      items.push({
        problemKey: planned.problem.key,
        mode: retrospective.mode,
        retrospectiveId: retrospective.retrospectiveId,
        recordedAt: retrospective.recordedAt,
        changed: true,
      });
    }
    return {
      accountId: batch.account.id,
      changedCount,
      unchangedCount: items.length - changedCount,
      items,
    };
  });
}

/** One account plus its problems and the single history read every edit is based on. */
async function readEditBatch(
  deps: RetrospectiveEditDeps,
  accountId: string,
  problemKeys: readonly string[],
  token: CancellationToken,
): Promise<EditBatch> {
  const account = await deps.store.getAccount(accountId);
  token.throwIfCancelled();
  if (account === null) {
    throw new DomainError('missing_reference', `account ${accountId} is not stored`, { accountId });
  }
  const problems: NormalizedProblem[] = [];
  for (const key of problemKeys) {
    const problem = await deps.store.getProblem(key);
    token.throwIfCancelled();
    if (problem === null) {
      throw new DomainError('missing_reference', `problem ${key} is not stored`, { problemKey: key });
    }
    assertProblemCoherent(problem, key, account);
    problems.push(problem);
  }
  const history = await deps.store.listRetrospectives(account.id);
  token.throwIfCancelled();
  return { account, problems, latest: latestRetrospectiveByProblem(history) };
}

/** Pure projection of one batch: next mode, unioned skills, preserved note and solution ids. */
function buildEditPreview(batch: EditBatch, parsed: ParsedEditRequest): BuiltPreview {
  const planned = batch.problems.map((problem): PlannedItem => {
    const latest = batch.latest.get(latestKey(batch.account.id, problem.key)) ?? null;
    if (latest !== null && latest.accountId !== batch.account.id) {
      throw new DomainError('invalid_input', `stored retrospective ${latest.retrospectiveId} belongs to another account`, {
        reason: 'retrospective_account_mismatch',
        retrospectiveId: latest.retrospectiveId,
      });
    }
    const existing = new Set(latest?.taxonomyIds ?? []);
    const addedTaxonomyIds = parsed.knowledge.taxonomyIds.filter((id) => !existing.has(id));
    const clearedSolutionCount = parsed.mode === 'independent' ? (latest?.solutionIds.length ?? 0) : 0;
    return {
      problem: problem,
      latest,
      nextMode: parsed.mode,
      taxonomyIds: [...(latest?.taxonomyIds ?? []), ...addedTaxonomyIds],
      // Consulted solutions survive an assisted/solution_used edit even when the stored snapshot
      // moved on; only an explicit switch to independent clears them.
      solutionIds: parsed.mode === 'independent' ? [] : [...(latest?.solutionIds ?? [])],
      addedTaxonomyIds,
      clearedSolutionCount,
      changed:
        latest === null || latest.mode !== parsed.mode || addedTaxonomyIds.length > 0 || clearedSolutionCount > 0,
    };
  });
  const items = planned.map((item): RetrospectiveEditPreviewEntry => ({
    problemKey: item.problem.key,
    title: item.problem.title,
    previousMode: item.latest?.mode ?? null,
    nextMode: item.nextMode,
    changed: item.changed,
    existingTaxonomyCount: item.latest?.taxonomyIds.length ?? 0,
    addedTaxonomyIds: item.addedTaxonomyIds,
    clearedSolutionCount: item.clearedSolutionCount,
  }));
  const changedCount = planned.filter((item) => item.changed).length;
  return {
    result: {
      accountId: batch.account.id,
      mode: parsed.mode,
      previewHash: previewHashOf(batch.account, parsed, planned),
      items,
      changedCount,
      unchangedCount: planned.length - changedCount,
    },
    planned,
  };
}

/**
 * Content hash binding an apply to the intent and the exact records the preview described.
 *
 * It covers the normalized intent, the account/source, each problem's identity and title and the
 * complete latest record; it deliberately excludes the *new* `recordedAt`, which the apply derives
 * from its own clock and which must not make a preview stale by itself.
 */
function previewHashOf(account: Account, parsed: ParsedEditRequest, planned: readonly PlannedItem[]): string {
  return contentHashOf({
    version: 'retrospective-edit.v1',
    accountId: account.id,
    sourceInstanceId: account.sourceInstanceId,
    mode: parsed.mode,
    knowledge: { kind: parsed.knowledge.kind, taxonomyIds: parsed.knowledge.taxonomyIds },
    items: planned.map((item) => ({
      problemKey: item.problem.key,
      sourceInstanceId: item.problem.ref.sourceInstanceId,
      domain: item.problem.ref.domain,
      externalKey: item.problem.ref.externalKey,
      title: item.problem.title,
      latest:
        item.latest === null
          ? null
          : {
              retrospectiveId: item.latest.retrospectiveId,
              mode: item.latest.mode,
              taxonomyIds: [...item.latest.taxonomyIds],
              solutionIds: [...item.latest.solutionIds],
              recordedAt: item.latest.recordedAt,
              note: item.latest.note,
            },
    })),
  });
}

function parseListRequest(request: RetrospectiveEditListRequest): {
  readonly accountId: string;
  readonly problemKeys: readonly string[];
} {
  invariant(request !== null && typeof request === 'object', 'invalid_input', 'a retrospective list needs a request object', {});
  const row = request as Partial<RetrospectiveEditListRequest>;
  return { accountId: requireAccountId(row.accountId), problemKeys: requireEditProblemKeys(row.problemKeys) };
}

function parseEditRequest(taxonomy: TaxonomyIndex, request: RetrospectiveEditRequest): ParsedEditRequest {
  invariant(request !== null && typeof request === 'object', 'invalid_input', 'a completion edit needs a request object', {});
  const row = request as Partial<RetrospectiveEditRequest>;
  return {
    accountId: requireAccountId(row.accountId),
    problemKeys: requireEditProblemKeys(row.problemKeys),
    mode: requireMode(row.mode),
    knowledge: normalizeKnowledge(taxonomy, row.knowledge),
  };
}

function requireAccountId(value: unknown): string {
  invariant(typeof value === 'string' && value.trim().length > 0, 'invalid_input', 'accountId is required', { value });
  return value.trim();
}

/**
 * 1..{@link MAX_RETROSPECTIVE_EDIT_KEYS} keys, deduplicated preserving order.
 *
 * The array bound is checked before the per-entry pass, so a huge array cannot force unbounded work.
 */
function requireEditProblemKeys(value: unknown): readonly string[] {
  invariant(Array.isArray(value), 'invalid_input', 'problemKeys must be an array of problem keys', { value });
  invariant(
    value.length >= 1 && value.length <= MAX_RETROSPECTIVE_EDIT_KEYS,
    'invalid_input',
    `problemKeys must hold 1..${MAX_RETROSPECTIVE_EDIT_KEYS} keys`,
    { length: value.length, bound: MAX_RETROSPECTIVE_EDIT_KEYS, reason: 'problem_key_list_out_of_bounds' },
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    invariant(typeof entry === 'string' && entry.trim().length > 0, 'invalid_input', 'problemKeys entries must be non-empty strings', { entry });
    const key = entry.trim();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

function requireMode(value: unknown): CompletionMode {
  invariant(
    typeof value === 'string' && COMPLETION_MODES.includes(value as CompletionMode),
    'invalid_input',
    `unknown completion mode ${String(value)}`,
    { mode: value },
  );
  return value as CompletionMode;
}

/** Default is `preserve`; `add` needs non-empty, known, non-category ids within the shared bound. */
function normalizeKnowledge(taxonomy: TaxonomyIndex, value: unknown): NormalizedKnowledge {
  if (value === undefined || value === null) {
    return PRESERVE_KNOWLEDGE;
  }
  invariant(typeof value === 'object' && !Array.isArray(value), 'invalid_input', 'knowledge must be an object', { value });
  const intent = value as Record<string, unknown>;
  if (intent['kind'] === 'preserve') {
    invariant(!Object.hasOwn(intent, 'taxonomyIds'), 'invalid_input', 'preserve knowledge carries no taxonomy ids', {
      reason: 'preserve_with_taxonomy_ids',
    });
    return PRESERVE_KNOWLEDGE;
  }
  invariant(intent['kind'] === 'add', 'invalid_input', `unknown knowledge kind ${String(intent['kind'])}`, {
    reason: 'unknown_knowledge_kind',
  });
  const ids = requireIdList('knowledge.taxonomyIds', intent['taxonomyIds']);
  invariant(ids.length > 0, 'invalid_input', 'add knowledge needs at least one confirmed skill', {
    reason: 'empty_taxonomy_ids',
  });
  const sorted = [...ids].sort();
  for (const id of sorted) {
    assertKnownTag(taxonomy, id);
    const node = taxonomy.node(id);
    invariant(
      node !== null && node.kind !== 'category',
      'invalid_input',
      `taxonomy id ${id} is not an editable skill`,
      { reason: 'category_taxonomy_id', taxonomyId: id },
    );
  }
  return { kind: 'add', taxonomyIds: sorted };
}

/** Opaque id list, deduplicated preserving order; the bound is checked before any dedup work. */
function requireIdList(name: string, value: unknown): readonly string[] {
  if (value === undefined || value === null) {
    return [];
  }
  invariant(Array.isArray(value), 'invalid_input', `${name} must be an array of ids`, { name });
  invariant(
    value.length <= MAX_RETROSPECTIVE_EDIT_IDS,
    'invalid_input',
    `${name} must hold at most ${MAX_RETROSPECTIVE_EDIT_IDS} ids`,
    { name, length: value.length, bound: MAX_RETROSPECTIVE_EDIT_IDS, reason: 'id_list_too_long' },
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    invariant(typeof entry === 'string' && entry.trim().length > 0, 'invalid_input', `${name} entries must be non-empty strings`, { name });
    const trimmed = entry.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function requirePreviewHash(request: RetrospectiveEditApplyRequest): string {
  invariant(
    typeof request.expectedPreviewHash === 'string' && request.expectedPreviewHash.length > 0,
    'invalid_input',
    'expectedPreviewHash is required',
    { reason: 'missing_preview_hash' },
  );
  return request.expectedPreviewHash;
}

/** Prove one stored problem really is the requested, same-source, canonical problem row. */
function assertProblemCoherent(problem: NormalizedProblem, key: string, account: Account): void {
  invariant(
    problem.key === key,
    'invalid_input',
    `stored problem metadata for ${key} reports key ${problem.key}`,
    { reason: 'problem_key_mismatch', accountId: account.id, expectedKey: key, storedKey: problem.key },
  );
  let canonical: string;
  try {
    canonical = canonicalProblemKey(problem.ref);
  } catch (error) {
    throw new DomainError('invalid_input', `problem ${problem.key} is not a canonical problem reference`, {
      reason: 'problem_key_mismatch',
      accountId: account.id,
      problemKey: problem.key,
      cause: String(error),
    });
  }
  invariant(canonical === problem.key, 'invalid_input', `problem ${problem.key} does not match its own reference`, {
    reason: 'problem_key_mismatch',
    accountId: account.id,
    problemKey: problem.key,
    canonicalKey: canonical,
  });
  invariant(
    problem.ref.sourceInstanceId === account.sourceInstanceId,
    'invalid_input',
    `problem ${problem.key} belongs to ${problem.ref.sourceInstanceId}, not to account ${account.id}`,
    {
      reason: 'problem_source_mismatch',
      accountId: account.id,
      accountSource: account.sourceInstanceId,
      problemSource: problem.ref.sourceInstanceId,
    },
  );
}

function latestKey(accountId: string, problemKey: string): string {
  return `${accountId}|${problemKey}`;
}

/** `now()`, or one millisecond after the previous record when the clock repeats. */
function monotonicInstant(previous: string | null, now: string): string {
  const at = Date.parse(now);
  invariant(Number.isFinite(at), 'invalid_input', 'now must be an ISO timestamp', { now });
  if (previous === null) {
    return new Date(at).toISOString();
  }
  const previousMs = Date.parse(previous);
  return at > previousMs ? new Date(at).toISOString() : new Date(previousMs + 1).toISOString();
}

function requireToken(token: CancellationToken | null | undefined): CancellationToken {
  invariant(
    token !== null && token !== undefined && typeof token.throwIfCancelled === 'function',
    'unfilled_settings',
    'a cancellation token is required',
    {},
  );
  return token;
}
