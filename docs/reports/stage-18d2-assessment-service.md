# Stage 18d2 — 持久化评估服务（AssessmentService）

范围：只实现 Sprint Contract `.local/contract-18d2.md`。新增 `src/application/assessment-service.ts` 与聚焦生命周期测试 `tests/assessment/service.test.ts`，并写下本报告。未改动 18d1 的 capture/store/generator、`src/adapters/sqlite`、提示词、schema、域模型、UI 或 host 组装；`sourceHash` 全程按不透明身份使用。契约、评审、Git 与预算由协调者负责。

## 交付内容

1. **`src/application/assessment-service.ts`（新增，应用层用例）**
   - `prepare`（免费）：读取**已存储**的 workbench settings（缺失或非 Flash-only 一律 `settings` 拒绝，严格调用 `requireFlashOnlySettings`），经 `AssessmentDataPort.captureAssessmentInput` 采集，要求显式 **1..4 个互不重复**的评估方法 id（`MAX_ASSESSMENT_METHODS = MAX_GUIDANCE_SELECTION = 4`），并把设置 revision、provider、`roles.analysisModel`、`ASSESSMENT_PROMPT_VERSION`、`assessmentInputHash` 与整份 capture 冻结进 `prepared` 行。事务内二次读取 request id：并发双 prepare 的败者回放胜者行而不是冲突。不调用模型、不计数。
   - 幂等与冲突：同一 requestId 回放返回原始行（含已终态行），即使设置已变也不重新采集；同 id 换账号或换方法选择抛 `conflict`，消息不含对方账号/方法内容。`status` 对不存在或**他人账号**的 requestId 一律返回 `null`；`run`/`cancel` 返回 `not_found`。
   - `run`（付费，立即返回）：校验账号后先重采集同一方法选择，比较**不透明 `sourceHash`**（不再比较新鲜时刻推导的 `evidenceHash`，付费提示词始终取冻结 capture），并比较设置 revision/provider/model；方法缺失/被替换、证据变化 → `stale`，设置变化 → `settings`，均不花费。随后进入**唯一**的预约事务：恢复过期 reserved → 幂等去重 → 设置再次核对 → 全局单飞（同时最多 1 个 reserved/live）→ 滚动 24h 配额（`coaching.maxCallsPer24Hours`，计数本服务自己的 `reserved|settled|uncertain` 行）→ 写入带真实 `requestedAt`/`expiresAt` 的 charged `reserved` 行；因此 `busy`/`quota` 也在花费前拒绝，并发重试不会重复派发。
   - 自有 dispatch：预约提交后才启动被服务持有的异步操作并立刻返回 `{ started, attempt }`；服务持有 model promise 与 `CancellationSource`（`startDispatch`/`jobs`），直到终态落库。`run` 的调用方 token 只约束准入（预约事务内 `throwIfCancelled` 会整体回滚），预约提交后 HTTP 断连不会丢失已付费任务。
   - 结算：结算事务重读该行，非 `reserved` 一律不重写（恢复已把它标为 `uncertain` 时，迟到的答案不会覆盖终态）。写报告前再次重证设置 revision/Flash 与 `sourceHash`；陈旧或结构非法的答案被拒绝但**保留 provider 已报用量**（`provider_error`/`invalid_output`）。`usage` 缺失（含 ok 但无 usage、generator 抛异常）→ `uncertain`，绝不伪造 0。取消语义：`prepared` → 已知零用量 `cancelled`（不计配额）；`reserved` → 只触发其 cancellation source，由模型结算记录已报用量或 `uncertain`；重复 cancel 幂等。
   - 结算写失败：事务回滚，durable 行保持 charged `reserved`；服务记录**脱敏**失败（固定文案）并暴露到 `AssessmentAttemptView.settlementFailure` 与 `close()` 报告；绝不重派发、绝不标记成功。
   - `close`：停止准入（`prepare`/`run`/`cancel`/`recoverExpiredReservations` 抛 `closing`），取消全部自有调用，`Promise.allSettled` 等待所有 promise 落库后返回 `{ failures }`，重复调用返回同一报告；只读 `status`/`history` 仍可用，存储由调用方在 close 之后关闭。
   - `history`：按账号、可选状态、`order: 'desc'`、最多 20 条、直接透传 store 的 `nextCursor`；返回安全视图（报告为已校验的 `AssessmentReportRecord`，错误只有 `{ code, retryable }`）。`config` 返回免费 UI 预览所需的模型/预算/配额/上限与固定披露文本。
   - 类型化本地错误：`AssessmentServiceError` 固定 code `invalid_request | not_found | conflict | stale | settings | quota | busy | closing`；预约前的取消继续抛域 `cancelled`。视图携带内部 `attempt`（供下一阶段插件投影），但错误文案从不进入 UI 投影。

2. **`tests/assessment/service.test.ts`（新增，8 例，真实 SQLite + 脚本化 capture/generator）**
   - prepare 免费且幂等回放；换方法/换账号 `conflict` 不泄露；空/重复/5 个/超长 requestId 与方法缺失的拒绝；`config` 与 store 计数一致。
   - `run` 并发双调用只预约/派发 1 次（generator 边界观察），第二个 prepared 尝试 `busy`，随后配额 `quota`，终态重跑 `started:false` 不再派发。
   - 方法被替换/卸载、证据变化（新增 AC + 官方分刷新）、设置保存后的 `stale`/`settings` 拒绝，均 0 dispatch、0 charged 行、prepared 行保持。
   - in-flight 证据/设置/方法变化与结构非法答案：4 例全部 `<status settled, report null, usage=USAGE>`（`provider_error`/`invalid_output`）。
   - 取消 before dispatch（已知零、幂等、不计配额）与 after dispatch（已知用量 → settled；未知用量 → uncertain，charged 保留）；他人 requestId `not_found`。
   - 过期 reserved 恢复为 `uncertain` 且配额不退还；孤儿调用迟到返回也不改写终态行。
   - history 账号隔离、`limit`/cursor 分页、卸载方法后仍返回原报告与冻结选择。
   - close 排空自有调用并停止准入；注入结算写失败时行保持 charged `reserved`、`settlementFailure` 可观测、`close().failures` 报告该 requestId、绝不重派发。

