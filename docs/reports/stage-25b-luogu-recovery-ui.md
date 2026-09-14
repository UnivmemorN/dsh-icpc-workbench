# Stage 25b — 洛谷题目资料补齐与手动处理（UI）

范围：仅前端与文档（`src/ui/`、`docs/`、聚焦测试）。未改动后端、schema、package/版本、`tests/sync` 或 `tests/storage`；
未运行完整 gate/build；未联网访问洛谷、未调用任何 AI 模型；未执行任何 Git 操作。

## 交付内容

在既有的紧凑面板（`LuoguSyncPanel`）里新增一个默认收起的展开项
**「待补题目与手动处理（N）」**，与紧凑卡片上的积压动作相邻；失败与积压文案会明确指向它。
展开后只按需读取**一页** `luogu.metadataBacklog`，逐题显示原题链接、已存标题、逐题原因/时间/尝试次数，
并提供「重试此题」与「手工补充」两条互不越权的路径。

## 变更文件

| 文件 | 变更 |
| --- | --- |
| `src/ui/luogu-metadata-view.ts` | 新增。纯规则模块：常量镜像、分页/夹取、诚实计数、原因翻译、逐题重试文案与固定错误、手工补充校验与请求负载、冲突保留草稿、变更门禁、`luoguStartNotice`/`luoguStartNoticeStep`。 |
| `src/ui/LuoguMetadata.tsx` | 新增。`LuoguMetadataPanel`（展开时才挂载、按页读取、单行重试、单表单）+ 内部 `LuoguSupplementForm`（草稿仅存在于组件状态；提交走 `luogu.supplementMetadata` 并携带 `expectedSnapshotId`）。 |
| `src/ui/LuoguSync.tsx` | 集成展开项与指针句；新增 `metadataOpen`/`runNotice` 状态；账号切换时清理；`luogu.start` 记录点击时间与持久基线并由状态效果折叠；开始提示单独渲染，可被持久结果清除。 |
| `src/ui/styles.ts` | 追加 `.icpc-luogu-backlog*`、`.icpc-luogu-supplement` 等少量作用域样式；分页沿用既有 `.icpc-pager` 规则。 |
| `docs/luogu-sync-recovery.md` | 新增用户文档（含安全示例、待补题数 vs 失败尝试次数的区别、冲突处理，并链接洛谷官方题目手册作为「个人题目题面可能不公开」的说明来源）。 |
| `docs/luogu-sync.md` | 「题目资料积压」条目后新增「逐题处理」要点并链接新文档。 |
| `tests/ui/luogu-metadata-view.test.ts` | 新增 13 个聚焦测试（纯决策边界：原因翻译、旧数据、计数区分、分页夹取、重试结果区分、表单校验与逐字段请求负载、冲突保留草稿、门禁、开始提示折叠）。 |
| `docs/reports/stage-25b-luogu-recovery-ui.md` | 本报告。 |

工作区中另有若干**先前阶段（25a / 25a2 / 25a3）已接受但尚未提交**的改动（`src/adapters/**`、`src/application/**`、
`src/plugin/**`、`tests/plugin|storage|sync/**`、`package.json`、`README.md` 等）。它们不是本阶段产物，
本阶段**只**写入/修改上表 8 个文件；`git status --short` 的其余条目均在此之前已存在。

## 实际执行的命令与结果

```powershell
# 1) 首轮：类型检查 + 三个洛谷 UI 测试文件
npm run typecheck                                        # 退出码 0
node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none `
  tests/ui/luogu-metadata-view.test.ts tests/ui/luogu-view.test.ts tests/ui/luogu-sync-progress.test.ts
# 结果：41 项中 40 通过、1 失败——失败为测试自身的正则笔误（/也可能还没尝试过/ 与实现文案
# 「也可能是还没尝试过」不一致），非实现缺陷。
```

```powershell
# 2) 修正测试断言后复跑新测试文件
node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none `
  tests/ui/luogu-metadata-view.test.ts
# tests 13 / pass 13 / fail 0，退出码 0
```

```powershell
# 3) 最终验证（改动后的最终代码状态）
npm run typecheck                                        # 退出码 0
node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none `
  tests/ui/luogu-metadata-view.test.ts tests/ui/luogu-view.test.ts tests/ui/luogu-sync-progress.test.ts
