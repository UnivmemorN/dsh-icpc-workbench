/**
 * Verified external learning resources for the current knowledge taxonomy (Sprint 09b).
 *
 * The mapping is static, hand-checked public navigation metadata: on
 * {@link KNOWLEDGE_RESOURCES_CHECKED_DATE} every URL and title below was matched against OI Wiki's
 * own official navigation (its site index and table of contents). That check confirms each entry
 * exists under the stated title on oi-wiki.org; it does not claim that every full article was read
 * or individually content-verified, and no article text, code or image was copied. Nothing here is
 * fetched, crawled or generated at runtime; the pages stay ordinary external links a reader can open.
 *
 * `relation` says how a page relates to its taxonomy node: `topic` for a page about that
 * technique and `overview` for a deliberately broader page that only gives context (for example
 * `search.ternary`). Composite nodes (for example `search.traversal`) can carry several pages,
 * and one page may serve several nodes. The taxonomy itself is untouched: this module never adds,
 * renames or re-parents a node.
 *
 * Immutable and total: the record is deep-frozen, and an id the vocabulary does not know (a future
 * taxonomy version, or a prototype key such as `constructor`) returns an empty list instead of a
 * guessed or inherited link.
 */
import { deepFreeze } from './immutable.js';

/** How a linked page relates to the taxonomy node it is attached to. */
export type KnowledgeResourceRelation = 'topic' | 'overview';

/** One external learning reference; the URL is HTTPS and its title was checked by hand. */
export interface KnowledgeResource {
  readonly provider: string;
  readonly title: string;
  readonly url: string;
  readonly relation: KnowledgeResourceRelation;
}

/** Date (ISO) on which every URL and title below was matched against OI Wiki's official navigation. */
export const KNOWLEDGE_RESOURCES_CHECKED_DATE = '2026-09-13';

/** Attribution of one external source the knowledge view credits. */
export interface KnowledgeAttributionSource {
  readonly provider: string;
  readonly url: string;
  /** What this project took from the source: a presentation or learning reference, never a verdict. */
  readonly contribution: string;
}

/**
 * Sources credited by the knowledge view footer.
 *
 * Nowcoder's ACM skill exercise is referenced for how techniques are classified, filtered and
 * presented for practice; OI Wiki for topic learning material. Neither source certifies a user's
 * mastery, and neither is copied into this project.
 */
export const KNOWLEDGE_ATTRIBUTION_SOURCES: Readonly<
  Record<'nowcoder' | 'oiWiki', KnowledgeAttributionSource>
> = deepFreeze({
  nowcoder: {
    provider: '牛客 ACM 模式技能练习',
    url: 'https://ac.nowcoder.com/acm/skill/acm',
    contribution: '知识点分类、筛选与练习呈现方式的参考',
  },
  oiWiki: {
    provider: 'OI Wiki 团队与社区',
    url: 'https://oi-wiki.org/',
    contribution: '知识点学习资料参考',
  },
});

/** OI Wiki copyright declaration linked by the footer (per-page exceptions remain). */
export const KNOWLEDGE_ATTRIBUTION_COPYRIGHT_URL = 'https://github.com/OI-wiki/OI-wiki#版权声明';

/** Honest attribution notes rendered with the footer. */
export const KNOWLEDGE_ATTRIBUTION_NOTES: readonly string[] = deepFreeze([
  '知识点状态与判定规则是本项目的设计；外部资料只作学习参考，不构成掌握证明。',
  'OI Wiki 的文字内容按其版权声明授权（非代码部分 CC BY-SA 4.0，另有 SATA 与逐页例外）；本项目未复制其文章、代码或图片。',
  '牛客 ACM 模式技能练习仅作为知识点分类、筛选与练习呈现方式的参考。',
]);

/** Resources of every current taxonomy id, in catalog order; frozen with all nested entries. */
export const KNOWLEDGE_RESOURCES_BY_TAXONOMY_ID: Readonly<
  Record<string, readonly KnowledgeResource[]>