## 下一阶段集成 API（精确签名）

```ts
type AssessmentServiceStore = AssessmentStore & SettingsStore & TrainingStore;

export interface AssessmentServiceOptions {
  readonly store: AssessmentServiceStore;      // SqliteTrainingStore 同时实现三者
  readonly capture: AssessmentDataPort;         // WorkbenchService.captureAssessmentInput
  readonly generator: AssessmentGenerator;      // adapters/dsh/assessment-generator
  readonly now: () => string;
}

class AssessmentService {
  constructor(options: AssessmentServiceOptions);
  prepare(request: { requestId: string; accountId: string; methodIds: readonly string[] }, token: CancellationToken): Promise<AssessmentAttemptView>;
  run(request: { requestId: string; accountId: string }, token: CancellationToken): Promise<{ started: boolean; attempt: AssessmentAttemptView }>;
  status(request: { requestId: string; accountId: string }, token: CancellationToken): Promise<AssessmentAttemptView | null>;
  cancel(request: { requestId: string; accountId: string }, token: CancellationToken): Promise<AssessmentAttemptView>;
  history(request: { accountId: string; status?: AssessmentAttemptStatus | null; limit?: number; cursor?: string | null }, token: CancellationToken): Promise<AssessmentHistoryResult>;
  recoverExpiredReservations(token: CancellationToken): Promise<readonly AssessmentAttemptView[]>;
  config(token: CancellationToken): Promise<AssessmentConfigView>;
  close(): Promise<AssessmentCloseReport>;
}
```

组装与生命周期示例（API/host 阶段可直接照此写）：

```ts
const assessments = new AssessmentService({
  store,                       // SqliteTrainingStore
  capture: workbench,          // captureAssessmentInput(request, token)
  generator: assessmentGenerator,
  now: () => new Date().toISOString(),
});

await assessments.recoverExpiredReservations(token);            // 启动时先恢复重启遗留的 reserved
const config = await assessments.config(token);                 // 免费 UI 预览：模型、预算、配额、披露

const prepared = await assessments.prepare(                     // 免费；1..4 个已安装方法 id
  { requestId, accountId, methodIds: ['balanced-dual-axis'] },
  token,
);
const { started, attempt } = await assessments.run({ requestId, accountId }, token);
// started === true 时调用立即返回；轮询 status 直到 settled/uncertain/cancelled
const view = await assessments.status({ requestId, accountId }, token);
// UI 只投影 view.report / view.usage / view.error {code,retryable} / view.methodIds / view.status
// 不要渲染 view.attempt.error.message（内部审计；`view.attempt` 仅供插件下一阶段投影）

await assessments.cancel({ requestId, accountId }, token);      // prepared：免费取消；reserved：触发自有调用取消
await shutdown();                                               // 停模型/平台等
await assessments.close();                                      // 排空自有结算
await store.close();                                            // 之后才关闭存储
```

## 实际运行的命令

- `npm run typecheck` — 通过（`src/**` + `tests/**`，严格模式无错误）。
- `npm run check:architecture` — 通过（新文件只依赖 domain/application）。
- `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/assessment/service.test.ts` — 8/8 通过（约 0.6s）。
- 调试期间：`--test-name-pattern="in-flight"` 定位到一处**测试**顺序问题（方法卸载后在飞结算尚未落库就重新安装），已改为等待该终态后再重装；另用 `node --input-type=module -e` 直接比较变更前后的 `sourceHash/evidenceHash`，确认证据变化确实改变哈希。
- 按契约未重复跑全量测试；未做 Git/安装/预算/模型调用。

## 明确的非目标与遗留

- **无 API/UI/host 组装**：`workbench-api`、`plugin/*`、`src/ui` 均未改动；`AssessmentAttemptView.attempt` 的插件投影、路由与渲染留给下一阶段。
- **不改 18d1 基础**：capture/generator/domain/schema/store 未动；`sourceHash` 始终按不透明值使用，未新增校验器或表。
- **无官方评分写入**、不改提示词、不做数值换算；报告仍由 `createAssessmentReportRecord` 绑定冻结 capture 的 `evidenceHash`/anchor。
- **`settlementFailure` 只是进程内标记**：重启后该行仍是 charged `reserved`，由 `recoverExpiredReservations` 在过期后转为 `uncertain`（保留配额），因此下一阶段必须在启动时调用恢复接口。
- **prepare 需要已存储设置**：组合层必须先保存 workbench settings；缺失时抛 `settings`，不会用默认值静默代替。
- **store 类型是联合端口**：`transaction` 定义在 `TrainingStore` 上，故 `AssessmentServiceStore = AssessmentStore & SettingsStore & TrainingStore`（与 `CoachingServiceStore` 同一取舍）。
- `docs/reports/stage-18d2-assessment-service.md` 未加入 `package.json` 的 `files` 列表（发布清单维护超出本切片范围）。
