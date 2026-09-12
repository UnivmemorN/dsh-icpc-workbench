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
