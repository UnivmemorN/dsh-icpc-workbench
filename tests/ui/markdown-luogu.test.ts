/**
 * Real renderer tests for the Luogu Markdown extensions and sample compatibility (Sprint 24b).
 *
 * Every case renders the actual pipeline with `renderToStaticMarkup` — react-markdown, remark-gfm,
 * remark-math, remark-directive, the stage-24b transforms, KaTeX and lowlight — so the assertions are
 * about produced markup and text, never about a meta string or an internal helper. The fixtures are
 * synthetic: no Luogu page, problem, editorial or account data is used.
 *
 * Covered here: fold directives (nesting, `open`, inline math titles, unknown/unclosed fallbacks),
 * alignment, epigraph, cute-table, `^`/`<` table merges including every invalid shape, fence meta
 * (`line-numbers`, `lines=`) with exact code reconstruction, the Bilibili video-link boundary, the
 * view-only legacy sample adapter, and the exactness of samples written by the new adapter builder.
 *
 * HTML attribute names are case-insensitive, and React's server renderer emits `colSpan` while it
 * lowercases `rowspan`, so span assertions are case-insensitive and opening tags are inspected as a
 * whole instead of assuming an attribute order.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent, MarkdownView, parseCodeMeta } from '../../src/ui/markdown/view.js';
import { adaptLegacyLuoguSamples } from '../../src/ui/markdown/luogu-samples.js';
import { buildLuoguStatement } from '../../src/adapters/luogu/parsers.js';

/** Render the real rendered-content component exactly as the client mounts it. */
function html(text: string, source?: 'luogu'): string {
  return renderToStaticMarkup(createElement(MarkdownContent, { text, source }));
}

/** Visible text of a rendered fragment, for assertions about characters rather than markup. */
function textContent(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Opening tag of the first `tag`, so attribute order is never part of an assertion. */
function openTag(markup: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>`).exec(markup);
  assert.ok(match, `a <${tag}> element must be rendered`);
  return match[0];
}

/** Exact text of every `<code>` element in document order. */
function codeTexts(markup: string): string[] {
  return [...markup.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)].map((match) => textContent(match[1] ?? ''));
}

/** The whole `<td>` element that renders `label`, so attribute assertions cannot depend on order. */
function cellTag(markup: string, label: string): string {
  const match = new RegExp(`<td[^>]*>${label}</td>`).exec(markup);
  assert.ok(match, `the cell ${JSON.stringify(label)} must be rendered`);
  return match[0];
}

/** `true` when any element in `markup` carries an inline style attribute. */
function hasInlineStyle(markup: string): boolean {
  return /<[a-z][^>]*\sstyle=/iu.test(markup);
}

const TABLE_HEAD = '| 列A | 列B | 列C |\n| --- | --- | --- |\n';

test('renders fold directives as semantic details with scoped classes and open only by presence', () => {
  const open = html(':::info[开局提示]{open}\n正文内容\n:::', 'luogu');
  const openDetails = openTag(open, 'details');
  assert.match(openDetails, /class="icpc-md-fold icpc-md-fold-info"/);
  assert.match(openDetails, /open=""/);
  assert.match(open, /<summary>开局提示<\/summary>/);
  assert.ok(textContent(open).includes('正文内容'));

  const closed = html(':::success[成功]\n内容\n:::');
  const closedDetails = openTag(closed, 'details');
  assert.match(closedDetails, /class="icpc-md-fold icpc-md-fold-success"/);
  assert.ok(!closedDetails.includes('open'));
  assert.match(closed, /<summary>成功<\/summary>/);

  const defaultTitle = html(':::error\n内容\n:::');
  assert.match(openTag(defaultTitle, 'details'), /class="icpc-md-fold icpc-md-fold-error"/);
  assert.match(defaultTitle, /<summary>错误<\/summary>/);
});

test('keeps fold bodies rich and nests folds with longer colon runs', () => {
  const out = html([
    '::::warning[外层]{open}',
    '- 第一项',
    '- 第二项',
    '',
    '$$',
    'x^2',
    '$$',
    '',
    '```py',
    'print(1)',
    '```',
    '',
    ':::info[内层]',
    '内层正文',
    ':::',
    '',
    '::::',
  ].join('\n'));
  const outer = openTag(out, 'details');
  assert.match(outer, /class="icpc-md-fold icpc-md-fold-warning"/);
  assert.match(outer, /open=""/);
  assert.match(out, /<details class="icpc-md-fold icpc-md-fold-info">/);
  assert.match(out, /<li>第一项<\/li>/);
  assert.match(out, /class="katex-display"/);
  assert.ok(codeTexts(out).includes('print(1)'));
  assert.ok(textContent(out).includes('内层正文'));
});

