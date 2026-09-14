/**
 * Public location of the local Markdown renderer (Sprint 24a).
 *
 * The implementation lives in `./markdown/view.ts` and is re-exported here so imports read as
 * `./MarkdownView.js` and stage 24b has a JSX-capable file to extend. The split is deliberate: the
 * repository's test runner strips TypeScript types without transforming JSX, so the component tree
 * itself must stay in a `.ts` module to be covered by real `renderToStaticMarkup` tests.
 */
export { MarkdownContent, MarkdownView, MAX_MARKDOWN_CHARS } from './markdown/view.js';
export type { MarkdownViewProps } from './markdown/view.js';
