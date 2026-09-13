/**
 * Source-aware raw-tag crosswalk (Sprint 10).
 *
 * Platform raw tags are *original labels*, not our taxonomy: Codeforces publishes broad English
 * categories, Luogu mixes Chinese names with numeric `luogu-tag:<id>` identifiers, Nowcoder lists
 * composite families such as `多项式算法(fft/ntt/fwt/idft)`, and OI Wiki is a learning catalog rather
 * than problem evidence. Resolving all of them through the global taxonomy alias index would claim
 * equivalences the platforms never asserted (`hashing` is not necessarily string hashing, `倍增` is
 * not necessarily LCA, `bit` is not necessarily a Fenwick tree).
 *
 * This module replaces the source-unaware alias lookup for the provisional raw-tag projection with
 * an explicit, versioned, one-way crosswalk:
 *
 * - the *vocabulary* is inferred only from the canonical source instance id (`platform:host`, with
 *   the host escaped exactly as `encodeIdPart` wrote it). A missing, malformed or unrecognised
 *   instance id yields vocabulary `unknown`; it never guesses from the tag language or the problem
 *   URL, and it never enables another platform's rules;
 * - source-specific rules (Codeforces broad categories, Luogu bilingual/numeric labels, Nowcoder
 *   composite families) come first; an unrecognised vocabulary — an unregistered instance id, or an
 *   explicit vocabulary value this build does not know — then fails closed **before** every shared
 *   spelling rule, so a malformed or foreign instance id can never borrow another platform's
 *   mapping. Only the unchanged non-algorithm provenance rules of `classify.ts` still apply there;
 * - recognised vocabularies continue with high-risk spellings (`tarjan`, `hash`, `bit`, `rmq`,
 *   `倍增`, `状态压缩`, `子集和`, …) and review-corrected spellings (`dijkstra`, `fft`, `矩阵乘法`,
 *   `快速幂`, …) intercepted before any alias lookup, then a small hand-reviewed shared spelling
 *   allowlist. Constituents of the frozen composite nodes (`DFS+BFS`, `单调栈与单调队列`, …) and of
 *   every combined node become `narrower`/`ambiguous`/`broader` candidates that never count;
 * - `targetIds` are the only ids allowed to feed provisional counts; `candidateIds` are diagnostics
 *   that never count. Every id is validated against the supplied index, so a catalog without that
 *   node stays `unmapped` instead of inventing one — there is deliberately **no** legacy fallback;
 * - a shared result carries the vocabulary's own public terminology page plus the OI Wiki definition
 *   of the node it names, because those pages support *term existence*, never an official
 *   cross-platform equivalence claim.
 *
 * The matching key normalises only case and whitespace (`A*` stays distinct from `A`, `C++` from
 * `C`) and never splits a label on `/`, `,` or `+`, so a composite label can never fan out into
 * several positive matches. The resolver is pure, deterministic and mutates nothing; results are
 * deep-frozen. {@link TAG_MAPPING_VERSION} travels with every result because this crosswalk is
 * provisional platform evidence, not an official cross-platform equivalence table.
 */
import { DomainError, invariant } from '../errors.js';
import { decodeIdPart, encodeIdPart } from '../ids.js';
import { deepFreeze } from '../immutable.js';
import { knowledgeResourcesFor } from '../knowledge-resources.js';
import { nonAlgorithmTagReason, type NonAlgorithmReason } from './classify.js';
import type { TaxonomyIndex } from './types.js';

/** Version of the crosswalk rules; changes whenever a rule or the matching key changes. */
export const TAG_MAPPING_VERSION = '2026.09.13.1';

/**
 * Tag vocabulary of a source instance. It is deliberately **separate** from `SourcePlatform`:
 * `nowcoder` is reserved for a future Nowcoder import, `oi-wiki` is only the learning-catalog
 * vocabulary behind reference links (never an import or account target), and `hydro`/other platforms
 * stay `unknown` instead of borrowing rules. An unknown vocabulary fails closed.
 */
export const TAG_VOCABULARIES = ['codeforces', 'luogu', 'nowcoder', 'oi-wiki', 'manual', 'unknown'] as const;

export type TagVocabulary = (typeof TAG_VOCABULARIES)[number];

/**
 * True only for the vocabulary literals this build knows.
 *
 * `mapSourceTag` accepts an explicit vocabulary for imports and references, but a caller can still
 * pass an arbitrary runtime value. Those values are refused as `unknown` — they never enable the
 * shared fallback, so a foreign platform name cannot silently become a known vocabulary.
 */
export function isTagVocabulary(value: unknown): value is TagVocabulary {
  return typeof value === 'string' && (TAG_VOCABULARIES as readonly string[]).includes(value);
}

/** How one raw label relates to the canonical taxonomy. */
export const TAG_MAPPING_RELATIONS = [
  'exact',
  'broader',
  'narrower',
  'ambiguous',
  'composite',
  'unmapped',
  'non_algorithm',
  'reference',
] as const;

export type TagMappingRelation = (typeof TAG_MAPPING_RELATIONS)[number];

/** Relations whose `targetIds` may feed provisional raw-tag counts. */
export function isCountedTagRelation(relation: TagMappingRelation): relation is 'exact' | 'broader' {
  return relation === 'exact' || relation === 'broader';
}

/**
 * Relations of algorithm-looking labels that stayed unresolved. `non_algorithm` (provenance) and
 * `reference` (platform id or learning catalog) are deliberately excluded: they are honest
 * metadata, not algorithm coverage gaps.
 */
export function isUnresolvedAlgorithmRelation(relation: TagMappingRelation): boolean {
  return relation === 'ambiguous' || relation === 'composite' || relation === 'narrower' || relation === 'unmapped';
}

/** One resolved mapping of a raw source label; immutable and JSON-serializable. */
export interface SourceTagMapping {
  /** Version of the crosswalk rules that produced this mapping. */
  readonly mappingVersion: string;
  /** Version of the vocabulary the ids were validated against. */
  readonly taxonomyVersion: string;
  /** Exact original label, preserved verbatim. */
  readonly raw: string;
  /** Exact source instance the label came from, preserved verbatim. */
  readonly sourceInstanceId: string;
  readonly vocabulary: TagVocabulary;
  readonly relation: TagMappingRelation;
  /** Canonical ids eligible for provisional counts; empty for every non-counted relation. */
  readonly targetIds: readonly string[];
  /** Plausible ids kept for review; they never count. */
  readonly candidateIds: readonly string[];
  /** Stable identifier of the rule that produced this mapping. */
  readonly ruleId: string;
  /** Concise Chinese explanation of the relation. */
  readonly explanation: string;
  /** External pages that support *term existence*; they never define our mapping semantics. */
  readonly referenceUrls: readonly string[];
}

/** Input of {@link mapSourceTag}: the raw label, its source instance and an optional vocabulary. */
export interface MapSourceTagInput {
  readonly raw: string;
  readonly sourceInstanceId: string;
  /**
   * Explicit vocabulary (for imports and reference namespaces); inferred from the instance when
   * absent. Only the literals in {@link TAG_VOCABULARIES} are accepted — anything else is refused as
   * `unknown` and fails closed instead of reaching the shared spelling rules.
   */
  readonly vocabulary?: TagVocabulary;
}

/**
 * Conservative matching key: NFC, lower case, collapsed whitespace — nothing else.
 *
 * Punctuation, slashes, plus signs and parentheses survive, so `A*` never matches `A`, `C++` never
 * matches `C`, and a composite label is never split into several positive matches.
 */
