# Stage 10 — source-aware raw-tag alignment（worker report）

状态：实现与 repair 1 已完成；本文件记录实际运行过的命令与结果。

范围：按 Sprint 10 契约，把知识视图"平台原始（未复核）"渠道的解析从
`classifyRawTag(index, tag.raw)`（来源无关、整表别名回退）换成新增的、带版本号的
来源感知对照 `mapSourceTag`，并输出可见诊断；UI 增加可折叠的"来源标签对照"表。
未触碰：taxonomy v1/v2、快照、AI/人工标签决定、复盘、正式弱点报告、训练计划、平台原生标签统计、
平台适配器、数据库。未做 DB 迁移、未发 AI/网络请求、未新增适配器。

## repair 1（review 修复）

首次实现后因 40 请求上限中断于最终报告复核。协调者复核后的修复范围：未知/非法词汇在共享规则之前
失败关闭；把历史别名表中过窄/过宽的拼写移出计数白名单并加入显式覆盖（含此前遗漏的
monotonic stack / monotonic queue / tree diameter / `A*` / `IDA*` 单项拼写）；共享结果补充
平台术语页与 OI Wiki 定义页引用；来源标签对照表的参考链接改为简短标题 + 块状排版，来源下拉在刷新后
消失时回落到"全部来源 / 第 1 页"；修正洛谷字典与 OI Wiki 定位的公开说明；新增
`classifyRawTag` 历史行为回归用例。未改变 taxonomy v1/v2、`SourcePlatform`、适配器或数据库。

## 变更文件

新增：

- `src/domain/taxonomy/crosswalk.ts` — `TAG_MAPPING_VERSION = 2026.09.13.1`、词汇推断
  （`inferTagVocabulary`）、保守匹配键（`sourceTagKey`）、来源专属规则、高风险共享拼写拦截、
  共享安全拼写白名单、组合大类成员规则、`mapSourceTag`、`SourceTagMapping`、
  `isCountedTagRelation` / `isUnresolvedAlgorithmRelation`、`TAG_CROSSWALK_SAFE_SPELLINGS`。
- `tests/domain/tag-crosswalk.test.ts` — 初始 12 个用例（词汇推断、白名单自检、CF/Luogu/Nowcoder/OI Wiki、
  高风险拼写、组合大类成员、标点键、缺目标不回退、自定义小词表、冻结与确定性）；repair 1 后共 16 个。
- `docs/tag-alignment.md` — 公开说明：已实现规则、关系语义、后续字典/迁移/适配器边界。
- `docs/reports/stage-10-tag-alignment.md` — 本报告。

修改：

- `src/domain/taxonomy/classify.ts` — 仅新增导出 `nonAlgorithmTagReason(raw)`（包装原有私有规则）；
  `classifyRawTag` 行为不变。
- `src/domain/taxonomy/index.ts`、`src/domain/index.ts` — 导出 crosswalk 新符号与
  `SourceTagMappingDiagnostic` 类型。
- `src/domain/knowledge.ts` — 平台原始渠道改用 `mapSourceTag`（按 `tag.sourceInstanceId`）；
  报告新增 `tagMappingVersion`、`sourceTagMappings`（每行含解析器字段 + 去重后的
  `attemptedDistinct` / `solvedDistinct`，按来源实例 + 原始标签 + 关系 + 规则稳定排序）；
  `unmatchedAlgorithmLabels` 现在收纳 `ambiguous`/`composite`/`narrower`/`unmapped`，排除
  `non_algorithm`/`reference`；新增一条 note。合并/并集计数、账户隔离、向上传播、
  已验证/复盘渠道与正式报告逻辑未改。
- `src/ui/knowledge-view.ts` — 新增 `TAG_MAPPING_PAGE_SIZE`、关系/词汇中文标签、
  `KNOWLEDGE_TAG_MAPPING_NOTE`、`TAG_MAPPING_ISSUE_RELATIONS`、`isTagMappingIssue`、
  `sourceTagMappingKey`、过滤/分页（`TagMappingViewState`、`changeTagMappingFilter`、
  `moveTagMappingPage`、`selectSourceTagMappings`、`tagMappingPage`）、来源选项与目标/候选文案。
- `src/ui/Knowledge.tsx` — 新增可折叠"来源标签对照（试行）"：来源与关系筛选、只看待核对、
  重置筛选、有界分页（复用 `pagerDisplay`/`pageNumbers` 的编号分页）、每行显示
  词汇 + 实例、原始标签、关系、计数目标的中文名或"待核对 / 仅作资料 / 来源信息"、候选、
  去重题数、说明与参考链接；账号切换同时重置筛选与页码；无数据时不渲染表格。
