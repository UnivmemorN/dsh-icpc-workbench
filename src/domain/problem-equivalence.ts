/**
 * Cross-site problem equivalence (Sprint Contract 08b): the one pure rule the merged bank groups by.
 *
 * The merged bank shows stored problems that are *the same problem on two sites*. Exactly one rule
 * is recognized, and it is a pure identity rule over the full {@link ProblemRef} — never a
 * similarity rule:
 *
 * - a Codeforces **main problemset** external key `<contest><index>` on the exact official instance
 *   `codeforces:codeforces.com`, and
 * - a Luogu external key `CF<contest><index>` on the exact official instance
 *   `luogu:www.luogu.com.cn`
 *
 * name the same problem when both references carry **no domain** and the identifier is canonical: a
 * positive contest id without a leading zero and below `100000`, and an index of one or more
 * uppercase letters with an optional numeric suffix (`A`, `B2`, `D10`, `A0`, `A01`). The suffix is
 * part of the identity and is preserved exactly: `A0` and `A01` are different indices from each other
 * and from `A`/`A1`, exactly as the canonical platform key spells them. The official rule reference
 * is `https://www.luogu.com.cn/problem/CF1A`, Luogu's own mirror entry of Codeforces problem `1A`.
 *
 * Everything else stays separate, deliberately:
 *
 * - **Gym contests are out of scope.** A `gym` domain (or any other domain) is never recognized, so
 *   a gym problem and a Luogu mirror of a main-problemset problem can never collapse;
 * - **a numeric Codeforces index is a different identifier family.** `921/01` and `14` are never
 *   guessed into an alphabetic index;
 * - **a non-canonical spelling is not recognized.** `cf1a`, `1a` and contest `01A` are left alone:
 *   the rule never normalizes case, contest padding or spacing to force a match. A zero-padded
 *   *index suffix* is not a spelling variant — `1B01` is an exact identity of its own, recognized
 *   and kept distinct from `1B0` and `1B1`;
 * - **titles, raw tags, ratings and statement similarity are never used.** Two problems that merely
 *   look alike stay two problems;
 * - **`E1` and `E2` (or `F1`/`F2`) stay distinct groups**, because the whole index is part of the
 *   identity.
 *
 * Every unrecognized reference is its own group, keyed by its full canonical `problemKey`, so the
 * grouping is total: every reference belongs to exactly one group and every group key is stable
 * across processes and runs. Recognized groups use the `merged:<rule>:<identity>` key space, which
 * cannot collide with a canonical problem key (those always carry two `|` separators).
 */
import { DomainError, invariant } from './errors.js';
import { parseProblemKey, problemKey, type ProblemRef } from './ids.js';

/** Rule id of the recognized Codeforces↔Luogu identifier rule. */
export const CF_MIRROR_RULE_ID = 'luogu_cf_identifier' as const;

/** Exact official Codeforces instance the rule recognizes (`platform:domain`). */
export const CODEFORCES_MAIN_INSTANCE_ID = 'codeforces:codeforces.com';

/** Exact official Luogu instance the rule recognizes (`platform:domain`). */
export const LUOGU_OFFICIAL_INSTANCE_ID = 'luogu:www.luogu.com.cn';

/** Largest contest id the rule recognizes; `100000` and above are out of scope. */
export const MAX_CF_MIRROR_CONTEST_ID = 99_999;

/** Prefix of a recognized group key; the rest is the canonical Codeforces external key. */
export const CF_MIRROR_GROUP_KEY_PREFIX = 'merged:cf:';

/** Official example of the rule: Luogu's own mirror entry of Codeforces problem `1A`. */
export const CF_MIRROR_REFERENCE_EXAMPLE_URL = 'https://www.luogu.com.cn/problem/CF1A';

/**
 * Plain-language statement of the rule, for a response that has to be self-describing.
 *
 * It is deliberately written as what is *not* merged as well: a caller must be able to tell that an
 * unmerged pair was left alone by rule, not by an accident of the data.
 */
export const CF_MIRROR_RULE_EXPLANATION =
  'A Codeforces main-problemset problem <contest><index> on codeforces:codeforces.com and a Luogu ' +
  'problem CF<contest><index> on luogu:www.luogu.com.cn are the same problem when both carry no ' +
  'domain and the identifier is canonical (positive contest id without a leading zero below 100000, ' +
  'uppercase index with an optional numeric suffix preserved exactly, zeros included). Gym contests, ' +
  'numeric Codeforces indices, non-canonical spellings, other source instances and other domains are ' +
  'never merged, and nothing is ever matched by title, tags, rating or statement similarity. ' +
  'Reference: ' + CF_MIRROR_REFERENCE_EXAMPLE_URL;