export function sourceTagKey(raw: string): string {
  return raw.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/** Prefix → vocabulary for source instance ids this build recognises. */
const VOCABULARY_PREFIXES: readonly (readonly [string, TagVocabulary])[] = [
  ['codeforces', 'codeforces'],
  ['luogu', 'luogu'],
  ['nowcoder', 'nowcoder'],
  ['oi-wiki', 'oi-wiki'],
  ['manual', 'manual'],
];

/** Hosts each vocabulary may live on; a mirror/subdomain of the official host is still that host. */
const VOCABULARY_HOSTS: Readonly<Partial<Record<TagVocabulary, readonly string[]>>> = deepFreeze({
  codeforces: ['codeforces.com'],
  luogu: ['luogu.com.cn'],
  nowcoder: ['nowcoder.com'],
  'oi-wiki': ['oi-wiki.org'],
});

/** Decode one escaped id part and require that it is exactly its own canonical encoding. */
function canonicalPartOf(encoded: string): string | null {
  try {
    const decoded = decodeIdPart(encoded);
    return encodeIdPart(decoded) === encoded ? decoded : null;
  } catch (cause) {
    // Malformed escaping is a refusal, not a crash; anything else keeps propagating.
    if (cause instanceof DomainError) {
      return null;
    }
    throw cause;
  }
}

/**
 * Infer the tag vocabulary of one source instance id (`platform:domain`).
 *
 * Only a canonically escaped domain on the vocabulary's own host counts. Everything else — a bare
 * platform word, malformed escaping, an unregistered platform (`hydro`), or an arbitrary host under
 * a known platform prefix — is `unknown`, which disables every source-specific rule and makes
 * {@link mapSourceTag} fail closed before the shared spelling rules.
 */
export function inferTagVocabulary(sourceInstanceId: string): TagVocabulary {
  if (typeof sourceInstanceId !== 'string') {
    return 'unknown';
  }
  const text = sourceInstanceId.trim();
  const separator = text.indexOf(':');
  if (separator <= 0 || separator === text.length - 1) {
    return 'unknown';
  }
  const platform = text.slice(0, separator);
  const domain = canonicalPartOf(text.slice(separator + 1));
  if (domain === null) {
    return 'unknown';
  }
  const vocabulary = VOCABULARY_PREFIXES.find(([prefix]) => prefix === platform);
  if (vocabulary === undefined) {
    return 'unknown';
  }
  const inferred = vocabulary[1];
  if (inferred === 'manual') {
    return 'manual';
  }
  const hosts = VOCABULARY_HOSTS[inferred];
  if (hosts === undefined) {
    return 'unknown';
  }
  // Hosts are case-insensitive and an explicit port is not part of the identity we match on.
  const host = domain.toLowerCase().replace(/:\d+$/u, '');
  return hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)) ? inferred : 'unknown';
}

/** Resolved rule outcome, before ids are validated against the supplied index. */
interface ResolvedRule {
  readonly ruleId: string;
  readonly relation: TagMappingRelation;
  readonly targetIds: readonly string[];
  readonly candidateIds: readonly string[];
  readonly explanation: string;
  readonly referenceUrls: readonly string[];
}

interface RuleIds {
  readonly targets?: readonly string[];
  readonly candidates?: readonly string[];
}

function rule(
  ruleId: string,
  relation: TagMappingRelation,
  ids: RuleIds,
  explanation: string,
  referenceUrls: readonly string[] = [],
): ResolvedRule {
  return {
    ruleId,
    relation,
    targetIds: [...(ids.targets ?? [])],
    candidateIds: [...(ids.candidates ?? [])],
    explanation,
    referenceUrls: [...referenceUrls],
  };
}

/** Build a keyed lookup table; duplicate keys are a programming error, never silently merged. */
function lookupTable(entries: Readonly<Record<string, ResolvedRule>>): ReadonlyMap<string, ResolvedRule> {
  const table = new Map<string, ResolvedRule>();
  for (const [spelling, entry] of Object.entries(entries)) {
    const key = sourceTagKey(spelling);
    invariant(!table.has(key), 'invalid_input', `duplicate crosswalk spelling ${JSON.stringify(spelling)}`, { key });
    table.set(key, entry);
  }
  return table;
}

const CODEFORCES_REFERENCES: readonly string[] = [
  'https://codeforces.com/apiHelp/objects#Problem',
  'https://codeforces.com/problemset',
];
const LUOGU_REFERENCES: readonly string[] = ['https://www.luogu.com.cn/problem/list'];
const NOWCODER_REFERENCES: readonly string[] = ['https://ac.nowcoder.com/acm/skill/acm'];
const OI_WIKI_REFERENCES: readonly string[] = [
  'https://oi-wiki.org/',
  'https://oi-wiki.org/intro/what-oi-wiki-is-not/',
];

/**
 * Verified OI Wiki definition pages for review-corrected spellings whose counted target is a
 * *category*: that category's own overview page would not document the operation the label names.
 */
const OI_WIKI_MATRIX_REFERENCE = 'https://oi-wiki.org/math/linear-algebra/matrix/';
const OI_WIKI_FERMAT_REFERENCE = 'https://oi-wiki.org/math/number-theory/fermat/';

/**
 * Vocabulary-level public terminology pages. A shared rule borrows the page of the vocabulary it was
 * seen on; `manual` has no platform page, and `unknown` never reaches this table because it fails
 * closed before any shared rule.
 */
const SHARED_VOCABULARY_REFERENCES: Readonly<Partial<Record<TagVocabulary, readonly string[]>>> = deepFreeze({
  codeforces: CODEFORCES_REFERENCES,
  luogu: LUOGU_REFERENCES,
  nowcoder: NOWCODER_REFERENCES,
  'oi-wiki': OI_WIKI_REFERENCES,
});

/**
 * Codeforces rules.
 *
 * The platform's own tag page says these are original problem labels, so broad labels map to the
 * matching *category* (`broader`) and never to a child technique; `dfs and similar` therefore does
 * not become "DFS+BFS", and `binary search` does not claim binary search on answer.
 */
