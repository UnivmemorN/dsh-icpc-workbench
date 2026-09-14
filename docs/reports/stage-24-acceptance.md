# Stage 24 — Markdown acceptance (0.1.19)

Local Markdown rendering now covers problem statements, saved solutions and disclosed coaching text. The principal implementation used dsh / DeepSeek Flash max; coordinator review added URL/asset isolation, full license accounting and regression fixes for sample boundaries and unknown directives. Rendering introduces no AI call or storage migration.

`npm run check` passed: 1246 tests passed, one environment-dependent test skipped; all 10 worker accounting/context checks passed, as did TypeScript, architecture, build and client protocol checks. The final client bundles 315 modules from 98 licensed packages; all full notices are reproduced. Twenty font faces reference 60 embedded font assets, with no runtime font CDN. KaTeX selectors and font names are isolated to the Markdown view.

The 46 focused renderer cases use actual React SSR and synthetic text: GFM, safe links/images, invalid/untrusted math, nested folds, literal unknown directives, table rectangles, code line numbers/ranges and copied text, raw-source fallback and old/new Luogu sample preservation. The coordinator reproduced and fixed legacy sample boundaries and new samples containing literal heading/input/output markers.

Installed 0.1.19 on the isolated acceptance profile and restarted successfully. A fresh offline SQLite backup was verified before installation. Every database table and every plugin setting matched the pre-install baseline, schema remained 8, and all model roles remained Flash. All 742 installed dist files matched the tested build byte-for-byte; client SHA-256: 71f02a93972e183f0fab39b7bd8e2376d87fea40187beeddf431a6ad133a13b5.

The first offline install correctly refused missing package-cache metadata; the old host was restored, then the same verified package was installed with normal official npm dependency resolution. No supply-chain policy was disabled.

Actual browser acceptance passed after reload: inline/display formulas and fonts, code highlighting, line-number gutter and range highlighting, nested folds and default-open state, alignment and epigraph, vertical/horizontal table spans, broken-image alt fallback and original-source disclosure. Copy was verified by pasting into an unsaved synthetic scratch form and comparing exact text (including whitespace and excluding line numbers), then clearing the draft. The browser automation clipboard-read surface returned an empty value, so its result was not used as proof; actual paste succeeded. An already-stored Luogu statement also showed its legacy input/output samples as literal copyable blocks, without refresh or AI.

Only a clearly synthetic manual problem received new Markdown material for acceptance; real account history was only read. Existing editorial/coaching disclosure and paid-action controls stayed intact. The retained browser page shows a real stored statement with rendered formulas and samples.

Raw HTML remains text and Bilibili video syntax opens a link instead of embedding a player. Unsupported/ambiguous syntax retains visible source; old legacy sample data with a complete builder-style hint heading after output is inherently indistinguishable from a real hint section, documented in the user guide. CRLF is normalized to LF in rendered code, while stored original text stays available.

Syntax attribution: [Luogu's official Markdown handbook](https://help.luogu.com.cn/rules/academic/handbook/markdown). No platform problem statements, editorials, account history or worker transcripts are published. Complete dependency notices and existing inspiration references remain in THIRD_PARTY_NOTICES.md.