/** Canonical main-problemset external key: `<contest><index>`, gym/numeric forms excluded. */
const CF_MAIN_EXTERNAL_KEY = /^([1-9][0-9]{0,4})([A-Z]+[0-9]*)$/u;

/** Canonical Luogu mirror identifier: `CF<contest><index>`. */
const LUOGU_CF_EXTERNAL_KEY = /^CF([1-9][0-9]{0,4})([A-Z]+[0-9]*)$/u;

/** Canonical index shape: uppercase letters with an optional numeric suffix (`A`, `B2`, `A0`, `A01`). */
const CF_MIRROR_INDEX = /^[A-Z]+[0-9]*$/u;

/** One recognized Codeforces mirror identity, shared by both sites' spellings of it. */
export interface CfMirrorIdentity {
  readonly ruleId: typeof CF_MIRROR_RULE_ID;
  readonly contestId: number;
  /** Canonical uppercase index (`A`, `B2`, `A0`); `E1`/`E2` and `A0`/`A01` are different indices. */
  readonly index: string;
  /** Codeforces spelling: `<contest><index>`. */
  readonly cfExternalKey: string;
  /** Luogu spelling: `CF<contest><index>`. */
  readonly luoguExternalKey: string;
  /** Stable group key of this identity; the same for both spellings. */
  readonly groupKey: string;
}

/**
 * The grouping of one problem reference.
 *
 * `luogu_cf_identifier` is a recognized cross-site identity; `single` is every other reference,
 * keyed by its own full canonical `problemKey`. A recognized group may hold only one member when
 * the other site's metadata was never fetched — the group is a statement about identity, not about
 * how many rows happen to be stored.
 */
export type ProblemGrouping =
  | { readonly kind: typeof CF_MIRROR_RULE_ID; readonly groupKey: string; readonly identity: CfMirrorIdentity }
  | { readonly kind: 'single'; readonly groupKey: string; readonly identity: null };

/** The recognized rule id, or `null` for a `single` group. */
export type ProblemMappingKind = ProblemGrouping['kind'];

/**
 * The recognized mirror identity of one reference, or `null` when the rule does not apply.
 *
 * A pure predicate over the reference: it performs no lookup, reads no clock and touches no store,
 * so the same reference always yields the same answer. `null` covers every reason the rule does not
 * apply (another instance, a domain, a gym set, a numeric index, a non-canonical spelling), which is
 * the honest answer in all of them.
 */
export function cfMirrorIdentity(ref: ProblemRef): CfMirrorIdentity | null {
  if (ref === null || typeof ref !== 'object') {
    return null;
  }
  // Both sites' official records of a main-problemset problem carry no domain; a domain names a
  // different scope of the same instance and is never merged.
  if (ref.domain !== null) {
    return null;
  }
  const externalKey = ref.externalKey;
  if (typeof externalKey !== 'string' || typeof ref.sourceInstanceId !== 'string') {
    return null;
  }
  if (ref.sourceInstanceId === CODEFORCES_MAIN_INSTANCE_ID) {
    return identityFromMatch(CF_MAIN_EXTERNAL_KEY.exec(externalKey));
  }
  if (ref.sourceInstanceId === LUOGU_OFFICIAL_INSTANCE_ID) {
    return identityFromMatch(LUOGU_CF_EXTERNAL_KEY.exec(externalKey));
  }
  return null;
}

/**
 * Build the identity of one recognized pair from an already-extracted contest id and index.
 *
 * Kept separate so a caller that has parsed an identity text (a stored group key) reconstructs
 * exactly the same identity instead of re-deriving it by string surgery.
 */
export function cfMirrorIdentityOf(contestId: number, index: string): CfMirrorIdentity {
  invariant(
    Number.isInteger(contestId) && contestId >= 1 && contestId <= MAX_CF_MIRROR_CONTEST_ID,
    'invalid_input',
    `a recognized mirror contest id must be an integer within 1..${MAX_CF_MIRROR_CONTEST_ID}`,
    { contestId },
  );
  invariant(
    typeof index === 'string' && CF_MIRROR_INDEX.test(index),
    'invalid_input',
    'a recognized mirror index must be uppercase letters with an optional numeric suffix, preserved exactly',
    { index },
  );
  const cfExternalKey = `${contestId}${index}`;
  return {
    ruleId: CF_MIRROR_RULE_ID,
    contestId,
    index,
    cfExternalKey,
    luoguExternalKey: `CF${cfExternalKey}`,
    groupKey: `${CF_MIRROR_GROUP_KEY_PREFIX}${cfExternalKey}`,
  };
}