const CODEFORCES_RULES = lookupTable({
  dp: rule('cf.dp', 'broader', { targets: ['dp'] }, 'Codeforces 的 dp 是范围标签，只累计到动态规划分类，不推断任何子技巧。', CODEFORCES_REFERENCES),
  'data structures': rule(
    'cf.data-structures',
    'broader',
    { targets: ['data-structure'] },
    'Codeforces 的 data structures 是范围标签，只累计到数据结构分类，不推断具体结构。',
    CODEFORCES_REFERENCES,
  ),
  graphs: rule('cf.graphs', 'broader', { targets: ['graph'] }, 'Codeforces 的 graphs 是范围标签，只累计到图论分类。', CODEFORCES_REFERENCES),
  trees: rule('cf.trees', 'broader', { targets: ['graph'] }, 'Codeforces 的 trees 是范围标签，只累计到图论分类，不判定具体树上算法。', CODEFORCES_REFERENCES),
  'dfs and similar': rule(
    'cf.dfs-and-similar',
    'broader',
    { targets: ['search'] },
    'Codeforces 的 dfs and similar 是搜索范围标签，只累计到搜索分类，不当作 DFS+BFS 单一技巧。',
    CODEFORCES_REFERENCES,
  ),
  probabilities: rule('cf.probabilities', 'broader', { targets: ['math'] }, 'Codeforces 的 probabilities 只累计到数学分类，不判定概率或期望。', CODEFORCES_REFERENCES),
  'string suffix structures': rule(
    'cf.string-suffix-structures',
    'broader',
    { targets: ['strings'] },
    'Codeforces 的 string suffix structures 是字符串范围标签，不判定后缀数组或后缀自动机。',
    CODEFORCES_REFERENCES,
  ),
  sortings: rule('cf.sortings', 'exact', { targets: ['implementation.sorting'] }, 'Codeforces 的 sortings 对应目录中的排序技巧。', CODEFORCES_REFERENCES),
  'binary search': rule(
    'cf.binary-search',
    'broader',
    { targets: ['search'] },
    'Codeforces 的 binary search 可能指二分查找或二分答案，保守地只累计到搜索分类。',
    CODEFORCES_REFERENCES,
  ),
  'constructive algorithms': rule(
    'cf.constructive-algorithms',
    'exact',
    { targets: ['implementation.constructive'] },
    'Codeforces 的 constructive algorithms 对应目录中的构造技巧。',
    CODEFORCES_REFERENCES,
  ),
  games: rule('cf.games', 'exact', { targets: ['math.game-theory'] }, 'Codeforces 的 games 对应目录中的博弈论。', CODEFORCES_REFERENCES),
  matrices: rule('cf.matrices', 'broader', { targets: ['math.linear-algebra'] }, 'Codeforces 的 matrices 只累计到线性代数分类。', CODEFORCES_REFERENCES),
  flows: rule('cf.flows', 'broader', { targets: ['flow'] }, 'Codeforces 的 flows 是网络流范围标签，不判定具体流算法。', CODEFORCES_REFERENCES),
  'graph matchings': rule('cf.graph-matchings', 'broader', { targets: ['matching'] }, 'Codeforces 的 graph matchings 只累计到匹配分类。', CODEFORCES_REFERENCES),
  'shortest paths': rule('cf.shortest-paths', 'exact', { targets: ['graph.shortest-path'] }, 'Codeforces 的 shortest paths 对应目录中的最短路。', CODEFORCES_REFERENCES),
  'ternary search': rule('cf.ternary-search', 'exact', { targets: ['search.ternary'] }, 'Codeforces 的 ternary search 对应目录中的三分。', CODEFORCES_REFERENCES),
  'meet-in-the-middle': rule('cf.meet-in-the-middle', 'exact', { targets: ['search.meet-in-the-middle'] }, 'Codeforces 的 meet-in-the-middle 对应目录中的折半搜索。', CODEFORCES_REFERENCES),
  'chinese remainder theorem': rule('cf.crt', 'exact', { targets: ['math.number-theory.crt'] }, 'Codeforces 的 chinese remainder theorem 对应目录中的中国剩余定理。', CODEFORCES_REFERENCES),
  interactive: rule('cf.interactive', 'exact', { targets: ['tricks.interactive'] }, 'Codeforces 的 interactive 对应目录中的交互题。', CODEFORCES_REFERENCES),
  'two pointers': rule('cf.two-pointers', 'exact', { targets: ['search.two-pointers'] }, 'Codeforces 的 two pointers 对应目录中的双指针。', CODEFORCES_REFERENCES),
  'brute force': rule('cf.brute-force', 'exact', { targets: ['implementation.brute-force'] }, 'Codeforces 的 brute force 对应目录中的暴力枚举。', CODEFORCES_REFERENCES),
});

/** Nowcoder rules for labels its skill catalog publishes as one composite family. */
const NOWCODER_RULES = lookupTable({
  tarjan: rule(
    'nowcoder.tarjan',
    'ambiguous',
    { candidates: ['graph.scc'] },
    '牛客把 tarjan 与“强连通分量”分开列出，tarjan 也用于割点/桥等场景，不能直接判定为强连通分量。',
    NOWCODER_REFERENCES,
  ),
});

