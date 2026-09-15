# 来源标签对照（source-aware raw-tag crosswalk）

> **开发参考** · [开发文档索引](development/README.md) · 日常操作请看[用户手册](user/README.md)。本文保留既有地址，供实现与排错核对。


状态：Sprint 32 已接通洛谷编号字典，并提供 CF 待核对标签入口；规则版本 `TAG_MAPPING_VERSION = 2026.09.15.1`（每次随统计报告一起返回）。

平台原始标签是**平台自己的说法**，不是本项目的知识分类。Codeforces 的 `dfs and similar`、`hashing`
是宽泛或含糊的英文标签；洛谷同时给出双语分类名和 `luogu-tag:<数字>` 平台标识；牛客把
`多项式算法(fft/ntt/fwt/idft)`、`筛法(线性筛/杜教筛/洲阁筛/min_25筛)` 这类组合标签当作一个选项；OI Wiki
是学习资料目录，不是解题证据。历史词表别名（`tarjan`、`倍增`、`状态压缩`、`hash` 等）只说明"这个词出现过"，
不构成平台等价声明，因此本模块不再整表回退。

本对照**只修正知识视图中"平台原始（未复核）"这一条试行渠道**的解析与诊断：冻结的 taxonomy v1/v2、快照、
AI/人工标签决定、复盘、正式弱点报告、训练计划与平台原生标签统计都不受影响。它不是官方跨平台等价表；
上游页面只用于确认词条存在，对照语义是本项目保守设计。

## 词汇（vocabulary）如何判断

只看来源实例 id 本身，形态为 `platform:host`，其中 host 必须与 `encodeIdPart` 写出的转义完全一致：

| 前缀 | 允许的主机 | vocabulary |
| --- | --- | --- |
| `codeforces:` | `codeforces.com` 及其子域 | `codeforces` |
| `luogu:` | `luogu.com.cn` 及其子域 | `luogu` |
| `nowcoder:` | `nowcoder.com` 及其子域 | `nowcoder` |
| `oi-wiki:` | `oi-wiki.org` 及其子域 | `oi-wiki` |
| `manual:` | 任意（本地来源） | `manual` |

其余情况一律 `unknown`：`hydro:*`、裸平台名（`codeforces`）、格式错误的转义（`codeforces:%zz`）、
已知前缀配任意主机（`codeforces:evil.example`）；调用方显式传入本模块不认识的 `vocabulary`
（例如 `hydro`）同样按 `unknown` 处理，不会被共享规则“洗白”。`unknown` **不会**根据标签语言或题面
URL 猜测平台，也不会借用其它平台的专属规则，并且**在共享拼写规则之前失败关闭**：除来源/年份/难度/
语言等来源信息仍识别为元数据外，其余标签一律 `unmapped`、零计数（见下面规则顺序第 2 步）。
`vocabulary` 与 `SourcePlatform` 是两个不同的概念：`nowcoder` 只是标签词汇与未来牛客 OJ 导入的预留；
`oi-wiki` 只是学习资料目录的标签词汇，本项目不会为 OI Wiki 提供导入适配器，也不会有 OI Wiki
账号或提交导入界面。

## 规则顺序

1. **来源专属规则**（最高优先级）：Codeforces 宽泛类别、洛谷双语分类名与数字标签标识、牛客组合标签。
2. **未知词汇失败关闭**：`unknown` 在此之前就返回；只有来源/年份/难度/语言等来源信息仍识别为
   `non_algorithm` 元数据，其余一律 `unmapped`、零目标、零候选，不进入下面任何共享规则。
3. **高风险共享拼写拦截**：`tarjan`、`缩点`、`hash`/`hashing`/`哈希`、`bit`、`bitmasks`、`rmq`、
   `倍增`、`subset sum`/`子集和`、`状态压缩`。
4. **粒度复核覆盖**：历史别名表里过窄或过宽的拼写不直接计数，只保留候选，或落到更宽的节点
   （详见下面“粒度复核”一节）；它与第 3 步一样先于白名单。
5. **共享安全拼写白名单**：人工复核过的直接同义拼写（`栈`/`stack`、`树状数组`、`线段树`、`拓扑排序`、
   `KMP`、`数位DP`、`前缀和`、`贪心`、`动态规划` 等），仍然通过**传入的** taxonomy index 解析；词表里没有
   该节点就是未匹配，不会凭空造节点。共享结果会带上词汇对应的平台术语页与该知识点的 OI Wiki 定义页，
   这些页面只证明词条存在，不构成官方跨平台等价声明。
6. **非算法来源信息**：source / event / year / difficulty / language / noise（与 `classify.ts` 完全相同的规则）。
7. **OI Wiki 未匹配标题**：一律 `reference`，只作资料。
8. 其余保持 **`unmapped`**，没有旧别名回退。

匹配键只做 NFC、小写和空白折叠：`A*` 不等于 `A`，`C++` 不等于 `C`，`树状数组/线段树` 不会被拆成两个
正向匹配。组合标签永远不会被拆开扇出。