/**
 * Group one reference: a recognized mirror identity, or the reference's own canonical problem key.
 *
 * This is the total, deterministic grouping every consumer must use, so a single problem is never
 * grouped by title (or any other field) and two consumers can never disagree about a group key.
 * Only the canonical-key fallback can throw, and only for a reference that cannot name a stored
 * problem at all.
 */
export function problemGroupingOf(ref: ProblemRef): ProblemGrouping {
  const identity = cfMirrorIdentity(ref);
  if (identity !== null) {
    return { kind: CF_MIRROR_RULE_ID, groupKey: identity.groupKey, identity };
  }
  return { kind: 'single', groupKey: problemKey(ref), identity: null };
}

/** Group key of one reference; see {@link problemGroupingOf}. */
export function mergedGroupKeyOf(ref: ProblemRef): string {
  return problemGroupingOf(ref).groupKey;
}

/**
 * Canonical problem keys of the two records that can carry one recognized identity.
 *
 * The merged read uses this to fetch a page's members by primary key instead of re-deriving the
 * grouping for the whole bank: a recognized group has at most these two members.
 */
export function cfMirrorProblemKeys(identity: CfMirrorIdentity): readonly string[] {
  return [
    problemKey({ sourceInstanceId: CODEFORCES_MAIN_INSTANCE_ID, domain: null, externalKey: identity.cfExternalKey }),
    problemKey({ sourceInstanceId: LUOGU_OFFICIAL_INSTANCE_ID, domain: null, externalKey: identity.luoguExternalKey }),
  ];
}

/** One parsed group key: a recognized mirror identity, or one canonical problem key. */
export type ParsedMergedGroupKey =
  | { readonly kind: typeof CF_MIRROR_RULE_ID; readonly identity: CfMirrorIdentity }
  | { readonly kind: 'single'; readonly problemKey: string };

/**
 * Parse a group key produced by {@link mergedGroupKeyOf}.
 *
 * Refuses a key that is neither a recognized identity nor a canonical problem key, and refuses a
 * canonical problem key whose reference the rule *does* recognize: such a reference must be grouped
 * under its mirror key, so presenting it as a single group is incoherent (a store under test, not a
 * user, is the only realistic source of that).
 */
export function parseMergedGroupKey(groupKey: string): ParsedMergedGroupKey {
  invariant(typeof groupKey === 'string' && groupKey.length > 0, 'invalid_input', 'groupKey is required', {
    reason: 'unknown_group_key',
    groupKey,
  });
  if (groupKey.startsWith(CF_MIRROR_GROUP_KEY_PREFIX)) {
    const identity = identityFromMatch(CF_MAIN_EXTERNAL_KEY.exec(groupKey.slice(CF_MIRROR_GROUP_KEY_PREFIX.length)));
    invariant(
      identity !== null && identity.groupKey === groupKey,
      'invalid_input',
      `group key ${groupKey} is not a recognized merged identity`,
      { reason: 'unknown_group_key', groupKey },
    );
    return { kind: CF_MIRROR_RULE_ID, identity };
  }
  let ref: ProblemRef;
  try {
    ref = parseProblemKey(groupKey);
  } catch (error) {
    throw new DomainError(
      'invalid_input',
      `group key ${groupKey} is neither a merged identity nor a canonical problem key`,
      { reason: 'unknown_group_key', groupKey, cause: String(error) },
    );
  }
  invariant(
    cfMirrorIdentity(ref) === null,
    'invalid_input',
    `group key ${groupKey} names a reference the mirror rule recognizes, so it must be grouped by its merged identity`,
    { reason: 'unknown_group_key', groupKey },
  );
  return { kind: 'single', problemKey: groupKey };
}

/**
 * Canonical problem keys a group key can name: the two mirror keys of a recognized identity, or the
 * single canonical key of a `single` group.
 */
export function mergedGroupMemberKeys(groupKey: string): readonly string[] {
  const parsed = parseMergedGroupKey(groupKey);
  return parsed.kind === CF_MIRROR_RULE_ID ? cfMirrorProblemKeys(parsed.identity) : [parsed.problemKey];
}

function identityFromMatch(match: RegExpExecArray | null): CfMirrorIdentity | null {
  if (match === null) {
    return null;
  }
  const contestText = match[1];
  const index = match[2];
  if (contestText === undefined || index === undefined) {
    return null;
  }
  const contestId = Number(contestText);
  return Number.isInteger(contestId) && contestId >= 1 && contestId <= MAX_CF_MIRROR_CONTEST_ID
    ? cfMirrorIdentityOf(contestId, index)
    : null;
}
