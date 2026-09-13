# 能力评分的来源与规则

从 0.1.11 起，“薄弱项 → 能力评估 → 同步 CF 评分”读取 CF 官方当前 rating、历史最高 rating 和全部 rated 比赛历史。同步只请求公开 user.info 和 user.rating，不调用模型。自动分的定义是 **CF 官方当前 rating**，原值展示，不取整、不混入练习中位数或历史最高分。它是比赛表现的一个指标，不声称覆盖全部个人能力。

## 为什么不照搬原工作台

复核 [ZF3373/icpc-workbench 的 ability.ts](https://github.com/ZF3373/icpc-workbench/blob/ac4a2e0920e07a9d5abde8cee54ac8aa8a3a5fa7/server/src/today/ability.ts) 和 [select.ts](https://github.com/ZF3373/icpc-workbench/blob/ac4a2e0920e07a9d5abde8cee54ac8aa8a3a5fa7/server/src/today/select.ts)：它用近 60 天 AC 难度中位数，样本不足时回退历史，同时允许用户修正并展示练习证据。中位数描述选题分布，大量基础题会降低它，因此本项目只借鉴来源分开和证据展示，不沿用它作为实力评分，也不沿用空样本 1200 的默认值。原项目 MIT 许可和作者引用保留；没有复制实现代码。

[CF 官方题目难度说明](https://codeforces.com/blog/entry/62865) 中的难度概率解释以比赛为前提。平时练习的最终 AC 缺少统一时间限制、完整尝试机会和独立完成信息，不能直接作为同一模型中的胜负。我们没有更换一个分位数、给最高 AC 减去常数，或将多个数字加权凑成期望分数。

也研究了 [AtCoder AHC v2 规则](https://atcoder.jp/posts/1381) 及其 [公式说明](https://img.atcoder.jp/file/AHC_rating_v2_en.pdf)。其对象是比赛 performance，包含权重和时间变化；本项目没有把单道题的 AC 难度冒充比赛 performance，因此没有移植该公式或常数。

## 选题参考与历史证据

- 用户主动保存的自评范围优先用于新 AI 计划，清晰标为 self_report；不会被同步覆盖。
- 没有自评或清除自评后，使用已同步的官方当前 rating 作为选题起点，来源 official_rating。相同上下限表示一个确切官方分值，不是只允许该难度的题；模型仍可安排巩固、同段与挑战题。
- 官方未评级或尚未同步，且没有自评时，水平保持未知，安排跨难度诊断。真正的零分或负分会按官网原值显示，与未评级不同。
- 官方历史最高分、参赛数和比赛明细单独展示。最近一场评分在 90 天前时标明历史记录较旧，不自行扣分，也不把最高分替换成当前分。
- 全部、近期、较早的练习分布仍供评估与训练参考；已知辅助完成单列，未知独立性不变成已确认掌握。CF、洛谷和其他平台的原生难度不相互换算。

## 数据边界

官方 API 来源：[user.info / user.rating](https://codeforces.com/apiHelp/methods#user.rating)、[User / RatingChange](https://codeforces.com/apiHelp/objects#RatingChange)。请求绑定当前存储账号和配置的 CF 源，复用每源至少两秒的限流器；只接受完整、身份匹配且相互一致的响应。网络或响应错误不会变成未评级；同步失败保留最近成功快照和时间，页面显示错误。若两个 API 恰好跨过评分更新而不一致，本次不写入，可再次同步。

schema v6 只增加 official_rating_snapshots，按账号追加版本并检查并发写入。旧库先备份再升级，原提交、复盘、题库、自评和计划保持不变。ability.syncRating 仅接受 accountId，客户端不能上传自称官方的分数或来源。

新计划保存无账号标识的 competition 摘要：当前分、最高分、参赛数、时效类别和版本，不发送 handle、比赛名称、逐场名次或时间戳。与原有练习统计、自评分别传递。评分快照改变会使旧准备失效，付费调用前再次验证；旧不可变准备不补写新字段。

当前没有独立校准的“仅凭自由练习预测 CF rating”算法，也没有自动评分的洛谷/牛客换算器。没有 CF 比赛分的选手仍可通过自评与诊断训练建立参考。