## 关系（relation）与计数

| relation | 含义 | `targetIds` 计数 | `candidateIds` |
| --- | --- | --- | --- |
| `exact` | 与目录节点直接同义 | 是 | 通常为空 |
| `broader` | 平台宽泛类别（分类节点） | 是，且不向下推断任何子技巧 | 通常为空 |
| `narrower` | 只是某个组合大类中的单项 | 否 | 保留该大类，供人工核对 |
| `ambiguous` | 有多种可能含义 | 否 | 保留可能节点 |
| `composite` | 标签本身列出多种方法 | 否 | 保留最接近的大类 |
| `unmapped` | 保守对照表没有结论 | 否 | 通常为空 |
| `non_algorithm` | 来源/年份/难度/语言等元数据 | 否 | 空 |
| `reference` | 非官方洛谷实例的数字平台标识或 OI Wiki 资料条目 | 否 | 识别到的目录条目 |

只有 `exact` / `broader` 计入"平台原始（未复核）"题数；`unmapped`、`ambiguous`、`composite`、`narrower`
会汇总到 `unmatchedAlgorithmLabels`（每个受影响题目只计一次）；`non_algorithm` 与 `reference` 不属于算法缺口。

较早的**合并知识节点**（如"深度优先与广度优先搜索""单调栈与单调队列""树的直径与换根"
"卢卡斯定理与斯特林数""Lucas / Stirling""DP 优化"）仍然只概括粗粒度大类：其中单个成员会被标为
`narrower` 或 `composite`，不计数、不合并，也不能据此认为该大类的每一项都已掌握。词表不重命名、不拆分
这些冻结节点。

## 粒度复核（repair 1）

历史别名表把一些“单项拼写”直接指向合并节点，或把一般运算指向了特例节点。以下拼写不再计数，
只保留候选（`hungarian` 因名称歧义只保留可能候选）；合并节点本身仍按原样冻结：

| 拼写 | 结果 | 原因 |
| --- | --- | --- |
| `01背包`、`完全背包` | `narrower` → 背包 | 背包节点中的一种模型 |
| `带权并查集` | `narrower` → 并查集 | 并查集的一种变体 |
| `treap`、`splay`、`fhq treap` | `narrower` → 平衡树 | 平衡树的一种实现 |
| `主席树`、`chairman tree` | `narrower` → 可持久化数据结构 | 可持久化结构的一种实现 |
| `dijkstra`、`spfa`、`bellman ford`、`floyd` | `narrower` → 最短路 | 最短路的具体算法 |
| `bridge`、`cut vertex`、`割点`、`割边`、`articulation point` | `narrower` → 割边与割点 | 合并节点中的单项 |
| `dinic`、`isap` | `narrower` → 最大流 | 最大流的具体实现 |
| `kuhn` | `narrower` → 二分图匹配 | 二分图匹配的具体实现 |
| `hungarian`、`匈牙利算法` | `ambiguous` → 候选 二分图匹配 | 该名称也用于带权匹配（KM） |
| `blossom`、`带花树` | `narrower` → 一般图匹配 | 一般图匹配的具体算法 |
| `hall theorem`、`霍尔定理`、`konig`、`柯尼希定理` | `narrower` → 霍尔与柯尼希定理 | 两个不同的定理被合并为一个节点 |
| `gcd`、`exgcd`、`扩展欧几里得`、`bezout`、`裴蜀定理` | `narrower` → 最大公约数与扩展欧几里得 | 合并节点中的单项 |
| `sieve`、`素数筛`、`线性筛`、`埃氏筛`、`factorization`、`质因数分解` | `narrower` → 素数筛与质因数分解 | 合并节点中的单项 |
| `fft`、`ntt`、`卷积`、`convolution`、`快速傅里叶变换` | `narrower` → 快速傅里叶变换与卷积 | FFT 不是 NTT 的证据；合并节点中的单项 |
| `sg函数`、`nim`、`sprague grundy` | `narrower` → 博弈论 | 博弈论中的单项工具 |
| `概率dp` | `narrower` → 概率 | 概率节点中的一种方法 |
| `期望dp`、`linearity of expectation` | `narrower` → 期望 | 期望节点中的一种方法 |
| `叉积`、`cross product`、`点积` | `narrower` → 向量与叉积 | 向量运算节点中的单项 |
| `graham`、`andrew` | `narrower` → 凸包 | 凸包的具体实现 |
| `带修莫队` | `narrower` → 莫队 | 莫队的一种变体 |
| `monotonic stack`、`monotonic queue` | `narrower` → 单调栈与单调队列 | 此前遗漏的英文单项拼写 |
| `tree diameter` | `narrower` → 树的直径与换根 | 此前遗漏的英文单项拼写 |
| `A*`、`IDA*` | `narrower` → 启发式搜索 | 启发式搜索中的单项；匹配键保留 `*`，与单字母 `A` 无关 |
| `矩阵乘法` | `broader` → 线性代数分类 | 矩阵乘法不等于矩阵快速幂 |
| `费马小定理`、`fermat little theorem` | `broader` → 数论分类 | 费马小定理不等于求模逆元 |
| `binary exponentiation`、`fast power`、`快速幂` | `ambiguous` → 候选 快速幂 | 一般快速幂不限定模数 |