# tests 41 / pass 41 / fail 0，退出码 0（含先前已接受的 luogu-view 与 sync-progress 用例，未改动、未削弱）
```

## 契约条目对应

- **可发现性**：`luoguMetadataDisclosureLabel` 始终显示 `待补题目与手动处理（N）`（0 也显示）；
  `luoguMetadataPointer` 在 `metadataBacklog > 0` 时输出短句，其中 `stage: 'metadata'` 的失败明确写
  「上一轮在补齐题目资料时失败」，并明确「不使用 AI」「逐题重试或手工补充」；该短句**不**声称凭据过期。
- **按需分页**：面板仅在展开时挂载（父组件 `open={metadataOpen}` + 条件渲染），关闭即卸载 → 不发请求、草稿随组件销毁；
  页大小 20/25，首/上/下/末页 + 页码指示，越界页在**发请求前**用上次已知总数夹取；服务端对越界页返回空页时，
  界面显示「这一页已经没有待补题目了：正在回到有效的页码」而不是「积压为空」，并自动回到有效页。
- **每行内容**：`externalKey` 作为链接文本、`url` 经 `ExternalLink` 校验 http/https 后打开原题；
  已存标题优先显示；逐题原因显示时间 + 该题累计失败次数 + 翻译后的固定原因；无记录时使用服务端
  `unknownIssueLabel`（镜像常量 `尚无逐题失败记录`）并说明「可能是旧数据，也可能还没尝试过」。顺序保持服务端排序（已知问题在前），界面不重排。
- **计数区分**：`luoguMetadataCounts` 明确区分「当前待补 N 题（题目键数量）」「本页逐题原因 M 条」
  「历史累计失败尝试 K 次（是尝试次数，不是失败题目数）」。
- **原因翻译**：`missing_statement` 输出契约规定的原句；`html_response`/`invalid_json`/`invalid_payload`
  一律写明「具体原因不确定」，只给「打开原题 / 稍后重试 / 手工补充」，不含原始异常、样本或推断；
  无分类时也保持不确定。元数据失败文案不诱导重新连接或断言 Cookie 过期。
- **逐题重试**：只调用一次 `luogu.retryMetadata`（`{accountId, problemKey}`），按 `resolved`/`deferred`/`failed`
  如实说明，随后刷新待补列表与 `luogu.status`，`resolved` 时再刷新题库（`onChange`）；没有整队启动、自动重试循环、
  AI 调用或检查点改动。
- **门禁**：`luoguMetadataMutationReason` 在同步运行中、他实例持有租约、插件关闭、状态未读取或本地操作进行中时
  以固定可读句子禁用重试与补充；请求失败按 `conflict`/`invalid_input`/`cancelled`/`unauthorized`/其他映射为固定文案；
  面板可见期间出现新的宿主失败会通过 `luoguMetadataHostFailureLine` 反映。
- **手工补充**：每行一个按钮，同一时刻只挂载一个表单；无标题时才要求填写（已有标题只读且原值回传，绝不覆盖）；
  题面必须为真实非空内容；明确写明「仅补齐本地题目资料，不改变通过记录或自动确认标签」与「不使用 AI」；
  提交按钮显式触发，负载为 `{accountId, problemKey, title, statement, expectedSnapshotId}`（测试逐字段断言）；
  冲突时保留草稿并提示先刷新待补列表再提交，绝不盲目覆盖快照；草稿只在组件状态中，未使用 `localStorage`；
  卸载/切换账号/切换行会中止在途请求并丢弃状态，迟到响应被 `alive`/`AbortController` 丢弃；
  表单不含 JSON、Cookie 或会话字段。
- **开始提示**：`luoguStartNotice` 记录提交结果、点击时刻与两个持久基线；`luoguStartNoticeStep` 只在
  持久证据出现时清除提示——新的 `lastSuccessAt`（succeeded）、点击之后记录的失败（failed）、
  已观察到运行或 `scanStartedAt` 变化而当前空闲（ended）、账号切换与插件关闭；初始的旧空闲读取一律保持提示
  （不把旧状态当作请求结果）。提示独立渲染，不会覆盖其他操作的说明。
- **既有行为不变**：登录表单、自动化设置、历史覆盖、失败分环节文案与轮询规则未改动；账号切换清理异步状态、
  卸载中止请求；同步编辑统一经 `onChange` 触发刷新；仅使用类型化业务 API（`luogu.metadataBacklog` /
  `luogu.retryMetadata` / `luogu.supplementMetadata`），未直接访问平台 HTTP、SQL 或凭据。

## 未决问题与限制

1. **没有组件级渲染测试**：仓库测试加载器（`tests/loader.mjs`）只做 `.js → .ts` 映射，Node 不会转译 JSX，
   因此 `.tsx` 组件无法在 `node --test` 中执行（既有 `src/ui/markdown/*.ts` 用 `createElement` 正是为此）。
   本阶段把全部决策边界放进 `luogu-metadata-view.ts` 并用 13 个测试覆盖（原因翻译、旧数据、计数区分、分页夹取、
   重试结果区分、表单校验与请求负载、冲突保留草稿、门禁、开始提示折叠）；`LuoguMetadata.tsx` / `LuoguSync.tsx`
   由 `tsc` 保证类型正确，**浏览器中的展开/提交/冲突流程仍需协调者做一次真实界面验收**。
2. **文档链接使用官方手册入口页**：`docs/luogu-sync-recovery.md` 链接到仓库中已核对的
   <https://help.luogu.com.cn/manual/luogu/problem/>，而非臆造的「个人题目」深层 URL；如需精确到该小节，
   请协调者用一次真实网页核对后替换并保留说明。
3. **`metadataBacklog` 与 `failure` 的时序**：逐题 deferred 失败不会产生会话级 `failure`，因此指针句在「仅逐题失败」时
   走中性措辞（只报待补数量），逐题原因在列表内显示；这是前台可见的行为，若协调者希望卡片也提示逐题失败，
   需要后端在状态里暴露「存在逐题诊断」的计数（本阶段未改后端）。
4. **未做完整 gate/build**：按契约只运行 `npm run typecheck` 与三个聚焦测试文件；未运行打包、端到端或全量测试套件。
5. 面板在每次操作后刷新待补列表与状态（两次本机业务 API 调用）；这是为了不显示陈旧计数，未做请求合并优化。

## 非目标（已遵守）

未修改 `AGENTS.md`、`scripts/worker.mjs`、任务契约、预算记录、`D:/DeepSeek Harness`、`D:/C++/NovaPhy`；
未新增依赖、未改动 `package.json`/版本号/README；未提交或推送；未调用 `ctx.llm` 之外的付费 API；
未读取或写入任何凭据、私有数据、真实题面/题解或模型对话内容。
