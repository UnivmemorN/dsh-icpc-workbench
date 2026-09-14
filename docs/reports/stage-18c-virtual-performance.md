# Stage 18c — 虚拟参赛表现的来源化证据（后端切片）

范围：只实现 Sprint Contract `contract-18c.md` 的后端部分。UI（`src/ui`）按合同推迟到 18c2，本次未改动任何 UI 文件；契约、评审、Git 与预算由协调者负责。

## 交付内容

1. **域模型 `src/domain/virtual-performance.ts`（新增，纯规则）**
   - `VirtualPerformanceEvidence`：稳定 `evidenceId`、正整数 `contestId`、ISO `participatedAt`、有界有符号整数 `performance`（文档化边界 -1000..5000）、非空 ≤200 的 `calculationMethod`、http(s)、无凭据、≤2000 的 `sourceUrl`、`independent|assisted|unknown`、`priorExposure`、可选正整数 `rank`、可选 ≤1000 的本地 `note`。
   - `VirtualPerformanceLedger`：每账号一行，`source` 只能是服务端注入的 `user_import`，`revision` 单调，`entries` 按 `contestId`/`evidenceId` 去重、最多 200 行、按 `participatedAt` 降序规范化。
   - `virtualPerformancePlanningSummary(ledger | null, now)`：唯一面向模型/后续阶段的无标识摘要（合成 `evidenceRef`、分数、粗粒度时间档、方法标签、独立性、赛前曝光、计数、`estimation: 'not_estimated'`、固定披露文本）。已知辅助/赛前见过题的记录放在 `knownAssistedOrPriorExposed`，未知独立性放在 `unknownIndependence`，只有 independent 且无赛前曝光的记录进入 `eligible`。
   - `virtualPerformanceLedgerHash`：覆盖全部已存语义字段（含不下发的 `contestId`、`sourceUrl`、`note`、`rank`、精确时间），且与时钟无关。
   - `virtualPerformanceEvidenceIdentity`：计划证据哈希使用的无时钟投影（排除由准备时刻推导的时间档），保证"证据未变、时钟移动"不会改写证据哈希。
   - `validateVirtualPerformancePlanningSummary`：持久化摘要的封闭形状校验，也是隐私保证（没有字段能承载账号、比赛编号、备注、URL、名次或精确时间）。

2. **应用服务与存储端口**
   - `src/application/virtual-performance-service.ts`（新增）：`list` / `save` / `delete`，账号必须存在且属于 Codeforces 源；`save` 新增行或不带 `evidenceId` 拒绝重复 `contestId`，带 `evidenceId` 时在同一事务内做 CAS 替换；`delete` 即使删空也写入空 `entries` 并递增 revision（防 ABA）；`participatedAt` 不得晚于注入时钟；所有字段经域校验器后才写入。
   - `src/application/ports.ts`：`TrainingStore` 增加 `getVirtualPerformanceLedger` / `saveVirtualPerformanceLedger`（`expectedRevision` 0 表示尚无账本）。

3. **SQLite v8（additive）**
   - `src/adapters/sqlite/schema.ts`：`STORE_SCHEMA_VERSION = 8`；v7 识别分支与 `STORE_TABLES_V8`；`SCHEMA_DDL_V8` 新增 `virtual_performance_ledgers`（`account_id` 主键、`revision` CAS、`body`）与预留的 `ability_evaluation_attempts`（无访问方法，仅建表）；`migrateToSchemaV7` 冻结为字面量 7，新增 `migrateToSchemaV8` 结束于当前版本。
   - `src/adapters/sqlite/store.ts`：实现两个账本方法（写入前后 CAS 校验、读取时重新校验 body 并与身份列交叉核对，损坏行报 `corrupt_row`）；打开旧库时 v7 也先做一致性备份，再迁移到 v8；`capabilities()` 说明更新。

4. **类型化 API**
   - `src/application/workbench-api.ts`：`PERFORMANCE_API_OPERATIONS`、三个 `ApiEndpoint` 条目与请求/响应类型别名（类型来自已接受的服务 DTO，浏览器安全）。
   - `src/plugin/performance-api.ts`（新增）：`performance.list/save/delete` 三条精确 POST 路由，封闭请求形状（未知键 400）、文档化数值边界、无 `source` 字段（服务端注入）、无任何模型/平台调用；类型化拒绝经 `mapBusinessError` 映射为稳定 transport code。
   - `src/plugin/index.ts`：组装并注册该 API（激活仍不产生任何模型或平台调用）。