> = deepFreeze({
  'search': [
    { provider: 'OI Wiki', title: '搜索', url: 'https://oi-wiki.org/search/', relation: 'overview' },
  ],
  'search.binary': [
    { provider: 'OI Wiki', title: '二分', url: 'https://oi-wiki.org/basic/binary/', relation: 'topic' },
  ],
  'search.binary-answer': [
    { provider: 'OI Wiki', title: '二分', url: 'https://oi-wiki.org/basic/binary/', relation: 'topic' },
  ],
  'search.ternary': [
    { provider: 'OI Wiki', title: '二分', url: 'https://oi-wiki.org/basic/binary/', relation: 'overview' },
  ],
  'search.two-pointers': [
    { provider: 'OI Wiki', title: '双指针', url: 'https://oi-wiki.org/misc/two-pointer/', relation: 'topic' },
  ],
  'search.sliding-window': [
    { provider: 'OI Wiki', title: '双指针', url: 'https://oi-wiki.org/misc/two-pointer/', relation: 'overview' },
  ],
  'search.meet-in-the-middle': [
    { provider: 'OI Wiki', title: '双向搜索', url: 'https://oi-wiki.org/search/bidirectional/', relation: 'overview' },
  ],
  'search.traversal': [
    { provider: 'OI Wiki', title: 'DFS（搜索）', url: 'https://oi-wiki.org/search/dfs/', relation: 'topic' },
    { provider: 'OI Wiki', title: 'BFS（搜索）', url: 'https://oi-wiki.org/search/bfs/', relation: 'topic' },
  ],
  'search.backtracking': [
    { provider: 'OI Wiki', title: '回溯法', url: 'https://oi-wiki.org/search/backtracking/', relation: 'topic' },
  ],
  'search.heuristic': [
    { provider: 'OI Wiki', title: '启发式搜索', url: 'https://oi-wiki.org/search/heuristic/', relation: 'topic' },
    { provider: 'OI Wiki', title: '模拟退火', url: 'https://oi-wiki.org/misc/simulated-annealing/', relation: 'topic' },
  ],
  'implementation': [
    { provider: 'OI Wiki', title: '算法基础', url: 'https://oi-wiki.org/basic/', relation: 'overview' },
  ],
  'implementation.simulation': [
    { provider: 'OI Wiki', title: '模拟', url: 'https://oi-wiki.org/basic/simulate/', relation: 'topic' },
  ],
  'implementation.constructive': [
    { provider: 'OI Wiki', title: '构造', url: 'https://oi-wiki.org/basic/construction/', relation: 'topic' },
  ],
  'implementation.brute-force': [
    { provider: 'OI Wiki', title: '枚举', url: 'https://oi-wiki.org/basic/enumerate/', relation: 'topic' },
  ],
  'implementation.ad-hoc': [
    { provider: 'OI Wiki', title: '算法基础', url: 'https://oi-wiki.org/basic/', relation: 'overview' },
  ],
  'greedy': [
    { provider: 'OI Wiki', title: '贪心', url: 'https://oi-wiki.org/basic/greedy/', relation: 'overview' },
  ],
  'greedy.exchange-argument': [
    { provider: 'OI Wiki', title: '贪心', url: 'https://oi-wiki.org/basic/greedy/', relation: 'overview' },
  ],
  'greedy.scheduling': [
    { provider: 'OI Wiki', title: '贪心', url: 'https://oi-wiki.org/basic/greedy/', relation: 'overview' },
  ],
  'dp': [
    { provider: 'OI Wiki', title: '动态规划', url: 'https://oi-wiki.org/dp/', relation: 'overview' },
  ],
  'dp.knapsack': [
    { provider: 'OI Wiki', title: '背包 DP', url: 'https://oi-wiki.org/dp/knapsack/', relation: 'topic' },
  ],
  'dp.interval': [
    { provider: 'OI Wiki', title: '区间 DP', url: 'https://oi-wiki.org/dp/interval/', relation: 'topic' },
  ],
  'dp.tree': [
    { provider: 'OI Wiki', title: '树形 DP', url: 'https://oi-wiki.org/dp/tree/', relation: 'topic' },
  ],
  'dp.bitmask': [
    { provider: 'OI Wiki', title: '状压 DP', url: 'https://oi-wiki.org/dp/state/', relation: 'topic' },
  ],
  'dp.digit': [
    { provider: 'OI Wiki', title: '数位 DP', url: 'https://oi-wiki.org/dp/number/', relation: 'topic' },
  ],
  'dp.sos': [
    { provider: 'OI Wiki', title: '动态规划', url: 'https://oi-wiki.org/dp/', relation: 'overview' },
    { provider: 'OI Wiki', title: '二进制集合操作', url: 'https://oi-wiki.org/math/binary-set/', relation: 'overview' },
  ],
  'dp.state-machine': [
    { provider: 'OI Wiki', title: '动态规划基础', url: 'https://oi-wiki.org/dp/basic/', relation: 'overview' },
    { provider: 'OI Wiki', title: '有限状态自动机', url: 'https://oi-wiki.org/misc/fsm/', relation: 'overview' },
  ],
  'dp.optimization': [
    { provider: 'OI Wiki', title: 'DP 优化简介', url: 'https://oi-wiki.org/dp/opt/dp-opt/', relation: 'topic' },
  ],
  'data-structure': [
    { provider: 'OI Wiki', title: '数据结构', url: 'https://oi-wiki.org/ds/', relation: 'overview' },
  ],
  'data-structure.prefix-sum': [
    { provider: 'OI Wiki', title: '前缀和 & 差分', url: 'https://oi-wiki.org/basic/prefix-sum/', relation: 'topic' },
  ],
  'data-structure.difference-array': [
    { provider: 'OI Wiki', title: '前缀和 & 差分', url: 'https://oi-wiki.org/basic/prefix-sum/', relation: 'topic' },
  ],
  'data-structure.dsu': [
    { provider: 'OI Wiki', title: '并查集', url: 'https://oi-wiki.org/ds/dsu/', relation: 'topic' },
  ],
  'data-structure.bit': [
    { provider: 'OI Wiki', title: '树状数组', url: 'https://oi-wiki.org/ds/fenwick/', relation: 'topic' },
  ],
  'data-structure.segment-tree': [
    { provider: 'OI Wiki', title: '线段树基础', url: 'https://oi-wiki.org/ds/seg/', relation: 'topic' },
  ],
  'data-structure.segment-tree-lazy': [
    { provider: 'OI Wiki', title: '线段树基础', url: 'https://oi-wiki.org/ds/seg/', relation: 'topic' },
  ],
  'data-structure.sparse-table': [
    { provider: 'OI Wiki', title: 'ST 表', url: 'https://oi-wiki.org/ds/sparse-table/', relation: 'topic' },
    { provider: 'OI Wiki', title: '专题', url: 'https://oi-wiki.org/topic/rmq/', relation: 'topic' },
  ],
  'data-structure.balanced-bst': [
    { provider: 'OI Wiki', title: '二叉搜索树 & 平衡树', url: 'https://oi-wiki.org/ds/bst/', relation: 'topic' },
  ],
  'data-structure.heap': [
    { provider: 'OI Wiki', title: '堆简介', url: 'https://oi-wiki.org/ds/heap/', relation: 'topic' },
  ],
  'data-structure.monotonic-stack': [
    { provider: 'OI Wiki', title: '单调栈', url: 'https://oi-wiki.org/ds/monotonic-stack/', relation: 'topic' },
    { provider: 'OI Wiki', title: '单调队列', url: 'https://oi-wiki.org/ds/monotonic-queue/', relation: 'topic' },
  ],
  'data-structure.sqrt-decomposition': [
    { provider: 'OI Wiki', title: '分块思想', url: 'https://oi-wiki.org/ds/decompose/', relation: 'topic' },
  ],
  'data-structure.persistent': [
    { provider: 'OI Wiki', title: '可持久化数据结构简介', url: 'https://oi-wiki.org/ds/persistent/', relation: 'topic' },
  ],
  'graph': [
    { provider: 'OI Wiki', title: '图论', url: 'https://oi-wiki.org/graph/', relation: 'overview' },
  ],
  'graph.shortest-path': [
    { provider: 'OI Wiki', title: '最短路', url: 'https://oi-wiki.org/graph/shortest-path/', relation: 'topic' },
  ],
  'graph.topological-sort': [
    { provider: 'OI Wiki', title: '拓扑排序', url: 'https://oi-wiki.org/graph/topo/', relation: 'topic' },
  ],
  'graph.scc': [
    { provider: 'OI Wiki', title: '强连通分量', url: 'https://oi-wiki.org/graph/scc/', relation: 'topic' },
  ],
  'graph.bridges-articulation': [
    { provider: 'OI Wiki', title: '割点和桥', url: 'https://oi-wiki.org/graph/cut/', relation: 'topic' },
  ],
  'graph.tree': [
    { provider: 'OI Wiki', title: '树基础', url: 'https://oi-wiki.org/graph/tree-basic/', relation: 'overview' },
  ],
  'graph.lca': [
    { provider: 'OI Wiki', title: '最近公共祖先', url: 'https://oi-wiki.org/graph/lca/', relation: 'topic' },
  ],
  'graph.tree-diameter': [
    { provider: 'OI Wiki', title: '树的直径', url: 'https://oi-wiki.org/graph/tree-diameter/', relation: 'topic' },
    { provider: 'OI Wiki', title: '树形 DP', url: 'https://oi-wiki.org/dp/tree/', relation: 'topic' },
  ],
  'flow': [
    { provider: 'OI Wiki', title: '网络流简介', url: 'https://oi-wiki.org/graph/flow/', relation: 'overview' },
  ],
  'flow.max-flow': [
    { provider: 'OI Wiki', title: '最大流', url: 'https://oi-wiki.org/graph/flow/max-flow/', relation: 'topic' },
  ],
  'flow.min-cut': [
    { provider: 'OI Wiki', title: '最小割', url: 'https://oi-wiki.org/graph/flow/min-cut/', relation: 'topic' },
  ],
  'flow.min-cost-flow': [
    { provider: 'OI Wiki', title: '费用流', url: 'https://oi-wiki.org/graph/flow/min-cost/', relation: 'topic' },
  ],
  'matching': [
    { provider: 'OI Wiki', title: '图匹配', url: 'https://oi-wiki.org/graph/graph-matching/graph-match/', relation: 'overview' },
  ],
  'matching.bipartite': [
    { provider: 'OI Wiki', title: '二分图最大匹配', url: 'https://oi-wiki.org/graph/graph-matching/bigraph-match/', relation: 'topic' },
  ],
  'matching.general': [
    { provider: 'OI Wiki', title: '一般图最大匹配', url: 'https://oi-wiki.org/graph/graph-matching/general-match/', relation: 'topic' },
  ],
  'matching.hall': [
    { provider: 'OI Wiki', title: '二分图最大匹配', url: 'https://oi-wiki.org/graph/graph-matching/bigraph-match/', relation: 'overview' },
  ],
  'strings': [
    { provider: 'OI Wiki', title: '字符串', url: 'https://oi-wiki.org/string/', relation: 'overview' },
  ],
  'strings.kmp': [
    { provider: 'OI Wiki', title: '前缀函数与 KMP 算法', url: 'https://oi-wiki.org/string/kmp/', relation: 'topic' },
  ],
  'strings.z-algorithm': [
    { provider: 'OI Wiki', title: 'Z 函数（扩展 KMP）', url: 'https://oi-wiki.org/string/z-func/', relation: 'topic' },
  ],
  'strings.hashing': [
    { provider: 'OI Wiki', title: '字符串哈希', url: 'https://oi-wiki.org/string/hash/', relation: 'topic' },
  ],
  'strings.trie': [
    { provider: 'OI Wiki', title: '字典树 (Trie)', url: 'https://oi-wiki.org/string/trie/', relation: 'topic' },
  ],
  'strings.ac-automaton': [
    { provider: 'OI Wiki', title: 'AC 自动机', url: 'https://oi-wiki.org/string/ac-automaton/', relation: 'topic' },
  ],
  'strings.suffix-array': [
    { provider: 'OI Wiki', title: '后缀数组简介', url: 'https://oi-wiki.org/string/sa/', relation: 'topic' },
  ],
  'strings.suffix-automaton': [
    { provider: 'OI Wiki', title: '后缀自动机 (SAM)', url: 'https://oi-wiki.org/string/sam/', relation: 'topic' },
  ],
  'strings.manacher': [
    { provider: 'OI Wiki', title: 'Manacher', url: 'https://oi-wiki.org/string/manacher/', relation: 'topic' },
  ],
  'math': [
    { provider: 'OI Wiki', title: '数学', url: 'https://oi-wiki.org/math/', relation: 'overview' },
  ],
  'math.number-theory': [
    { provider: 'OI Wiki', title: '数论基础', url: 'https://oi-wiki.org/math/number-theory/basic/', relation: 'overview' },
  ],
  'math.number-theory.gcd': [
    { provider: 'OI Wiki', title: '最大公约数', url: 'https://oi-wiki.org/math/number-theory/gcd/', relation: 'topic' },
    { provider: 'OI Wiki', title: '线性同余方程', url: 'https://oi-wiki.org/math/number-theory/linear-equation/', relation: 'topic' },
  ],
  'math.number-theory.prime-sieve': [
    { provider: 'OI Wiki', title: '筛法', url: 'https://oi-wiki.org/math/number-theory/sieve/', relation: 'topic' },
    { provider: 'OI Wiki', title: '分解质因数', url: 'https://oi-wiki.org/math/number-theory/pollard-rho/', relation: 'topic' },
  ],
  'math.number-theory.modular-inverse': [
    { provider: 'OI Wiki', title: '模逆元', url: 'https://oi-wiki.org/math/number-theory/inverse/', relation: 'topic' },
  ],
  'math.number-theory.crt': [
    { provider: 'OI Wiki', title: '中国剩余定理', url: 'https://oi-wiki.org/math/number-theory/crt/', relation: 'topic' },
  ],
  'math.number-theory.mobius': [
    { provider: 'OI Wiki', title: '莫比乌斯反演', url: 'https://oi-wiki.org/math/number-theory/mobius/', relation: 'topic' },
  ],
  'math.combinatorics': [
    { provider: 'OI Wiki', title: '排列组合', url: 'https://oi-wiki.org/math/combinatorics/combination/', relation: 'overview' },
  ],
  'math.combinatorics.inclusion-exclusion': [
    { provider: 'OI Wiki', title: '容斥原理', url: 'https://oi-wiki.org/math/combinatorics/inclusion-exclusion-principle/', relation: 'topic' },
  ],
  'math.combinatorics.catalan': [
    { provider: 'OI Wiki', title: '卡特兰数', url: 'https://oi-wiki.org/math/combinatorics/catalan/', relation: 'topic' },
    { provider: 'OI Wiki', title: '范德蒙德卷积', url: 'https://oi-wiki.org/math/combinatorics/vandermonde-convolution/', relation: 'topic' },
  ],
  'math.combinatorics.lucas': [
    { provider: 'OI Wiki', title: '卢卡斯定理', url: 'https://oi-wiki.org/math/number-theory/lucas/', relation: 'topic' },
    { provider: 'OI Wiki', title: '斯特林数', url: 'https://oi-wiki.org/math/combinatorics/stirling/', relation: 'topic' },
  ],
  'math.linear-algebra': [
    { provider: 'OI Wiki', title: '线性代数简介', url: 'https://oi-wiki.org/math/linear-algebra/', relation: 'overview' },
  ],
  'math.linear-algebra.matrix-power': [
    { provider: 'OI Wiki', title: '矩阵', url: 'https://oi-wiki.org/math/linear-algebra/matrix/', relation: 'topic' },
    { provider: 'OI Wiki', title: '快速幂', url: 'https://oi-wiki.org/math/binary-exponentiation/', relation: 'topic' },
  ],
  'math.linear-algebra.gaussian-elimination': [
    { provider: 'OI Wiki', title: '高斯消元', url: 'https://oi-wiki.org/math/numerical/gauss/', relation: 'topic' },
  ],
  'math.linear-algebra.linear-basis': [
    { provider: 'OI Wiki', title: '线性基', url: 'https://oi-wiki.org/math/linear-algebra/basis/', relation: 'topic' },
  ],
  'math.probability': [
    { provider: 'OI Wiki', title: '基本概念', url: 'https://oi-wiki.org/math/probability/basic-conception/', relation: 'topic' },
  ],
  'math.expected-value': [
    { provider: 'OI Wiki', title: '随机变量的数字特征', url: 'https://oi-wiki.org/math/probability/exp-var/', relation: 'topic' },
  ],
  'math.game-theory': [
    { provider: 'OI Wiki', title: '博弈论简介', url: 'https://oi-wiki.org/math/game-theory/intro/', relation: 'topic' },
  ],
  'math.fft': [
    { provider: 'OI Wiki', title: '快速傅里叶变换', url: 'https://oi-wiki.org/math/poly/fft/', relation: 'topic' },
    { provider: 'OI Wiki', title: '快速数论变换', url: 'https://oi-wiki.org/math/poly/ntt/', relation: 'topic' },
  ],
  'geometry': [
    { provider: 'OI Wiki', title: '计算几何', url: 'https://oi-wiki.org/geometry/', relation: 'overview' },
  ],
  'geometry.basic': [
    { provider: 'OI Wiki', title: '二维计算几何基础', url: 'https://oi-wiki.org/geometry/2d/', relation: 'topic' },
  ],
  'geometry.convex-hull': [
    { provider: 'OI Wiki', title: '凸包', url: 'https://oi-wiki.org/geometry/convex-hull/', relation: 'topic' },
  ],
  'geometry.sweep-line': [
    { provider: 'OI Wiki', title: '扫描线', url: 'https://oi-wiki.org/geometry/scanning/', relation: 'topic' },
  ],
  'geometry.rotating-calipers': [
    { provider: 'OI Wiki', title: '旋转卡壳', url: 'https://oi-wiki.org/geometry/rotating-calipers/', relation: 'topic' },
  ],
  'geometry.half-plane': [
    { provider: 'OI Wiki', title: '半平面交', url: 'https://oi-wiki.org/geometry/half-plane/', relation: 'topic' },
  ],
  'offline': [
    { provider: 'OI Wiki', title: '离线算法简介', url: 'https://oi-wiki.org/misc/offline/', relation: 'overview' },
  ],
  'offline.mo': [
    { provider: 'OI Wiki', title: '莫队算法简介', url: 'https://oi-wiki.org/misc/mo-algo-intro/', relation: 'topic' },
  ],
  'offline.cdq-divide': [
    { provider: 'OI Wiki', title: 'CDQ 分治', url: 'https://oi-wiki.org/misc/cdq-divide/', relation: 'topic' },
  ],
  'offline.parallel-binary-search': [
    { provider: 'OI Wiki', title: '整体二分', url: 'https://oi-wiki.org/misc/parallel-binsearch/', relation: 'topic' },
  ],
  'tricks': [
    { provider: 'OI Wiki', title: '杂项', url: 'https://oi-wiki.org/misc/', relation: 'overview' },
  ],
  'tricks.bitwise': [
    { provider: 'OI Wiki', title: '位操作', url: 'https://oi-wiki.org/math/bit/', relation: 'topic' },
  ],
  'tricks.discretization': [
    { provider: 'OI Wiki', title: '离散化', url: 'https://oi-wiki.org/misc/discrete/', relation: 'topic' },
  ],
  'tricks.small-to-large': [
    { provider: 'OI Wiki', title: '树上启发式合并', url: 'https://oi-wiki.org/graph/dsu-on-tree/', relation: 'topic' },
  ],
  'tricks.randomization': [
    { provider: 'OI Wiki', title: '随机化技巧', url: 'https://oi-wiki.org/misc/rand-technique/', relation: 'topic' },
  ],
  'tricks.interactive': [
    { provider: 'OI Wiki', title: '交互题', url: 'https://oi-wiki.org/contest/interaction/', relation: 'topic' },
  ],
  'graph.minimum-spanning-tree': [
    { provider: 'OI Wiki', title: '最小生成树', url: 'https://oi-wiki.org/graph/mst/', relation: 'topic' },
  ],
  'implementation.sorting': [
    { provider: 'OI Wiki', title: '排序简介', url: 'https://oi-wiki.org/basic/sort-intro/', relation: 'topic' },
  ],
  'math.number-theory.modular-exponentiation': [
    { provider: 'OI Wiki', title: '快速幂', url: 'https://oi-wiki.org/math/binary-exponentiation/', relation: 'topic' },
  ],
  'data-structure.stack': [
    { provider: 'OI Wiki', title: '栈', url: 'https://oi-wiki.org/ds/stack/', relation: 'topic' },
  ],
  'data-structure.queue': [
    { provider: 'OI Wiki', title: '队列', url: 'https://oi-wiki.org/ds/queue/', relation: 'topic' },
  ],
});

/** Shared frozen empty list, so an unknown id allocates nothing. */
const NO_RESOURCES: readonly KnowledgeResource[] = deepFreeze([]);

/**
 * Resources of one taxonomy id, or an empty list when the id is unknown to this mapping.
 *
 * Only an own key can match: a prototype name such as `toString` is not a taxonomy id and returns
 * the empty list.
 */
export function knowledgeResourcesFor(taxonomyId: string): readonly KnowledgeResource[] {
  const found = Object.hasOwn(KNOWLEDGE_RESOURCES_BY_TAXONOMY_ID, taxonomyId)
    ? KNOWLEDGE_RESOURCES_BY_TAXONOMY_ID[taxonomyId]
    : undefined;
  return found ?? NO_RESOURCES;
}
