# 文档导航

本仓库的文档分为两条路径：**使用插件**请走用户文档，**参与开发**请走开发文档。`docs/` 根目录下已有的技术参考文档保持原地址不变，其中不少页面同时包含用户操作与实现细节，因此作为技术参考而不是使用手册。

## 用户文档（使用插件）

入口：**[docs/user/README.md](user/README.md)**

用户文档是按任务组织的手册：从安装、账号与同步，到题库、标签、知识点、训练计划与故障排查。它只描述你在界面上做什么、会看到什么、以及哪些操作会调用模型，不要求你了解数据库结构或 API。用户文档随插件包一起提供，安装后也能在包内阅读。

| 任务 | 文档 |
| --- | --- |
| 安装到隔离 profile、配置数据目录、首次启动 | [安装与首次启动](user/installation.md) |
| 添加 CF/洛谷账号、导入与洛谷同步、失败恢复 | [账号与同步](user/accounts-and-sync.md) |
| 浏览/筛选题库、合并题库、完成方式与跳过回收站 | [题库](user/problem-bank.md) |
| 用 JSON/CSV 导入题目、提交与题解材料 | [手工导入](user/manual-import.md) |
| 查看题解证据、审核标签、粘贴外部答案 | [标签与题解材料](user/tags-and-answers.md) |
| 知识点证据、难度分层、CF 评分与自评 | [知识点与能力](user/knowledge-and-ability.md) |
| 生成训练计划与 AI 能力评估、安装指导方法 | [训练计划与能力评估](user/training-and-assessment.md) |
| 常见问题的症状与处理 | [故障排查](user/troubleshooting.md) |
| 哪些操作调用模型、凭据与费用边界 | [隐私与费用](user/privacy-and-cost.md) |

## 开发文档（参与开发）

入口：**[docs/development/README.md](https://github.com/UnivmemorN/dsh-icpc-workbench/blob/main/docs/development/README.md)**（GitHub）

开发文档给贡献者使用：仓库与 harness 工作区的边界、克隆与构建检查命令（`npm ci` / `npm run check` / `npm pack`）、精确宿主基线与升级注意、以及既有技术参考的分组索引。

> 用户安装与开发构建是两件不同的事：使用者只需要本地 tgz 与 `dsh plugin --profile <profile> add <tgz>`；`npm ci`、`npm run check`、`npm pack` 属于开发者在源码仓库中的构建路径，日常使用不需要运行它们。

## 现有技术参考与历史报告

- `docs/` 中原有的专题文档：混合了用户过程与实现细节的技术参考，**地址保持不变**，供排查与实现核对使用。每份文档的定位见[开发文档索引](https://github.com/UnivmemorN/dsh-icpc-workbench/blob/main/docs/development/README.md)。当技术参考与用户文档描述冲突时，用户任务路径以用户文档为准，实现事实以代码与检查为准。
- `docs/reports/*.md` 与 `docs/handoffs/v1.md`：撰写当时的实现说明、检查与验收记录，属于**历史证据**。阶段报告只描述那一轮做了什么、当时验证到什么程度，**不承诺当前行为**，也不代表当前版本仍然如此。

## 相关

- [项目 README](../README.md)
- [第三方说明](../THIRD_PARTY_NOTICES.md)
- [架构说明](https://github.com/UnivmemorN/dsh-icpc-workbench/blob/main/docs/architecture.md)
