/**
 * Verified knowledge resources (Sprint 09b).
 *
 * The resource module is the only place that maps a taxonomy id to an external page, so these cases
 * pin the externally meaningful guarantees: exactly the current catalog is covered, every link is
 * an official HTTPS OI Wiki URL, composite nodes keep every page, the metadata is deeply immutable,
 * and an unknown (for example future) id returns an empty list instead of a guessed or inherited
 * link. No network is involved: the checked date is data, not a fetch.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CURRENT_TAXONOMY,
  KNOWLEDGE_ATTRIBUTION_COPYRIGHT_URL,
  KNOWLEDGE_ATTRIBUTION_NOTES,
  KNOWLEDGE_ATTRIBUTION_SOURCES,
  KNOWLEDGE_RESOURCES_BY_TAXONOMY_ID,
  KNOWLEDGE_RESOURCES_CHECKED_DATE,
  isDeeplyFrozen,
  knowledgeResourcesFor,
} from '../../src/domain/index.js';

const IDS = Object.keys(KNOWLEDGE_RESOURCES_BY_TAXONOMY_ID);

void test('the mapping covers exactly the current taxonomy ids', () => {
  const catalogIds = CURRENT_TAXONOMY.nodes.map((node) => node.id);
  assert.equal(catalogIds.length, 105);
  assert.equal(IDS.length, catalogIds.length);
  assert.deepEqual([...IDS].sort(), [...catalogIds].sort());
});

void test('every resource is an OI Wiki HTTPS page with a real title and relation', () => {
  let total = 0;
  for (const id of IDS) {
    const resources = knowledgeResourcesFor(id);
    assert.ok(resources.length > 0, `${id} must have at least one page`);
    const urls = resources.map((resource) => resource.url);
    assert.equal(new Set(urls).size, urls.length, `${id} must not repeat a URL`);
    for (const resource of resources) {
      total += 1;
      assert.equal(resource.provider, 'OI Wiki', `${id} provider`);
      assert.match(resource.url, /^https:\/\/oi-wiki\.org\//u, `${id} URL`);
      assert.ok(resource.title.trim().length > 0, `${id} title`);
      assert.ok(resource.relation === 'topic' || resource.relation === 'overview', `${id} relation`);
    }
  }
  assert.equal(total, 118);
});

void test('the catalog shares 106 unique URLs and keeps every composite node', () => {
  const urls = new Set<string>();
  for (const id of IDS) {
    for (const resource of knowledgeResourcesFor(id)) {
      urls.add(resource.url);
    }
  }
  assert.equal(urls.size, 106);

  const composite = IDS.filter((id) => knowledgeResourcesFor(id).length > 1);
  assert.deepEqual(composite.sort(), [
    'data-structure.monotonic-stack',
    'data-structure.sparse-table',
    'dp.sos',
    'dp.state-machine',
    'graph.tree-diameter',
    'math.combinatorics.catalan',
    'math.combinatorics.lucas',
    'math.fft',
    'math.linear-algebra.matrix-power',
    'math.number-theory.gcd',
    'math.number-theory.prime-sieve',
    'search.heuristic',
    'search.traversal',
  ]);
});

void test('representative ids keep their exact verified URL, title and relation', () => {
  assert.deepEqual(knowledgeResourcesFor('search.binary-answer'), [
    { provider: 'OI Wiki', title: '二分', url: 'https://oi-wiki.org/basic/binary/', relation: 'topic' },
  ]);
  // The deliberately broader mapping of the same page stays an overview, never an equivalence claim.
  assert.deepEqual(knowledgeResourcesFor('search.ternary'), [
    { provider: 'OI Wiki', title: '二分', url: 'https://oi-wiki.org/basic/binary/', relation: 'overview' },
  ]);
  assert.deepEqual(knowledgeResourcesFor('search.traversal'), [
    { provider: 'OI Wiki', title: 'DFS（搜索）', url: 'https://oi-wiki.org/search/dfs/', relation: 'topic' },
    { provider: 'OI Wiki', title: 'BFS（搜索）', url: 'https://oi-wiki.org/search/bfs/', relation: 'topic' },
  ]);
  assert.deepEqual(knowledgeResourcesFor('data-structure.queue'), [
    { provider: 'OI Wiki', title: '队列', url: 'https://oi-wiki.org/ds/queue/', relation: 'topic' },
  ]);
  assert.deepEqual(knowledgeResourcesFor('tricks.interactive'), [
    { provider: 'OI Wiki', title: '交互题', url: 'https://oi-wiki.org/contest/interaction/', relation: 'topic' },
  ]);
});

void test('an unknown or prototype id returns an empty list, never a guessed link', () => {
  for (const unknown of ['', 'future.technique', 'constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.deepEqual(knowledgeResourcesFor(unknown), [], `${JSON.stringify(unknown)} has no resources`);
  }
});

void test('the metadata is deeply frozen', () => {
  assert.ok(isDeeplyFrozen(KNOWLEDGE_RESOURCES_BY_TAXONOMY_ID));
  assert.throws(() => {
    (KNOWLEDGE_RESOURCES_BY_TAXONOMY_ID as Record<string, unknown>)['search'] = [];
  });
  assert.throws(() => {
    (knowledgeResourcesFor('search') as unknown as { title: string }[])[0]!.title = 'changed';
  });
});

void test('the checked date and attribution are explicit and honest', () => {
  assert.equal(KNOWLEDGE_RESOURCES_CHECKED_DATE, '2026-09-13');
  assert.match(KNOWLEDGE_RESOURCES_CHECKED_DATE, /^\d{4}-\d{2}-\d{2}$/u);
  assert.equal(KNOWLEDGE_ATTRIBUTION_SOURCES.nowcoder.url, 'https://ac.nowcoder.com/acm/skill/acm');
  assert.equal(KNOWLEDGE_ATTRIBUTION_SOURCES.oiWiki.url, 'https://oi-wiki.org/');
  assert.equal(KNOWLEDGE_ATTRIBUTION_COPYRIGHT_URL, 'https://github.com/OI-wiki/OI-wiki#版权声明');
  const notes = KNOWLEDGE_ATTRIBUTION_NOTES.join('\n');
  assert.match(notes, /不构成掌握证明/u);
  assert.match(notes, /CC BY-SA 4\.0/u);
  assert.match(notes, /未复制/u);
  assert.ok(isDeeplyFrozen(KNOWLEDGE_ATTRIBUTION_NOTES));
});
