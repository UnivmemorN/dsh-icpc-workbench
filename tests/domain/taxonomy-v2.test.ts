/**
 * Stage-3 taxonomy release: 2026.09.2 is strictly additive over the frozen 2026.09.1 vocabulary.
 *
 * The cases state observable consequences: a snapshot pinned to the old version keeps resolving
 * exactly as before, every new bilingual spelling reaches one node, and no pre-existing raw tag
 * changes meaning. Importing the module at all already proves `createTaxonomy` accepted the new
 * vocabulary (canonical unique ids, known parents, acyclic, unambiguous aliases).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CURRENT_TAXONOMY,
  TAXONOMY_V1,
  TAXONOMY_V1_VERSION,
  TAXONOMY_V2,
  TAXONOMY_V2_VERSION,
  classifyRawTag,
  createTaxonomy,
  createTaxonomyIndex,
  isCanonicalTaxonomyId,
  isDeeplyFrozen,
} from '../../src/domain/index.js';

const V1_INDEX = createTaxonomyIndex(TAXONOMY_V1);
const V2_INDEX = createTaxonomyIndex(TAXONOMY_V2);

/** New nodes: id, required pre-existing parent, raw spellings that must resolve to them. */
const ADDED: readonly (readonly [string, string, readonly string[]])[] = [
  ['graph.minimum-spanning-tree', 'graph', ['minimum spanning tree', 'mst', '最小生成树']],
  ['implementation.sorting', 'implementation', ['sorting', 'sort', '排序']],
  [
    'math.number-theory.modular-exponentiation',
    'math.number-theory',
    ['modular exponentiation', 'binary exponentiation', 'fast power', '快速幂', '模幂'],
  ],
  ['data-structure.stack', 'data-structure', ['stack', '栈']],
  ['data-structure.queue', 'data-structure', ['queue', '队列']],
];

test('2026.09.1 nodes stay identical and old snapshots keep resolving under the old version', () => {
  assert.equal(TAXONOMY_V1_VERSION, '2026.09.1');
  assert.equal(TAXONOMY_V1.version, '2026.09.1');
  assert.equal(isDeeplyFrozen(TAXONOMY_V1), true);
  assert.equal(TAXONOMY_V2.nodes.length, TAXONOMY_V1.nodes.length + ADDED.length);

  for (const oldNode of TAXONOMY_V1.nodes) {
    assert.deepEqual(V2_INDEX.node(oldNode.id), oldNode, `${oldNode.id} must be unchanged in 2026.09.2`);
    assert.equal(V1_INDEX.has(oldNode.id), true);
  }

  // Resolution through the pinned vocabulary is unchanged, and 2026.09.2-only spellings stay
  // unknown there instead of being silently reinterpreted by an old snapshot.
  assert.equal(V1_INDEX.resolveAlias('二分')?.taxonomyId, 'search.binary');
  assert.equal(V1_INDEX.resolveAlias('排序'), null);
  assert.equal(classifyRawTag(V1_INDEX, '最小生成树').kind, 'unknown');
  assert.equal(classifyRawTag(V1_INDEX, '栈').kind, 'unknown');
});

test('every added node validates and resolves its bilingual spellings uniquely', () => {
  for (const [id, parentId, aliases] of ADDED) {
    assert.equal(isCanonicalTaxonomyId(id), true, `${id} must be a canonical id`);
    assert.ok(V2_INDEX.has(parentId), `${parentId} must already exist`);
    const node = V2_INDEX.node(id);
    assert.ok(node, `${id} must exist in 2026.09.2`);
    assert.equal(node.kind, 'technique');
    assert.equal(node.parentId, parentId);
    assert.equal(node.description.length > 0, true, `${id} needs a description`);

    for (const spelling of [...aliases, node.names.en, node.names.zh]) {
      assert.equal(V2_INDEX.resolveAlias(spelling)?.taxonomyId, id, `${spelling} must resolve to ${id}`);
    }
    const classified = classifyRawTag(V2_INDEX, aliases[0] ?? '');
    assert.equal(classified.kind, 'taxonomy');
    assert.equal(classified.kind === 'taxonomy' ? classified.taxonomyId : null, id);
  }

  // Re-validating the released vocabulary through the public factory must succeed unchanged.
  const revalidated = createTaxonomy({ version: TAXONOMY_V2_VERSION, nodes: TAXONOMY_V2.nodes });
  assert.deepEqual(
    revalidated.nodes.map((node) => node.id),
    TAXONOMY_V2.nodes.map((node) => node.id),
  );
});

test('the release adds no duplicate DSU node and steals no pre-existing meaning', () => {
  // DSU already exists as `data-structure.dsu`; a second id for it would split statistics.
  assert.equal(V2_INDEX.has('data-structure.disjoint-set'), false);

  const preserved: readonly (readonly [string, string])[] = [
    ['binary search', 'search.binary'],
    ['二分', 'search.binary'],
    ['monotonic stack', 'data-structure.monotonic-stack'],
    ['单调队列', 'data-structure.monotonic-stack'],
    ['heap', 'data-structure.heap'],
    ['union find', 'data-structure.dsu'],
    ['并查集', 'data-structure.dsu'],
    ['topological sort', 'graph.topological-sort'],
    ['matrix exponentiation', 'math.linear-algebra.matrix-power'],
    ['矩阵快速幂', 'math.linear-algebra.matrix-power'],
    ['modular inverse', 'math.number-theory.modular-inverse'],
    ['dp', 'dp'],
  ];
  for (const [spelling, id] of preserved) {
    assert.equal(V1_INDEX.resolveAlias(spelling)?.taxonomyId, id, `${spelling} must keep its 2026.09.1 meaning`);
    assert.equal(V2_INDEX.resolveAlias(spelling)?.taxonomyId, id, `${spelling} must keep its 2026.09.2 meaning`);
  }
});

test('CURRENT_TAXONOMY points at the 2026.09.2 vocabulary', () => {
  assert.equal(TAXONOMY_V2_VERSION, '2026.09.2');
  assert.equal(CURRENT_TAXONOMY, TAXONOMY_V2);
  assert.equal(CURRENT_TAXONOMY.version, '2026.09.2');
  assert.notEqual(CURRENT_TAXONOMY, TAXONOMY_V1);
  assert.deepEqual(
    createTaxonomyIndex(CURRENT_TAXONOMY)
      .children('data-structure')
      .map((node) => node.id)
      .filter((id) => id === 'data-structure.stack' || id === 'data-structure.queue'),
    ['data-structure.stack', 'data-structure.queue'],
  );
});