test('renders inline math inside a fold title and never forwards directive attributes', () => {
  const out = html(':::info[定义 $a^2$]{open id=x class=y style=color:red onclick=alert(1)}\n正文\n:::');
  assert.match(out, /<summary>定义 <span class="katex">/);
  assert.match(openTag(out, 'details'), /class="icpc-md-fold icpc-md-fold-info"/);
  assert.ok(!out.includes('onclick'));
  assert.ok(!/\sid="/u.test(out));

  const attributes = html(':::info[标题]{open id=x class=y style=color:red onclick=alert(1)}\n正文\n:::');
  assert.ok(!attributes.includes('onclick'));
  assert.ok(!hasInlineStyle(attributes));
  assert.ok(!/\sid="/u.test(attributes));

  const injected = html(':::info[<img src=x onerror=alert(1)>]\n正文\n:::');
  assert.ok(!injected.includes('<img'));
  assert.ok(textContent(injected).includes('<img src=x onerror=alert(1)>'));
});

test('keeps unknown and unclosed directives visible instead of dropping content', () => {
  const unknown = html(':::mystery[神秘]\n需要保留的内容\n:::', 'luogu');
  assert.match(unknown, /<div class="icpc-md-unknown-directive">/);
  assert.ok(textContent(unknown).includes(':::mystery[神秘]'));
  assert.ok(textContent(unknown).includes('需要保留的内容'));
  assert.ok(!unknown.includes('<details'));
  assert.ok(!unknown.includes('icpc-md-fold'));

  // remark-directive reads an unclosed container as a container to the end of the document; the
  // guarantee here is that no content is lost, not that the marker keeps a particular shape.
  const unclosed = html(':::info\n未闭合的内容');
  assert.ok(textContent(unclosed).includes('未闭合的内容'));
  const unclosedUnknown = html(':::mystery\n未知内容');
  assert.ok(textContent(unclosedUnknown).includes('未知内容'));

  const inline = html('普通文本 :guess[保留] 结束');
  assert.ok(textContent(inline).includes(':guess[保留]'));
  assert.ok(textContent(inline).includes('普通文本'));
});

test('treats raw HTML as literal text even when it looks like a fold', () => {
  const source = '<details open><summary>标题</summary>正文</details>';
  const out = html(source);
  assert.ok(!out.includes('<details'));
  assert.ok(out.includes('&lt;details'));
  const view = renderToStaticMarkup(createElement(MarkdownView, { text: source }));
  assert.match(view, /查看原文/);
});

test('aligns only by the two allowlisted keywords and keeps other values visible', () => {
  assert.match(html(':::align{center}\n居中文字\n:::'), /<div class="icpc-md-align icpc-md-align-center">/);
  assert.match(html(':::align{right}\n右对齐\n:::'), /<div class="icpc-md-align icpc-md-align-right">/);

  const unsupported = html(':::align{justify}\n仍然可见\n:::');
  assert.ok(!unsupported.includes('icpc-md-align'));
  assert.ok(textContent(unsupported).includes('仍然可见'));
  assert.ok(textContent(unsupported).includes(':::align{justify}'));

  const both = html(':::align{center right style=text-align:left}\n两者\n:::');
  assert.ok(!both.includes('icpc-md-align'));
  assert.ok(!hasInlineStyle(both));
});

test('renders an epigraph blockquote with a visible attribution', () => {
  const out = html(':::epigraph[某位作者]\n第一行引用\n第二行引用\n:::');
  assert.match(out, /<blockquote class="icpc-md-epigraph">/);
  assert.match(out, /<footer class="icpc-md-epigraph-author">某位作者<\/footer>/);
  assert.ok(textContent(out).includes('第一行引用'));
  assert.ok(textContent(out).includes('第二行引用'));

  const unsigned = html(':::epigraph\n没有署名的引用\n:::');
  assert.match(unsigned, /<footer class="icpc-md-epigraph-author">未署名<\/footer>/);
  assert.ok(textContent(unsigned).includes('没有署名的引用'));
});

test('consumes cute-table only when it decorates the following table', () => {
  const attached = html('::cute-table{tuack}\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |');
  assert.match(attached, /<div class="icpc-md-cute-table">[\s\S]*<table>/);
  assert.ok(!textContent(attached).includes('cute-table'));
  assert.ok(textContent(attached).includes('列A'));

  const detached = html('::cute-table{tuack}\n\n只是普通段落。');
  assert.ok(!detached.includes('icpc-md-cute-table'));
  assert.ok(textContent(detached).includes('::cute-table{tuack}'));
  assert.ok(textContent(detached).includes('只是普通段落。'));

  const wrongAttribute = html('::cute-table\n\n| 列A |\n| --- |\n| 1 |');
  assert.ok(!wrongAttribute.includes('icpc-md-cute-table'));
  assert.ok(textContent(wrongAttribute).includes('::cute-table'));
});

test('never forwards cute-table or fold attributes into the DOM', () => {
  const out = html('::cute-table{tuack class=evil style=color:red onclick=alert(1)}\n\n| 列A |\n| --- |\n| 1 |');
  assert.match(out, /<div class="icpc-md-cute-table">/);
  assert.ok(!out.includes('evil'));
  assert.ok(!out.includes('onclick'));
  assert.ok(!hasInlineStyle(out));
});

test('merges a table cell upward with ^ and leaves the header row untouched', () => {
  const out = html(`${TABLE_HEAD}| 合并 | B1 | C1 |\n| ^ | B2 | C2 |`);
  assert.match(cellTag(out, '合并'), /rowspan="2"/iu);
  assert.equal((out.match(/<td/g) ?? []).length, 5);
  assert.ok(!textContent(out).includes('^'));

  const headerMarker = html('| H1 | ^ |\n| --- | --- |\n| a | b |');
  assert.ok(textContent(headerMarker).includes('^'));
  assert.ok(!headerMarker.includes('rowspan'));

  const firstBodyRow = html('| H1 | H2 |\n| --- | --- |\n| ^ | ^ |');
  assert.ok(!firstBodyRow.includes('rowspan'));
  assert.ok(textContent(firstBodyRow).includes('^'));
});

test('merges a table cell left with < and keeps first-column markers visible', () => {
  const out = html(`${TABLE_HEAD}| 横跨 | < | C1 |`);
  assert.match(cellTag(out, '横跨'), /colspan="2"/iu);
  assert.equal((out.match(/<td/g) ?? []).length, 2);

  const firstColumn = html(`${TABLE_HEAD}| < | b | c |`);
  assert.ok(!firstColumn.includes('colspan'));
  assert.ok(textContent(firstColumn).includes('<'));

  const headerRow = html('| H1 | < |\n| --- | --- |\n| a | b |');
  assert.ok(!headerRow.includes('colspan'));
  assert.ok(textContent(headerRow).includes('<'));
});

test('builds valid mixed rectangles and independent adjacent spans', () => {
  const mixed = html(`${TABLE_HEAD}| A | B | C |\n| D | < | < |\n| ^ | ^ | ^ |`);
  const origin = cellTag(mixed, 'D');
  assert.match(origin, /rowspan="2"/iu);
  assert.match(origin, /colspan="3"/iu);
  assert.equal((mixed.match(/<td/g) ?? []).length, 4);

  const twoByTwo = html('| H1 | H2 |\n| --- | --- |\n| A | B |\n| C | < |\n| ^ | ^ |');
  const square = cellTag(twoByTwo, 'C');
  assert.match(square, /rowspan="2"/iu);
  assert.match(square, /colspan="2"/iu);
  assert.equal((twoByTwo.match(/<td/g) ?? []).length, 3);

  const adjacent = html('| H1 | H2 | H3 | H4 |\n| --- | --- | --- | --- |\n| A | < | B | < |');
  assert.match(cellTag(adjacent, 'A'), /colspan="2"/iu);
  assert.match(cellTag(adjacent, 'B'), /colspan="2"/iu);
  assert.equal((adjacent.match(/<td/g) ?? []).length, 2);
});

test('leaves non-rectangular and malformed merge markers visible', () => {
  const nonRectangular = html('| H1 | H2 |\n| --- | --- |\n| A | B |\n| < | < |\n| ^ | ^ |');
  assert.ok(!nonRectangular.includes('rowspan'));
  assert.ok(!nonRectangular.includes('colspan'));
  assert.equal((nonRectangular.match(/<td/g) ?? []).length, 6);
  const text = textContent(nonRectangular);
  assert.ok(text.includes('<') && text.includes('^'));

  const stacked = html('| H1 | H2 |\n| --- | --- |\n| A | B |\n| ^ | C |\n| ^ | ^ |');
  assert.match(cellTag(stacked, 'A'), /rowspan="3"/iu);
  assert.match(cellTag(stacked, 'C'), /rowspan="2"/iu);

  const unbalanced = html('| H1 | H2 |\n| --- | --- |\n| A | B |\n| ^ x | ^^ |');
  assert.ok(!unbalanced.includes('rowspan'));
  assert.ok(textContent(unbalanced).includes('^ x'));
});

test('keeps escaped and inline-code merge markers literal', () => {
  const out = html('| H1 | H2 |\n| --- | --- |\n| a | \\^ |\n| b | `^` |');
  assert.ok(!out.includes('rowspan'));
  assert.ok(!out.includes('colspan'));
  assert.match(out, /<code>\^<\/code>/);
  const text = textContent(out);
  assert.ok(text.includes('^'));
  assert.equal((out.match(/<td/g) ?? []).length, 4);
});

test('leaves a normal GFM table byte-for-byte equivalent', () => {
  const out = html('| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |');
  assert.ok(!out.includes('rowspan'));
  assert.ok(!out.includes('colspan'));
  assert.equal((out.match(/<td/g) ?? []).length, 4);
  assert.match(out, /<th>列A<\/th>/);
});

test('numbers fenced code lines without touching the code text', () => {
  const out = html('```cpp line-numbers\nint a;\nint b;\n```');
  assert.match(out, /<div class="icpc-code icpc-code-numbered">/);
  assert.match(out, /<span class="icpc-code-gutter" aria-hidden="true">1\n2<\/span>/);
  assert.match(out, /data-code-info="cpp line-numbers"/);
  assert.equal(codeTexts(out)[0], 'int a;\nint b;');
  assert.equal((out.match(/class="icpc-code-line"/g) ?? []).length, 2);
  // The gutter lives outside `<code>`, so the exact code text cannot contain a line number.
  assert.ok(!codeTexts(out)[0]?.includes('1\n2'));

  const bare = html('```line-numbers\nx\ny\n```');
  assert.match(bare, /<span class="icpc-code-gutter" aria-hidden="true">1\n2<\/span>/);
  assert.equal(codeTexts(bare)[0], 'x\ny');
});

test('highlights a bounded line range and keeps highlight spans across line breaks', () => {
  const out = html('```cpp line-numbers lines=2-4\nint a;\nint b;\nint c;\nint d;\nint e;\n```');
  assert.equal((out.match(/icpc-code-line-active/g) ?? []).length, 3);
  assert.match(out, /<span class="icpc-code-line icpc-code-line-active">/);
  assert.equal(codeTexts(out)[0], 'int a;\nint b;\nint c;\nint d;\nint e;');
  assert.match(out, /data-code-info="cpp line-numbers lines=2-4"/);

  const separated = html('```lines=3\nfirst\nsecond\nthird\n```');
  assert.equal((separated.match(/icpc-code-line-active/g) ?? []).length, 1);
  assert.ok(!separated.includes('icpc-code-gutter'));
  assert.equal(codeTexts(separated)[0], 'first\nsecond\nthird');
});

test('ignores malformed or out-of-range fence meta without changing the code', () => {
  const malformed = html('```cpp lines=9-2\nint a;\nint b;\n```');
  assert.ok(!malformed.includes('icpc-code-line'));
  assert.ok(!malformed.includes('icpc-code-gutter'));
  assert.equal(codeTexts(malformed)[0], 'int a;\nint b;');

  const beyond = html('```cpp lines=1-999\nint a;\n```');
  assert.ok(!beyond.includes('icpc-code-line-active'));
  assert.equal(codeTexts(beyond)[0], 'int a;');

  assert.deepEqual(parseCodeMeta('line-numbers lines=2-4', 5), { lineNumbers: true, range: { start: 2, end: 4 } });
  assert.deepEqual(parseCodeMeta('lines=2-4 line-numbers', 5), { lineNumbers: true, range: { start: 2, end: 4 } });
  assert.deepEqual(parseCodeMeta('lines=3', 5), { lineNumbers: false, range: { start: 3, end: 3 } });
  assert.deepEqual(parseCodeMeta('lines=9-2', 5), { lineNumbers: false, range: null });
  assert.deepEqual(parseCodeMeta('lines=0-2', 5), { lineNumbers: false, range: null });
  assert.deepEqual(parseCodeMeta('lines=4-9', 5), { lineNumbers: false, range: null });
  assert.deepEqual(parseCodeMeta('line-numbers=10', 5), { lineNumbers: false, range: null });
});

test('shows a safe external link for a recognizable Bilibili video image link', () => {
  const video = html('![题解视频](https://www.bilibili.com/video/BV1xx411c7mD?p=2)');
  assert.match(video, /<a class="icpc-markdown-video-link" href="https:\/\/www\.bilibili\.com\/video\/BV1xx411c7mD\?p=2"/);
  assert.match(video, /target="_blank"/);
  assert.match(video, /rel="noopener noreferrer"/);
  assert.ok(textContent(video).includes('打开视频：题解视频'));
  assert.ok(!video.includes('<img'));
  assert.ok(!video.includes('iframe'));

  const player = html('![播放器](https://player.bilibili.com/player.html?bvid=BV1xx411c7mD)');
  assert.match(player, /class="icpc-markdown-video-link"/);
  assert.ok(!player.includes('<img'));

  const av = html('![av 号](https://www.bilibili.com/video/av170001)');
  assert.match(av, /class="icpc-markdown-video-link"/);
});

test('keeps non-video and lookalike destinations as ordinary images', () => {
  const space = html('![用户](https://www.bilibili.com/space/12345)');
  assert.match(space, /<img[^>]*class="icpc-markdown-image"/);
  assert.ok(!space.includes('icpc-markdown-video-link'));

  const shortLink = html('![短链](https://b23.tv/abcd1234)');
  assert.match(shortLink, /<img[^>]*class="icpc-markdown-image"/);

  const lookalikeHost = html('![伪装](https://www.bilibili.com.evil.example/video/BV1xx411c7mD)');
  assert.match(lookalikeHost, /<img[^>]*class="icpc-markdown-image"/);
  assert.ok(!lookalikeHost.includes('icpc-markdown-video-link'));

  const blocked = html('![坏](javascript:alert(1))');
  assert.ok(!blocked.includes('<a'));
  assert.ok(!blocked.includes('<img'));
});

test('rewrites pre-24b sample sections into literal blocks and keeps prose as Markdown', () => {
  const legacy = [
    '## 题目描述',
    '',
    '求两数之和。',
    '',
    '## 样例 #1',
    '',
    '输入:',
    '',
    '$x$ <b>not html</b>',
    '',
    '输出:',
    '',
    '42',
    '',
    '## 提示',
    '',
    '注意边界。',
  ].join('\n');
  const adapted = adaptLegacyLuoguSamples(legacy);
  assert.equal(adapted.rewritten, 1);
  assert.equal(adapted.ambiguous, 0);

  const out = html(legacy, 'luogu');
  assert.equal(codeTexts(out)[0], '$x$ <b>not html</b>');
  assert.equal(codeTexts(out)[1], '42');
  assert.ok(!out.includes('<b>'));
  assert.ok(textContent(out).includes('$x$ <b>not html</b>'));
  assert.match(out, /<h2>提示<\/h2>/);
  assert.ok(textContent(out).includes('注意边界。'));

  // Without the Luogu source hint nothing is rewritten: the adapter is display-only and explicit.
  const plain = html(legacy);
  assert.ok(!plain.includes('icpc-code'));
  assert.ok(textContent(plain).includes('42'));
});

test('keeps the untouched original behind 查看原文 while displaying the adapted samples', () => {
  const legacy = '## 样例 #1\n\n输入:\n\n  1   2  \n\n输出:\n\n3\n';
  const view = renderToStaticMarkup(createElement(MarkdownView, { text: legacy, source: 'luogu', label: '题面' }));
  assert.match(view, /aria-label="题面"/);
  assert.match(view, /<summary>查看原文<\/summary>/);
  assert.ok(view.includes('## 样例 #1'));
  assert.ok(codeTexts(view).includes('  1   2  '));
  assert.ok(codeTexts(view).includes('3\n'));
});

test('falls back to one literal section when stored sample text is ambiguous', () => {
  const legacy = [
    '## 样例 #1',
    '',
    '输入:',
    '',
    '数据里出现围栏',
    '```',
    '看起来像围栏',
    '```',
    '',
    '输出:',
    '',
    '结果',
  ].join('\n');
  const adapted = adaptLegacyLuoguSamples(legacy);
  assert.equal(adapted.ambiguous, 1);
  assert.equal(adapted.rewritten, 0);

  const out = html(legacy, 'luogu');
  const text = textContent(out);
  assert.ok(text.includes('输入:'));
  assert.ok(text.includes('看起来像围栏'));
  assert.ok(text.includes('结果'));

  const duplicated = adaptLegacyLuoguSamples('## 样例 #1\n\n输入:\n\na\n\n输出:\n\n输入:\n\nb\n');
  assert.equal(duplicated.ambiguous, 1);
});

test('never treats a fenced marker lookalike as a sample section', () => {
  const lookalike = [
    '# 题解',
    '',
    '```',
    '## 样例 #1',
    '',
    '输入:',
    '',
    'not-a-sample',
    '',
    '输出:',
    '',
    'still-not-a-sample',
    '```',
    '',
    '## 提示',
    '',
    '正文。',
  ].join('\n');
  const adapted = adaptLegacyLuoguSamples(lookalike);
  assert.equal(adapted.rewritten, 0);
  assert.equal(adapted.ambiguous, 0);
  assert.equal(adapted.text, lookalike);
});

test('skips statements that already use the new fenced sample format', () => {
  const sections = { background: null, description: '求两数之和。', formatI: null, formatO: null, hint: null };
  const statement = buildLuoguStatement(sections, [{ input: '1 2\n3 4\n', output: '$x$ <b>\n```\n' }]);
  const adapted = adaptLegacyLuoguSamples(statement);
  assert.equal(adapted.rewritten, 0);
  assert.equal(adapted.ambiguous, 0);
  assert.equal(adapted.text, statement);
});

test('reconstructs newly built sample text exactly through the real renderer', () => {
  const sections = { background: null, description: '求两数之和。', formatI: null, formatO: null, hint: null };
  const statement = buildLuoguStatement(sections, [{ input: '1 2\n3 4\n', output: '$x$ <b>\n```\n' }]);
  const out = html(statement);
  assert.equal(codeTexts(out)[0], '1 2\n3 4\n');
  assert.equal(codeTexts(out)[1], '$x$ <b>\n```\n');
  assert.match(out, /<h2>样例 #1<\/h2>/);
  assert.ok(!out.includes('<b>'));
  assert.ok(textContent(out).includes('$x$ <b>'));
  assert.ok(!out.includes('katex'));

  const fenceLike = buildLuoguStatement(sections, [{ input: '````\ninner\n````\n', output: 'plain\n\n' }]);
  const fences = html(fenceLike);
  assert.equal(codeTexts(fences)[0], '````\ninner\n````\n');
  assert.equal(codeTexts(fences)[1], 'plain\n\n');
});

test('keeps content visible beyond the directive depth bound', () => {
  let body = '最内层内容';
  for (let run = 3; run <= 16; run += 1) {
    const colons = ':'.repeat(run);
    body = `${colons}info[层 ${run}]\n${body}\n${colons}`;
  }
  const out = html(body);
  assert.ok(textContent(out).includes('最内层内容'));
  assert.ok(out.includes('icpc-md-fold'));
  assert.ok(textContent(out).includes('层 4'));
});

test('new literal sample bodies may contain markers and headings without being rewrapped', () => {
  const sections = {background:null, description:'synthetic', formatI:null, formatO:null, hint:null};
  const input='输入:\n输出:\n## 提示\n$x$\n';
  const output='## 样例 #2\n输入:\n';
  const statement=buildLuoguStatement(sections,[{input,output}]);
  assert.equal(adaptLegacyLuoguSamples(statement).text,statement);
  assert.deepEqual(codeTexts(html(statement,'luogu')),[input,output]);
});

test('ambiguous legacy section boundary before output keeps the complete tail literal', () => {
  const source='## 样例 #1\n\n输入:\n\n## 提示\n$x$\n\n输出:\n\n2';
  const out=html(source,'luogu');
  assert.ok(!out.includes('katex'));
  assert.ok(!out.includes('<h2>提示</h2>'));
  assert.ok(codeTexts(out).some(code=>code.includes('## 提示\n$x$\n\n输出:\n\n2')));
});

test('unknown container preserves its complete syntax including nested directive markers', () => {
  const source='::::unknown[Outer]\n\n:::info[Inner]\n$x$\n:::\n\n::::';
  assert.ok(codeTexts(html(source)).includes(source));
});
