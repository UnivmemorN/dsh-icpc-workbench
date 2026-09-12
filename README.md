# dsh ICPC Workbench

面向个人 ICPC 训练的 DeepSeek Harness 插件。独立工作区、独立 SQLite 数据库；基于题解证据补全标签，保留原始标签、人工决定和分析版本。

**0.1.0 实验版**已实现六页浏览器工作台、CF/洛谷/手工导入、持久化模型批次、逐级提示、人工审核、薄弱项与规则训练计划。已完成隔离宿主和浏览器流程验收；模型效果及已知限制见 [验收报告](docs/reports/stage-05-acceptance.md)。

## 构建和隔离安装

支持 **dsh 0.1.5-rc.2**，Node **22.19+（22 系列）或 24+**。不兼容版本会在创建数据目录前拒绝激活。公开宿主依赖采用精确版本，升级 dsh 后应先验证兼容性。

```powershell
npm ci
npm run check
npm pack
# 首次创建隔离的 Web 配置，保持日常配置独立
dsh --profile icpc-acceptance --from-default-profile web --help
dsh plugin --profile icpc-acceptance add ./dsh-icpc-workbench-0.1.0.tgz
```

插件不需要位于 harness 源码树中，构建也不依赖相邻的 harness checkout。默认数据目录为系统应用数据目录中的 `dsh-icpc-workbench`。如需自定义，在宿主的配置覆盖文件中设置绝对路径：

```yaml
- id: icpc-workbench
  config:
    dataDir: 'D:/ICPC-Training'
```

将上面的 YAML 保存为 `icpc.patch.yml` 后启动：

```powershell
dsh --profile icpc-acceptance --patch ./icpc.patch.yml --port 3081
```

在 dsh 侧栏点击 **ICPC 训练** 进入工作台，点击 **返回对话** 退出。依次在题库导入材料、选择题目并准备分析；核对调用上限后再启动。个人训练记录可按 [JSON/CSV 格式](docs/manual-import.md) 导入。

数据目录不能位于 dsh 安装目录或 dsh home 内。数据库升级前会备份；卸载插件保留训练数据。备份 API 只写插件自己的 `backups` 目录，返回本地路径。模型审计会话由 dsh 保存，训练数据由插件保存。

## 模型和训练规则

默认分析、复核、提示使用 `deepseek-official/deepseek-flash`，无题解推理使用 `deepseek-v4-pro`；强度 **max**，输出上限 65536。模型目录仅供参考，可保留自定义 ID；已知不支持文本/max 的模型会被拒绝，不会静默替换。

批次默认 20 题、50 次分析/复核调用、5 次推理调用，并发 2；重试计入额度，未知费用保留为未知。先准备并查看设置版本，再显式启动；版本变化需重新确认，重启不自动续跑。

自动标签必须引用实际题解片段并通过第二次复核。只有明确确认没有题解且存在完整题面，才允许进入大模型推理；鉴权、限流和网络错误不会触发该流程。尚未完成的题目默认隐藏标签、题解与提示正文，完整题解需要明确请求。

统计按不同题目计数，至少 5 题才排序薄弱点；AC 不代表掌握所有解法。训练计划只使用真实候选题，支持预览、采纳、编辑和手工完成记录。

## 平台边界

- Codeforces 公开 API：目录和提交历史；请求间隔至少 2 秒。HTML 题面/题解可能受到站点访问限制。
- 洛谷：公开题目目录和题面；匿名题解可能要求登录。当前不宣称已支持鉴权后的提交历史，使用手工导入补充。
- 手工 JSON/CSV 导入与题面/题解补充：预览后按内容哈希应用，失败不会被当作“没有题解”。
- HydroOJ 校内 OJ 与学生记录导入为未来计划，当前尚未实现。

30 道真实 CF 题解评测：27 道产生可采纳结果；按冻结标签定义复核的精确率 92.2%，参考方法召回率 62.9%。若严格按显示名称解释两处“前缀和”映射，精确率为 88.2%；因此当前按实验版提供，仍需人工检查关键标签。详见报告中的逐项裁定、冗余扣分和失败记录。P1001 三层提示及完整讲解已实测；两份原始生成 C++17 代码各通过 107 组本地用例，没有代用户提交 OJ。

本地测试与真实平台、模型效果及浏览器验收分别记录；模型复核不是独立专家审核。开发架构见 [architecture](docs/architecture.md)，交付标准见 [v1 contract](docs/handoffs/v1.md)。

## 许可证与引用

本项目采用 MIT。受 [ZF3373/icpc-workbench](https://github.com/ZF3373/icpc-workbench) 启发，参考提交 `781e9f1981dba2822617e2cd13e92d6516f11b23`；原项目 MIT 许可证已保留，当前实现未复制其源码。

架构参考 [NovaPhy](https://github.com/UnivmemorN/NovaPhy) 的数据所有权、可替换后端与契约验收设计。依赖和宿主许可证见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。这是独立社区项目。