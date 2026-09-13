/**
 * Merged problem bank (Sprint Contract 08b): the `problem.mergedBrowse` use case.
 *
 * The merged bank answers one question the plain bank cannot: *which of these stored problems are the
 * same problem on two sites, and are they solved?* It reads one numbered page of groups from the
 * store (which groups by the domain's own identity rule before it counts, filters or pages) and then
 * **re-validates everything the store claimed** before it projects a single row:
 *
 * - every member must be the canonical problem its own reference names, must belong to the group's
 *   identity, and must name either no account or one of the selected accounts of its own source
 *   instance;
 * - every accepted evidence row is read back from storage by submission id and must be an accepted
 *   submission of that account, on that account's own source instance, for exactly the claimed
 *   canonical identity, and its reference must belong to the group;
 * - `solved` must be exactly "accepted evidence is non-empty", and a member may only claim its own
 *   direct AC when this account's own accepted evidence for that exact problem is present.
 *
 * Nothing here trusts a claimed `solved` flag: derived spoiler visibility (a member's raw platform
 * tags and effective taxonomy ids) is authorised by the member's **own** direct accepted submission
 * or by an explicit `reveal`, never by a linked solve on the other site. A linked solve is shown as
 * a banner (`solved` plus its safe evidence metadata) and nothing more. An incoherent claim is a
 * typed refusal instead of a silently smaller or more revealing answer.
 *
 * The service owns no clock and no store schema: `fetchedAt` comes from the store read, the page id
 * from the injected `uniqueId`, and the summary projection is supplied by {@link WorkbenchService}
 * so a merged member row is byte-identical to a `problem.browse` row.
 */
import {
  CF_MIRROR_REFERENCE_EXAMPLE_URL,
  CF_MIRROR_RULE_EXPLANATION,
  CF_MIRROR_RULE_ID,
  DomainError,
  invariant,
  isAccepted,
  mergedGroupKeyOf,
  problemGroupingOf,
  problemKey as canonicalProblemKey,
  type Account,
  type CancellationToken,
  type NormalizedProblem,
  type ProblemRef,
  type Submission,
} from '../domain/index.js';
import {
  BROWSE_PAGE_LIMITS,
  MAX_MERGED_BANK_ACCOUNTS,
  MAX_RATING_DIMENSION_CHARS,
  PROBLEM_SOLVED_FILTERS,
  PROBLEM_SORTS,
  RATING_SORTS,
  type MergedProblemEvidenceRow,
  type MergedProblemGroupRow,
  type MergedProblemMemberRow,
  type ProblemSolvedFilter,
  type ProblemSort,
  type TrainingStore,
} from './ports.js';
import type {
  WorkbenchAcceptedEvidenceView,
  WorkbenchMergedBrowsePage,
  WorkbenchMergedEquivalenceRuleView,
  WorkbenchMergedProblemGroup,
  WorkbenchMergedProblemMember,
  WorkbenchProblemSummary,
} from './workbench-types.js';

/**
 * Longest accepted merged-bank search term.
 *
 * The same literal bound as the bank's own `MAX_PROBLEM_QUERY_CHARS`; it is restated here because
 * this module must not import the workbench service (which delegates *to* this service), and the
 * store re-checks the bound anyway.
 */
export const MAX_MERGED_QUERY_CHARS = 200;

/** The equivalence rules this service knows, stated once per response. */
const MERGED_BANK_RULES: readonly WorkbenchMergedEquivalenceRuleView[] = [
  {
    ruleId: CF_MIRROR_RULE_ID,
    explanation: CF_MIRROR_RULE_EXPLANATION,
    referenceExampleUrl: CF_MIRROR_REFERENCE_EXAMPLE_URL,
  },
];

/**
 * Merged-bank page request: the same bank, grouped by problem identity over the selected accounts.
 *
 * `accountIds` selects the accounts whose solved state is projected (at most one per source
 * instance); `sourceInstanceId` is an independent display filter (groups having a member from that
 * instance) and the difficulty source of a difficulty sort. An empty selection is legal for the
 * unfiltered read; `status` and `onlyAttempted` are refused without at least one account.
 */