- `tests/domain/knowledge.test.ts` — 新增 5 个用例（来源感知计数与诊断、按标签+题目去重、
  同文本不同来源分行、组合成员/平台标识为诚实缺口、空报告零映射）。
- `tests/ui/knowledge.test.ts` — 新增 3 个用例（筛选组合与不可变、分页与页重置、稳定标识与文案）；
  repair 1 后共 19 个。

repair 1 修改：

- `src/domain/taxonomy/crosswalk.ts` — 新增 `isTagVocabulary`、`SHARED_OVERRIDE_RULES`（粒度覆盖）、
  `SHARED_VOCABULARY_REFERENCES`、`attachSharedReferences`；`unknown`/非法 vocabulary 在规则顺序第 2 步
  失败关闭（仅来源信息仍作元数据）；高风险与粒度覆盖共用一次拦截；删除 CF 专属 `fft` 精确规则；
  安全白名单删除全部过窄/过宽拼写并补上合并节点的中文名 `模逆元`。
- `src/domain/taxonomy/index.ts`、`src/domain/index.ts` — 公开导出 `isTagVocabulary`。
- `src/ui/knowledge-view.ts` — 新增 `reconcileTagMappingSource`、`sourceTagMappingReferenceTitle`。
- `src/ui/Knowledge.tsx` — 来源实例在刷新后消失时回落到"全部来源 / 第 1 页"；参考链接改用简短标题
  的块状列表，不再显示完整 URL。
- `src/ui/styles.ts` — 新增 `.icpc-tag-mapping-refs` 排版规则。
- `tests/domain/tag-crosswalk.test.ts` — 新增未知/非法词汇失败关闭、粒度覆盖表、共享引用、
  `classifyRawTag` 历史回归；补充单项拼写用例。
- `tests/ui/knowledge.test.ts` — 新增来源回落与参考链接标题用例。
- `docs/tag-alignment.md`、`docs/knowledge-learning.md` — 未知处理、粒度复核表、洛谷字典与
  OI Wiki 定位修正；`README.md` — 同步严格未知处理与粒度说明；
  `docs/reports/stage-10-tag-alignment.md` — 本报告。

## 实际运行的命令（repair 1 实测）

```
npm run typecheck
npm run check:architecture
node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/domain/tag-crosswalk.test.ts tests/domain/knowledge.test.ts tests/workbench/knowledge.test.ts tests/ui/knowledge.test.ts
node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none "tests/domain/**/*.test.ts" "tests/ui/**/*.test.ts" "tests/workbench/**/*.test.ts"
```

结果：`npm run typecheck` 通过；`npm run check:architecture` 通过（输出 "Architecture imports satisfy
the declared layer boundaries."）；四个知识相关套件 55/55 通过（crosswalk 16、domain knowledge 15、
workbench knowledge 5、UI knowledge 19）；域/UI/工作台回归套件 226/226 通过，0 失败。
首次实现时受 40 请求上限影响，中断在最终报告复核；repair 1 未新增依赖、未发网络请求。
未运行 `npm run check`、build 与浏览器验收（契约要求留给协调者）。

## 已知限制 / 待协调者确认

- 平台标签清单是保守子集：未覆盖的标签保持 `unmapped` 或 `ambiguous`，不做完整四平台穷举。
- 洛谷适配器已能把平台字典抓取为原始标签（`luogu-tag:<id>` 数字标识与名称标签并存，既有导入的
  ID/名称原样保留）；本次只验证了它们作为彼此独立的原始标签被保留，尚未验证完整的
  id→名称→知识点交叉表，因此 `luogu-tag:<id>` 仍只保留为平台标识，不猜含义。
- 共享安全白名单按拼写逐个人工复核并通过传入 index 解析；自检用例保证每个白名单拼写在当前词表中
  都能落地，但词表新增节点时仍应复核该列表。
- `SourceTagMappingDiagnostic` 是实时报告的新增字段；前后端随同一插件包升级。旧版页面应在升级后刷新，当前 UI 不承诺读取缺少该字段的旧响应。
- `unknown` / 非法 `vocabulary` 在共享规则前失败关闭：这类来源的算法标签保持 `unmapped`（零候选、
  无参考链接），只有来源信息仍是元数据；这是有意为之，不是缺失映射。
- 共享结果附带词汇平台术语页与目标节点的 OI Wiki 定义页（`矩阵乘法`、`费马小定理` 另有定向定义页）；
  UI 以“平台标签说明 / 知识点参考”标题呈现，不再显示裸 URL。
- OI Wiki 只是学习资料目录（词汇 + 参考链接），不是 OJ：不做导入适配器，也不会有账号/提交导入界面；
  面向 OJ 的导入预留只针对牛客。两者当前都只有词汇与标签解析。
