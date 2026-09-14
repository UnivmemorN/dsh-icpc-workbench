/**
 * SQL planning for the merged problem bank (Sprint Contract 08b).
 *
 * The store's `browseMergedProblems` is one serialized read assembled from the queries planned here:
 * the grouped bank, its page, the page's members and the accepted evidence behind its groups. Four
 * properties shape every statement:
 *
 * - **Grouping first.** The `problems` table is grouped by a registered scalar function that returns
 *   the domain's own group key for a stored reference, so the count, the filters and the page all
 *   describe the same groups. Grouping never looks at a title, tag or rating.
 * - **Two deterministic scalar functions.** {@link MERGED_REF_KEY_FUNCTION} re-derives a reference's
 *   canonical `problemKey` from its stored columns and {@link MERGED_GROUP_KEY_FUNCTION} returns the
 *   group key; both return `NULL` for columns that cannot name a problem. A row whose columns do not
 *   re-derive its own key is therefore never grouped, joined or counted — the same "incoherent
 *   evidence cannot confer a verdict" rule the indexed `browseProblems` path already applies.
 * - **Bounded account scope.** Accepted evidence and the attempt flag come from a CTE over the
 *   selected accounts' own submissions, joined to the account's stored source instance, and reduced
 *   to one row per `(account, problem)`; the page's members are then fetched by primary key from the
 *   page's group keys, so no bank-wide row set ever leaves SQLite.
 * - **One display member per group.** The external-key and title orders read a single member of the
 *   group — the requested source's own member when a source filter is present, otherwise the least
 *   canonical problem key — and a descending sort only reverses that same value, so a mirror pair
 *   keeps one sort position whichever direction is asked for.
 *
 * Every caller value is a bound parameter; the only interpolated text is a static, allowlisted SQL
 * fragment, so no request can change a statement.
 */
import { DomainError, mergedGroupKeyOf, problemKey, type ProblemRef } from '../../domain/index.js';
import type { ProblemSolvedFilter, ProblemSort } from '../../application/ports.js';
import { NATURAL_KEY_FUNCTION, RATING_VALUE_FUNCTION } from './sorting.js';

/** SQLite name of the canonical-reference scalar function; registered with `deterministic: true`. */
export const MERGED_REF_KEY_FUNCTION = 'icpc_merged_ref_key';

/** SQLite name of the merged-group-key scalar function; registered with `deterministic: true`. */
export const MERGED_GROUP_KEY_FUNCTION = 'icpc_merged_group_key';

/** Values this planner binds into its statements. */
export type MergedSqlValue = null | number | string;

/** One selected account: its id plus the source instance stored next to it in `accounts`. */
export interface MergedSelectedAccount {
  readonly id: string;
  readonly sourceInstanceId: string;
}

/** Everything one merged read decides before SQL is built. */
export interface MergedBrowsePlanInput {
  readonly accounts: readonly MergedSelectedAccount[];
  readonly sourceInstanceId: string | null;
  readonly status: ProblemSolvedFilter;
  readonly onlyAttempted: boolean;
  readonly search: string | null;
  readonly sort: ProblemSort;
  readonly ratingDimension: string | null;
}

/** One planned statement: SQL text plus the bound parameters, in order. */
export interface MergedQuery {
  readonly sql: string;
  readonly params: readonly MergedSqlValue[];
}

/** The shared `WITH …` chain of one merged read plus the ordering of its page. */
export interface MergedBrowsePlan {
  /** Complete `WITH …` chain ending in the `filtered` CTE (with a trailing space). */
  readonly prefix: string;
  readonly params: readonly MergedSqlValue[];
  readonly ordering: string;
}

/**
 * Canonical problem key of one stored reference, or `null` when the columns cannot name a problem.
 *
 * `null` is the honest answer for a row the domain's identity functions refuse (an empty component, a
 * control character, a non-canonical instance id); such a row is never treated as evidence.
 */
export function mergedRefKeyOfColumns(sourceInstanceId: unknown, domain: unknown, externalKey: unknown): string | null {
  const ref = refOfColumns(sourceInstanceId, domain, externalKey);
  if (ref === null) {
    return null;
  }
  try {
    return problemKey(ref);
  } catch {
    // A reference the domain refuses cannot take part in grouping or evidence; `null` excludes it.
    return null;
  }
}