export interface MergedBankBrowseRequest {
  readonly accountIds?: readonly string[];
  readonly sourceInstanceId?: string | null;
  readonly status?: ProblemSolvedFilter | null;
  readonly onlyAttempted?: boolean;
  readonly query?: string | null;
  readonly sort?: ProblemSort | null;
  readonly ratingDimension?: string | null;
  /** 1-based page number. */
  readonly page: number;
  /** Page size within `1..MAX_BROWSE_PAGE_SIZE`. */
  readonly limit: number;
  /** Explicitly show tags of members this account has not solved directly. */
  readonly reveal?: boolean;
}

/**
 * One member summary projection, supplied by the workbench service.
 *
 * Signature matches the service's own private `projectSummary`, so a merged row cannot drift from a
 * `problem.browse` row: `solved` authorises derived spoiler material, `visible` decides it, and
 * `pendingReview` is `null` on this operation because no review filter runs here.
 */
export type MergedSummaryProjection = (
  problem: NormalizedProblem,
  solved: boolean,
  visible: boolean,
  pendingReview: boolean,
  token: CancellationToken,
) => Promise<WorkbenchProblemSummary>;

export interface MergedBankServiceOptions {
  readonly store: TrainingStore;
  readonly uniqueId: () => string;
  readonly projectSummary: MergedSummaryProjection;
}

/** Normalized request: every optional member resolved to a concrete value. */
interface MergedBankFilters {
  readonly accountIds: readonly string[];
  readonly sourceInstanceId: string | null;
  readonly status: ProblemSolvedFilter;
  readonly onlyAttempted: boolean;
  readonly query: string | null;
  readonly sort: ProblemSort;
  readonly ratingDimension: string | null;
  readonly page: number;
  readonly limit: number;
  readonly reveal: boolean;
}

/** One merged-bank read; see the module doc for the re-validation it performs. */
export class MergedBankService {
  private readonly store: TrainingStore;
  private readonly uniqueId: () => string;
  private readonly projectSummary: MergedSummaryProjection;

  constructor(options: MergedBankServiceOptions) {
    if (options === null || typeof options !== 'object') {
      throw new DomainError('unfilled_settings', 'merged bank service needs an options object', {});
    }
    if (options.store === null || typeof options.store !== 'object') {
      throw new DomainError('unfilled_settings', 'merged bank service needs a TrainingStore', {});
    }
    if (typeof options.uniqueId !== 'function') {
      throw new DomainError('unfilled_settings', 'merged bank service needs an injected uniqueId()', {});
    }
    if (typeof options.projectSummary !== 'function') {
      throw new DomainError('unfilled_settings', 'merged bank service needs a summary projection', {});
    }
    this.store = options.store;
    this.uniqueId = options.uniqueId;
    this.projectSummary = options.projectSummary;
  }

  /**
   * One numbered page of the merged bank.
   *
   * The account resolution, the store read and the re-validation share ONE store transaction, so the
   * accounts, the groups and the evidence they are checked against are a single serialized read: a
   * concurrent write can never pair a stale evidence row with a fresh group inside one response.
   * Cancellation is checked after every await, so a cancelled read stops before projecting a page.
   */
  async browse(request: MergedBankBrowseRequest, token: CancellationToken): Promise<WorkbenchMergedBrowsePage> {
    requireMergedToken(token);
    token.throwIfCancelled();
    const filters = parseMergedBankRequest(request);
    const stored = await this.store.transaction(async () => {
      token.throwIfCancelled();
      const accounts = await this.resolveAccounts(filters.accountIds, token);
      const page = await this.store.browseMergedProblems({
        accountIds: accounts.map((account) => account.id),
        sourceInstanceId: filters.sourceInstanceId,
        status: filters.status,
        onlyAttempted: filters.onlyAttempted,
        query: filters.query,
        sort: filters.sort,
        ratingDimension: filters.ratingDimension,
        page: filters.page,
        limit: filters.limit,
      });
      token.throwIfCancelled();
      const selected = new Map(accounts.map((account) => [account.id, account]));
      const items: WorkbenchMergedProblemGroup[] = [];
      const seen = new Set<string>();
      for (const group of page.items) {
        invariant(
          !seen.has(group.groupKey),
          'invalid_input',
          `merged page returned group ${group.groupKey} twice`,
          { reason: 'duplicate_merged_group', groupKey: group.groupKey },
        );
        seen.add(group.groupKey);
        items.push(await this.projectGroup(group, selected, filters.reveal, token));
      }
      return {
        items,
        page: page.page,
        pageSize: page.pageSize,
        totalItems: page.totalItems,
        totalPages: page.totalPages,
        fetchedAt: page.fetchedAt,
      };
    });
    return {
      pageId: this.mintId(),
      ...stored,
      reveal: filters.reveal,
      equivalenceRules: MERGED_BANK_RULES,
    };
  }