5. **计划准备与陈旧失效**
   - `PlanAttemptPreparation.virtualPerformance?`：新准备始终携带摘要（无账本时为显式空捕获）；历史行**没有该键**，因此保持原证据哈希不变（与 18b `guidanceSnapshot` 同一规则）。
   - `planPreparationEvidenceHash` 仅在字段存在时纳入其无时钟身份；`validatePlanAttempt` 对存在字段做结构校验。
   - `WorkbenchService.revalidatePlanInput` 用 `virtualPerformanceLedgerHash` 比较，账本被保存或删除后返回 `virtual_performance_changed`，付费调用前拒绝（测试证明没有 dispatch）。
   - `PlanGenerationRequest.virtualPerformance`：派发时携带同一份去标识摘要，并在 `planningGenerationProblem` 中重新做结构校验；本轮不改提示词、不做数值估计。

6. **测试与文档**
   - `tests/performance/virtual-performance.test.ts`（新增，10 例）：CRUD/CAS/去重/账号隔离/删空递增与 ABA、非法值/日期/URL、200 行与重复比赛、真实 v7 库备份+迁移+数据保留（且不再重复备份）、官方评分逐字节不变、摘要隐私与哈希时钟无关、计划保存/删除后的陈旧失效与历史准备保持有效、类型化 API 边界（未知键/越界/陈旧 revision/缺失账号/客户端中止 499/释放）。
   - 既有版本断言有意义地更新：`tests/storage/schema.test.ts`（v9 拒绝、新表清单与空表断言）、`tests/storage/luogu-sync.test.ts`（更新为"当前 schema"与 `STORE_SCHEMA_VERSION + 1`）、`tests/plugin/composition.test.ts`（路由数 53）。
   - `docs/ability-scoring.md`：新增"虚拟参赛表现（用户录入，非官方评分）"一节，直接引用 [RanklistRow](https://codeforces.com/apiHelp/objects#RanklistRow) 与 [Carrot](https://github.com/meooow25/carrot)（Carrot 把 performance 定义为使 rating 变化为 0 的 rating），说明为何 `calculationMethod` 必填；未复制任何公式或代码。

## 实际运行的命令

- `npm run typecheck` — 本切片完成时通过。随后并行 Stage-18b 工作流于 10:43 写入 `tests/model/plan-generator.test.ts`（+19 行），当前检查只剩该文件第 421/422 行的 2 个 `TS2532`（`GenerateOptions.system?: string` 上的 `state.dispatch[0]?.system.includes(...)`）。本切片 diff 中的任何文件都不在错误列表内；一行 `?.system?.includes` 的类型修正留给该文件的所有者，本次未越界修改。
- `npm run check:architecture` — 通过（层次边界满足）。
- 聚焦回归：`node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/performance/virtual-performance.test.ts tests/storage/schema.test.ts tests/storage/luogu-sync.test.ts tests/plugin/composition.test.ts tests/planning/service.test.ts tests/planning/guidance-service.test.ts tests/plugin/business-api.test.ts` — 105/105 通过。
- 追加复核（额外包含并行写入的 plan-generator 测试文件）：同一命令加 `tests/model/plan-generator.test.ts` — 113/113 通过。
- `npm test`（在并行写入之前运行）— 1011 项：1009 通过、0 失败、2 跳过（既有跳过项，与本次改动无关）。

## 明确的非目标与遗留

- **UI 全部推迟到 18c2**：录入/编辑/删除表单、官方分与"虚拟参赛表现（用户录入，非官方评分）"分区、账号切换取消或丢弃陈旧异步结果、空证据显示未知而非 0、来源链接 `target="_blank" rel="noreferrer"` 等，均未实现。
- **没有 JSON 导入**：合同说明该项可选；表单接口已提供完整 CRUD。
- **`ability_evaluation_attempts` 只是预留表**：无读写方法，18d 才实现，不是本版本的可用功能。
- **提示词未渲染摘要**：摘要已经随派发请求传递并逐字段校验，但 dsh 计划生成器的提示词文本留待后续阶段；本轮不做性能数值估计。
- **名次、备注、来源链接、比赛编号仅本地**：不下发模型；官方 rating 快照在 CRUD 前后逐字节一致（有测试）。
- **工作区并发改动**：`tests/model/plan-generator.test.ts` 在本切片完成之后由并行 Stage-18b 工作流修改（mtime 10:43，+19 行），因此当前 `npm run typecheck` 仅剩该文件的 2 个严格模式类型错误；该文件不属于本切片，未做修改。其余并行改动（`src/ui/*`、`src/domain/guidance.ts` 等 Stage-18b 文件）同样未被本切片触碰。
- 未改包版本、未执行 Git/安装/预算文件操作；未改动 `src/ui`。
