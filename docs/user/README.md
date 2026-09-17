# 用户文档

这是给**使用者**的任务手册：只讲在 dsh 界面里做什么、会看到什么、结果意味着什么，以及哪些操作会调用模型。这里不涉及数据库结构、API、SQL 或测试。

当前版本 **0.1.26**（实验版），测试基线 dsh **0.1.5-rc.2**。部分能力（洛谷同步、AI 报告）仍在实验阶段，界面会用固定文案如实说明限制；遇到不符合预期的结果，请按[故障排查](troubleshooting.md)处理。

## 建议的阅读顺序

1. [安装与首次启动](installation.md)：把插件装进隔离的 dsh profile，设置独立数据目录并启动。
2. [账号与同步](accounts-and-sync.md)：添加 Codeforces / 洛谷账号，导入或同步做题记录。
3. [题库](problem-bank.md)：浏览题目、看题面、改完成方式、批量刷新平台材料、处理跳过与回收站。
4. [标签与题解材料](tags-and-answers.md)：查看证据、运行标签分析批次、按当前批次批量刷新平台材料、粘贴外部答案。
5. [知识点与能力](knowledge-and-ability.md)：读懂知识点证据、难度分层、CF 评分与自评。
6. [训练计划与能力评估](training-and-assessment.md)：生成训练计划与 AI 评估报告。
7. [隐私与费用](privacy-and-cost.md)：了解哪些操作会调用模型、凭据在哪里。
8. [故障排查](troubleshooting.md)：同步失败、缺少题面、报告过时等问题。

没有平台连接或需要补充材料时，看[手工导入](manual-import.md)。

## 全部用户文档

| 文档 | 回答的问题 |
| --- | --- |
| [安装与首次启动](installation.md) | 怎么装、装到哪里、数据放在哪、第一次打开做什么 |
| [账号与同步](accounts-and-sync.md) | CF Handle 与洛谷 UID 怎么填、Cookie 怎么给、同步到底做了什么、失败怎么办 |
| [题库](problem-bank.md) | 分平台题库与合并题库、筛选排序分页、每行/整页修改完成方式、批量刷新平台材料、跳过与回收站、题面渲染范围 |
| [手工导入](manual-import.md) | JSON/CSV 的完整格式、最小可用样例、常见字段错误 |
| [标签与题解材料](tags-and-answers.md) | 平台原始标签和已采用标签的区别、第二次独立复核、人工审核、按当前批次批量刷新平台材料、粘贴外部答案 |
| [知识点与能力](knowledge-and-ability.md) | 独立完成/提示/参考题解/未知、难度分档、历史三期、官方 CF 评分与自评、虚拟参赛表现、OI Wiki 与牛客的角色 |
| [训练计划与能力评估](training-and-assessment.md) | AI 计划的两步流程、免费与付费边界、方法插件、AI 评估报告怎么用 |
| [故障排查](troubleshooting.md) | 症状 → 操作对照表，以及恢复/跳过/回收站的完整流程 |
| [隐私与费用](privacy-and-cost.md) | 哪些操作调用模型、审计会记录什么、凭据和本地数据在哪里、费用怎么计 |

## 你需要知道的几条总原则

- **平台记录不等于掌握**：平台上的「已通过」是外部证据；是否独立完成、用了什么方法，要由你的复盘记录补充。
- **原始标签不等于已采用标签**：平台原始标签、AI 建议、人工决定和当前采用的标签始终分开显示。
- **模型调用永远是显式的**：查看、筛选、同步、导入预览和「免费准备」都不调用模型；只有你确认「开始付费分析」「生成 AI 计划」「生成 AI 评估报告」或请求提示时才会调用。
- **凭据分开管理**：插件里没有 API key 字段；洛谷会话保存在 Windows 凭据管理器里，永远不要粘贴到 AI 对话、聊天群或在线服务。
- **历史报告是快照**：计划与评估报告保存生成时的结果，数据变化后需要重新准备并生成。

## 开发者请走开发文档

构建、检查、打包、架构与实现细节不在用户文档内。开发入口见 [docs/development/README.md](https://github.com/UnivmemorN/dsh-icpc-workbench/blob/main/docs/development/README.md)；已有的技术参考（如[手工导入格式](https://github.com/UnivmemorN/dsh-icpc-workbench/blob/main/docs/manual-import.md)、[洛谷同步实现](https://github.com/UnivmemorN/dsh-icpc-workbench/blob/main/docs/luogu-sync.md)、[Markdown 渲染](https://github.com/UnivmemorN/dsh-icpc-workbench/blob/main/docs/markdown-rendering.md)）保留在 `docs/` 原地址。
