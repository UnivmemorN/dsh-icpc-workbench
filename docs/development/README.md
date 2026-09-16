# 开发文档（贡献者索引）

本页是参与开发的入口：仓库与工作区边界、构建与检查命令、精确宿主基线、以及全部 26 份顶层技术参考的分组索引。**使用者请从[用户文档](../user/README.md)开始**；用户安装只需要本地 tgz 与 `dsh plugin` 命令，不需要这里的任何工具链。

## 仓库与工作区

```powershell
git clone https://github.com/UnivmemorN/dsh-icpc-workbench.git
cd dsh-icpc-workbench
```

- 公开仓库：<https://github.com/UnivmemorN/dsh-icpc-workbench>。
- **harness 工作区与本仓库分离**：插件在本仓库独立构建，不依赖相邻的 harness 源码 checkout；不要修改 D:/DeepSeek Harness 之类的只读参考树，也不要为了兼容去改 harness 源码。需要核对宿主行为时，读它、不要动它。
- 插件不依赖协调者的脚本（如 `scripts/worker.mjs`）；`plugin` 代码不得 import 它。
- 训练数据目录、dsh profile 与 harness 源码树三者互不写入。测试与本地开发请使用隔离 profile。

## 宿主基线与升级注意

- 测试基线：dsh **0.1.5-rc.2**，源码提交 `fb2c4b9e698e30edb738bca4cf0618587db7d203`（见 [architecture.md](../architecture.md)）。
- 公开宿主依赖使用**精确版本**（`package.json` 中的 peerDependencies 与 devDependencies）；变更基线时同步核对兼容检查与依赖声明。
- 升级 dsh 后必须重新验证：服务注入、注册释放、原生模型审计接口（`ctx.llm` / Session 日志）、浏览器注册协议，以及带认证的 API 载体。兼容性变化应通过适配本插件解决，而不是修改 harness。
- 不兼容的宿主版本或能力缺失应在激活前拒绝，而不是降级运行。

## 构建与检查

```powershell
npm ci
npm run check
npm pack
```

- `npm run check` 依次执行：`typecheck`、架构检查（`check:architecture`）、单元/行为测试、脚本测试（usage / worker-context / patch-balance-client）、构建与 `check-client`。它是提交前的完整门禁。
- 需要单独复现某个环节时，直接用 `package.json` 里对应的脚本，例如 `npm run check:architecture`。
- `npm pack` 产出的 tgz 是给使用者的安装物；把它安装进隔离 profile 的步骤属于**用户路径**，见[安装与首次启动](../user/installation.md)。开发者构建与用户安装不要混为一谈：前者需要 Node 工具链与测试，后者不需要。
- 保持检查自包含：不要削弱测试或跳过门禁来让任务通过；测试要覆盖外部可观察行为，包括取消、恢复、版本检查与失败路径。

## 安全与卫生

- **插件中不放任何凭据**：配置与设置没有 API key/token 字段；模型调用只经公开的 `ctx.llm` 与审计 Session。
- 凭据、会话、用户数据、下载的题面/题解、工件与日志都不进 Git。
- 脚本不得关闭 TLS 校验或暴露秘密；不要打开独立的未认证服务端，API 路由注册在宿主的 Connection Fetch 载体下。
- 架构方向（domain / application / adapters / ui / plugin）与「原始标签、AI 建议、人工决定必须可区分」等硬性约束见 [AGENTS.md](../../AGENTS.md) 与 [architecture.md](../architecture.md)。

## 顶层技术参考索引（26 份）

这些文档**保留原有地址**，混合了用户过程与实现细节，属于技术参考。使用者的任务路径以[用户文档](../user/README.md)为准。

### 架构与集成（4）

| 文档 | 内容 |
| --- | --- |
| [architecture.md](../architecture.md) | 运行时形态、依赖方向、显式流水线、存储与合并题库的架构边界 |
| [dsh-integration.md](../dsh-integration.md) | 宿主基线实测记录：Connection Fetch、`ctx.llm`、审计 Session、浏览器工厂协议、隔离 profile |
| [platform-observations.md](../platform-observations.md) | 平台端点的匿名观测结果与适配器边界选择（响应形状、限速、导入探测） |
| [guidance-plugins.md](../guidance-plugins.md) | 可装卸训练指导方法的注册接口 `icpc-guidance-v1`、安装/卸载与更新边界 |

### 模型与知识契约（7）

