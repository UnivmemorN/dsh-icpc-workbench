/**
 * Source-aware raw-tag crosswalk (Sprint 10).
 *
 * These cases drive the pure resolver directly against the shipped taxonomy and against small custom
 * catalogs. They pin the externally meaningful guarantees: vocabulary is inferred only from a
 * canonical source instance, source-specific rules outrank shared spellings, broad Codeforces
 * categories never populate children, high-risk spellings never claim a node, constituents of frozen
 * composite nodes stay uncounted candidates, Luogu numeric ids stay platform references, OI Wiki
 * titles are reference-only, the matching key never merges punctuation-sensitive labels, and a
 * missing target is `unmapped` instead of falling back to a historical alias.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CURRENT_TAXONOMY,
  TAG_CROSSWALK_SAFE_SPELLINGS,
  TAG_MAPPING_VERSION,
  classifyRawTag,
  createTaxonomy,
  createTaxonomyIndex,
  inferTagVocabulary,
  isCountedTagRelation,
  isDeeplyFrozen,
  isTagVocabulary,
  isUnresolvedAlgorithmRelation,
  mapSourceTag,
  sourceTagKey,
  type SourceTagMapping,
  type TaxonomyNode,
  type TaxonomyNodeKind,
} from '../../src/domain/index.js';

const INDEX = createTaxonomyIndex(CURRENT_TAXONOMY);
const CF = 'codeforces:codeforces.com';
const LUOGU = 'luogu:www.luogu.com.cn';
const NOWCODER = 'nowcoder:ac.nowcoder.com';
const OI_WIKI = 'oi-wiki:oi-wiki.org';

function map(raw: string, sourceInstanceId: string = CF, vocabulary?: SourceTagMapping['vocabulary']): SourceTagMapping {
  return vocabulary === undefined
    ? mapSourceTag(INDEX, { raw, sourceInstanceId })
    : mapSourceTag(INDEX, { raw, sourceInstanceId, vocabulary });
}

function node(
  id: string,
  parentId: string | null,
  kind: TaxonomyNodeKind,
  en: string,
  zh: string,
  aliases: readonly string[] = [],
): TaxonomyNode {
  return { id, parentId, kind, names: { en, zh }, aliases, description: `${en} (crosswalk test node)` };
}

void test('vocabulary is inferred from a canonical source instance id only', () => {
  assert.equal(inferTagVocabulary('codeforces:codeforces.com'), 'codeforces');
  assert.equal(inferTagVocabulary('codeforces:m1.codeforces.com'), 'codeforces', 'a mirror subdomain stays CF');
  assert.equal(inferTagVocabulary('luogu:www.luogu.com.cn'), 'luogu');
  assert.equal(inferTagVocabulary('nowcoder:ac.nowcoder.com'), 'nowcoder');
  assert.equal(inferTagVocabulary('oi-wiki:oi-wiki.org'), 'oi-wiki');
  assert.equal(inferTagVocabulary('manual:local'), 'manual');
  assert.equal(inferTagVocabulary('hydro:hydro.example.edu'), 'unknown', 'hydro borrows no other platform rules');
  assert.equal(inferTagVocabulary('codeforces'), 'unknown', 'a bare platform word is not an instance id');
  assert.equal(inferTagVocabulary('codeforces:'), 'unknown');
  assert.equal(inferTagVocabulary('codeforces:%zz'), 'unknown', 'malformed escaping is refused');
  assert.equal(inferTagVocabulary('codeforces:evil.example'), 'unknown', 'an arbitrary host is refused');
  assert.equal(inferTagVocabulary(''), 'unknown');
  assert.equal(inferTagVocabulary('   '), 'unknown');
});

void test('every shared safe spelling resolves in the shipped taxonomy and no key is duplicated', () => {
  const keys = new Set<string>();
  for (const spelling of TAG_CROSSWALK_SAFE_SPELLINGS) {
    const key = sourceTagKey(spelling);
    assert.equal(keys.has(key), false, `duplicate shared spelling ${JSON.stringify(spelling)}`);
    keys.add(key);
    const mapping = map(spelling);
    assert.ok(
      isCountedTagRelation(mapping.relation),
      `${spelling} should map, got ${mapping.relation} (${mapping.ruleId})`,
    );
    assert.ok(mapping.targetIds.length > 0, `${spelling} needs a live target`);
    for (const id of mapping.targetIds) {
      assert.equal(INDEX.has(id), true, `${spelling} produced an invented id ${id}`);
    }
  }
});

void test('Codeforces broad categories map to categories and never to a child technique', () => {
  const dp = map('dp');
  assert.equal(dp.vocabulary, 'codeforces');
  assert.equal(dp.relation, 'broader');
  assert.deepEqual(dp.targetIds, ['dp']);
  assert.equal(dp.ruleId, 'cf.dp');

  assert.deepEqual(map('Data Structures').targetIds, ['data-structure'], 'the key is case-insensitive');
  assert.deepEqual(map('graphs').targetIds, ['graph']);
  assert.deepEqual(map('trees').targetIds, ['graph'], 'trees is a broad graph label, not a tree technique');
  assert.deepEqual(map('probabilities').targetIds, ['math']);
  assert.deepEqual(map('string suffix structures').targetIds, ['strings']);

  const dfs = map('dfs and similar');
  assert.equal(dfs.relation, 'broader');
  assert.deepEqual(dfs.targetIds, ['search'], 'the broad CF label lands on the search category');
  assert.deepEqual(dfs.candidateIds, [], 'no DFS/BFS child is inferred');

  const binarySearch = map('binary search');
  assert.equal(binarySearch.relation, 'broader');
  assert.deepEqual(binarySearch.targetIds, ['search'], 'CF binary search is conservatively the search category');
  assert.equal(binarySearch.targetIds.includes('search.binary'), false);
  assert.equal(binarySearch.targetIds.includes('search.binary-answer'), false);

  const sortings = map('sortings');
  assert.equal(sortings.relation, 'exact');
  assert.deepEqual(sortings.targetIds, ['implementation.sorting']);

  const hashing = map('hashing');
  assert.equal(hashing.relation, 'ambiguous');
  assert.deepEqual(hashing.targetIds, [], 'hashing is not necessarily string hashing');
  assert.deepEqual(hashing.candidateIds, ['strings.hashing', 'tricks.randomization']);

  const bitmasks = map('bitmasks');
  assert.equal(bitmasks.relation, 'ambiguous');
  assert.deepEqual(bitmasks.targetIds, [], 'bitmasks is not automatically bitmask DP');
  assert.deepEqual(bitmasks.candidateIds, ['dp.bitmask', 'tricks.bitwise']);

  const unknown = map('divide and conquer');
  assert.equal(unknown.relation, 'unmapped', 'an unmapped CF label stays explicit');
  assert.equal(unknown.ruleId, 'codeforces.unmapped');
  assert.deepEqual(unknown.targetIds, []);
  assert.equal(isUnresolvedAlgorithmRelation(unknown.relation), true);

  assert.equal(map('*special').relation, 'non_algorithm');
  assert.equal(map('2021').relation, 'non_algorithm');
  assert.equal(map('C++').relation, 'non_algorithm');
});

void test('Luogu bilingual labels map once and numeric platform ids stay references', () => {
  const bilingual = map('动态规划 DP', LUOGU);
  assert.equal(bilingual.vocabulary, 'luogu');
  assert.equal(bilingual.relation, 'broader');
  assert.deepEqual(bilingual.targetIds, ['dp']);
  assert.equal(bilingual.ruleId, 'luogu.dp-bilingual');
  assert.deepEqual(map('动态规划', LUOGU).targetIds, ['dp'], 'the plain Chinese name comes from the shared list');

  const numeric = map('luogu-tag:42', LUOGU);
  assert.equal(numeric.relation, 'reference');
  assert.equal(numeric.ruleId, 'luogu.numeric-tag-id');
  assert.deepEqual(numeric.targetIds, [], 'a numeric id is never guessed into an algorithm');
  assert.deepEqual(numeric.candidateIds, []);
  assert.equal(isUnresolvedAlgorithmRelation(numeric.relation), false, 'a numeric id is not an algorithm gap');
  assert.equal(map('luogu-tag:-2', LUOGU).relation, 'reference', 'negative ids are legal platform ids');

  assert.deepEqual(map('线段树', LUOGU).targetIds, ['data-structure.segment-tree']);

  const queue = map('单调队列', LUOGU);
  assert.equal(queue.relation, 'narrower');
  assert.deepEqual(queue.targetIds, []);
  assert.deepEqual(queue.candidateIds, ['data-structure.monotonic-stack']);

  const dfs = map('DFS', LUOGU);
  assert.equal(dfs.relation, 'narrower');
  assert.deepEqual(dfs.targetIds, []);
  assert.deepEqual(dfs.candidateIds, ['search.traversal']);
});

void test('Nowcoder composites never fan out and safe synonyms still resolve', () => {
  assert.deepEqual(map('树状数组', NOWCODER).targetIds, ['data-structure.bit']);

  const tarjan = map('tarjan', NOWCODER);
  assert.equal(tarjan.relation, 'ambiguous');
  assert.equal(tarjan.ruleId, 'nowcoder.tarjan');
  assert.deepEqual(tarjan.candidateIds, ['graph.scc']);
  assert.deepEqual(tarjan.targetIds, []);

  const polynomial = map('多项式算法(fft/ntt/fwt/idft)', NOWCODER);
  assert.equal(polynomial.relation, 'composite');
  assert.deepEqual(polynomial.targetIds, [], 'the composite label counts nothing');
  assert.deepEqual(polynomial.candidateIds, ['math.fft']);

  const sieve = map('筛法(线性筛/杜教筛/洲阁筛/min_25筛)', NOWCODER);
  assert.equal(sieve.relation, 'composite');
  assert.deepEqual(sieve.targetIds, []);
  assert.deepEqual(sieve.candidateIds, ['math.number-theory.prime-sieve']);

  const gcd = map('gcd(裴蜀定理)', NOWCODER);
  assert.equal(gcd.relation, 'composite');
  assert.deepEqual(gcd.targetIds, []);
  assert.deepEqual(gcd.candidateIds, ['math.number-theory.gcd']);
  const bareGcd = map('gcd', NOWCODER);
  assert.equal(bareGcd.relation, 'narrower', 'the combined GCD/extended-Euclid node is not claimed by one half');
  assert.deepEqual(bareGcd.targetIds, []);
  assert.deepEqual(bareGcd.candidateIds, ['math.number-theory.gcd']);

  const probability = map('概率期望', NOWCODER);
  assert.equal(probability.relation, 'ambiguous');
  assert.deepEqual(probability.targetIds, []);
  assert.deepEqual(probability.candidateIds, ['math.probability', 'math.expected-value']);
});

void test('OI Wiki vocabulary is reference-only, even for a recognised title', () => {
  const segmentTree = map('线段树', OI_WIKI);
  assert.equal(segmentTree.relation, 'reference');
  assert.deepEqual(segmentTree.targetIds, [], 'a learning-catalog title is never solution evidence');
  assert.deepEqual(segmentTree.candidateIds, ['data-structure.segment-tree']);

  const tarjan = map('tarjan', OI_WIKI);
  assert.equal(tarjan.relation, 'reference');
  assert.deepEqual(tarjan.candidateIds, ['graph.scc']);

  const unknown = map('not a taxonomy title', OI_WIKI);
  assert.equal(unknown.relation, 'reference');
  assert.deepEqual(unknown.candidateIds, []);

  assert.equal(map('2021', OI_WIKI).relation, 'non_algorithm', 'provenance metadata stays metadata');

  const explicit = map('线段树', CF, 'oi-wiki');
  assert.equal(explicit.relation, 'reference', 'an explicit vocabulary supports future OI references');
  assert.deepEqual(explicit.targetIds, []);
});

void test('high-risk shared spellings intercept the historical aliases of every source', () => {
  const risky: readonly (readonly [string, string])[] = [
    ['tarjan', 'graph.scc'],
    ['缩点', 'graph.scc'],
    ['hash', 'strings.hashing'],
    ['hashing', 'strings.hashing'],
    ['哈希', 'strings.hashing'],
    ['bit', 'data-structure.bit'],
    ['rmq', 'data-structure.sparse-table'],
    ['倍增', 'graph.lca'],
    ['subset sum', 'dp.sos'],
    ['子集和', 'dp.sos'],
    ['状态压缩', 'dp.bitmask'],
  ];
  for (const [raw, candidate] of risky) {
    const mapping = map(raw);
    assert.equal(mapping.relation, 'ambiguous', `${raw} must stay ambiguous`);
    assert.deepEqual(mapping.targetIds, [], `${raw} must count nothing`);
    assert.ok(mapping.candidateIds.includes(candidate), `${raw} keeps ${candidate} as a review candidate`);
    assert.equal(isUnresolvedAlgorithmRelation(mapping.relation), true);
  }
  assert.equal(map('subsetsum').relation, 'unmapped', 'a collapsed spelling is not the risky one');
  assert.equal(map('tarjan', LUOGU).relation, 'ambiguous', 'the interception is shared, not CF-only');
});

void test('constituents of frozen composite nodes are uncounted narrower candidates', () => {
  const constituents: readonly (readonly [string, string])[] = [
    ['dfs', 'search.traversal'],
    ['bfs', 'search.traversal'],
    ['深度优先搜索', 'search.traversal'],
    ['广度优先搜索', 'search.traversal'],
    ['traversal', 'search.traversal'],
    ['单调栈', 'data-structure.monotonic-stack'],
    ['单调队列', 'data-structure.monotonic-stack'],
    ['启发式搜索', 'search.heuristic'],
    ['模拟退火', 'search.heuristic'],
    ['a star', 'search.heuristic'],
    ['simulated annealing', 'search.heuristic'],
    ['树的直径', 'graph.tree-diameter'],
    ['换根dp', 'graph.tree-diameter'],
    ['rerooting', 'graph.tree-diameter'],
    ['lucas', 'math.combinatorics.lucas'],
    ['stirling', 'math.combinatorics.lucas'],
    ['catalan', 'math.combinatorics.catalan'],
    ['卡特兰数', 'math.combinatorics.catalan'],
    ['斜率优化', 'dp.optimization'],
    ['决策单调性', 'dp.optimization'],
    ['单调队列优化', 'dp.optimization'],
    ['convex hull trick', 'dp.optimization'],
    ['sos dp', 'dp.sos'],
    ['高维前缀和', 'dp.sos'],
    ['monotonic stack', 'data-structure.monotonic-stack'],
    ['monotonic queue', 'data-structure.monotonic-stack'],
    ['tree diameter', 'graph.tree-diameter'],
    ['a*', 'search.heuristic'],
    ['ida*', 'search.heuristic'],
  ];
  for (const [raw, family] of constituents) {
    const mapping = map(raw);
    assert.equal(mapping.relation, 'narrower', `${raw} is a constituent, not an equivalence`);
    assert.deepEqual(mapping.targetIds, [], `${raw} must not count`);
    assert.ok(mapping.candidateIds.includes(family), `${raw} keeps its family as a candidate`);
  }

  for (const [raw, family] of [
    ['单调栈与单调队列', 'data-structure.monotonic-stack'],
    ['DFS+BFS', 'search.traversal'],
    ['DP 优化', 'dp.optimization'],
    ['树的直径与换根', 'graph.tree-diameter'],
  ] as const) {
    const mapping = map(raw);
    assert.equal(mapping.relation, 'composite', `${raw} is a composite label`);
    assert.deepEqual(mapping.targetIds, []);
    assert.ok(mapping.candidateIds.includes(family));
  }
});

void test('the matching key never merges punctuation-sensitive labels', () => {
  assert.equal(sourceTagKey('A*'), 'a*');
  assert.notEqual(sourceTagKey('A*'), sourceTagKey('A'));
  assert.notEqual(sourceTagKey('C++'), sourceTagKey('C'));
  assert.equal(sourceTagKey('  树状数组  '), '树状数组', 'only surrounding whitespace is trimmed');

  const aStar = map('A*');
  assert.equal(aStar.relation, 'narrower', 'A* is a constituent of the heuristic-search node, not a node');
  assert.deepEqual(aStar.targetIds, []);
  assert.deepEqual(aStar.candidateIds, ['search.heuristic']);
  assert.equal(map('A').relation, 'unmapped', 'the bare letter A is unrelated to A*');
  assert.equal(map('C++').relation, 'non_algorithm', 'C++ is a language, never the single letter C');
  assert.equal(map('union-find').relation, 'unmapped', 'a hyphen is not silently collapsed to a space');

  const combined = map('树状数组/线段树');
  assert.equal(combined.relation, 'unmapped', 'a slash-joined label is not split into two positive matches');
  assert.deepEqual(combined.targetIds, []);

  const comma = map('线段树,树状数组');
  assert.deepEqual(comma.targetIds, [], 'a comma-joined label is not split either');
});

void test('a missing target is unmapped and never falls back to a historical alias', () => {
  const decoy = createTaxonomyIndex(
    createTaxonomy({
      version: 'test.10.decoy',
      nodes: [
        node('misc', null, 'category', 'Misc', '杂项'),
        // A custom catalog that aliases `dp` to its own node: the Codeforces rule points at the
        // canonical `dp` id, which this catalog does not have, so the mapping must stay unmapped.
        node('misc.dp-alias', 'misc', 'technique', 'Aliased dp', '别名 dp', ['dp']),
      ],
    }),
  );
  const mapping = mapSourceTag(decoy, { raw: 'dp', sourceInstanceId: CF });
  assert.equal(mapping.relation, 'unmapped');
  assert.equal(mapping.ruleId, 'cf.dp.missing-target');
  assert.deepEqual(mapping.targetIds, []);
  assert.equal(mapping.taxonomyVersion, 'test.10.decoy');
});

void test('safe shared spellings resolve through a small custom catalog without inventing nodes', () => {
  const custom = createTaxonomyIndex(
    createTaxonomy({
      version: 'test.10.custom',
      nodes: [
        node('ds', null, 'category', 'Data structures', '数据结构'),
        node('ds.stack', 'ds', 'technique', 'Stack', '栈', ['stack', '栈']),
        node('ds.queue', 'ds', 'technique', 'Queue', '队列', ['queue']),
      ],
    }),
  );
  const stack = mapSourceTag(custom, { raw: '栈', sourceInstanceId: CF });
  assert.equal(stack.relation, 'exact');
  assert.deepEqual(stack.targetIds, ['ds.stack']);
  assert.equal(stack.taxonomyVersion, 'test.10.custom');

  const category = mapSourceTag(custom, { raw: '数据结构', sourceInstanceId: CF });
  assert.equal(category.relation, 'broader', 'a category node always maps as an aggregate');
  assert.deepEqual(category.targetIds, ['ds']);

  const absent = mapSourceTag(custom, { raw: '线段树', sourceInstanceId: CF });
  assert.equal(absent.relation, 'unmapped', 'a catalog without the node resolves nothing');
  assert.deepEqual(absent.targetIds, []);
  assert.deepEqual(absent.candidateIds, []);
});

void test('results preserve exact input, echo both versions, freeze and stay deterministic', () => {
  const mapping = map('  栈  ');
  assert.equal(mapping.raw, '  栈  ', 'the exact original raw label is preserved');
  assert.equal(mapping.sourceInstanceId, CF);
  assert.equal(mapping.mappingVersion, TAG_MAPPING_VERSION);
  assert.equal(mapping.taxonomyVersion, CURRENT_TAXONOMY.version);
  assert.deepEqual(mapping.targetIds, ['data-structure.stack']);
  assert.equal(isDeeplyFrozen(mapping), true);
  assert.deepEqual(map('  栈  '), mapping, 'the resolver is deterministic');
  assert.deepEqual(JSON.parse(JSON.stringify(mapping)), mapping, 'the mapping is JSON-serializable as-is');

  const empty = map('   ');
  assert.equal(empty.relation, 'unmapped');
  assert.equal(empty.ruleId, 'raw.empty');
  assert.equal(empty.raw, '   ');
});

void test('an unknown or invalid vocabulary fails closed before every shared spelling rule', () => {
  const foreignSources = ['hydro:hydro.example.edu', 'codeforces:evil.example', 'codeforces:%zz', 'codeforces', ''];
  for (const source of foreignSources) {
    for (const raw of ['stack', '栈', 'dp', 'tarjan']) {
      const mapping = map(raw, source);
      assert.equal(mapping.vocabulary, 'unknown', `${source} must not borrow a vocabulary`);
      assert.equal(mapping.relation, 'unmapped', `${raw} from ${source} must stay unmapped`);
      assert.deepEqual(mapping.targetIds, [], `${raw} from ${source} must count nothing`);
      assert.deepEqual(mapping.candidateIds, [], `${raw} from ${source} must not keep candidates either`);
      assert.deepEqual(mapping.referenceUrls, [], `${raw} from ${source} gets no borrowed reference`);
    }
    assert.equal(map('2021', source).relation, 'non_algorithm', 'provenance metadata stays metadata');
    assert.equal(map('codeforces', source).relation, 'non_algorithm');
    assert.equal(map('C++', source).relation, 'non_algorithm');
  }

  const invalidRuntime = mapSourceTag(INDEX, {
    raw: '栈',
    sourceInstanceId: CF,
    vocabulary: 'hydro' as never,
  });
  assert.equal(invalidRuntime.vocabulary, 'unknown', 'an explicit foreign vocabulary is refused');
  assert.equal(invalidRuntime.relation, 'unmapped');
  assert.deepEqual(invalidRuntime.targetIds, []);

  const nullish = mapSourceTag(INDEX, { raw: 'stack', sourceInstanceId: CF, vocabulary: null as never });
  assert.equal(nullish.vocabulary, 'unknown', 'a non-string runtime vocabulary is refused');
  assert.equal(nullish.relation, 'unmapped');

  assert.equal(isTagVocabulary('hydro'), false, 'a foreign platform name is not a vocabulary');
  assert.equal(isTagVocabulary('oi-wiki'), true);
  assert.equal(isTagVocabulary(null), false);
  assert.equal(isTagVocabulary(7), false);

  const explicitKnown = map('线段树', CF, 'oi-wiki');
  assert.equal(explicitKnown.relation, 'reference', 'a known explicit vocabulary still works');
  assert.deepEqual(explicitKnown.targetIds, []);
});

void test('review-corrected spellings never count as the whole combined node', () => {
  const narrower: readonly (readonly [string, string])[] = [
    ['01背包', 'dp.knapsack'],
    ['完全背包', 'dp.knapsack'],
    ['带权并查集', 'data-structure.dsu'],
    ['treap', 'data-structure.balanced-bst'],
    ['splay', 'data-structure.balanced-bst'],
    ['fhq treap', 'data-structure.balanced-bst'],
    ['主席树', 'data-structure.persistent'],
    ['chairman tree', 'data-structure.persistent'],
    ['dijkstra', 'graph.shortest-path'],
    ['spfa', 'graph.shortest-path'],
    ['bellman ford', 'graph.shortest-path'],
    ['floyd', 'graph.shortest-path'],
    ['bridge', 'graph.bridges-articulation'],
    ['cut vertex', 'graph.bridges-articulation'],
    ['割点', 'graph.bridges-articulation'],
    ['割边', 'graph.bridges-articulation'],
    ['articulation point', 'graph.bridges-articulation'],
    ['dinic', 'flow.max-flow'],
    ['isap', 'flow.max-flow'],
    ['kuhn', 'matching.bipartite'],
    ['blossom', 'matching.general'],
    ['带花树', 'matching.general'],
    ['hall theorem', 'matching.hall'],
    ['霍尔定理', 'matching.hall'],
    ['konig', 'matching.hall'],
    ['柯尼希定理', 'matching.hall'],
    ['gcd', 'math.number-theory.gcd'],
    ['exgcd', 'math.number-theory.gcd'],
    ['扩展欧几里得', 'math.number-theory.gcd'],
    ['bezout', 'math.number-theory.gcd'],
    ['裴蜀定理', 'math.number-theory.gcd'],
    ['sieve', 'math.number-theory.prime-sieve'],
    ['素数筛', 'math.number-theory.prime-sieve'],
    ['线性筛', 'math.number-theory.prime-sieve'],
    ['埃氏筛', 'math.number-theory.prime-sieve'],
    ['factorization', 'math.number-theory.prime-sieve'],
    ['质因数分解', 'math.number-theory.prime-sieve'],
    ['fft', 'math.fft'],
    ['ntt', 'math.fft'],
    ['卷积', 'math.fft'],
    ['convolution', 'math.fft'],
    ['快速傅里叶变换', 'math.fft'],
    ['sg函数', 'math.game-theory'],
    ['nim', 'math.game-theory'],
    ['sprague grundy', 'math.game-theory'],
    ['概率dp', 'math.probability'],
    ['期望dp', 'math.expected-value'],
    ['linearity of expectation', 'math.expected-value'],
    ['叉积', 'geometry.basic'],
    ['cross product', 'geometry.basic'],
    ['点积', 'geometry.basic'],
    ['graham', 'geometry.convex-hull'],
    ['andrew', 'geometry.convex-hull'],
    ['带修莫队', 'offline.mo'],
  ];
  for (const [raw, family] of narrower) {
    const mapping = map(raw);
    assert.equal(mapping.relation, 'narrower', `${raw} is one member, not the whole node (${mapping.ruleId})`);
    assert.deepEqual(mapping.targetIds, [], `${raw} must not count`);
    assert.ok(mapping.candidateIds.includes(family), `${raw} keeps ${family} as a review candidate`);
    assert.ok(mapping.referenceUrls.length > 0, `${raw} needs at least one public terminology reference`);
  }

  const broader: readonly (readonly [string, string])[] = [
    ['矩阵乘法', 'math.linear-algebra'],
    ['费马小定理', 'math.number-theory'],
    ['fermat little theorem', 'math.number-theory'],
  ];
  for (const [raw, category] of broader) {
    const mapping = map(raw);
    assert.equal(mapping.relation, 'broader', `${raw} lands on a category, never on the special-case node`);
    assert.deepEqual(mapping.targetIds, [category]);
    assert.deepEqual(mapping.candidateIds, []);
  }
  assert.equal(
    map('矩阵乘法').targetIds.includes('math.linear-algebra.matrix-power'),
    false,
    'matrix multiplication is not matrix exponentiation',
  );
  assert.equal(
    map('费马小定理').targetIds.includes('math.number-theory.modular-inverse'),
    false,
    'Fermat little theorem is not the modular-inverse operation',
  );

  const ambiguous: readonly (readonly [string, string])[] = [
    ['hungarian', 'matching.bipartite'],
    ['匈牙利算法', 'matching.bipartite'],
    ['binary exponentiation', 'math.number-theory.modular-exponentiation'],
    ['fast power', 'math.number-theory.modular-exponentiation'],
    ['快速幂', 'math.number-theory.modular-exponentiation'],
  ];
  for (const [raw, candidate] of ambiguous) {
    const mapping = map(raw);
    assert.equal(mapping.relation, 'ambiguous', `${raw} has more than one reading`);
    assert.deepEqual(mapping.targetIds, [], `${raw} must not count`);
    assert.ok(mapping.candidateIds.includes(candidate));
    assert.equal(isUnresolvedAlgorithmRelation(mapping.relation), true);
  }

  // The nodes' own plain spellings keep counting; only the narrow/broad readings moved.
  assert.deepEqual(map('背包').targetIds, ['dp.knapsack']);
  assert.deepEqual(map('并查集').targetIds, ['data-structure.dsu']);
  assert.deepEqual(map('平衡树').targetIds, ['data-structure.balanced-bst']);
  assert.deepEqual(map('可持久化').targetIds, ['data-structure.persistent']);
  assert.deepEqual(map('最短路').targetIds, ['graph.shortest-path']);
  assert.deepEqual(map('最大流').targetIds, ['flow.max-flow']);
  assert.deepEqual(map('二分图匹配').targetIds, ['matching.bipartite']);
  assert.deepEqual(map('一般图匹配').targetIds, ['matching.general']);
  assert.deepEqual(map('凸包').targetIds, ['geometry.convex-hull']);
  assert.deepEqual(map('莫队').targetIds, ['offline.mo']);
  assert.deepEqual(map('博弈论').targetIds, ['math.game-theory']);
  assert.deepEqual(map('概率').targetIds, ['math.probability']);
  assert.deepEqual(map('期望').targetIds, ['math.expected-value']);
  assert.deepEqual(map('模幂').targetIds, ['math.number-theory.modular-exponentiation']);
  assert.deepEqual(map('矩阵快速幂').targetIds, ['math.linear-algebra.matrix-power']);
  assert.deepEqual(map('模逆元').targetIds, ['math.number-theory.modular-inverse']);
  assert.deepEqual(map('逆元').targetIds, ['math.number-theory.modular-inverse']);
  assert.deepEqual(map('线段树').targetIds, ['data-structure.segment-tree'], 'unrelated safe spellings are untouched');
});

void test('shared mapped and risk results carry terminology references, refused sources carry none', () => {
  const stack = map('栈');
  assert.equal(stack.relation, 'exact');
  assert.equal(
    stack.referenceUrls.includes('https://codeforces.com/apiHelp/objects#Problem'),
    true,
    'a shared result cites the vocabulary terminology page',
  );
  assert.equal(
    stack.referenceUrls.includes('https://oi-wiki.org/ds/stack/'),
    true,
    'a shared result also cites the OI Wiki definition of the node it names',
  );

  const hash = map('hash');
  assert.equal(hash.relation, 'ambiguous');
  assert.equal(hash.referenceUrls.includes('https://oi-wiki.org/string/hash/'), true);

  const matrix = map('矩阵乘法');
  assert.equal(
    matrix.referenceUrls.includes('https://oi-wiki.org/math/linear-algebra/matrix/'),
    true,
    'the broader matrix-multiplication rule cites the matrix page, not the exponentiation node',
  );
  const fermat = map('费马小定理');
  assert.equal(fermat.referenceUrls.includes('https://oi-wiki.org/math/number-theory/fermat/'), true);

  const manual = map('栈', 'manual:local');
  assert.equal(manual.vocabulary, 'manual');
  assert.equal(manual.relation, 'exact', 'a manual label still uses the shared allowlist');
  assert.equal(
    manual.referenceUrls.some((url) => url.startsWith('https://codeforces.com')),
    false,
    'manual has no platform terminology page',
  );

  const hydro = map('栈', 'hydro:hydro.example.edu');
  assert.deepEqual(hydro.referenceUrls, [], 'a refused vocabulary gets no borrowed reference');
});

void test('the historical classifier keeps its alias outcomes where the crosswalk now refuses', () => {
  const aliases: readonly (readonly [string, string])[] = [
    ['tarjan', 'graph.scc'],
    ['hash', 'strings.hashing'],
    ['bit', 'data-structure.bit'],
    ['rmq', 'data-structure.sparse-table'],
    ['倍增', 'graph.lca'],
    ['状态压缩', 'dp.bitmask'],
    ['子集和', 'dp.sos'],
    ['treap', 'data-structure.balanced-bst'],
    ['主席树', 'data-structure.persistent'],
    ['带权并查集', 'data-structure.dsu'],
    ['dijkstra', 'graph.shortest-path'],
    ['dinic', 'flow.max-flow'],
    ['nim', 'math.game-theory'],
    ['fft', 'math.fft'],
    ['01背包', 'dp.knapsack'],
  ];
  for (const [raw, taxonomyId] of aliases) {
    const legacy = classifyRawTag(INDEX, raw);
    assert.equal(legacy.kind, 'taxonomy', `${raw} keeps its historical classifier outcome`);
    assert.equal(legacy.kind === 'taxonomy' ? legacy.taxonomyId : null, taxonomyId);
    const mapping = map(raw);
    assert.equal(isCountedTagRelation(mapping.relation), false, `${raw} must not count through the crosswalk`);
    assert.deepEqual(mapping.targetIds, []);
    assert.equal(
      isUnresolvedAlgorithmRelation(mapping.relation),
      true,
      `${raw} stays an explicitly unresolved crosswalk result`,
    );
  }
});