  /**
   * Resolve the selected accounts, refusing a repeated id and two accounts of one source instance.
   *
   * A merged read asks what *these* people solved; two accounts of one instance would silently
   * double-count one person, and an unknown id has no solved state to report, so both are refusals
   * rather than quietly dropped selections.
   */
  private async resolveAccounts(accountIds: readonly string[], token: CancellationToken): Promise<readonly Account[]> {
    const byInstance = new Map<string, Account>();
    for (const accountId of accountIds) {
      const account = await this.store.getAccount(accountId);
      token.throwIfCancelled();
      if (account === null) {
        throw new DomainError('missing_reference', `account ${accountId} is not stored`, { accountId });
      }
      const existing = byInstance.get(account.sourceInstanceId);
      invariant(
        existing === undefined,
        'invalid_input',
        `accounts ${existing?.id ?? ''} and ${account.id} both belong to ${account.sourceInstanceId}; a merged read selects at most one account per source instance`,
        {
          reason: 'duplicate_account_source',
          sourceInstanceId: account.sourceInstanceId,
          accountIds: [existing?.id ?? null, account.id],
        },
      );
      byInstance.set(account.sourceInstanceId, account);
    }
    return [...byInstance.values()];
  }

  /** Re-validate one stored group and project it field by field. */
  private async projectGroup(
    group: MergedProblemGroupRow,
    accounts: ReadonlyMap<string, Account>,
    reveal: boolean,
    token: CancellationToken,
  ): Promise<WorkbenchMergedProblemGroup> {
    assertMergedGroupShape(group);
    const evidence: WorkbenchAcceptedEvidenceView[] = [];
    const byAccountProblem = new Set<string>();
    for (const row of group.acceptedEvidence) {
      assertEvidenceShape(row);
      token.throwIfCancelled();
      const account = accounts.get(row.accountId);
      invariant(
        account !== undefined,
        'invalid_input',
        `merged evidence ${row.submissionId} names account ${row.accountId}, which is not selected`,
        { reason: 'merged_evidence_foreign_account', accountId: row.accountId, submissionId: row.submissionId },
      );
      // The submission is read back from storage: identity, verdict and time must all match what the
      // store claimed, so a fabricated evidence record cannot reveal a linked solve.
      const submission = await this.store.getSubmission(row.submissionId);
      token.throwIfCancelled();
      assertEvidenceMatchesStorage(group.groupKey, row, submission, account);
      const pair = evidencePair(row.accountId, row.problemKey);
      invariant(
        !byAccountProblem.has(pair),
        'invalid_input',
        `merged group ${group.groupKey} carries more than one accepted evidence row for account ${row.accountId} and problem ${row.problemKey}`,
        { reason: 'duplicate_merged_evidence', groupKey: group.groupKey, accountId: row.accountId, problemKey: row.problemKey },
      );
      byAccountProblem.add(pair);
      evidence.push({
        accountId: row.accountId,
        problemKey: row.problemKey,
        sourceInstanceId: row.sourceInstanceId,
        externalKey: row.externalKey,
        submissionId: row.submissionId,
        submittedAt: row.submittedAt,
      });
    }
    invariant(
      group.solved === evidence.length > 0,
      'invalid_input',
      `merged group ${group.groupKey} claims solved=${String(group.solved)} with ${evidence.length} accepted evidence row(s)`,
      { reason: 'merged_solved_without_evidence', groupKey: group.groupKey, solved: group.solved, evidence: evidence.length },
    );
    invariant(
      typeof group.attempted === 'boolean',
      'invalid_input',
      `merged group ${group.groupKey} reports a non-boolean attempted flag`,
      { reason: 'merged_attempted_invalid', groupKey: group.groupKey },
    );
    const members: WorkbenchMergedProblemMember[] = [];
    for (const member of group.members) {
      assertMergedMemberShape(group, member, accounts);
      if (member.solvedByAccount) {
        // A member's own direct AC is only believed when this account's own accepted evidence for
        // exactly this problem is present; a linked solve never authorises a member's spoilers.
        invariant(
          member.accountId !== null && byAccountProblem.has(evidencePair(member.accountId, member.problem.key)),
          'invalid_input',
          `merged member ${member.problem.key} is reported solved without this account's own accepted submission`,
          {
            reason: 'merged_member_solved_without_evidence',
            groupKey: group.groupKey,
            problemKey: member.problem.key,
            accountId: member.accountId,
          },
        );
      }
      const visible = member.solvedByAccount || reveal;
      members.push({
        problem: await this.projectSummary(member.problem, member.solvedByAccount, visible, false, token),
        accountId: member.accountId,
      });
      token.throwIfCancelled();
    }
    return {
      groupKey: group.groupKey,
      members,
      solved: evidence.length > 0,
      attempted: group.attempted,
      acceptedEvidence: evidence,
      mappingKind: group.mappingKind,
    };
  }