| 文档 | 内容 |
| --- | --- |
| [flash-only-policy.md](../flash-only-policy.md) | 统一 Flash + max 策略、旧配置迁移与拒绝越权模型 |
| [credential-boundary.md](../credential-boundary.md) | 模型调用通道、审计记录内容、上游诊断投影与用户禁止事项 |
| [completeness-review.md](../completeness-review.md) | 完整性检查的定义、第二次独立复核、重跑与缺失材料处理 |
| [tag-alignment.md](../tag-alignment.md) | 来源标签对照的词汇判定、规则顺序、关系与计数、粒度复核 |
| [user-provided-answers.md](../user-provided-answers.md) | 用户提供解析的保存语义、快照复用与模型可见性 |
| [knowledge-learning.md](../knowledge-learning.md) | 知识点视图、证据分层、OI Wiki 的角色与引用边界 |
| [knowledge-difficulty.md](../knowledge-difficulty.md) | 知识点证据的难度分档规则与稀疏处理 |

### 数据、导入与同步（8）

| 文档 | 内容 |
| --- | --- |
| [manual-import.md](../manual-import.md) | Manual interchange v1 的 JSON/CSV 字段、校验、哈希与适配器接口 |
| [luogu-sync.md](../luogu-sync.md) | 洛谷连接、同步语义、失败环节、凭据存放与生命周期 |
| [luogu-sync-recovery.md](../luogu-sync-recovery.md) | 待补题目逐题重试、手工补充与逐题原因分类；登录态题解读取的载荷结构与失败语义见 [Stage 33C 报告](../reports/stage-33c-luogu-editorial-read.md) |
| [luogu-tag-names.md](../luogu-tag-names.md) | 洛谷数字标签编号到平台名称的显示快照与显示规则 |
| [luogu-account-names.md](../luogu-account-names.md) | 洛谷公开昵称读取范围、UID 身份与界面出现位置 |
| [merged-bank.md](../merged-bank.md) | 跨站去重读模型、映射边界与通过状态归属；唯一的等价规则 `cfMirrorIdentity()` 与全部拒绝边界（也用于镜像题题解复用） |
| [problem-recycle-bin.md](../problem-recycle-bin.md) | 跳过与可恢复回收站的语义、存储与批量操作边界 |
| [completion-editing.md](../completion-editing.md) | 完成方式的单题/批量编辑、预览应用与保留规则 |

### UI 与兼容（2）

| 文档 | 内容 |
| --- | --- |
| [markdown-rendering.md](../markdown-rendering.md) | 本地 Markdown/Katex/洛谷指令渲染范围、安全边界与不支持清单 |
| [dsh-balance-setup.md](../dsh-balance-setup.md) | 可选余额插件的按 profile 安装、显示位置与兼容说明 |

### 评分与训练（5）

| 文档 | 内容 |
| --- | --- |
| [ability-history.md](../ability-history.md) | 全部/近 90 天/更早三期练习分布的口径 |
| [ability-calibration.md](../ability-calibration.md) | 个人自评校准、练习统计与「不用中位数推断水平」的修正 |
| [ability-scoring.md](../ability-scoring.md) | CF 官方当前/最高评分来源、虚拟参赛表现账本与数据边界 |
| [ai-training-plans.md](../ai-training-plans.md) | AI 训练计划的后端契约：准备、付费调用、结算真值表与新鲜度 |
| [ai-ability-assessment.md](../ai-ability-assessment.md) | 独立 AI 能力评估的准备、调用、证据摘要与报告边界 |

## 历史报告与交接（历史证据）

- [阶段报告目录](../reports/)与[交接目录](../handoffs/)（包括 [v1 合同](../handoffs/v1.md)） 记录**撰写当时**的实现、命令、检查与验收结论。
- 它们属于**历史证据**：只说明那一轮做了什么、当时验证到什么程度，**不承诺当前行为**，也不代表当前版本仍然如此。引用时请注明是历史记录，并以代码、当前检查与用户文档为准。
- 阶段报告中的“通过/失败”是当时门禁的结果；不要把它们当作当前版本的测试结论，也不要据此推断未验证的平台或模型行为。

早期真实题解评测与限制见 [Stage 05 验收](../reports/stage-05-acceptance.md)，后续修正按阶段报告追踪。

## 文档维护

用户操作放入 docs/user/；架构、接口、开发工具与验收记录从本页索引。新增用户指南须更新用户索引。安装包只携带用户手册与文档导航，开发资料保留在仓库；用户手册引用开发资料时使用完整 GitHub 链接。修改相对链接后检查仓库目标和安装包内容，避免用户安装后打不开文档。

## 相关

- [用户文档索引](../user/README.md)、[文档导航](../README.md)、[项目 README](../../README.md)
- [第三方说明](../../THIRD_PARTY_NOTICES.md)