/** Nowcoder composite labels are matched by prefix because the platform appends its own lists. */
const NOWCODER_COMPOSITE_PATTERNS: readonly { readonly pattern: RegExp; readonly outcome: ResolvedRule }[] = [
  {
    pattern: /^多项式算法/u,
    outcome: rule(
      'nowcoder.polynomial-family',
      'composite',
      { candidates: ['math.fft'] },
      '牛客把 fft/ntt/fwt/idft 合并为“多项式算法”一个标签，是组合标签，不拆成多个精确知识点。',
      NOWCODER_REFERENCES,
    ),
  },
  {
    pattern: /^筛法/u,
    outcome: rule(
      'nowcoder.sieve-family',
      'composite',
      { candidates: ['math.number-theory.prime-sieve'] },
      '牛客的“筛法”把线性筛、杜教筛、洲阁筛、min_25 筛合并为一个标签，不能逐项当作已掌握。',
      NOWCODER_REFERENCES,
    ),
  },
  {
    pattern: /^gcd\s*[（(]/u,
    outcome: rule(
      'nowcoder.gcd-family',
      'composite',
      { candidates: ['math.number-theory.gcd'] },
      '牛客的 gcd 标签附带了裴蜀定理等组合内容，按组合标签处理，不拆成多个精确知识点。',
      NOWCODER_REFERENCES,
    ),
  },
  {
    pattern: /^概率期望$/u,
    outcome: rule(
      'nowcoder.probability-expectation',
      'ambiguous',
      { candidates: ['math.probability', 'math.expected-value'] },
      '“概率期望”同时覆盖概率与期望两个节点，不能判定为其中任意一个。',
      NOWCODER_REFERENCES,
    ),
  },
];

/** Luogu rules plus its numeric platform-tag identifiers. */
const LUOGU_RULES = lookupTable({
  '动态规划 dp': rule(
    'luogu.dp-bilingual',
    'broader',
    { targets: ['dp'] },
    '洛谷观察到的双语分类名“动态规划 DP”只累计到动态规划分类，不推断子技巧。',
    LUOGU_REFERENCES,
  ),
});

/** `luogu-tag:<integer>` is a preserved platform identifier, never an algorithm guess. */
const LUOGU_NUMERIC_TAG = /^luogu-tag:-?\d+$/u;

/**
 * High-risk shared spellings and combined-node constituents. These intercept every alias path for
 * every recognised vocabulary: the taxonomy alias table is historical and its entries are not
 * platform equivalence claims. An `unknown` vocabulary never reaches this table (it fails closed).
 */
const SHARED_RISK_RULES = lookupTable({
  tarjan: rule('shared.risk.tarjan', 'ambiguous', { candidates: ['graph.scc'] }, 'tarjan 也可能指割点/桥或树上算法，不能直接判定为强连通分量。'),
  缩点: rule('shared.risk.condensation', 'ambiguous', { candidates: ['graph.scc'] }, '缩点通常出现在强连通分量语境，但也可用于其他收缩技巧，需要人工核对。'),
  hash: rule('shared.risk.hash', 'ambiguous', { candidates: ['strings.hashing', 'tricks.randomization'] }, '哈希不一定是字符串哈希，也可能是哈希冲突处理或随机化技巧。'),
  hashing: rule('shared.risk.hashing', 'ambiguous', { candidates: ['strings.hashing', 'tricks.randomization'] }, 'hashing 不一定是字符串哈希，保留候选供人工核对。'),
  哈希: rule('shared.risk.hash-zh', 'ambiguous', { candidates: ['strings.hashing', 'tricks.randomization'] }, '“哈希”不一定是字符串哈希，保留候选供人工核对。'),
  bit: rule('shared.risk.bit', 'ambiguous', { candidates: ['data-structure.bit', 'tricks.bitwise', 'dp.bitmask'] }, 'bit 是缩写，可能指树状数组、位运算或状压 DP。'),
  bitmasks: rule('shared.risk.bitmasks', 'ambiguous', { candidates: ['dp.bitmask', 'tricks.bitwise'] }, 'bitmasks 既可能指位运算，也可能指状压 DP，不能直接判定。'),
  rmq: rule('shared.risk.rmq', 'ambiguous', { candidates: ['data-structure.sparse-table'] }, 'RMQ 是问题族，ST 表只是其中一种解法，不能直接判定。'),
  倍增: rule('shared.risk.binary-lifting', 'ambiguous', { candidates: ['graph.lca'] }, '倍增常用于 LCA，也用于其他倍增结构，不能直接判定为最近公共祖先。'),
  'subset sum': rule('shared.risk.subset-sum', 'ambiguous', { candidates: ['dp.sos'] }, '子集和是问题族，不一定是高维前缀和（SOS）DP。'),
  子集和: rule('shared.risk.subset-sum-zh', 'ambiguous', { candidates: ['dp.sos'] }, '“子集和”是问题族，不一定是高维前缀和（SOS）DP。'),
  状态压缩: rule('shared.risk.bitmask-state', 'ambiguous', { candidates: ['dp.bitmask'] }, '状态压缩不一定是 DP，也可能是位运算枚举。'),

  dfs: rule('shared.constituent.dfs', 'narrower', { candidates: ['search.traversal'] }, 'DFS 只是“深度优先与广度优先搜索”大类中的单项，当前目录没有独立节点。'),
  bfs: rule('shared.constituent.bfs', 'narrower', { candidates: ['search.traversal'] }, 'BFS 只是“深度优先与广度优先搜索”大类中的单项，当前目录没有独立节点。'),
  深度优先搜索: rule('shared.constituent.dfs-zh', 'narrower', { candidates: ['search.traversal'] }, '“深度优先搜索”是大类中的单项，不与广度优先搜索合并计数。'),
  广度优先搜索: rule('shared.constituent.bfs-zh', 'narrower', { candidates: ['search.traversal'] }, '“广度优先搜索”是大类中的单项，不与深度优先搜索合并计数。'),
  traversal: rule('shared.constituent.traversal', 'narrower', { candidates: ['search.traversal'] }, 'traversal 只说明是遍历，不能判定为具体的 DFS 或 BFS。'),
  'dfs+bfs': rule('shared.family.dfs-bfs', 'composite', { candidates: ['search.traversal'] }, '“DFS+BFS”是组合标签，不对应任何单一技巧。'),
  单调栈: rule('shared.constituent.monotonic-stack', 'narrower', { candidates: ['data-structure.monotonic-stack'] }, '“单调栈”是“单调栈与单调队列”大类中的单项，当前目录没有独立节点。'),
  单调队列: rule('shared.constituent.monotonic-queue', 'narrower', { candidates: ['data-structure.monotonic-stack'] }, '“单调队列”是“单调栈与单调队列”大类中的单项，当前目录没有独立节点。'),
  'monotonic stack': rule('shared.constituent.monotonic-stack-en', 'narrower', { candidates: ['data-structure.monotonic-stack'] }, 'monotonic stack 只是“单调栈与单调队列”大类中的单项。'),
  'monotonic queue': rule('shared.constituent.monotonic-queue-en', 'narrower', { candidates: ['data-structure.monotonic-stack'] }, 'monotonic queue 只是“单调栈与单调队列”大类中的单项。'),
  单调栈与单调队列: rule('shared.family.monotonic', 'composite', { candidates: ['data-structure.monotonic-stack'] }, '“单调栈与单调队列”是组合标签，不对应任何单一技巧。'),
  启发式搜索: rule('shared.constituent.heuristic-search', 'narrower', { candidates: ['search.heuristic'] }, '“启发式搜索”是启发式搜索/模拟退火大类中的单项，当前目录没有独立节点。'),
  模拟退火: rule('shared.constituent.annealing', 'narrower', { candidates: ['search.heuristic'] }, '“模拟退火”是启发式搜索/模拟退火大类中的单项，当前目录没有独立节点。'),
  'heuristic search': rule('shared.constituent.heuristic-search-en', 'narrower', { candidates: ['search.heuristic'] }, 'heuristic search 只说明是启发式方法，不能判定为模拟退火或 A*。'),
  'simulated annealing': rule('shared.constituent.annealing-en', 'narrower', { candidates: ['search.heuristic'] }, 'simulated annealing 只是启发式搜索大类中的单项。'),
  'a star': rule('shared.constituent.a-star', 'narrower', { candidates: ['search.heuristic'] }, 'A* 只是启发式搜索大类中的单项，且不会被当作单字母 A。'),
  'a*': rule('shared.constituent.a-star-punct', 'narrower', { candidates: ['search.heuristic'] }, 'A* 只是启发式搜索大类中的单项；匹配键保留星号，不会被当作单字母 A。'),
  'ida star': rule('shared.constituent.ida-star', 'narrower', { candidates: ['search.heuristic'] }, 'IDA* 只是启发式搜索大类中的单项。'),
  'ida*': rule('shared.constituent.ida-star-punct', 'narrower', { candidates: ['search.heuristic'] }, 'IDA* 只是启发式搜索大类中的单项；匹配键保留星号。'),
  树的直径: rule('shared.constituent.tree-diameter', 'narrower', { candidates: ['graph.tree-diameter'] }, '“树的直径”是“树的直径与换根”大类中的单项，当前目录没有独立节点。'),
  'tree diameter': rule('shared.constituent.tree-diameter-en', 'narrower', { candidates: ['graph.tree-diameter'] }, 'tree diameter 只是“树的直径与换根”大类中的单项。'),
  换根dp: rule('shared.constituent.rerooting-dp', 'narrower', { candidates: ['graph.tree-diameter'] }, '“换根 DP”是“树的直径与换根”大类中的单项，当前目录没有独立节点。'),
  rerooting: rule('shared.constituent.rerooting', 'narrower', { candidates: ['graph.tree-diameter'] }, 'rerooting 是换根技巧，不与树的直径合并计数。'),
  树的直径与换根: rule('shared.family.tree-diameter', 'composite', { candidates: ['graph.tree-diameter'] }, '“树的直径与换根”是组合标签，不对应任何单一技巧。'),
  lucas: rule('shared.constituent.lucas', 'narrower', { candidates: ['math.combinatorics.lucas'] }, 'Lucas 只是“卢卡斯定理与斯特林数”节点中的单项。'),
  卢卡斯定理: rule('shared.constituent.lucas-zh', 'narrower', { candidates: ['math.combinatorics.lucas'] }, '“卢卡斯定理”只是“卢卡斯定理与斯特林数”节点中的单项。'),
  stirling: rule('shared.constituent.stirling', 'narrower', { candidates: ['math.combinatorics.lucas'] }, 'Stirling 只是“卢卡斯定理与斯特林数”节点中的单项。'),
  斯特林数: rule('shared.constituent.stirling-zh', 'narrower', { candidates: ['math.combinatorics.lucas'] }, '“斯特林数”只是“卢卡斯定理与斯特林数”节点中的单项。'),
  catalan: rule('shared.constituent.catalan', 'narrower', { candidates: ['math.combinatorics.catalan'] }, 'Catalan 只是“卡特兰数与组合恒等式”节点中的单项。'),
  卡特兰数: rule('shared.constituent.catalan-zh', 'narrower', { candidates: ['math.combinatorics.catalan'] }, '“卡特兰数”只是“卡特兰数与组合恒等式”节点中的单项。'),
  'dp optimization': rule('shared.family.dp-optimization', 'composite', { candidates: ['dp.optimization'] }, '“DP 优化”是组合标签，涵盖多种优化技巧，不对应任何单一技巧。'),
  'dp 优化': rule('shared.family.dp-optimization-zh', 'composite', { candidates: ['dp.optimization'] }, '“DP 优化”是组合标签，涵盖多种优化技巧，不对应任何单一技巧。'),
  斜率优化: rule('shared.constituent.slope-trick', 'narrower', { candidates: ['dp.optimization'] }, '“斜率优化”只是 DP 优化大类中的单项。'),
  决策单调性: rule('shared.constituent.monotone-decision', 'narrower', { candidates: ['dp.optimization'] }, '“决策单调性”只是 DP 优化大类中的单项。'),
  单调队列优化: rule('shared.constituent.monotonic-queue-optimization', 'narrower', { candidates: ['dp.optimization'] }, '“单调队列优化”只是 DP 优化大类中的单项，不等于单调队列结构本身。'),
  'convex hull trick': rule('shared.constituent.convex-hull-trick', 'narrower', { candidates: ['dp.optimization'] }, 'convex hull trick 只是 DP 优化大类中的单项。'),
  'sos dp': rule('shared.constituent.sos-dp', 'narrower', { candidates: ['dp.sos'] }, 'SOS DP 只是“子集和与高维前缀和”节点中的单项。'),
  高维前缀和: rule('shared.constituent.sos-prefix', 'narrower', { candidates: ['dp.sos'] }, '“高维前缀和”只是“子集和与高维前缀和”节点中的单项。'),
  概率期望: rule('shared.risk.probability-expectation', 'ambiguous', { candidates: ['math.probability', 'math.expected-value'] }, '“概率期望”同时覆盖概率与期望两个节点，不能判定为其中任意一个。'),
});

/**
 * Review-corrected shared spellings (Sprint 10 repair 1).
 *
 * The historical alias table lists spellings that are *narrower* or *broader* than the node they
 * resolve to: one member of a combined node (`dijkstra` inside 最短路, `fft` inside 快速傅里叶变换与
 * 卷积), or a general operation whose neighbouring node is a special case (`矩阵乘法` is not 矩阵快速幂,
 * 费马小定理 is not the modular-inverse operation). These rules intercept exactly like the risk
 * spellings and, unless the review specified otherwise, keep the whole node only as an uncounted
 * candidate. The node's own plain spellings stay in the safe allowlist and keep counting.
 */
const SHARED_OVERRIDE_RULES = lookupTable({
  // One model of the knapsack node.
  '01背包': rule('shared.override.knapsack-01', 'narrower', { candidates: ['dp.knapsack'] }, '“01 背包”只是“背包”节点中的一种模型，不直接判定为整个背包节点。'),
  '完全背包': rule('shared.override.knapsack-complete', 'narrower', { candidates: ['dp.knapsack'] }, '“完全背包”只是“背包”节点中的一种模型，不直接判定为整个背包节点。'),
  // One variant or implementation of the data-structure node.
  '带权并查集': rule('shared.override.weighted-dsu', 'narrower', { candidates: ['data-structure.dsu'] }, '“带权并查集”只是并查集大类中的一种变体，当前目录没有独立节点。'),
  treap: rule('shared.override.treap', 'narrower', { candidates: ['data-structure.balanced-bst'] }, 'treap 只是“平衡树”大类中的一种实现，当前目录没有独立节点。'),
  splay: rule('shared.override.splay', 'narrower', { candidates: ['data-structure.balanced-bst'] }, 'splay 只是“平衡树”大类中的一种实现，当前目录没有独立节点。'),
  'fhq treap': rule('shared.override.fhq-treap', 'narrower', { candidates: ['data-structure.balanced-bst'] }, 'FHQ treap 只是“平衡树”大类中的一种实现，当前目录没有独立节点。'),
  '主席树': rule('shared.override.chairman-tree', 'narrower', { candidates: ['data-structure.persistent'] }, '“主席树”只是“可持久化数据结构”大类中的一种实现。'),
  'chairman tree': rule('shared.override.chairman-tree-en', 'narrower', { candidates: ['data-structure.persistent'] }, 'chairman tree 只是“可持久化数据结构”大类中的一种实现。'),
  // One shortest-path algorithm.
  dijkstra: rule('shared.override.dijkstra', 'narrower', { candidates: ['graph.shortest-path'] }, 'Dijkstra 只是最短路的一种算法，当前目录没有独立节点。'),
  spfa: rule('shared.override.spfa', 'narrower', { candidates: ['graph.shortest-path'] }, 'SPFA 只是最短路的一种算法，当前目录没有独立节点。'),
  'bellman ford': rule('shared.override.bellman-ford', 'narrower', { candidates: ['graph.shortest-path'] }, 'Bellman–Ford 只是最短路的一种算法，当前目录没有独立节点。'),
  floyd: rule('shared.override.floyd', 'narrower', { candidates: ['graph.shortest-path'] }, 'Floyd 只是最短路的一种算法，当前目录没有独立节点。'),
  // One member of the combined bridges/articulation node.
  bridge: rule('shared.override.bridge', 'narrower', { candidates: ['graph.bridges-articulation'] }, 'bridge 只是“割边与割点”大类中的单项，当前目录没有独立节点。'),
  'cut vertex': rule('shared.override.cut-vertex', 'narrower', { candidates: ['graph.bridges-articulation'] }, 'cut vertex 只是“割边与割点”大类中的单项，当前目录没有独立节点。'),
  割点: rule('shared.override.articulation-zh', 'narrower', { candidates: ['graph.bridges-articulation'] }, '“割点”只是“割边与割点”大类中的单项，当前目录没有独立节点。'),
  割边: rule('shared.override.bridge-zh', 'narrower', { candidates: ['graph.bridges-articulation'] }, '“割边”只是“割边与割点”大类中的单项，当前目录没有独立节点。'),
  'articulation point': rule('shared.override.articulation-point', 'narrower', { candidates: ['graph.bridges-articulation'] }, 'articulation point 只是“割边与割点”大类中的单项，当前目录没有独立节点。'),
  // One max-flow implementation.
  dinic: rule('shared.override.dinic', 'narrower', { candidates: ['flow.max-flow'] }, 'Dinic 只是最大流的一种实现，当前目录没有独立节点。'),
  isap: rule('shared.override.isap', 'narrower', { candidates: ['flow.max-flow'] }, 'ISAP 只是最大流的一种实现，当前目录没有独立节点。'),
  // Matching algorithms and theorems whose names cover more than the child node.
  kuhn: rule('shared.override.kuhn', 'narrower', { candidates: ['matching.bipartite'] }, 'Kuhn 算法只是二分图匹配的一种实现，当前目录没有独立节点。'),
  hungarian: rule('shared.override.hungarian', 'ambiguous', { candidates: ['matching.bipartite'] }, '“匈牙利算法”在不同语境下也指带权匹配（KM），不能直接判定为二分图最大匹配。'),
  匈牙利算法: rule('shared.override.hungarian-zh', 'ambiguous', { candidates: ['matching.bipartite'] }, '“匈牙利算法”在不同语境下也指带权匹配（KM），不能直接判定为二分图最大匹配。'),
  blossom: rule('shared.override.blossom', 'narrower', { candidates: ['matching.general'] }, 'blossom 只是“一般图匹配”大类中的一种算法。'),
  带花树: rule('shared.override.blossom-zh', 'narrower', { candidates: ['matching.general'] }, '“带花树”只是“一般图匹配”大类中的一种算法。'),
  'hall theorem': rule('shared.override.hall', 'narrower', { candidates: ['matching.hall'] }, 'Hall 定理与 König 定理是两个不同的定理，当前目录把它们合并为一个节点，单项不直接计数。'),
  霍尔定理: rule('shared.override.hall-zh', 'narrower', { candidates: ['matching.hall'] }, 'Hall 定理与 König 定理是两个不同的定理，当前目录把它们合并为一个节点，单项不直接计数。'),
  konig: rule('shared.override.konig', 'narrower', { candidates: ['matching.hall'] }, 'König 定理与 Hall 定理是两个不同的定理，当前目录把它们合并为一个节点，单项不直接计数。'),
  柯尼希定理: rule('shared.override.konig-zh', 'narrower', { candidates: ['matching.hall'] }, 'König 定理与 Hall 定理是两个不同的定理，当前目录把它们合并为一个节点，单项不直接计数。'),
  // One half of a combined number-theory node.
  gcd: rule('shared.override.gcd', 'narrower', { candidates: ['math.number-theory.gcd'] }, '最大公约数与扩展欧几里得共用一个节点，单项拼写不直接计数。'),
  exgcd: rule('shared.override.exgcd', 'narrower', { candidates: ['math.number-theory.gcd'] }, '扩展欧几里得与最大公约数共用一个节点，单项拼写不直接计数。'),
  扩展欧几里得: rule('shared.override.exgcd-zh', 'narrower', { candidates: ['math.number-theory.gcd'] }, '扩展欧几里得与最大公约数共用一个节点，单项拼写不直接计数。'),
  bezout: rule('shared.override.bezout', 'narrower', { candidates: ['math.number-theory.gcd'] }, '裴蜀定理与最大公约数共用一个节点，单项拼写不直接计数。'),
  裴蜀定理: rule('shared.override.bezout-zh', 'narrower', { candidates: ['math.number-theory.gcd'] }, '裴蜀定理与最大公约数共用一个节点，单项拼写不直接计数。'),
  // One half of a combined sieve/factoring node.
  sieve: rule('shared.override.sieve', 'narrower', { candidates: ['math.number-theory.prime-sieve'] }, '“素数筛与质因数分解”是合并节点，单项拼写不直接计数。'),
  素数筛: rule('shared.override.prime-sieve-zh', 'narrower', { candidates: ['math.number-theory.prime-sieve'] }, '“素数筛与质因数分解”是合并节点，单项拼写不直接计数。'),
  线性筛: rule('shared.override.linear-sieve-zh', 'narrower', { candidates: ['math.number-theory.prime-sieve'] }, '“素数筛与质因数分解”是合并节点，单项拼写不直接计数。'),
  埃氏筛: rule('shared.override.eratosthenes-zh', 'narrower', { candidates: ['math.number-theory.prime-sieve'] }, '“素数筛与质因数分解”是合并节点，单项拼写不直接计数。'),
  factorization: rule('shared.override.factorization', 'narrower', { candidates: ['math.number-theory.prime-sieve'] }, '“素数筛与质因数分解”是合并节点，单项拼写不直接计数。'),
  质因数分解: rule('shared.override.factorization-zh', 'narrower', { candidates: ['math.number-theory.prime-sieve'] }, '“素数筛与质因数分解”是合并节点，单项拼写不直接计数。'),
  // One member of the combined FFT/convolution node; FFT is not evidence of NTT.
  fft: rule('shared.override.fft', 'narrower', { candidates: ['math.fft'] }, 'FFT 只是“快速傅里叶变换与卷积”节点中的单项，而且 FFT 不是 NTT 的证据。'),
  ntt: rule('shared.override.ntt', 'narrower', { candidates: ['math.fft'] }, 'NTT 只是“快速傅里叶变换与卷积”节点中的单项。'),
  卷积: rule('shared.override.convolution-zh', 'narrower', { candidates: ['math.fft'] }, '“卷积”只是“快速傅里叶变换与卷积”节点中的单项。'),
  convolution: rule('shared.override.convolution', 'narrower', { candidates: ['math.fft'] }, 'convolution 只是“快速傅里叶变换与卷积”节点中的单项。'),
  快速傅里叶变换: rule('shared.override.fft-zh', 'narrower', { candidates: ['math.fft'] }, '“快速傅里叶变换”只是“快速傅里叶变换与卷积”节点中的单项。'),
  // One tool or one model inside a broader node.
  sg函数: rule('shared.override.sg', 'narrower', { candidates: ['math.game-theory'] }, 'SG 函数只是博弈论中的一项工具，当前目录没有独立节点。'),
  nim: rule('shared.override.nim', 'narrower', { candidates: ['math.game-theory'] }, 'Nim 只是博弈论中的一项内容，当前目录没有独立节点。'),
  'sprague grundy': rule('shared.override.sprague-grundy', 'narrower', { candidates: ['math.game-theory'] }, 'Sprague–Grundy 只是博弈论中的一项工具，当前目录没有独立节点。'),
  概率dp: rule('shared.override.probability-dp', 'narrower', { candidates: ['math.probability'] }, '“概率 DP”只是概率节点中的一种计算方法。'),
  期望dp: rule('shared.override.expected-dp', 'narrower', { candidates: ['math.expected-value'] }, '“期望 DP”只是期望节点中的一种计算方法。'),
  'linearity of expectation': rule('shared.override.linearity-of-expectation', 'narrower', { candidates: ['math.expected-value'] }, '期望线性性只是期望节点中的一项性质，不直接判定为整个节点。'),
  // One vector operation of the geometry.basic node.
  叉积: rule('shared.override.cross-product-zh', 'narrower', { candidates: ['geometry.basic'] }, '“叉积”只是“向量与叉积”节点中的一项运算。'),
  'cross product': rule('shared.override.cross-product', 'narrower', { candidates: ['geometry.basic'] }, 'cross product 只是“向量与叉积”节点中的一项运算。'),
  点积: rule('shared.override.dot-product-zh', 'narrower', { candidates: ['geometry.basic'] }, '“点积”只是“向量与叉积”节点中的一项运算。'),
  // One convex-hull implementation.
  graham: rule('shared.override.graham', 'narrower', { candidates: ['geometry.convex-hull'] }, 'Graham 只是凸包的一种实现，当前目录没有独立节点。'),
  andrew: rule('shared.override.andrew', 'narrower', { candidates: ['geometry.convex-hull'] }, 'Andrew 只是凸包的一种实现，当前目录没有独立节点。'),
  // One variant of Mo's algorithm.
  带修莫队: rule('shared.override.mo-with-modification', 'narrower', { candidates: ['offline.mo'] }, '“带修莫队”只是莫队算法的一种变体，当前目录没有独立节点。'),
  // Broader spellings: the operation/definition is wider than the neighbouring child node.
  矩阵乘法: rule('shared.override.matrix-multiplication', 'broader', { targets: ['math.linear-algebra'] }, '矩阵乘法是线性代数运算，不等于矩阵快速幂；只累计到线性代数分类。', [OI_WIKI_MATRIX_REFERENCE]),
  费马小定理: rule('shared.override.fermat', 'broader', { targets: ['math.number-theory'] }, '费马小定理是数论定理，不等于求模逆元的操作；只累计到数论分类。', [OI_WIKI_FERMAT_REFERENCE]),
  'fermat little theorem': rule('shared.override.fermat-en', 'broader', { targets: ['math.number-theory'] }, 'Fermat 小定理是数论定理，不等于求模逆元的操作；只累计到数论分类。', [OI_WIKI_FERMAT_REFERENCE]),
  // Generic exponentiation does not itself specify a modulus.
  'binary exponentiation': rule('shared.override.binary-exponentiation', 'ambiguous', { candidates: ['math.number-theory.modular-exponentiation'] }, '“快速幂”不限定模数，可能只是普通幂运算；保留候选供人工核对。'),
  'fast power': rule('shared.override.fast-power', 'ambiguous', { candidates: ['math.number-theory.modular-exponentiation'] }, '“快速幂”不限定模数，可能只是普通幂运算；保留候选供人工核对。'),
  快速幂: rule('shared.override.fast-power-zh', 'ambiguous', { candidates: ['math.number-theory.modular-exponentiation'] }, '“快速幂”不限定模数，可能只是普通幂运算；保留候选供人工核对。'),
});

/**
 * Hand-reviewed shared spellings that are straightforward, unambiguous synonyms.
 *
 * Membership is the *only* way a raw label reaches the taxonomy alias index, which is what keeps
 * historical alias entries (`tarjan`, `倍增`, `状态压缩`, …) from silently becoming equivalence
 * claims. Sprint 10 repair 1 removed every spelling that is narrower or broader than its node (those
 * live in `SHARED_OVERRIDE_RULES`), so this list holds direct synonyms only. Resolution still goes
 * through the supplied index, so a small custom catalog can resolve the same safe spelling to its
 * own id and a catalog without that node stays `unmapped`.
 */
export const TAG_CROSSWALK_SAFE_SPELLINGS: readonly string[] = deepFreeze([
  // Categories (a category target always resolves as `broader`, never as a technique).
  'search', '搜索',
  'implementation', '实现',
  'greedy', '贪心', '贪心算法',
  'dp', 'dynamic programming', '动态规划', '动规',
  'data structure', '数据结构',
  'graph', '图论', 'graph theory',
  'flow', 'network flow', '网络流',
  'matching', '匹配',
  'string', '字符串', 'strings',
  'math', '数学',
  'number theory', '数论',
  'combinatorics', '组合数学',
  'linear algebra', '线性代数',
  'geometry', '计算几何', '几何',
  'offline', '离线', '离线技巧',
  'trick', '技巧',
  // Search and implementation.
  'binary search', '二分', '二分查找', 'bisect',
  'binary search on answer', '二分答案', 'parametric search',
  'ternary search', '三分', '三分法',
  'two pointers', '双指针', 'two pointer',
  'sliding window', '滑动窗口', '尺取法',
  'meet in the middle', '折半搜索', 'mitm',
  'backtracking', '回溯',
  'simulation', '模拟', '模拟题',
  'constructive', '构造', '构造题', 'construction',
  'brute force', '暴力', '枚举', 'enumeration',
  'ad hoc', '思维题',
  'sorting', 'sort', '排序',
  // Greedy and dynamic programming.
  'exchange argument', '交换论证',
  'scheduling', '调度贪心', 'deadline greedy', '反悔贪心', 'regret greedy',
  'knapsack', '背包',
  'interval dp', '区间dp', '区间动态规划',
  'tree dp', '树形dp', '树上dp',
  'bitmask dp', '状压dp', '状态压缩dp',
  'digit dp', '数位dp', 'digital dp',
  'state machine dp', '状态机dp',
  // Data structures.
  'prefix sum', 'prefix sums', '前缀和',
  'difference array', '差分',
  'dsu', 'union find', '并查集',
  'fenwick', 'fenwick tree', '树状数组',
  'segment tree', '线段树', 'segtree',
  'lazy propagation', '懒标记', 'lazy segment tree',
  'sparse table', 'st表',
  'balanced bst', '平衡树',
  'heap', '堆', '优先队列', 'priority queue',
  'sqrt decomposition', '分块', 'block decomposition',
  'persistent data structure', '可持久化',
  'stack', '栈',
  'queue', '队列',
  // Graphs, flow and matching.
  'shortest path', '最短路',
  'topological sort', '拓扑排序', 'topsort',
  'scc', 'strongly connected components', '强连通分量',
  'tree algorithm', '树上问题', '树的遍历',
  'lca', 'lowest common ancestor', '最近公共祖先',
  'minimum spanning tree', 'mst', '最小生成树',
  'max flow', '最大流',
  'min cut', '最小割',
  'min cost flow', '费用流', 'mcmf',
  'bipartite matching', '二分图匹配',
  'general matching', '一般图匹配',
  // Strings.
  'kmp', 'prefix function', '前缀函数',
  'z algorithm', 'z函数', '扩展kmp', 'exkmp',
  'string hashing', '字符串哈希', 'rolling hash',
  'trie', '字典树', '前缀树',
  'aho corasick', 'ac自动机', 'acam',
  'suffix array', '后缀数组',
  'suffix automaton', '后缀自动机',
  'manacher', '马拉车',
  // Number theory, combinatorics and algebra.
  'modular inverse', '逆元', '模逆元',
  'crt', 'chinese remainder theorem', '中国剩余定理', 'excrt',
  'mobius', '莫比乌斯反演',
  'modular exponentiation', '模幂',
  'inclusion exclusion', '容斥', '容斥原理',
  'matrix exponentiation', '矩阵快速幂',
  'gaussian elimination', '高斯消元',
  'linear basis', '线性基', 'xor basis',
  'probability', '概率',
  'expected value', '期望',
  'game theory', '博弈论', '博弈',
  // Geometry.
  'convex hull', '凸包',
  'sweep line', '扫描线',
  'rotating calipers', '旋转卡壳',
  'half plane intersection', '半平面交',
  // Offline and tricks.
  'mo algorithm', '莫队', "mo's algorithm",
  'cdq divide and conquer', 'cdq分治', 'cdq',
  'parallel binary search', '整体二分', '整体二分答案',
  'bitwise', 'bitwise operations', '位运算',
  'coordinate compression', '离散化',
  'small to large', '启发式合并', 'dsu on tree',
  'randomization', '随机化',
  'interactive', '交互题', '交互',
]);

const SHARED_SAFE_BY_KEY: ReadonlyMap<string, string> = (() => {
  const table = new Map<string, string>();
  for (const spelling of TAG_CROSSWALK_SAFE_SPELLINGS) {
    const key = sourceTagKey(spelling);
    invariant(!table.has(key), 'invalid_input', `duplicate shared spelling ${JSON.stringify(spelling)}`, { key });
    table.set(key, spelling);
  }
  return table;
})();

/** Chinese explanation of every non-algorithm provenance reason (mirrors `classify.ts` rules). */
const METADATA_EXPLANATIONS: Readonly<Record<NonAlgorithmReason, string>> = deepFreeze({
  source: '平台或来源名称，是来源信息而不是算法。',
  event: '比赛、赛制或场次标签，属于来源信息。',
  year: '年份标签，属于来源信息。',
  difficulty: '难度或评分标签，保留为平台原生维度，不计入知识点。',
  noise: '占位或无语义标签。',
  language: '编程语言标签，不是算法。',
});

/** Keep only ids the supplied index knows, preserving order and dropping duplicates. */
function existingIds(index: TaxonomyIndex, ids: readonly string[]): string[] {
  const kept: string[] = [];
  for (const id of ids) {
    if (!kept.includes(id) && index.has(id)) {
      kept.push(id);
    }
  }
  return kept;
}

/** Turn a resolved rule into a frozen mapping; a counted rule without a live target is unmapped. */
function finalize(base: Omit<SourceTagMapping, 'relation' | 'targetIds' | 'candidateIds' | 'ruleId' | 'explanation' | 'referenceUrls'>, index: TaxonomyIndex, outcome: ResolvedRule): SourceTagMapping {
  const targets = existingIds(index, outcome.targetIds);
  const candidates = existingIds(index, outcome.candidateIds).filter((id) => !targets.includes(id));
  if (isCountedTagRelation(outcome.relation) && targets.length === 0) {
    return deepFreeze({
      ...base,
      relation: 'unmapped',
      targetIds: [],
      candidateIds: candidates,
      ruleId: `${outcome.ruleId}.missing-target`,
      explanation: `规则 ${outcome.ruleId} 指向的知识点不在当前词表中，保持未匹配，不退回旧别名。`,
      referenceUrls: [...outcome.referenceUrls],
    });
  }
  return deepFreeze({
    ...base,
    relation: outcome.relation,
    targetIds: isCountedTagRelation(outcome.relation) ? targets : [],
    candidateIds: candidates,
    ruleId: outcome.ruleId,
    explanation: outcome.explanation,
    referenceUrls: [...outcome.referenceUrls],
  });
}

/**
 * Give a shared outcome the public pages that support its terminology.
 *
 * Shared rules are not vocabulary-specific, so references are attached once the vocabulary is known:
 * the vocabulary's own public terminology page (when it has one; `manual` and `unknown` do not) plus
 * the first OI Wiki definition of the node the rule names. The pages document that the terms exist;
 * they are never an official cross-platform equivalence statement, and an `unknown` vocabulary never
 * reaches this code because it fails closed earlier.
 */
function attachSharedReferences(outcome: ResolvedRule, vocabulary: TagVocabulary): ResolvedRule {
  const urls: string[] = [...outcome.referenceUrls];
  for (const url of SHARED_VOCABULARY_REFERENCES[vocabulary] ?? []) {
    if (!urls.includes(url)) {
      urls.push(url);
    }
  }
  for (const id of [...outcome.targetIds, ...outcome.candidateIds]) {
    const definition = knowledgeResourcesFor(id)[0];
    if (definition !== undefined && !urls.includes(definition.url)) {
      urls.push(definition.url);
      break;
    }
  }
  return { ...outcome, referenceUrls: urls };
}

/** OI Wiki is a learning catalog: every hit becomes a zero-count reference with candidates. */
function asReference(outcome: ResolvedRule): ResolvedRule {
  const candidates = isCountedTagRelation(outcome.relation) ? [...outcome.targetIds, ...outcome.candidateIds] : [...outcome.candidateIds];
  return rule(
    `reference.${outcome.ruleId}`,
    'reference',
    { candidates },
    'OI Wiki 是学习资料导航目录：该条目只作为资料候选，永不进入解题证据计数。',
    OI_WIKI_REFERENCES,
  );
}

/**
 * Resolve one raw platform label against the supplied taxonomy.
 *
 * Pure, total and deterministic: malformed input is refused as `unmapped` instead of throwing, and
 * the result is deep-frozen. See the module header for the rule order and the counting semantics.
 */
export function mapSourceTag(index: TaxonomyIndex, input: MapSourceTagInput): SourceTagMapping {
  invariant(
    index !== null &&
      typeof index === 'object' &&
      typeof index.has === 'function' &&
      typeof index.resolveAlias === 'function',
    'invalid_input',
    'source-tag crosswalk needs a taxonomy index',
    {},
  );
  invariant(input !== null && typeof input === 'object', 'invalid_input', 'source-tag crosswalk needs an input object', {});
  const raw = typeof input.raw === 'string' ? input.raw : '';
  const sourceInstanceId = typeof input.sourceInstanceId === 'string' ? input.sourceInstanceId : '';
  // An explicit vocabulary is accepted only when this build knows it; anything else (a foreign
  // platform name, or a non-string at runtime) is refused as `unknown` and fails closed below.
  const vocabulary: TagVocabulary =
    input.vocabulary === undefined
      ? inferTagVocabulary(sourceInstanceId)
      : isTagVocabulary(input.vocabulary)
        ? input.vocabulary
        : 'unknown';
  const base = {
    mappingVersion: TAG_MAPPING_VERSION,
    taxonomyVersion: index.taxonomy.version,
    raw,
    sourceInstanceId,
    vocabulary,
  };
  const key = sourceTagKey(raw);
  if (key.length === 0) {
    return finalize(base, index, rule('raw.empty', 'unmapped', {}, '空标签没有语义，保持未匹配。'));
  }

  // 1. Explicit source-specific rules outrank every shared spelling.
  if (vocabulary === 'codeforces') {
    const sourced = CODEFORCES_RULES.get(key);
    if (sourced !== undefined) {
      return finalize(base, index, sourced);
    }
  }
  if (vocabulary === 'luogu') {
    const sourced = LUOGU_RULES.get(key);
    if (sourced !== undefined) {
      return finalize(base, index, sourced);
    }
    if (LUOGU_NUMERIC_TAG.test(key)) {
      return finalize(
        base,
        index,
        rule(
          'luogu.numeric-tag-id',
          'reference',
          {},
          '洛谷数字标签 ID（luogu-tag:…）是平台标识，不猜测其含义；标签名由平台字典另行提供，两者是彼此独立的原始标签。',
          LUOGU_REFERENCES,
        ),
      );
    }
  }
  if (vocabulary === 'nowcoder') {
    const sourced = NOWCODER_RULES.get(key);
    if (sourced !== undefined) {
      return finalize(base, index, sourced);
    }
    for (const composite of NOWCODER_COMPOSITE_PATTERNS) {
      if (composite.pattern.test(key)) {
        return finalize(base, index, composite.outcome);
      }
    }
  }

  // 2. An unrecognised vocabulary fails closed before every shared spelling rule. Provenance
  //    metadata (source/event/year/difficulty/language/noise) stays metadata; nothing else may reach
  //    the shared risk/override/allowlist tables, so a malformed or foreign instance id can never
  //    count through another platform's mapping.
  if (vocabulary === 'unknown') {
    const unknownReason = nonAlgorithmTagReason(raw);
    if (unknownReason !== null) {
      return finalize(
        base,
        index,
        rule(`metadata.${unknownReason}`, 'non_algorithm', {}, METADATA_EXPLANATIONS[unknownReason]),
      );
    }
    return finalize(
      base,
      index,
      rule(
        'vocabulary.unknown',
        'unmapped',
        {},
        '无法从来源实例判断平台词汇（实例缺失、格式不正确、主机未登记，或显式 vocabulary 不被识别）：除来源信息外一律保持未匹配，不套用共享拼写。',
      ),
    );
  }

  // 3. High-risk spellings and review-corrected spellings intercept the historical alias table.
  const shared = SHARED_RISK_RULES.get(key) ?? SHARED_OVERRIDE_RULES.get(key);
  if (shared !== undefined) {
    return finalize(
      base,
      index,
      vocabulary === 'oi-wiki' ? asReference(shared) : attachSharedReferences(shared, vocabulary),
    );
  }

  // 4. Hand-reviewed shared allowlist, resolved through the supplied index (never invented).
  const safeSpelling = SHARED_SAFE_BY_KEY.get(key);
  if (safeSpelling !== undefined) {
    const resolved = index.resolveAlias(safeSpelling);
    if (resolved !== null && index.has(resolved.taxonomyId)) {
      const node = index.node(resolved.taxonomyId);
      const categoryLevel = node !== null && node.kind === 'category';
      const outcome = categoryLevel
        ? rule(
            'shared.safe-category',
            'broader',
            { targets: [resolved.taxonomyId] },
            '该标签是目录分类（或其已复核共享拼写），只累计到分类，不推断任何子技巧。',
          )
        : rule(
            'shared.safe-exact',
            'exact',
            { targets: [resolved.taxonomyId] },
            '共享安全拼写：与目录节点同名或为已复核的直接同义拼写。',
          );
      return finalize(
        base,
        index,
        vocabulary === 'oi-wiki' ? asReference(outcome) : attachSharedReferences(outcome, vocabulary),
      );
    }
  }

  // 5. Unchanged provenance rules: a source/event/year/difficulty/language/noise label is metadata.
  const reason = nonAlgorithmTagReason(raw);
  if (reason !== null) {
    return finalize(base, index, rule(`metadata.${reason}`, 'non_algorithm', {}, METADATA_EXPLANATIONS[reason]));
  }

  // 6. Unmatched OI Wiki titles stay reference material instead of becoming algorithm gaps.
  if (vocabulary === 'oi-wiki') {
    return finalize(
      base,
      index,
      rule('oi-wiki.unrecognized', 'reference', {}, 'OI Wiki 是学习资料目录；未匹配到目录条目的标题只作资料，不作为解题证据。', OI_WIKI_REFERENCES),
    );
  }

  // 7. Everything else stays honestly unmapped; no legacy alias fallback exists. An unknown
  //    vocabulary already returned at step 2, so only the recognised platforms remain here.
  const references = SHARED_VOCABULARY_REFERENCES[vocabulary] ?? [];
  return finalize(
    base,
    index,
    rule(`${vocabulary}.unmapped`, 'unmapped', {}, '该来源标签不在当前保守对照表中，保持未匹配，等待人工核对。', references),
  );
}