  private mintId(): string {
    const value = this.uniqueId();
    invariant(
      typeof value === 'string' && value.trim().length > 0,
      'invalid_input',
      'uniqueId() must return a non-empty string',
      { value },
    );
    return value;
  }
}

// ---------------------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------------------

/** Every declared member, validated without coercion; unknown keys are refused by the API boundary. */
function parseMergedBankRequest(request: MergedBankBrowseRequest): MergedBankFilters {
  invariant(
    request !== null && typeof request === 'object',
    'invalid_input',
    'problem.mergedBrowse needs a request object',
    {},
  );
  const accountIds = requireMergedAccountIds(request.accountIds);
  const sourceInstanceId = optionalMergedId('sourceInstanceId', request.sourceInstanceId);
  const status = requireMergedSolvedFilter(request.status);
  const onlyAttempted = optionalMergedFlag('onlyAttempted', request.onlyAttempted);
  invariant(
    status === 'all' || accountIds.length > 0,
    'invalid_input',
    'a solved-state filter needs at least one selected account id; solved status is relative to the selected accounts',
    { reason: 'status_without_account', status },
  );
  invariant(
    !onlyAttempted || accountIds.length > 0,
    'invalid_input',
    'onlyAttempted needs at least one selected account id; there is no account whose attempts could be listed',
    { reason: 'only_attempted_without_account' },
  );
  const sort = requireMergedSort(request.sort);
  const ratingDimension = requireMergedRatingDimension(request.ratingDimension);
  if (RATING_SORTS.includes(sort)) {
    invariant(
      sourceInstanceId !== null,
      'invalid_input',
      'a difficulty sort needs an explicit source instance id; a rating is only comparable inside one',
      { reason: 'rating_source_required', sort },
    );
    invariant(
      ratingDimension !== null,
      'invalid_input',
      `a difficulty sort needs a rating dimension of 1..${MAX_RATING_DIMENSION_CHARS} characters`,
      { reason: 'rating_dimension_required', sort },
    );
  }
  return {
    accountIds,
    sourceInstanceId,
    status,
    onlyAttempted,
    query: normalizeMergedQuery(request.query),
    sort,
    ratingDimension: RATING_SORTS.includes(sort) ? ratingDimension : null,
    page: requireMergedPage(request.page),
    limit: requireMergedLimit(request.limit),
    reveal: optionalMergedFlag('reveal', request.reveal),
  };
}