/** Merged group key of one stored reference, or `null` when the columns cannot name a problem. */
export function mergedGroupKeyOfColumns(
  sourceInstanceId: unknown,
  domain: unknown,
  externalKey: unknown,
): string | null {
  const ref = refOfColumns(sourceInstanceId, domain, externalKey);
  if (ref === null) {
    return null;
  }
  try {
    return mergedGroupKeyOf(ref);
  } catch {
    // See above: an unrepresentable reference has no group.
    return null;
  }
}

function refOfColumns(sourceInstanceId: unknown, domain: unknown, externalKey: unknown): ProblemRef | null {
  if (typeof sourceInstanceId !== 'string' || sourceInstanceId.length === 0) {
    return null;
  }
  if (typeof externalKey !== 'string' || externalKey.length === 0) {
    return null;
  }
  if (domain !== null && typeof domain !== 'string') {
    return null;
  }
  return { sourceInstanceId, domain, externalKey };
}

/** Bound-parameter list `(?, ?, …)` of `count` placeholders; `count` is always a small bound. */
export function mergedPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * Plan the shared grouping/filter chain of one merged read.
 *
 * `accounts` are the *stored* pairs the caller resolved from the database (never raw request values),
 * so even a caller that passes an account of another instance cannot widen the submission scope.
 */
