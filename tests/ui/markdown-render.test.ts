/**
 * Real renderer tests for the local Markdown view (Sprint 24a).
 *
 * These cases render the actual component tree with `renderToStaticMarkup`, so they exercise the
 * installed react-markdown/remark/rehype/KaTeX/lowlight stack rather than a copy of its rules. They
 * pin the guarantees the problem page, the saved solutions and the AI coaching text rely on:
 *
 * - GFM block and inline semantics, including tables and task lists;
 * - inline and block math, with invalid math and untrusted commands staying visible and inert;
 * - fenced and inline code keeping their exact characters, including `$`, HTML and fence info;
 * - link/image destinations limited to http/https (plus mailto and anchors), with relative URLs
 *   resolved against the caller's source base and every unsafe scheme rejected;
 * - raw HTML never becoming markup or an event handler;
 * - oversized stored text shown in full behind a notice instead of being parsed or truncated.
 *
 * No DOM, no network, no storage and no snapshot-only assertions: the input is synthetic text and
 * the assertion is on the produced markup.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent, MarkdownView, MAX_MARKDOWN_CHARS } from '../../src/ui/markdown/view.js';

/** Render the real rendered-content component exactly as the client mounts it. */
function html(text: string, baseUrl?: string): string {
  return renderToStaticMarkup(createElement(MarkdownContent, { text, baseUrl }));
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

const BASE = 'https://codeforces.com/problemset/problem/1/A';

test('renders GFM blocks: headings, emphasis, lists, blockquote and table', () => {
  const out = html([
    '# 标题',
    '',
    '**粗体** 与 *斜体* 与 ~~删除~~',
    '',
    '- 第一项',
    '- 第二项',
    '',
    '1. 甲',
    '2. 乙',
    '',
    '> 引用段落',
    '',
    '| 列A | 列B |',
    '| --- | --- |',
    '| 1 | 2 |',
  ].join('\n'));
  assert.match(out, /<h1>标题<\/h1>/);
  assert.match(out, /<strong>粗体<\/strong>/);
  assert.match(out, /<em>斜体<\/em>/);
  assert.match(out, /<del>删除<\/del>/);
  assert.match(out, /<ul>[\s\S]*<li>第一项<\/li>/);
  assert.match(out, /<ol>[\s\S]*<li>甲<\/li>/);
  assert.match(out, /<blockquote>[\s\S]*引用段落/);
  assert.match(out, /<table>[\s\S]*<th>列A<\/th>[\s\S]*<td>1<\/td>/);
});

test('renders GFM task lists as disabled checkboxes', () => {
  const out = html('- [x] 已完成\n- [ ] 未完成');
  assert.match(out, /<input[^>]*type="checkbox"/);
  assert.match(out, /<input[^>]*checked/);
  assert.match(out, /<input[^>]*disabled/);
  assert.match(out, /task-list-item/);
  assert.ok(textContent(out).includes('已完成') && textContent(out).includes('未完成'));
});

test('keeps fenced and inline code exact, including dollars and HTML', () => {
  const out = html([
    '行内 `$x$` 与 `<b>inline</b>` 保持原样。',
    '',
    '```',
    'if (a < b) { // $not math$ }',
    '<div>raw</div>',
    '```',
  ].join('\n'));
  assert.match(out, /<code>\$x\$<\/code>/);
  assert.match(out, /&lt;b&gt;inline&lt;\/b&gt;/);
  assert.ok(textContent(out).includes('if (a < b) { // $not math$ }'));
  assert.ok(textContent(out).includes('<div>raw</div>'));
  assert.ok(!out.includes('<div>raw</div>'));
  assert.ok(!out.includes('katex'));
});

test('highlights the registered language subset and preserves the exact fence info', () => {
  const cpp = html('```cpp\nint main(){ return 0; }\n```');
  assert.match(cpp, /class="language-cpp"/);
  assert.match(cpp, /hljs-keyword/);
  assert.match(cpp, /data-code-info="cpp"/);
  assert.ok(textContent(cpp).includes('int main(){ return 0; }'));

  const withMeta = html('```cpp line-numbers=10\nint main(){}\n```');
  assert.match(withMeta, /data-code-info="cpp line-numbers=10"/);
  assert.match(withMeta, /hljs-type/);

  const unknown = html('```brainfuck\n+[>,.]\n```');
  assert.match(unknown, /class="language-brainfuck"/);
  assert.ok(!unknown.includes('hljs-'));
  assert.ok(textContent(unknown).includes('+[>,.]'));
});

test('skips highlighting above the size guard without losing any character', () => {
  const code = 'x'.repeat(20001);
  const out = html(`\`\`\`cpp\n${code}\n\`\`\``);
  assert.ok(!out.includes('hljs-'));
  assert.ok(out.includes(code));
});

test('renders inline and block math with KaTeX', () => {
  const out = html('行内 $a^2+b^2=c^2$ 结束。\n\n$$\n\\frac{1}{2}\n$$');
  assert.match(out, /class="katex"/);
  assert.match(out, /class="katex-display"/);
  assert.ok(out.includes('katex-mathml'));
  assert.ok(out.includes('a^2+b^2=c^2'));
  assert.ok(!out.includes('<img'));
});

test('keeps invalid math and untrusted commands visible and inert', () => {
  const out = html('坏公式 $\\frac{1}{$ 与 $\\href{javascript:alert(1)}{点我}$ 以及 $\\includegraphics{https://evil.example/x.png}$');
  assert.match(out, /katex-error/);
  assert.ok(textContent(out).includes('\\frac{1}{'));
  assert.ok(textContent(out).includes('点我'));
  assert.ok(!/href="javascript:/i.test(out));
  assert.ok(!/<a[\s>]/i.test(out));
  assert.ok(!out.includes('<img'));
});

test('does not leak KaTeX macros between renders', () => {
  const first = html('$\\gdef\\leak{x}\\leak$');
  assert.match(first, /class="katex"/);
  assert.ok(first.includes('>x</span>'));
  const second = html('$\\leak$');
  // The second render gets fresh macros, so the command is unresolved and stays visible in the
  // error color instead of silently expanding to the first render's definition.
  assert.ok(second.includes('#b05532'));
  assert.ok(second.includes('\\leak'));
  assert.ok(!second.includes('>x</span>'));
});

test('respects escaped Markdown markers', () => {
  const out = html('\\*不是斜体\\* 与 \\$5 与 \\_下划线\\_');
  assert.ok(!out.includes('<em>'));
  const text = textContent(out);
  assert.ok(text.includes('*不是斜体*'));
  assert.ok(text.includes('$5'));
  assert.ok(text.includes('_下划线_'));
});

test('rejects unsafe link destinations and keeps the label as plain text', () => {
  const attacks = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///C:/Windows/win.ini',
    'blob:https://codeforces.com/abc',
    'java&#115;cript:alert(1)',
    'javascript\\:alert(1)',
    '<java\tscript:alert(1)>',
  ];
  for (const target of attacks) {
    const out = html(`[点我](${target})`, BASE);
    assert.ok(!/<a[\s>]/i.test(out), `destination must stay inert: ${JSON.stringify(target)}`);
    assert.ok(textContent(out).includes('点我'), `label must stay visible: ${JSON.stringify(target)}`);
  }
});

test('resolves safe relative and same-document URLs and marks external links', () => {
  const relative = html('[题解](/blog/entry/1)', BASE);
  assert.match(relative, /<a href="https:\/\/codeforces\.com\/blog\/entry\/1"/);
  assert.match(relative, /target="_blank"/);
  assert.match(relative, /rel="noopener noreferrer"/);

  const noBase = html('[题解](/blog/entry/1)');
  assert.ok(!/<a[\s>]/i.test(noBase));

  const mail = html('[邮件](mailto:someone@example.com)');
  assert.match(mail, /<a href="mailto:someone@example\.com"/);
  assert.ok(!mail.includes('target="_blank"'));

  const anchor = html('[回到顶部](#section-1)');
  assert.match(anchor, /<a href="#section-1"/);
  assert.ok(!anchor.includes('target="_blank"'));
});

test('loads only http/https images with lazy loading and falls back to alt text', () => {
  const ok = html('![示意图](https://cdn.example.com/a.png)');
  assert.match(ok, /<img[^>]*class="icpc-markdown-image"/);
  assert.match(ok, /loading="lazy"/);
  // React's server renderer emits the DOM property spelling; HTML attribute names are
  // case-insensitive, so the browser receives `referrerpolicy="no-referrer"`.
  assert.match(ok, /referrerpolicy="no-referrer"/i);
  assert.match(ok, /alt="示意图"/);

  const blocked = html('![示意图](javascript:alert(1))');
  assert.ok(!blocked.includes('<img'));
  assert.ok(blocked.includes('图片：示意图'));

  const dataImage = html('![图](data:image/png;base64,AAAA)');
  assert.ok(!dataImage.includes('<img'));

  const relativeImage = html('![图](/img/a.png)', BASE);
  assert.match(relativeImage, /<img[^>]*src="https:\/\/codeforces\.com\/img\/a\.png"/);
});

test('never turns raw HTML into markup or an event handler', () => {
  const source = '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n<b onclick="x">bold</b>';
  const out = html(source);
  assert.ok(!out.includes('<script'));
  assert.ok(!out.includes('<img'));
  assert.ok(!out.includes('<b '));
  assert.ok(!out.includes('onerror="'));
  assert.ok(!out.includes('onclick="'));

  const view = renderToStaticMarkup(createElement(MarkdownView, { text: source }));
  assert.match(view, /查看原文/);
  assert.ok(view.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('keeps the original text in one disclosure and names the region', () => {
  const out = renderToStaticMarkup(createElement(MarkdownView, { text: '# 标题', label: '题面' }));
  assert.match(out, /aria-label="题面"/);
  assert.match(out, /<details class="icpc-markdown-source">/);
  assert.match(out, /<summary>查看原文<\/summary>/);
  assert.match(out, /<pre class="icpc-markdown-raw"># 标题<\/pre>/);

  const defaultLabel = renderToStaticMarkup(createElement(MarkdownView, { text: '# 标题' }));
  assert.match(defaultLabel, /aria-label="内容"/);
});

test('oversized content shows the complete original behind a notice instead of rendering', () => {
  const text = `# 标题\n${'a'.repeat(MAX_MARKDOWN_CHARS)}`;
  const out = renderToStaticMarkup(createElement(MarkdownView, { text }));
  assert.match(out, /超过 250000 字符的渲染上限/);
  assert.match(out, /内容共 \d+ 个字符/);
  assert.ok(!out.includes('<h1>'));
  assert.equal(out.split('<pre class="icpc-markdown-raw">').length - 1, 1);
  assert.match(out, /<details class="icpc-markdown-source" open="">/);
  assert.ok(out.includes(text));
});

test('decodes Markdown destinations once and preserves literal URL query text', () => {
  assert.match(html('[query](https://example.com/?a=1&amp;b=2)'), /href="https:\/\/example\.com\/\?a=1&amp;b=2"/);
  assert.match(html('[literal](https://example.com/?x=&amp;amp;)'), /href="https:\/\/example\.com\/\?x=&amp;amp;"/);
  assert.match(html(String.raw`[escaped](https://example.com/a\(b\))`), /href="https:\/\/example\.com\/a\(b\)"/);
});