/**
 * Selected accounts: an optional array of distinct, non-empty ids, bounded before any lookup.
 *
 * The array is bounded and dedup-checked before a single account is read, so a huge or repetitive
 * selection cannot force unbounded work; a repeated id is refused instead of collapsed, because a
 * caller that selected the same account twice is describing a different request than the one served.
 */
function requireMergedAccountIds(value: readonly string[] | null | undefined): readonly string[] {
  if (value === undefined || value === null) {
    return [];
  }
  invariant(Array.isArray(value), 'invalid_input', 'accountIds must be an array of account ids', { value });
  invariant(
    value.length <= MAX_MERGED_BANK_ACCOUNTS,
    'invalid_input',
    `accountIds must hold at most ${MAX_MERGED_BANK_ACCOUNTS} ids`,
    { reason: 'too_many_accounts', length: value.length, bound: MAX_MERGED_BANK_ACCOUNTS },
  );
  const seen = new Set<string>();
  for (const entry of value) {
    invariant(
      typeof entry === 'string' && entry.length > 0,
      'invalid_input',
      'accountIds entries must be non-empty strings',
      { entry },
    );
    invariant(!seen.has(entry), 'invalid_input', `accountIds names account ${entry} twice`, {
      reason: 'duplicate_account',
      accountId: entry,
    });
    seen.add(entry);
  }
  return [...value];
}

/** Optional opaque id: omitted/`null` means "no scope", a non-empty string is passed through. */
function optionalMergedId(name: string, value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  invariant(typeof value === 'string' && value.length > 0, 'invalid_input', `${name} must be a non-empty string`, {
    name,
    value,
  });
  return value;
}

/** Optional flag: omitted/`null` is `false`, anything that is not a boolean is rejected. */
function optionalMergedFlag(name: string, value: boolean | null | undefined): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  invariant(typeof value === 'boolean', 'invalid_input', `${name} must be a boolean when present`, { name, value });
  return value;
}

/** Solved-state filter: omitted/`null` means `all`; an unknown value is refused, never coerced. */
function requireMergedSolvedFilter(value: ProblemSolvedFilter | null | undefined): ProblemSolvedFilter {
  if (value === undefined || value === null) {
    return 'all';
  }
  invariant(
    PROBLEM_SOLVED_FILTERS.includes(value),
    'invalid_input',
    `status must be one of: ${PROBLEM_SOLVED_FILTERS.join(', ')}`,
    { status: value },
  );
  return value;
}

/** Sort: omitted/`null` is the canonical-key ascending order of the plain bank. */
function requireMergedSort(value: ProblemSort | null | undefined): ProblemSort {
  if (value === undefined || value === null) {
    return 'default';
  }
  invariant(PROBLEM_SORTS.includes(value), 'invalid_input', `sort must be one of: ${PROBLEM_SORTS.join(', ')}`, {
    sort: value,
  });
  return value;
}

/** Raw rating dimension of a difficulty sort: a non-blank bounded label, or `null` when omitted. */
function requireMergedRatingDimension(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  invariant(typeof value === 'string', 'invalid_input', 'ratingDimension must be a string when present', {
    reason: 'invalid_rating_dimension',
  });
  const trimmed = value.trim();
  invariant(
    trimmed.length > 0 && trimmed.length <= MAX_RATING_DIMENSION_CHARS,
    'invalid_input',
    `ratingDimension must be 1..${MAX_RATING_DIMENSION_CHARS} characters`,
    { reason: 'invalid_rating_dimension' },
  );
  return trimmed;
}

/** 1-based page number; there is no upper bound because the store clamps an out-of-range page. */
function requireMergedPage(value: number): number {
  invariant(Number.isInteger(value) && value >= 1, 'invalid_input', 'page must be an integer >= 1', { page: value });
  return value;
}

/** Page size of one merged page: any integer within `1..BROWSE_PAGE_LIMITS.maxPageSize`. */
function requireMergedLimit(value: number): number {
  invariant(
    Number.isInteger(value) && value >= BROWSE_PAGE_LIMITS.minPageSize && value <= BROWSE_PAGE_LIMITS.maxPageSize,
    'invalid_input',
    `page limit must be an integer within ${BROWSE_PAGE_LIMITS.minPageSize}..${BROWSE_PAGE_LIMITS.maxPageSize}`,
    { limit: value },
  );
  return value;
}

