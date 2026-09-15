# dsh ICPC Workbench

面向个人 ICPC 训练的 DeepSeek Harness 插件：汇总 Codeforces、洛谷和手工做题记录，复核并补全知识点标签，查看薄弱项，生成兼顾思维与板子的训练计划及能力评估。

当前为 **0.1.25 实验版**。已测试宿主 **dsh 0.1.5-rc.2**，Node **22.19+（22 系列）或 24+**。插件源码、训练数据与 Harness 工作区分别管理。

## 文档

| 读者 | 入口 | 内容 |
| --- | --- | --- |
| 使用者 | **[用户文档](docs/user/README.md)** | 安装、账号同步、题库、标签审核、训练与评估、排错、费用 |
| 开发者 | **[开发文档](https://github.com/UnivmemorN/dsh-icpc-workbench/blob/main/docs/development/README.md)** | 源码构建、架构、接口、扩展方法、宿主兼容与历史验收 |

## 开始使用

1. 按[安装指南](docs/user/installation.md)将本地安装包放入独立的 dsh profile，并设置训练数据目录。
2. 在「账号与同步」添加 CF Handle 或洛谷数字 UID，导入或同步记录。见[账号与同步](docs/user/accounts-and-sync.md)。
3. 在[题库](docs/user/problem-bank.md)查看题目并补充完成方式，再进行[标签审核](docs/user/tags-and-answers.md)或[训练与评估](docs/user/training-and-assessment.md)。

日常安装使用已有的本地 tgz；从源码构建安装包的步骤见开发文档。遇到问题可查看[故障排查](docs/user/troubleshooting.md)。

## AI 与数据

所有模型任务均经 dsh 使用 **DSV4.1 Flash、max 强度**，不可用时会报错。模型凭据由 dsh 管理，插件没有 API key 配置项。同步、导入、本地统计和免费准备不调用模型；分析、提示、AI 计划和评估需要显式启动。发送给模型的材料与输出会留在本地审计记录中，详见[隐私与费用](docs/user/privacy-and-cost.md)。

当前跨站去重支持 CF 主站与洛谷 CF 镜像的明确题号对应；HydroOJ 在线接入和牛客记录导入尚未实现。标签仍需人工核对，虚拟参赛表现目前需要手工录入。

## 许可证与引用

本项目采用 [MIT](LICENSE)。功能受 [ZF3373/icpc-workbench](https://github.com/ZF3373/icpc-workbench) 启发，保留其 MIT 许可证，未复制其源码；架构参考 [NovaPhy](https://github.com/UnivmemorN/NovaPhy)。知识点学习入口参考 [OI Wiki](https://oi-wiki.org/)，分类与练习进度展示参考[牛客 ACM 知识点练习](https://ac.nowcoder.com/acm/skill/acm)。

来源、参考提交、依赖许可和内容使用边界见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。本项目为独立社区项目。
