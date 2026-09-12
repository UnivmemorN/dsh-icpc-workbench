/**
 * Taxonomy 2026.09.2 — strictly additive release over the frozen 2026.09.1 vocabulary.
 *
 * Only new nodes are appended: every 2026.09.1 id, alias, parent and description stays unchanged
 * inside `TAXONOMY_V1`, so problems and snapshots pinned to the old version keep resolving
 * exactly as before. Ids are permanent; renaming one is a migration, never an edit.
 */
import { createTaxonomy, type Taxonomy, type TaxonomyNode } from './types.js';
import { TAXONOMY_V1 } from './v1.js';

/** Version of the current vocabulary. */
export const TAXONOMY_V2_VERSION = '2026.09.2';

/**
 * Nodes added since 2026.09.1 (bilingual spellings are first-class for CF and Luogu raw tags).
 *
 * `data-structure.disjoint-set` is deliberately **not** added: DSU already exists as
 * `data-structure.dsu` (aliases `dsu`, `union find`, `并查集`, `带权并查集`), and a second id
 * for the same technique would make statistics ambiguous.
 */
const ADDED_NODES: readonly TaxonomyNode[] = [
  {
    id: 'graph.minimum-spanning-tree',
    parentId: 'graph',
    kind: 'technique',
    names: { en: 'Minimum spanning tree', zh: '最小生成树' },
    aliases: ['minimum spanning tree', 'mst', '最小生成树'],
    description: 'Connect every vertex at minimum total edge weight.',
  },
  {
    id: 'implementation.sorting',
    parentId: 'implementation',
    kind: 'technique',
    names: { en: 'Sorting', zh: '排序' },
    aliases: ['sorting', 'sort', '排序'],
    description: 'Order items by a comparison, key or counting rule.',
  },
  {
    id: 'math.number-theory.modular-exponentiation',
    parentId: 'math.number-theory',
    kind: 'technique',
    names: { en: 'Modular exponentiation', zh: '快速幂' },
    aliases: ['modular exponentiation', 'binary exponentiation', 'fast power', '快速幂', '模幂'],
    description: 'Compute a power modulo m with logarithmically many multiplications.',
  },
  {
    id: 'data-structure.stack',
    parentId: 'data-structure',
    kind: 'technique',
    names: { en: 'Stack', zh: '栈' },
    aliases: ['stack', '栈'],
    description: 'Last-in-first-out container and its direct applications.',
  },
  {
    id: 'data-structure.queue',
    parentId: 'data-structure',
    kind: 'technique',
    names: { en: 'Queue', zh: '队列' },
    aliases: ['queue', '队列'],
    description: 'First-in-first-out container (deque, circular and monotone variants excluded).',
  },
];

/** Current taxonomy: all 2026.09.1 nodes plus the additive nodes above. */
export const TAXONOMY_V2: Taxonomy = createTaxonomy({
  version: TAXONOMY_V2_VERSION,
  nodes: [...TAXONOMY_V1.nodes, ...ADDED_NODES],
});

/** Current taxonomy shipped with this build (compatibility alias for `TAXONOMY_V2`). */
export const CURRENT_TAXONOMY: Taxonomy = TAXONOMY_V2;
