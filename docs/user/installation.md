# 安装与首次启动

本页讲**使用者**怎么把插件装进一个隔离的 dsh profile、把训练数据放在独立目录，以及第一次打开工作台要做什么。日常使用只需要 dsh 命令与一个本地打包好的 `.tgz`，不需要编译插件源码或运行测试；从源码构建是另一条开发者路径。

## 前置条件

- 已经安装并能正常使用 dsh。测试基线是 **0.1.5-rc.2**。插件在激活时会校验宿主版本与能力，不兼容时会在创建数据目录之前拒绝激活并给出原因。
- 准备好插件的本地安装包，例如 `dsh-icpc-workbench-0.1.25.tgz`。本文按已有本地 tgz 说明安装；需要自行生成安装包时，请按开发文档从源码构建。请确认文件名与版本一致，并在升级时使用新的文件名（安装器可能缓存同一路径与版本的文件）。
- 系统与插件版本：
  - Node 声明为 `^22.19.0 || >=24.0.0`；运行环境需满足该版本要求。
  - **Windows**：洛谷本机会话连接可用，凭据保存在 Windows 凭据管理器。
  - **Linux 等没有受支持凭据后端的系统**：账号、题库、JSON/CSV 导入与 AI 功能仍可用，但「连接洛谷 / 检查登录 / 断开连接」会返回固定的不可用提示。

## 安装到隔离 profile

保持日常使用的 dsh 配置不受影响：为训练工作台单独创建一个 profile（下面以 `icpc-training` 为例）。

```powershell
# 1) 首次创建隔离 profile（只需一次）；它会继承默认 web 配置作为起点
dsh --profile icpc-training --from-default-profile web --help

# 2) 把本地 tgz 装进这个 profile
dsh plugin --profile icpc-training add .\dsh-icpc-workbench-0.1.25.tgz
```

- 把 tgz 路径换成真实路径；相对路径请确认当前目录正确。
- 插件**不需要**位于 harness 源码树中，构建与安装也不依赖相邻的 harness checkout。
- 不要在日常 profile 里试装插件来“先看看”；先在隔离 profile 验证，符合预期后再决定是否装入常用 profile。

## 配置独立的数据目录

默认数据目录是系统应用数据目录下的 `dsh-icpc-workbench`。建议显式指定独立的绝对路径。将以下内容保存为 `icpc.patch.yml`，并把示例路径改为你希望存放训练数据的位置：

```yaml
# icpc.patch.yml
- id: icpc-workbench
  config:
    dataDir: 'D:/ICPC-Training'
```

规则：

- `dataDir` 必须是**绝对路径**，且不能位于 dsh 安装目录或 dsh home 内；否则激活会被拒绝并说明原因。
- 训练数据库、备份和统计都在这个目录里；模型审计会话由 dsh 保存，不在这个目录。

## 启动

```powershell
dsh --profile icpc-training --patch .\icpc.patch.yml --port 3081
```

- 端口冲突时换一个端口号。
- 启动后打开 Web 界面，在侧栏点击 **ICPC 训练** 进入工作台，点击 **返回对话** 退出。工作台在自己的模式里接管主面板。
- 首次启动会创建数据目录与 SQLite 数据库。数据库升级前会自动生成可验证备份；旧版本插件会拒绝打开更新版本的数据库。

## 确认安装状态

进入「设置」页，可以在「本地数据」里核对：

- **数据目录**（你配置的绝对路径）、**宿主版本**、**数据库版本**；
- 「创建本地备份」会生成一个备份并返回本地路径（只写入插件自己的 `backups` 目录）。

「设置 → 模型角色」是只读的：提供方与模型由统一模型策略固定，不能在这里改成别的模型。

## 首次使用路径

1. **添加账号**：「账号与同步 → 添加账号」。Codeforces 填 Handle（用户名），洛谷填数字 UID；只保存公开标识，不需要密码。见[账号与同步](accounts-and-sync.md)。
2. **导入记录**：在「账号与同步 → 导入与同步」同步题目目录与所选账号的提交记录；洛谷可以另外连接本机会话做提交历史同步。没有连接时用[手工导入](manual-import.md)。
3. **选题与看材料**：在「题库」筛选题目、打开题面；缺少题面时先刷新平台材料或手工补充。见[题库](problem-bank.md)。
4. **审核标签**：在「标签审核」免费准备批次，核对将要发送的模型信息与调用上限，确认无误后再「确认开始付费分析」。见[标签与题解材料](tags-and-answers.md)。
5. **看结果与计划**：「薄弱项」查看知识点证据与能力评估；「训练计划」先免费准备，再显式生成。见[知识点与能力](knowledge-and-ability.md)与[训练计划与能力评估](training-and-assessment.md)。

## 自行构建安装包

若尚无 tgz，可按[开发文档](https://github.com/UnivmemorN/dsh-icpc-workbench/blob/main/docs/development/README.md)从源码构建，获得安装包后回到本页继续。

## 卸载与数据

```powershell
dsh plugin --profile icpc-training remove dsh-icpc-workbench
```

卸载**保留**训练数据：题库、提交记录、快照、复盘、统计、计划与报告都留在 `dataDir`。凭据的处理分两种：插件自身的洛谷登录凭据可以在界面上「断开连接」删除（只删凭据，不动已同步数据）；数据目录需要你自己决定是否清理。

## 相关

- [账号与同步](accounts-and-sync.md)
- [故障排查](troubleshooting.md)
- [隐私与费用](privacy-and-cost.md)
- [返回用户文档索引](README.md)
