# Stage 24b — Luogu Markdown extensions and sample compatibility

Bounded continuation after the coordinator accepted stage 24a. The accepted renderer core
(`view.ts`/`plugins.ts`/`highlight.ts` + `MarkdownView.tsx` facade, build assets and URL policy) was
reused unchanged; this stage adds the Luogu syntax layer, the view-only legacy sample adapter, the
sample fencing for newly assembled statements and the focused tests. No AI, storage, provider or
runtime change; no version/budget/schema edit; synthetic fixtures only.

## Changed files

| File | Change |
| --- | --- |
| `src/ui/markdown/extensions.ts` | **new**: `remarkLuoguDirectives` (folds, align, epigraph, cute-table, visible fallbacks) and `rehypeTableMerges` (`^`/`<` origin-grid rectangles); bounds and exact-source marker proofs |
| `src/ui/markdown/luogu-samples.ts` | **new**: view-only legacy `## 样例 #N` adapter with explicit ambiguity fallbacks |
| `src/ui/markdown/literal-fence.ts` | **new**: adaptive literal fence shared by the display paths |
| `src/ui/markdown/plugins.ts` | registers `remark-directive`, the directive transform and the hast merge pass; documents ordering |
| `src/ui/markdown/view.ts` | `source?: 'luogu'` display hint, fence-meta parsing (`line-numbers`, `lines=`), line gutter + range highlight, Bilibili external-link boundary |
| `src/ui/Problem.tsx` | passes `source="luogu"` only when the problem's own source instance is `platform === 'luogu'` |
| `src/adapters/luogu/parsers.ts` | `luoguSampleFence` + `buildLuoguStatement` now fence new sample input/output; stored statements/hashes untouched |
| `src/ui/styles.ts` | scoped CSS for folds, tints, align, epigraph, tuack, unknown-directive fallback, merged cells, line gutter/range, video link |
| `tests/ui/markdown-luogu.test.ts` | **new**: 27 real-pipeline SSR tests |
| `docs/markdown-rendering.md` | **new**: Chinese syntax/entry-point/limit documentation |
| `THIRD_PARTY_NOTICES.md` | 24b implemented-independently paragraph (syntax reference only, synthetic fixtures) |

## Behavior implemented

- **Folds** `:::info|success|warning|error[title]{open}` → semantic `<details>`/`<summary>`, only the
  presence of `open` expands, titles may contain inline math, bodies support lists/math/code/nested
  folds. Unknown, inline (`:name[…]`) and over-depth directives keep their content (inline ones their
  exact source); no input attribute reaches the DOM.
- **Align** `{center}`/`{right}` only; **epigraph** with a visible `<footer>` attribution;
  **cute-table** consumed only when attached to a real table.
- **Table merges** at hast level with an origin grid: valid rectangles only, header (`<thead>`) never
  merges, first-row/first-column markers stay visible, escaped and inline-code markers stay literal,
  no overlap, unmarked tables unchanged. The hast (not mdast) pass matters: mdast-util-to-hast pads a
  shortened row back to the header width, which would have added a phantom column.
- **Fence meta** `line-numbers` and `lines=a-b` (combined, either order, or meta-first fences): line
  numbers live outside `<code>` in an `aria-hidden` gutter, range highlighting reopens `hljs-*` spans
  across line breaks, and malformed/out-of-range flags are ignored without touching the code text.
- **Bilibili** video/player image links render as an external "打开视频" link; no iframe, script,
  autoplay or provider request (documented boundary).
- **Samples**: new statements use adaptive literal fences; stored legacy statements are adapted only
  for display under the Luogu source hint, with a literal fallback for every ambiguous shape; the
  original stays in `查看原文`.

## Commands actually run

| Command | Result |
| --- | --- |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/ui/markdown-luogu.test.ts tests/ui/markdown-render.test.ts` | **43/43 pass** (27 new + 16 accepted 24a tests) |
| `npm run typecheck` | pass (two errors found and fixed: unused parameter, hast root content type) |
| `npm run check:architecture` | pass — "Architecture imports satisfy the declared layer boundaries" |
| focused one-off Node probes (mdast cell offsets, fence `lang`/`meta`, rendered markup) | used only for diagnosis; no artifacts kept |

The suite was also run once per fix cycle; the final run above is the recorded one. Every fixture is
synthetic, and both code-fenced and legacy sample cases assert the **exact reconstructed code text**
(`$`, `<b>`, fence-like lines, trailing blanks) rather than a meta string.

## Open issues / not run here

- **Not run (out of scope by contract)**: full regression gate, `npm run build` / client protocol
  check (no core asset or URL-policy change), real-browser and installed-package verification, and
  publication. These remain with the coordinator.
- The CSS additions are type-checked source but were not visually verified in a browser here; the
  `colSpan`/`rowspan` spelling in the SSR markup depends on React's attribute table
  (`rowspan` lowercased, `colSpan` not), which is valid HTML either way and is asserted
  case-insensitively.
- `unist-util-visit` remains an unused installed dependency (the walkers are handwritten and bounded);
  removing it is a packaging decision for the coordinator.
- Statement refresh semantics: existing snapshots keep their text and hash; the new fencing appears
  only when a fresh platform refresh rebuilds a statement, as required.