export function planMergedBrowse(input: MergedBrowsePlanInput): MergedBrowsePlan {
  const params: MergedSqlValue[] = [];
  const selectedValues = input.accounts.map(() => '(?, ?)').join(', ');
  for (const account of input.accounts) {
    params.push(account.id, account.sourceInstanceId);
  }
  // An empty selection is a legal "no account context" read: the CTE stays a real (empty) relation
  // so every downstream join and subquery keeps working without a special case.
  const selected =
    input.accounts.length === 0
      ? 'selected(account_id, source_instance_id) AS (SELECT NULL AS account_id, NULL AS source_instance_id FROM accounts WHERE 0)'
      : `selected(account_id, source_instance_id) AS (VALUES ${selectedValues})`;

  // Every scoped submission must re-derive its own canonical key: an incoherent stored row (the
  // legacy cross-source case) can neither confer a solve nor count as an attempt.
  const scoped = `scoped AS (
    SELECT s.account_id AS account_id, s.id AS submission_id, s.problem_key AS problem_key,
           s.source_instance_id AS source_instance_id, s.domain AS domain, s.external_key AS external_key,
           s.submitted_at AS submitted_at, s.verdict AS verdict,
           ${MERGED_GROUP_KEY_FUNCTION}(s.source_instance_id, s.domain, s.external_key) AS group_key
      FROM submissions s
      JOIN selected sel ON sel.account_id = s.account_id AND sel.source_instance_id = s.source_instance_id
     WHERE ${MERGED_REF_KEY_FUNCTION}(s.source_instance_id, s.domain, s.external_key) = s.problem_key
       AND NOT EXISTS (SELECT 1 FROM problem_dispositions d WHERE d.problem_key = s.problem_key AND d.state = 'trashed')
  )`;

  // One canonical accepted evidence per (group, account, problem): the earliest accepted submission,
  // with the submission id breaking a tie so the choice is total and repeatable.
  const acceptedEvidence = `accepted_evidence AS (
    SELECT group_key, account_id, problem_key, source_instance_id, external_key, submission_id, submitted_at
      FROM (
        SELECT group_key, account_id, problem_key, source_instance_id, external_key, submission_id, submitted_at,
               ROW_NUMBER() OVER (
                 PARTITION BY group_key, account_id, problem_key
                 ORDER BY submitted_at ASC, submission_id ASC
               ) AS evidence_rank
          FROM scoped
         WHERE verdict = 'accepted'
      )
     WHERE evidence_rank = 1
  )`;

  const attemptedGroups = 'attempted_groups AS (SELECT DISTINCT group_key FROM scoped)';

  // Reuse computed identities: correlated source/search predicates would otherwise rescan every
  // problem of a source for every group. Materialization enables transient group-key indexes.
  const memberRows = `member_rows AS MATERIALIZED (
    SELECT p.key AS problem_key, p.source_instance_id AS source_instance_id, p.domain AS domain,
           p.external_key AS external_key, p.title AS title, p.body AS body,
           ${MERGED_GROUP_KEY_FUNCTION}(p.source_instance_id, p.domain, p.external_key) AS group_key
      FROM problems p
     WHERE ${MERGED_REF_KEY_FUNCTION}(p.source_instance_id, p.domain, p.external_key) = p.key
       AND NOT EXISTS (SELECT 1 FROM problem_dispositions d WHERE d.problem_key = p.key AND d.state = 'trashed')
  )`;

  // The external-key and title orders compare ONE display member per group, chosen the same way in
  // both directions: the member of the requested source instance when a source filter is present,
  // otherwise the member with the lexicographically least canonical problem key (for a recognized
  // pair that is naturally the Codeforces spelling). A descending sort only reverses the comparison
  // of that same member's value, so the pair `1A`/`CF1A` can never change its sort position when the
  // direction changes. Only the aggregate the requested order needs is computed: a natural-key or
  // rating function call per member row is real work, and an unfiltered page must not pay for four
  // unused series.
  const displayOrder =
    input.sourceInstanceId === null
      ? 'm.problem_key ASC'
      : 'CASE WHEN m.source_instance_id = ? THEN 0 ELSE 1 END ASC, m.problem_key ASC';
  const usesDisplayMember =
    input.sort === 'problem_asc' ||
    input.sort === 'problem_desc' ||
    input.sort === 'title_asc' ||
    input.sort === 'title_desc';
  if (usesDisplayMember && input.sourceInstanceId !== null) {
    // Bound here, before the grouped/difficulty values below, matching the statement text order.
    params.push(input.sourceInstanceId);
  }
  const displayMembers = usesDisplayMember
    ? `display_members AS (
    SELECT group_key, source_instance_id, external_key, title
      FROM (
        SELECT m.group_key AS group_key, m.source_instance_id AS source_instance_id,
               m.external_key AS external_key, m.title AS title,
               ROW_NUMBER() OVER (PARTITION BY m.group_key ORDER BY ${displayOrder}) AS display_rank
          FROM member_rows m
      )
     WHERE display_rank = 1
  )`
    : '';

  let sortExpression: string;
  let direction: 'ASC' | 'DESC' = 'ASC';
  let collation = '';
  switch (input.sort) {
    case 'default':
      // The canonical-key order is already a single value per group and stays unchanged.
      sortExpression = 'MIN(m.problem_key)';
      break;
    case 'problem_asc':
    case 'problem_desc':
      sortExpression = `${NATURAL_KEY_FUNCTION}(m.external_key)`;
      direction = input.sort === 'problem_desc' ? 'DESC' : 'ASC';
      break;
    case 'title_asc':
    case 'title_desc':
      sortExpression = 'm.title COLLATE NOCASE';
      collation = ' COLLATE NOCASE';
      direction = input.sort === 'title_desc' ? 'DESC' : 'ASC';
      break;
    case 'difficulty_asc':
    case 'difficulty_desc':
      // The requested source instance's member decides the group's difficulty; a member of another
      // source contributes nothing, and a group with no comparable value sorts last in both
      // directions (`IS NULL ASC` below). The dimension is compared as literal data, never as SQL.
      sortExpression = `MIN(CASE WHEN m.source_instance_id = ? THEN ${RATING_VALUE_FUNCTION}(m.body, ?) END)`;
      direction = input.sort === 'difficulty_asc' ? 'ASC' : 'DESC';
      params.push(input.sourceInstanceId, input.ratingDimension);
      break;
    default:
      // Unreachable for the closed sort union; a future sort must state its own aggregate instead of
      // silently inheriting the canonical-key order.
      throw new DomainError('invalid_input', `unsupported merged bank sort ${String(input.sort)}`, {
        sort: input.sort,
      });
  }

  // A display-member order reads exactly one row per group, so it needs no aggregate and no GROUP BY
  // (which could otherwise re-select a member); the other orders aggregate over every member.
  const grouped = usesDisplayMember
    ? `grouped AS (
    SELECT m.group_key AS group_key, ${sortExpression} AS sort_key
      FROM display_members m
  )`
    : `grouped AS (
    SELECT m.group_key AS group_key, ${sortExpression} AS sort_key
      FROM member_rows m
     GROUP BY m.group_key
  )`;

  const where: string[] = [];
  if (input.sourceInstanceId !== null) {
    // The source filter is about *composition*: keep groups having a member from that instance,
    // while accepted evidence may still come from any selected account on an equivalent source.
    where.push(
      'EXISTS (SELECT 1 FROM member_rows src WHERE src.group_key = g.group_key AND src.source_instance_id = ?)',
    );
    params.push(input.sourceInstanceId);
  }
  if (input.search !== null) {
    // The same literal `instr` match as the plain bank, applied to EVERY member: a pair is found by
    // either site's title or either site's external key.
    where.push(
      'EXISTS (SELECT 1 FROM member_rows q WHERE q.group_key = g.group_key AND (instr(lower(q.title), lower(?)) > 0 OR instr(lower(q.external_key), lower(?)) > 0))',
    );
    params.push(input.search, input.search);
  }
  if (input.status === 'solved') {
    where.push('EXISTS (SELECT 1 FROM accepted_evidence e WHERE e.group_key = g.group_key)');
  }
  if (input.status === 'unconfirmed') {
    // The exact negation: a never-attempted group and an attempted-but-unsolved group are the same
    // statement, so `unconfirmed` includes problems nobody has ever submitted to.
    where.push('NOT EXISTS (SELECT 1 FROM accepted_evidence e WHERE e.group_key = g.group_key)');
  }
  if (input.onlyAttempted) {
    where.push('EXISTS (SELECT 1 FROM attempted_groups t WHERE t.group_key = g.group_key)');
  }

  const filtered = `filtered AS (
    SELECT g.group_key AS group_key, g.sort_key AS sort_key,
           EXISTS (SELECT 1 FROM attempted_groups t WHERE t.group_key = g.group_key) AS attempted
      FROM grouped g${where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`}
  )`;

  const prefix = `WITH ${[
    selected,
    scoped,
    acceptedEvidence,
    attemptedGroups,
    memberRows,
    ...(displayMembers === '' ? [] : [displayMembers]),
    grouped,
    filtered,
  ].join(',\n')} `;
  const nullsLast = input.sort === 'difficulty_asc' || input.sort === 'difficulty_desc';
  const ordering = `${nullsLast ? 'sort_key IS NULL ASC, ' : ''}sort_key${collation} ${direction}, group_key ASC`;
  return { prefix, params, ordering };
}

/** The filtered total of one grouped read; the same parameters as the page query. */
export function mergedCountQuery(plan: MergedBrowsePlan): MergedQuery {
  return { sql: `${plan.prefix}SELECT COUNT(*) AS total FROM filtered`, params: plan.params };
}

/**
 * One numbered page of group keys plus each group's attempt flag.
 *
 * The page is taken from the fully grouped and filtered relation, so the count above and this page
 * always describe the same groups.
 */
export function mergedPageQuery(plan: MergedBrowsePlan, limit: number, offset: number): MergedQuery {
  return {
    sql: `${plan.prefix}SELECT group_key, attempted FROM filtered ORDER BY ${plan.ordering} LIMIT ? OFFSET ?`,
    params: [...plan.params, limit, offset],
  };
}

/** Accepted evidence of exactly the page's groups, in deterministic group/account/problem order. */
export function mergedEvidenceQuery(plan: MergedBrowsePlan, groupKeys: readonly string[]): MergedQuery {
  return {
    sql: `${plan.prefix}SELECT group_key, account_id, problem_key, source_instance_id, external_key, submission_id, submitted_at
            FROM accepted_evidence
           WHERE group_key IN (${mergedPlaceholders(groupKeys.length)})
           ORDER BY group_key ASC, account_id ASC, problem_key ASC`,
    params: [...plan.params, ...groupKeys],
  };
}

/**
 * The stored problem rows of one page, fetched by primary key.
 *
 * A caller derives the candidate keys from the page's group keys (a recognized mirror group has at
 * most its two spellings), so this is a set of primary-key lookups rather than a second pass over the
 * bank.
 */
export function mergedMembersQuery(problemKeys: readonly string[]): MergedQuery {
  return {
    sql: `SELECT key, source_instance_id, domain, external_key, title, body
            FROM problems
           WHERE key IN (${mergedPlaceholders(problemKeys.length)})
             AND NOT EXISTS (SELECT 1 FROM problem_dispositions d WHERE d.problem_key = problems.key AND d.state = 'trashed')
           ORDER BY key ASC`,
    params: [...problemKeys],
  };
}
