# 可装卸的训练指导方法

工作台负责读取证据、模型调用、结果校验、用量和历史；方法插件负责提供教学指导。核心与方法包分别安装，插件工作区保持在独立仓库，运行时不读取 Harness 的源码目录。

## 随仓库提供的方法

- `dsh-icpc-method-balanced`：思维与板子综合训练。思维包括建模、推导、证明；板子包括算法知识、常用模式、实现和适用条件。两者互相支撑：知识不足会限制思路，推导能力不足也会妨碍算法应用。证据支持时优先补强当前阻碍下一阶段学习的方向，同时保留另一方向的练习；证据不足则安排诊断。
- `dsh-icpc-method-deliberate-practice`：可选的刻意练习循环。根据已有证据选择难度，独立尝试、按需求助、理解后重写、复盘。它是对 [USACO Guide Practicing](https://usaco.guide/general/practicing) 的简短原创改写；[OI Wiki 竞赛资源](https://oi-wiki.org/contest/) 作为学习资料入口。方法文本以中文简短改写与独立组织呈现，采用 CC BY-NC-SA 4.0；注册代码采用 MIT，详见方法包 NOTICE.md。

“思维与板子互相支撑、优先解除前置瓶颈”来自本项目用户的设计要求。工作台最初的功能参考 [ZF3373/icpc-workbench](https://github.com/ZF3373/icpc-workbench)，原作者与 MIT 许可见仓库 `THIRD_PARTY_NOTICES.md`。这些来源与当前实现的作者、许可分开保留。

## 安装与卸载

在本仓库根目录先分别打包：

```powershell
npm pack ./packages/dsh-icpc-method-balanced
npm pack ./packages/dsh-icpc-method-deliberate-practice
```

将核心工作台和需要的方法安装到同一个 dsh 配置。以下 `web` 可换成你实际使用的配置名，压缩包使用真实路径：

```powershell
dsh plugin --profile web add ./dsh-icpc-method-balanced-0.1.0.tgz
dsh plugin --profile web add ./dsh-icpc-method-deliberate-practice-0.1.0.tgz
```

在工作台刷新“指导方法插件”列表后选择使用的方法；最多同时选择 4 项。默认选择已安装的综合训练方法，用户主动取消后不自动替换。卸载可以使用：

```powershell
dsh plugin --profile web remove dsh-icpc-method-deliberate-practice
```

方法卸载或更新后，尚未执行的准备需要重新生成。历史计划保留当时的名称、版本、正文快照、哈希和来源。规则计划仍可使用。安装方法不会自动调用模型。

## 扩展接口与更新边界

伴随包导出 `name`、`inject: ['icpcGuidance']` 和 `apply(ctx)`；通过 `ctx.effect(() => ctx.icpcGuidance.register(registration))` 绑定注册生命周期。`cordis.patch.yml` 声明独立加载项，`package.json` 声明 `dsh.bundle.patch`。现有两个包可作为可运行示例。

注册结构采用 `icpc-guidance-v1`：稳定 methodId、独立的内容 version、显示名称与摘要、plan/assessment 能力声明、分节指导文本、训练步骤和来源链接。宿主校验大小、ID、链接与能力的一致性；注册返回仅移除自身贡献的释放函数。同 ID 重复注册会被拒绝。

此接口由工作台提供，故意限制为教学指导。当前测试的 Harness 也具有原生技能注册服务；这里选择独立的窄接口来隔离宿主迭代，不能据此声称 Harness 缺少技能机制。方法不得改变固定模型输出格式、配额、数据披露或防剧透规则。只有明确安装和选择的方法正文进入系统提示，做题数据作为独立任务材料传入。

宿主支持基线仍以 `docs/architecture.md` 的版本与提交为准。升级 dsh 后需重新验证服务注入、注册释放和原生模型审计接口；不修改 Harness 源码来维持兼容。