/** Literal whole-bank search term: trimmed, bounded, matched literally by the store (never a pattern). */
function normalizeMergedQuery(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  invariant(typeof value === 'string', 'invalid_input', 'query must be a string', { value });
  const trimmed = value.trim();
  invariant(
    trimmed.length > 0 && trimmed.length <= MAX_MERGED_QUERY_CHARS,
    'invalid_input',
    `query must be 1..${MAX_MERGED_QUERY_CHARS} characters`,
    { length: trimmed.length },
  );
  return trimmed;
}

/** Cancellation is not validation, but a read without a real token could never observe an abort. */
function requireMergedToken(token: CancellationToken | null | undefined): CancellationToken {
  invariant(
    token !== null && token !== undefined && typeof token.throwIfCancelled === 'function',
    'unfilled_settings',
    'a cancellation token is required',
    {},
  );
  return token;
}

// ---------------------------------------------------------------------------------------
// Store-claim re-validation
// ---------------------------------------------------------------------------------------

/** The `(account, problem)` identity of one accepted evidence row. */
function evidencePair(accountId: string, problemKey: string): string {
  return `${accountId}\u0000${problemKey}`;
}

/** Shape of one group before any member or evidence is believed. */
function assertMergedGroupShape(group: MergedProblemGroupRow): void {
  invariant(
    group !== null && typeof group === 'object',
    'invalid_input',
    'a merged group must be an object',
    { reason: 'merged_group_invalid' },
  );
  invariant(
    typeof group.groupKey === 'string' && group.groupKey.length > 0,
    'invalid_input',
    'a merged group must carry a non-empty groupKey',
    { reason: 'merged_group_invalid' },
  );
  invariant(
    group.mappingKind === CF_MIRROR_RULE_ID || group.mappingKind === 'single',
    'invalid_input',
    `merged group ${group.groupKey} carries unknown mappingKind ${String(group.mappingKind)}`,
    { reason: 'merged_mapping_kind_unknown', groupKey: group.groupKey, mappingKind: group.mappingKind },
  );
  invariant(
    Array.isArray(group.members) && group.members.length > 0,
    'invalid_input',
    `merged group ${group.groupKey} carries no member`,
    { reason: 'merged_group_without_member', groupKey: group.groupKey },
  );
  invariant(
    group.mappingKind === 'single' ? group.members.length === 1 : group.members.length <= 2,
    'invalid_input',
    `merged group ${group.groupKey} carries ${group.members.length} members for mappingKind ${group.mappingKind}`,
    { reason: 'merged_group_member_count', groupKey: group.groupKey, mappingKind: group.mappingKind, members: group.members.length },
  );
  const keys = new Set<string>();
  for (const member of group.members) {
    const key = member !== null && typeof member === 'object' ? member.problem?.key : undefined;
    invariant(
      typeof key === 'string' && !keys.has(key),
      'invalid_input',
      `merged group ${group.groupKey} repeats the member ${String(key)}`,
      { reason: 'duplicate_merged_member', groupKey: group.groupKey, problemKey: key },
    );
    keys.add(key as string);
  }
  invariant(
    Array.isArray(group.acceptedEvidence),
    'invalid_input',
    `merged group ${group.groupKey} carries no accepted-evidence list`,
    { reason: 'merged_evidence_invalid', groupKey: group.groupKey },
  );
  invariant(
    typeof group.solved === 'boolean' && typeof group.attempted === 'boolean',
    'invalid_input',
    `merged group ${group.groupKey} carries a non-boolean solved/attempted flag`,
    { reason: 'merged_group_invalid', groupKey: group.groupKey },
  );
}

