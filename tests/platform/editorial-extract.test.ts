/**
 * Pure extractor tests: plain-text rendering of third-party HTML, problem identity in links and
 * target-section selection inside a multi-problem editorial. These run without an adapter and
 * without network access, so a downloaded live body can be checked with the same functions.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractEditorialSection,
  extractProblemPage,
  htmlToPlainText,
  parseCodeforcesBlogUrl,
  problemReferenceFromHref,
} from '../../src/adapters/codeforces/index.js';
import { ambiguousBlogHtml, blogContentHtml, missingSectionBlogHtml, problemPageHtml } from './fixtures.js';

test('plain text keeps entities, formulas, sub/sup and image alt, and drops scripts and styles', () => {
  const html =
    '<div><p>a &lt; b &amp;&amp; c &gt; d</p><p>x<sup>2</sup> and y<sub>1</sub></p>' +
    '<p><img src="f.png" alt="a figure"></p><p><script type="math/tex">\\frac{1}{2}</script></p>' +
    '<script>evil()</script><style>.x{ color: red }</style></div>';
  const text = htmlToPlainText(html);
  assert.match(text, /a < b && c > d/);
  assert.match(text, /x\^2 and y_1/);
  assert.match(text, /a figure/);
  assert.match(text, /\\frac\{1\}\{2\}/);
  assert.equal(text.includes('evil()'), false);
  assert.equal(text.includes('color: red'), false);
});

test('a section keeps inline breaks, sub/sup math and method subheadings, and ends at the next problem heading', () => {
  const html =
    '<div><h3>455A - A</h3>' +
    '<p>Line one<br>Line two with n<sup>2</sup>, a<sub>i</sub> and <script type="math/tex">\\frac{1}{2}</script>.</p>' +
    '<h2>Idea</h2><p>Idea body.</p><h2>Solution 2</h2><p>Second body.</p>' +
    '<h3>455B - B</h3><p>B body must not leak.</p></div>';
  const result = extractEditorialSection(html, { contestId: 455, index: 'A' });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.match(result.text, /Line one\nLine two with n\^2, a_i and/);
  assert.match(result.text, /\\frac\{1\}\{2\}/);
  assert.match(result.text, /Idea\n\nIdea body\./);
  assert.match(result.text, /Solution 2\n\nSecond body\./);
  assert.equal(result.text.includes('B body must not leak'), false);
  // The model receives plain text, never markup.
  assert.equal(result.text.includes('<'), false);
});

test('a section stops at the next problem heading and keeps embedded references', () => {
  const result = extractEditorialSection(blogContentHtml(), { contestId: 455, index: 'A' });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.match(result.text, /dynamic programming over values/);
  assert.match(result.text, /this reference is embedded in explanation text/);
  assert.equal(result.text.includes('Both problems share'), false);
  assert.equal(result.text.includes('must not leak'), false);
  assert.equal(result.headingText, '455A - Boredom');
});

test('a heading may pair explicit aliases in the same line', () => {
  const result = extractEditorialSection(blogContentHtml(), { contestId: 456, index: 'C' });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.match(result.text, /Both problems share a greedy write-up/);
  assert.equal(result.text.includes('must not leak'), false);
  assert.deepEqual(result.matchedReferences, ['455B', '456C']);
});

test('a reference inside explanation text does not split a section', () => {
  const paragraph = `${'Intro '.repeat(40)}<a href="/contest/455/problem/B">problem B</a> continues here.`;
  const html = `<div><h3>455A - A</h3><p>${paragraph}</p><h3>455B - B</h3><p>Only B text.</p></div>`;
  const result = extractEditorialSection(html, { contestId: 455, index: 'A' });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.match(result.text, /continues here/);
  assert.equal(result.text.includes('Only B text'), false);
});

test('a link-only paragraph starts a section and a bare index heading only bounds it', () => {
  const linked = '<div><p><a href="/problemset/problem/455/A">A</a></p><p>Linked write-up.</p><h3>B</h3><p>B write-up.</p></div>';
  const result = extractEditorialSection(linked, { contestId: 455, index: 'A' });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.match(result.text, /Linked write-up/);
  assert.equal(result.text.includes('B write-up'), false);
  assert.deepEqual(result.matchedReferences, ['455A']);
});

test('a bare index heading never starts a section, even beside a heading that names a contest', () => {
  const bareOnly = '<div><h3>B</h3><p>B write-up.</p></div>';
  const withContest = '<div><h3>455A - A</h3><p>A write-up.</p><h3>B</h3><p>B write-up.</p></div>';
  for (const html of [bareOnly, withContest]) {
    const result = extractEditorialSection(html, { contestId: 455, index: 'B' });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'missing');
    }
  }
});

test('a paragraph that leads with a problem link but continues as prose is body text', () => {
  const html =
    '<div><h3>455A - A</h3>' +
    '<p><a href="/contest/455/problem/B">455B</a> is a paragraph that starts with the link and then continues as prose.</p>' +
    '<h3>455C - C</h3><p>C body.</p></div>';
  const target = extractEditorialSection(html, { contestId: 455, index: 'B' });
  assert.equal(target.ok, false);
  if (!target.ok) {
    assert.equal(target.reason, 'missing');
  }
  const sectionOfA = extractEditorialSection(html, { contestId: 455, index: 'A' });
  assert.equal(sectionOfA.ok, true);
  if (sectionOfA.ok) {
    assert.match(sectionOfA.text, /continues as prose/);
    assert.equal(sectionOfA.text.includes('C body'), false);
  }
});

test('a heading without non-heading body text is an empty section', () => {
  const noBody = '<div><h3>455A - A</h3><h3>455B - B</h3><p>B body.</p></div>';
  const headingsOnly =
    '<div><h3>455A - A</h3><h2>Idea</h2><h2>Solution 2</h2><h3>455B - B</h3><p>B body.</p></div>';
  for (const html of [noBody, headingsOnly]) {
    const result = extractEditorialSection(html, { contestId: 455, index: 'A' });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'empty');
    }
  }
});

test('a long legacy paragraph that names several problems in one block is refused', () => {
  const paragraph =
    `Problem 455A ${'is solved with dynamic programming. '.repeat(4)}` +
    'Problem 455B needs sorting. Problem 455C needs a segment tree.';
  const result = extractEditorialSection(`<div><p>${paragraph}</p></div>`, { contestId: 455, index: 'A' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'missing');
  }
});

test('missing and ambiguous target sections are explicit failures', () => {
  const missing = extractEditorialSection(missingSectionBlogHtml(), { contestId: 455, index: 'A' });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.reason, 'missing');
    assert.match(missing.sample ?? '', /455B/);
  }
  const ambiguous = extractEditorialSection(ambiguousBlogHtml(), { contestId: 455, index: 'A' });
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) {
    assert.equal(ambiguous.reason, 'ambiguous');
    assert.match(ambiguous.sample ?? '', /455A/);
  }
});

test('official problem links are recognized in both official forms and nowhere else', () => {
  assert.deepEqual(problemReferenceFromHref('/contest/455/problem/C'), { contestId: 455, index: 'C' });
  assert.deepEqual(problemReferenceFromHref('https://codeforces.com/problemset/problem/455/A'), {
    contestId: 455,
    index: 'A',
  });
  // Legacy `http://`/`www.` spellings are identity references; a numeric index keeps its padding.
  assert.deepEqual(problemReferenceFromHref('http://www.codeforces.com/contest/921/problem/01'), {
    contestId: 921,
    index: '01',
  });
  for (const bad of [
    'https://evil.example/contest/455/problem/C',
    '/blog/entry/455',
    '/contest/455/problem/',
    '/contest/455/problem/A/',
    '/contest/455/problem/A/submission/1',
    'https://codeforces.com:8443/contest/455/problem/A',
    'https://user:secret@codeforces.com/contest/455/problem/A',
  ]) {
    assert.equal(problemReferenceFromHref(bad), null, bad);
  }
});

test('only an official https blog URL is accepted', () => {
  assert.equal(parseCodeforcesBlogUrl('https://codeforces.com/blog/entry/9001'), 9001);
  for (const bad of [
    'http://codeforces.com/blog/entry/9001',
    'https://codeforces.org/blog/entry/1',
    'https://codeforces.com/problemset/problem/1/A',
  ]) {
    assert.throws(() => parseCodeforcesBlogUrl(bad));
  }
  // A locale query is tolerated because the URL is never fetched as given.
  assert.equal(parseCodeforcesBlogUrl('https://codeforces.com/blog/entry/9001?locale=en'), 9001);
});

test('tag-box metadata outside the statement stays readable and never renders as statement text', () => {
  const html =
    '<body><div class="roundbox"><span class="tag-box" title="Difficulty">*2400</span>' +
    '<span class="tag-box">trees</span></div>' +
    '<div class="problem-statement"><div class="header"><div class="title">C. Trees</div>' +
    '<div class="time-limit">2 seconds</div></div>' +
    '<p>Body with n<sup>2</sup> and a<sub>i</sub>.</p><span class="tag-box">*2400</span></div></body>';
  const result = extractProblemPage(html);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.page.rating, 2400);
  assert.deepEqual(result.page.rawTags, ['trees']);
  assert.equal(result.page.title, 'Trees');
  assert.match(result.page.statement, /n\^2 and a_i/);
  assert.equal(result.page.statement.includes('*2400'), false);
  assert.equal(result.page.statement.includes('trees'), false);
});

test('a normal problem page keeps its statement sections and reads metadata from inside it', () => {
  const result = extractProblemPage(problemPageHtml({ statementHtml: '<p>Split w into two even parts.</p>' }));
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.page.rating, 800);
  assert.deepEqual(result.page.rawTags, ['math', 'brute force']);
  assert.match(result.page.statement, /Split w into two even parts/);
  assert.equal(result.page.statement.includes('*800'), false);
});

test('a statement node that only carries its title header is refused as empty', () => {
  const html =
    '<body><div class="problem-statement"><div class="header"><div class="title">A. Watermelon</div>' +
    '<div class="time-limit">1 second</div></div><div class="tags"><span class="tag-box">*800</span></div></div></body>';
  const result = extractProblemPage(html);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'empty_statement');
  }
});

test('real heading tags allow a problem prefix and short author credit without broadening prose', () => {
  for (const heading of [
    '<h3>Problem <a href="//www.codeforces.com/problemset/problem/189/A">189A — Cut Ribbon</a></h3>',
    '<h4><a href="/contest/189/problem/A">189A - Cut Ribbon</a> ( Author : Bidhan )</h4>',
  ]) {
    const result = extractEditorialSection(heading + '<p>Compute a dynamic programming table over the ribbon length.</p>', { contestId: 189, index: 'A' });
    assert.equal(result.ok, true);
  }
  const prose = extractEditorialSection('<p>Problem <a href="/contest/189/problem/A">189A</a></p><p>A passing mention in prose.</p>', { contestId: 189, index: 'A' });
  assert.equal(prose.ok, false);
});