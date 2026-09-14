/**
 * Ambient declarations for the two non-TypeScript module shapes the renderer imports:
 * the KaTeX stylesheet (an asset handled by the build's CSS loader) and the individual
 * highlight.js grammars (CommonJS files published without a subpath type map).
 */
declare module '*.css' {
  /** Exact stylesheet text; the build turns it into a JavaScript string. */
  const css: string;
  export default css;
}

declare module 'highlight.js/lib/languages/*' {
  import type { LanguageFn } from 'lowlight';
  const language: LanguageFn;
  export default language;
}