/** Shape of one evidence row; storage is consulted separately in {@link assertEvidenceMatchesStorage}. */
function assertEvidenceShape(row: MergedProblemEvidenceRow): void {
  invariant(
    row !== null && typeof row === 'object',
    'invalid_input',
    'a merged evidence row must be an object',
    { reason: 'merged_evidence_invalid' },
  );
  for (const [name, value] of [
    ['accountId', row.accountId],
    ['problemKey', row.problemKey],
    ['sourceInstanceId', row.sourceInstanceId],
    ['externalKey', row.externalKey],
    ['submissionId', row.submissionId],
    ['submittedAt', row.submittedAt],
  ] as const) {
    invariant(
      typeof value === 'string' && value.length > 0,
      'invalid_input',
      `a merged evidence row needs a non-empty ${name}`,
      { reason: 'merged_evidence_invalid', field: name },
    );
  }
}

/**
 * Prove one evidence row against the stored submission it names.
 *
 * Every claim the row makes is re-derived: the submission exists, is accepted, belongs to the named
 * account on that account's own source instance, carries exactly the claimed canonical identity, and
 * its reference belongs to this group. A row that fails any of these is refused — never dropped,
 * because a dropped row would silently change a solved verdict.
 */
function assertEvidenceMatchesStorage(
  groupKey: string,
  row: MergedProblemEvidenceRow,
  submission: Submission | null,
  account: Account,
): void {
  invariant(
    submission !== null,
    'invalid_input',
    `merged accepted evidence ${row.submissionId} is not stored`,
    { reason: 'merged_evidence_missing', submissionId: row.submissionId, groupKey },
  );
  const canonical = canonicalKeyOfStoredSubmission(submission, groupKey);
  invariant(
    canonical === submission.key && submission.key === row.problemKey,
    'invalid_input',
    `merged accepted evidence ${row.submissionId} does not match its canonical problem identity`,
    {
      reason: 'merged_evidence_key_mismatch',
      submissionId: row.submissionId,
      groupKey,
      problemKey: row.problemKey,
      submissionKey: submission.key,
      canonicalKey: canonical,
    },
  );
  invariant(
    submission.ref.sourceInstanceId === row.sourceInstanceId && submission.ref.externalKey === row.externalKey,
    'invalid_input',
    `merged accepted evidence ${row.submissionId} does not match the claimed reference`,
    { reason: 'merged_evidence_identity_mismatch', submissionId: row.submissionId, groupKey },
  );
  invariant(
    isAccepted(submission),
    'invalid_input',
    `merged accepted evidence ${row.submissionId} is not an accepted submission`,
    { reason: 'merged_evidence_not_accepted', submissionId: row.submissionId, groupKey, verdict: submission.verdict },
  );
  invariant(
    submission.accountId === account.id && account.sourceInstanceId === submission.ref.sourceInstanceId,
    'invalid_input',
    `merged accepted evidence ${row.submissionId} does not belong to account ${account.id} on its own source instance`,
    {
      reason: 'merged_evidence_foreign_source',
      submissionId: row.submissionId,
      groupKey,
      accountId: account.id,
      accountSource: account.sourceInstanceId,
      submissionAccountId: submission.accountId,
      submissionSource: submission.ref.sourceInstanceId,
    },
  );
  invariant(
    mergedGroupKeyOf(submission.ref) === groupKey,
    'invalid_input',
    `merged accepted evidence ${row.submissionId} belongs to another group`,
    {
      reason: 'merged_evidence_foreign_group',
      submissionId: row.submissionId,
      groupKey,
      evidenceGroupKey: mergedGroupKeyOf(submission.ref),
    },
  );
  invariant(
    submission.submittedAt === row.submittedAt,
    'invalid_input',
    `merged accepted evidence ${row.submissionId} reports a different submission time`,
    {
      reason: 'merged_evidence_timestamp_mismatch',
      submissionId: row.submissionId,
      groupKey,
      submittedAt: row.submittedAt,
      storedSubmittedAt: submission.submittedAt,
    },
  );
}

/**
 * Prove one member is a coherent row of the group it claims to belong to.
 *
 * The member's canonical key is re-derived from its own reference (so a row cannot borrow another
 * problem's key), the domain's grouping rule must place it in exactly this group and mapping kind,
 * and its account — when it has one — must be a selected account of the member's own source
 * instance. A member without an account can never be reported solved.
 */
