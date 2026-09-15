# Third-party notices

## Reference projects

- [ZF3373/icpc-workbench](https://github.com/ZF3373/icpc-workbench), reference commit `781e9f1981dba2822617e2cd13e92d6516f11b23`, MIT, Copyright (c) 2026 ZF3373. This project independently implements a related ICPC workflow; no upstream implementation files are copied. The original license is included in [licenses/icpc-workbench-MIT.txt](licenses/icpc-workbench-MIT.txt). Record any future copied components here and retain their notices.
- [NovaPhy](https://github.com/UnivmemorN/NovaPhy): architecture and development workflow reference only; no code is copied. Its physics implementation is not part of this package.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), tested baseline `0.1.5-rc.2` at commit `fb2c4b9e698e30edb738bca4cf0618587db7d203`, MIT, Copyright (c) 2026 DeepSeek. The plugin uses its public extension APIs and browser registration protocol. The host remains an external dependency. See [licenses/deepseek-harness-MIT.txt](licenses/deepseek-harness-MIT.txt).

## npm dependencies

The exact dependency tree is recorded in package-lock.json. Installed dependencies retain their own package licenses and notices. Host and React dependencies are shared with dsh; their implementation is not vendored into this repository. The browser factory bundles pure @noble/hashes code; its full MIT notice is retained in the factory header and [licenses/noble-hashes-MIT.txt](licenses/noble-hashes-MIT.txt). Since Sprint 24a the factory also bundles the local Markdown rendering stack below with its transitive packages; the exact package names, versions, declared licenses and full notice texts are generated into `dist/client-LICENSES.txt` at build time. React, `react/jsx-runtime`, `react-dom/client` and `@deepseek-ai/cordis` remain shared with the dsh host and are not bundled; server-side dependencies (storage, platform adapters, CSV import) remain outside the browser factory.

| Package | Version | Declared license |
| --- | --- | --- |
| @noble/hashes | 2.4.0 | MIT |
| csv-parse | 7.0.2 | MIT |
| domhandler | 6.0.1 | BSD-2-Clause |
| domutils | 4.0.2 | BSD-2-Clause |
| htmlparser2 | 12.0.0 | MIT |
| @deepseek-ai/cordis | 4.0.2 | MIT |
| @deepseek-ai/dsh-llm | 0.1.5-rc.2 | MIT |
| @deepseek-ai/dsh-session | 0.1.5-rc.2 | MIT |
| @deepseek-ai/dsh-session-persistence | 0.1.5-rc.2 | MIT |
| @deepseek-ai/dsh-client-connection | 0.1.5-rc.2 | MIT |
| @deepseek-ai/dsh-client-ui-slots | 0.1.5-rc.2 | MIT |
| @deepseek-ai/dsh-client-ui-layout | 0.1.5-rc.2 | MIT |
| @deepseek-ai/dsh-client-ui-sidebar | 0.1.5-rc.2 | MIT |
| @deepseek-ai/dsh-client-ui-renderer | 0.1.5-rc.2 | MIT |
| react | 18.3.1 | MIT |
| react-markdown | 10.1.0 | MIT |
| remark-gfm | 4.0.1 | MIT |
| remark-math | 6.0.0 | MIT |
| rehype-katex | 7.0.1 | MIT |
| katex | 0.16.47 | MIT |
| lowlight | 3.3.0 | MIT |
| highlight.js | 11.12.0 | BSD-3-Clause |
| remark-directive | 4.0.0 | MIT |
| unist-util-visit | 5.1.0 | MIT |

## Local Markdown rendering

Sprint 24a renders stored problem statements, saved solution text and AI coaching text in the client
with `react-markdown` (CommonMark/GFM through `remark-gfm`), `remark-math` + `rehype-katex` (KaTeX)
for math, and `lowlight` + `highlight.js` for a small registered code-language subset. Nothing is
fetched for parsing or math fonts; external images load only from their validated source URL. Raw HTML is never enabled, and the original stored string stays available
behind a "查看原文" disclosure. `remark-directive` supplies the parser for the
stage-24b Luogu directive/table transform.

Sprint 24b implements that transform independently: fold directives, alignment, epigraph, the
`::cute-table` decorator, `^`/`<` table-cell merges and fence meta (`line-numbers`, `lines=`) are
recognized in the parsed AST and mapped onto fixed, scoped elements, and nothing is produced by
rewriting an HTML string. The implemented behavior is specified against the public
[Luogu Markdown handbook](https://help.luogu.com.cn/rules/academic/handbook/markdown), checked
2026-09-14. Only the public syntax rules are referenced: no Luogu prose, example, screenshot, sample
problem, editorial, code or dataset is copied, and every test fixture is synthetic.

Installed license fields were verified on 2026-09-14: the Markdown libraries above are MIT and
`highlight.js` is BSD-3-Clause, each with the full notice reproduced in `dist/client-LICENSES.txt`
for every package that the browser bundle actually contains. Two bundled packages,
`rehype-katex@7.0.1` and `remark-math@6.0.0`, publish no LICENSE file in their npm artifacts; that
file reproduces verified full upstream notices from exact release commits retained under `licenses/`. The KaTeX stylesheet and all 60 referenced font files are inlined from the installed package as data URLs, accompanied by its published license; no runtime CDN request is needed. The bundle currently contains `highlight.js` twice, at 11.12.0 (direct) and
11.11.2 (through lowlight's `~11.11.0` range); both notices are reproduced.

## Knowledge learning references

- [Nowcoder ACM knowledge-point exercises](https://ac.nowcoder.com/acm/skill/acm), observed 2026-09-13: inspiration for category browsing, search/filter and per-topic practice counts. The learning-evidence rules and implementation here are independent; no Nowcoder page, code, question bank or account records are copied.
- [OI Wiki](https://oi-wiki.org/), OI Wiki Team and community contributors, [repository](https://github.com/OI-wiki/OI-wiki), observed 2026-09-13: reference for topic navigation and external learning resources. The package contains independently selected title/URL mappings, not OI Wiki article bodies, code, images or a mirror. Broad mappings are explicitly marked as overview references. See [knowledge-learning.md](https://github.com/UnivmemorN/dsh-icpc-workbench/blob/main/docs/knowledge-learning.md) for implemented roles and future plans.
- OI Wiki's [copyright declaration](https://github.com/OI-wiki/OI-wiki#版权声明) states that non-code content, unless otherwise specified, is available under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) and additional [SATA](https://github.com/zTrix/sata-license) terms; individual material may have separate notices. Any future reproduced/adapted content must retain its applicable attribution, license, source/version and change notices and must not be represented as covered solely by this project's MIT license.

Neither Nowcoder nor OI Wiki supplies or certifies this project's mastery assessment. The status labels describe recorded evidence and are not a validated mastery probability.

## Source-tag alignment

The [tag-alignment rules](https://github.com/UnivmemorN/dsh-icpc-workbench/blob/main/docs/tag-alignment.md) reference public terminology from [Codeforces](https://codeforces.com/apiHelp/objects#Problem), [Luogu](https://www.luogu.com.cn/problem/list), [Nowcoder](https://ac.nowcoder.com/acm/skill/acm), and [OI Wiki](https://oi-wiki.org/), checked 2026-09-13. Cross-source equivalences and conservative exclusions are independently maintained project decisions, not an official joint taxonomy or endorsement. No problem/editorial bodies or third-party article code/images are incorporated. Existing project and content-license notices above continue to apply.

## Ability scoring references

Reviewed 2026-09-13: [ZF3373/icpc-workbench](https://github.com/ZF3373/icpc-workbench) commit ac4a2e0920e07a9d5abde8cee54ac8aa8a3a5fa7, server/src/today/ability.ts and select.ts (MIT, Copyright (c) 2026 ZF3373). The separation of explicit overrides and practice evidence is a design reference; its median formula is not used as player ability. No implementation files are copied; the original MIT notice above remains included.

[Codeforces official problem-difficulty explanation](https://codeforces.com/blog/entry/62865) and [official rating API](https://codeforces.com/apiHelp/methods#user.rating) define the distinction between problem ratings and official competition ratings. [AtCoder AHC v2](https://atcoder.jp/posts/1381) and its [formula](https://img.atcoder.jp/file/AHC_rating_v2_en.pdf) were reviewed, not implemented: practice solves are not contest performances. No article bodies, images or rating implementation code are incorporated. The product uses CF's returned current rating and independently implements the fetch, persistence and display; the sites do not certify or endorse this plugin. See [method and limitations](https://github.com/UnivmemorN/dsh-icpc-workbench/blob/main/docs/ability-scoring.md).

## Luogu history synchronization

The Luogu history adapter references the account-history workflow and public endpoint usage in [ZF3373/icpc-workbench, server/src/adapters/luogu.ts](https://github.com/ZF3373/icpc-workbench/blob/ac4a2e0920e07a9d5abde8cee54ac8aa8a3a5fa7/server/src/adapters/luogu.ts), commit `ac4a2e0920e07a9d5abde8cee54ac8aa8a3a5fa7` (MIT, Copyright (c) 2026 ZF3373; license rechecked 2026-09-13). The existing complete MIT notice remains in `licenses/icpc-workbench-MIT.txt`. The implementation here is independent; no upstream implementation, challenge solver, difficulty conversion or account material is copied.

[Luogu public configuration](https://www.luogu.com.cn/_lfe/config), checked 2026-09-13, supplies the meaning of numeric verdicts; private authenticated responses are not included as fixtures. Windows session storage uses the operating system's [Credential Manager API](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw) through an independently written wrapper. No platform endorses this plugin.

## Luogu platform tag-name snapshot

Sprint 21a bundles a public id → display-name snapshot read from [Luogu's public tag payload](https://www.luogu.com.cn/_lfe/tags), retrieved 2026-09-14 (HTTP 200, 505 entries). Only public tag identifiers and their platform display names are stored; the snapshot contains no problem statements, editorials, submissions, account records or other user material, and no third-party code is copied. These names are platform metadata for Luogu's own raw tags, not an algorithm taxonomy and not a verification by this plugin: unknown future ids stay explicitly unnamed, the snapshot is versioned with the plugin, and stored records are never migrated, re-imported or rewritten. No third-party license is asserted for this factual metadata here; Luogu does not license or endorse this plugin. Sprint 32 shares this unchanged snapshot between display and the provisional source-tag crosswalk; dictionary names pass through independently authored conservative mapping rules and never become verified mastery. The public payload was rechecked on 2026-09-15 with all 505 pairs unchanged. See [docs/luogu-tag-names.md](https://github.com/UnivmemorN/dsh-icpc-workbench/blob/main/docs/luogu-tag-names.md).

## Luogu public nickname presentation

Sprint 22b2 presents a Luogu account's public nickname next to its UID. The read uses Luogu's own
public profile page, `GET https://www.luogu.com.cn/user/<UID>` with the `x-lentille-request:
content-only` request header, verified anonymously by the coordinator on 2026-09-14; the official
reference page <https://www.luogu.com.cn/user/1> is cited only to identify that endpoint. Only
`data.user.uid` and `data.user.name` are read — never `root.user` (the viewer identity a logged-in
page may include), and never biography, scores, submissions or other profile content. The
implementation here is independent: no profile body, upstream code or dataset is copied, and no AI
model is involved. Luogu does not license or endorse this plugin. See
[docs/luogu-account-names.md](https://github.com/UnivmemorN/dsh-icpc-workbench/blob/main/docs/luogu-account-names.md).

## Installable training methods

The balanced thinking/templates method implements this project user's design requirements. The optional deliberate-practice companion adapts teaching ideas from [USACO Guide — How to Practice](https://usaco.guide/general/practicing), Competitive Programming Initiative and credited page contributors including Darren Yao, Nathan Wang and Benjamin Qi, checked 2026-09-14. Its teaching text is separately licensed CC BY-NC-SA 4.0; JavaScript registration is MIT. Full attribution, adaptation notes and source license are included in that companion's NOTICE.md and LICENSE.method-text. No source code, problem statements, solutions or page images are copied.

[Carrot](https://github.com/meooow25/carrot) is cited to explain a performance definition, not incorporated or executed. User-imported performance remains separate from official CF rating. The sources do not certify the workbench's AI assessment.

The build reproduces full notices for every resolved client dependency. `remark-math@6.0.0` and `rehype-katex@7.0.1` omit their notice in npm; exact upstream notices are retained under `licenses/`, with commit provenance and SHA-256 verification in the build. PostCSS (MIT, https://github.com/postcss/postcss) is used only at build time to isolate formula styles. KaTeX fonts are embedded from its installed npm package with its published license notice.

## Balance companion compatibility

The reproducible client compatibility patch and its synthetic fixtures reference small portions of [LemCAE/dsh-balance](https://github.com/LemCAE/dsh-balance), package `@lemcae/dsh-balance` 0.1.7, MIT, Copyright (c) 2026 LemCAE. The complete original license is preserved in [licenses/dsh-balance-MIT.txt](licenses/dsh-balance-MIT.txt). This is an independently maintained local compatibility patch, not an upstream release. The balance plugin remains separately installed and removable; the ICPC model gateway does not acquire provider credentials. No installed profile, runtime log, balance amount or credential is included in the repository.
