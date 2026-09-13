# Third-party notices

## Reference projects

- [ZF3373/icpc-workbench](https://github.com/ZF3373/icpc-workbench), reference commit `781e9f1981dba2822617e2cd13e92d6516f11b23`, MIT, Copyright (c) 2026 ZF3373. This project independently implements a related ICPC workflow; no upstream implementation files are copied. The original license is included in [licenses/icpc-workbench-MIT.txt](licenses/icpc-workbench-MIT.txt). Record any future copied components here and retain their notices.
- [NovaPhy](https://github.com/UnivmemorN/NovaPhy): architecture and development workflow reference only; no code is copied. Its physics implementation is not part of this package.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), tested baseline `0.1.5-rc.2` at commit `fb2c4b9e698e30edb738bca4cf0618587db7d203`, MIT, Copyright (c) 2026 DeepSeek. The plugin uses its public extension APIs and browser registration protocol. The host remains an external dependency. See [licenses/deepseek-harness-MIT.txt](licenses/deepseek-harness-MIT.txt).

## npm dependencies

The exact dependency tree is recorded in package-lock.json. Installed dependencies retain their own package licenses and notices. Host and React dependencies are shared with dsh; their implementation is not vendored into this repository. The browser factory bundles pure @noble/hashes code; its full MIT notice is retained in the factory header and [licenses/noble-hashes-MIT.txt](licenses/noble-hashes-MIT.txt). Other dependencies remain external.

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

## Knowledge learning references

- [Nowcoder ACM knowledge-point exercises](https://ac.nowcoder.com/acm/skill/acm), observed 2026-09-13: inspiration for category browsing, search/filter and per-topic practice counts. The learning-evidence rules and implementation here are independent; no Nowcoder page, code, question bank or account records are copied.
- [OI Wiki](https://oi-wiki.org/), OI Wiki Team and community contributors, [repository](https://github.com/OI-wiki/OI-wiki), observed 2026-09-13: reference for topic navigation and external learning resources. The package contains independently selected title/URL mappings, not OI Wiki article bodies, code, images or a mirror. Broad mappings are explicitly marked as overview references. See [knowledge-learning.md](docs/knowledge-learning.md) for implemented roles and future plans.
- OI Wiki's [copyright declaration](https://github.com/OI-wiki/OI-wiki#版权声明) states that non-code content, unless otherwise specified, is available under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) and additional [SATA](https://github.com/zTrix/sata-license) terms; individual material may have separate notices. Any future reproduced/adapted content must retain its applicable attribution, license, source/version and change notices and must not be represented as covered solely by this project's MIT license.

Neither Nowcoder nor OI Wiki supplies or certifies this project's mastery assessment. The status labels describe recorded evidence and are not a validated mastery probability.

## Source-tag alignment

The [tag-alignment rules](docs/tag-alignment.md) reference public terminology from [Codeforces](https://codeforces.com/apiHelp/objects#Problem), [Luogu](https://www.luogu.com.cn/problem/list), [Nowcoder](https://ac.nowcoder.com/acm/skill/acm), and [OI Wiki](https://oi-wiki.org/), checked 2026-09-13. Cross-source equivalences and conservative exclusions are independently maintained project decisions, not an official joint taxonomy or endorsement. No problem/editorial bodies or third-party article code/images are incorporated. Existing project and content-license notices above continue to apply.

## Ability scoring references

Reviewed 2026-09-13: [ZF3373/icpc-workbench](https://github.com/ZF3373/icpc-workbench) commit ac4a2e0920e07a9d5abde8cee54ac8aa8a3a5fa7, server/src/today/ability.ts and select.ts (MIT, Copyright (c) 2026 ZF3373). The separation of explicit overrides and practice evidence is a design reference; its median formula is not used as player ability. No implementation files are copied; the original MIT notice above remains included.

[Codeforces official problem-difficulty explanation](https://codeforces.com/blog/entry/62865) and [official rating API](https://codeforces.com/apiHelp/methods#user.rating) define the distinction between problem ratings and official competition ratings. [AtCoder AHC v2](https://atcoder.jp/posts/1381) and its [formula](https://img.atcoder.jp/file/AHC_rating_v2_en.pdf) were reviewed, not implemented: practice solves are not contest performances. No article bodies, images or rating implementation code are incorporated. The product uses CF's returned current rating and independently implements the fetch, persistence and display; the sites do not certify or endorse this plugin. See [method and limitations](docs/ability-scoring.md).