节点自身的通用拼写（`背包`、`并查集`、`平衡树`、`可持久化`、`最短路`、`最大流`、`二分图匹配`、
`一般图匹配`、`模逆元`、`矩阵快速幂`、`模幂`、`概率`、`期望`、`博弈论`、`凸包`、`莫队`、
`单调栈与单调队列`（组合标签）、`树的直径与换根`（组合标签）等）仍按 `exact`/`broader`/`composite`
处理，不受影响。

## 已实现 / 后续工作

已实现：

- Codeforces 宽泛标签映射到分类（`dp`、`data structures`、`graphs`、`trees`、`dfs and similar`、
  `probabilities`、`string suffix structures`）；`binary search` 保守落到搜索分类；`sortings` 落到排序；
  `hashing` 与 `bitmasks` 保持 `ambiguous`；未列出的 CF 标签保持 `unmapped`。
- 洛谷：官方实例的严格数字编号通过共享的 505 项公开字典解析名称，再走既有名称规则。例如 `luogu-tag:53`
  → 树状数组 → `data-structure.bit`；`luogu-tag:3` → 动态规划 DP → `dp` 分类，不推断子技巧。
  原始编号、来源和字典出处保留；同题的编号与名称不会重复累计知识点题数。字典未收录或名称没有对照规则时
  保持 `unmapped`；歧义与粒度限制仍保留。只接受官方 `luogu:luogu.com.cn` / `luogu:www.luogu.com.cn`
  实例，镜像、额外端口与显式指定词汇的其他来源不借用字典；畸形或非安全整数编号不计入知识点。
- 牛客：组合标签（多项式算法、筛法、`gcd(裴蜀定理)`、`概率期望`）保持 `composite`/`ambiguous`，`tarjan`
  与"强连通分量"分开，`树状数组` 等普通同义词照常解析。
- OI Wiki：即使标题被识别，也只返回 `reference`、零计数。
- 词汇：只有 `codeforces`/`luogu`/`nowcoder`/`oi-wiki`/`manual` 会启用共享拼写规则；`unknown`
  （含显式传入非法 `vocabulary`）在规则顺序第 2 步失败关闭，只有来源信息仍作元数据。
- 粒度：`dijkstra`/`fft`/`gcd`/`treap` 等单项拼写只作候选；`矩阵乘法` 落到线性代数分类、`费马小定理`
  落到数论分类；`快速幂`、`匈牙利算法` 因含义歧义保留候选。
- 参考链接：共享规则的结果会带词汇对应的平台术语页（若有）与目标节点的 OI Wiki 定义页；这些页面只
  证明词条存在，不代表官方跨平台等价。
- 诊断：报告包含 `tagMappingVersion` 与 `sourceTagMappings`，每行含来源实例、词汇、原始标签、关系、
  计数目标、候选、规则、中文说明、参考链接，以及去重后的尝试/通过题目数；同一标签来自不同来源时分行列出。

知识点页顶部显示「待核对来源标签（全部难度）」及「查看待核对标签」入口，打开既有对照表并清空冲突筛选。
CF 的 `divide and conquer`、`schedules` 等未映射标签保留原文和每标签去重的尝试/通过数，
`hashing`、`bitmasks` 保留歧义候选；不会阻断同题其他有效标签，也不会据此伪造知识点或掌握证据。
这里的标签行数不是题目总数，各行题数不能相加。

后续工作（不在本 Sprint）：

- 定期核对洛谷公开字典并独立审核新的名称对照规则；当前编号桥接已实现，但字典完整不代表知识点映射完整。
  规则与字典随版本发布，不改写平台原始标识、AI/人工标签决定或复盘。
- 牛客导入适配器与账号界面（未来 OJ 导入；当前只有词汇与标签解析）。OI Wiki 只是学习资料目录，
  不做导入适配器，也不会有 OI Wiki 账号或提交导入界面。
- taxonomy 版本迁移：新增节点是新的词表版本；重命名 id 必须显式迁移，不能靠本模块的对照表隐式改名。
- 各平台完整标签清单：当前是保守子集，未覆盖不等于不存在。

## 参考（只用于确认词条存在）

- Codeforces API 对象说明与标签页：<https://codeforces.com/apiHelp/objects#Problem>、
  <https://codeforces.com/problemset>
- 洛谷题单页标签与公开字典：<https://www.luogu.com.cn/problem/list>、<https://www.luogu.com.cn/_lfe/tags>
- 牛客 ACM 模式技能练习：<https://ac.nowcoder.com/acm/skill/acm>
- OI Wiki 及其定位说明：<https://oi-wiki.org/>、<https://oi-wiki.org/intro/what-oi-wiki-is-not/>

以上链接均为外部资料，本项目未复制其文章、代码或图片；引用与版权信息见 `THIRD_PARTY_NOTICES.md`。