function assertMergedMemberShape(
  group: MergedProblemGroupRow,
  member: MergedProblemMemberRow,
  accounts: ReadonlyMap<string, Account>,
): void {
  invariant(
    member !== null && typeof member === 'object' && member.problem !== null && typeof member.problem === 'object',
    'invalid_input',
    `merged group ${group.groupKey} carries a malformed member`,
    { reason: 'merged_member_invalid', groupKey: group.groupKey },
  );
  const problem = member.problem;
  const canonical = canonicalKeyOfStoredProblem(problem, group.groupKey);
  invariant(
    canonical === problem.key,
    'invalid_input',
    `merged member ${problem.key} does not match its own reference ${canonical}`,
    { reason: 'merged_member_key_mismatch', groupKey: group.groupKey, problemKey: problem.key, canonicalKey: canonical },
  );
  const grouping = problemGroupingOf(problem.ref);
  invariant(
    grouping.groupKey === group.groupKey && grouping.kind === group.mappingKind,
    'invalid_input',
    `merged member ${problem.key} does not belong to group ${group.groupKey}`,
    {
      reason: 'merged_member_foreign_group',
      groupKey: group.groupKey,
      problemKey: problem.key,
      memberGroupKey: grouping.groupKey,
      memberMappingKind: grouping.kind,
    },
  );
  invariant(
    typeof member.solvedByAccount === 'boolean',
    'invalid_input',
    `merged member ${problem.key} carries a non-boolean solved flag`,
    { reason: 'merged_member_invalid', groupKey: group.groupKey, problemKey: problem.key },
  );
  if (member.accountId === null) {
    invariant(
      !member.solvedByAccount,
      'invalid_input',
      `merged member ${problem.key} is reported solved without an account`,
      { reason: 'merged_member_solved_without_account', groupKey: group.groupKey, problemKey: problem.key },
    );
    return;
  }
  invariant(
    typeof member.accountId === 'string' && member.accountId.length > 0,
    'invalid_input',
    `merged member ${problem.key} carries a malformed account id`,
    { reason: 'merged_member_invalid', groupKey: group.groupKey, problemKey: problem.key },
  );
  const account = accounts.get(member.accountId);
  invariant(
    account !== undefined,
    'invalid_input',
    `merged member ${problem.key} names account ${member.accountId}, which is not selected`,
    { reason: 'merged_member_foreign_account', groupKey: group.groupKey, problemKey: problem.key, accountId: member.accountId },
  );
  invariant(
    account.sourceInstanceId === problem.ref.sourceInstanceId,
    'invalid_input',
    `merged member ${problem.key} belongs to ${problem.ref.sourceInstanceId}, not to account ${account.id} of ${account.sourceInstanceId}`,
    {
      reason: 'merged_member_foreign_source',
      groupKey: group.groupKey,
      problemKey: problem.key,
      accountId: account.id,
      accountSource: account.sourceInstanceId,
      memberSource: problem.ref.sourceInstanceId,
    },
  );
}

/** Re-derive one stored problem's canonical key through the domain's own identity function. */
function canonicalKeyOfStoredProblem(problem: NormalizedProblem, groupKey: string): string {
  return canonicalKeyOfRef(`merged member of group ${groupKey}`, problem.ref, {
    reason: 'merged_member_key_mismatch',
    groupKey,
    problemKey: problem.key,
  });
}

/** Re-derive one stored submission's canonical key through the domain's own identity function. */
function canonicalKeyOfStoredSubmission(submission: Submission, groupKey: string): string {
  return canonicalKeyOfRef(`merged accepted evidence ${submission.id}`, submission.ref, {
    reason: 'merged_evidence_key_mismatch',
    groupKey,
    submissionId: submission.id,
  });
}

function canonicalKeyOfRef(label: string, ref: ProblemRef, details: Record<string, unknown>): string {
  try {
    return canonicalProblemKey(ref);
  } catch (error) {
    throw new DomainError('invalid_input', `${label} is not a canonical problem reference`, {
      ...details,
      cause: String(error),
    });
  }
}
