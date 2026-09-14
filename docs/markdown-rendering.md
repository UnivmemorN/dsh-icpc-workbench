# 本地 Markdown 渲染（含洛谷扩展语法）

> **开发参考** · [开发文档索引](development/README.md) · 日常操作请看[用户手册](user/README.md)。本文保留既有地址，供实现与排错核对。


本文档描述本插件在客户端本地渲染已存题面、题解与 AI 文本的实现范围、语法、入口与明确不支持的行为。
实现是**独立实现**：只参考官方公开语法规则，没有复制官方文档的正文、示例、截图或任何题面/题解数据。

- 官方语法参考：[洛谷 Markdown 手册](https://help.luogu.com.cn/rules/academic/handbook/markdown)（核对日期 2026-09-14）。
- 测试入口：`tests/ui/markdown-luogu.test.ts`（真实 `renderToStaticMarkup`，合成样例）。
- 运行方式：`node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none tests/ui/markdown-luogu.test.ts`

## 使用方式

在「题库」打开一道题，展开题面即可查看排版结果。保存的题解与读取到的 AI 提示正文也使用同一渲染器。点击伸缩栏标题展开或收起，代码块右上角可以复制，底部「查看原文」保留原始 Markdown。查看已有内容不消耗 AI 额度。

## 1. 入口与文件职责

| 文件 | 职责 |
| --- | --- |
| `src/ui/MarkdownView.tsx` | 公开入口，仅做再导出；导入方读作 `./MarkdownView.js` |
| `src/ui/markdown/view.ts` | 组件树（`createElement`，无 JSX，便于 strip-types 测试）、`查看原文`、代码块与行号、图片/视频链接边界 |
| `src/ui/markdown/plugins.ts` | 唯一插件注册点：GFM、数学、`remark-directive`、洛谷指令变换、表格合并 |
| `src/ui/markdown/extensions.ts` | 指令白名单变换（mdast）与 `^`/`<` 表格合并（hast） |
| `src/ui/markdown/luogu-samples.ts` | 仅用于显示的旧格式样例适配器 |
| `src/ui/markdown/literal-fence.ts` | 自适应字面量围栏（围栏长于内容中最长的反引号串） |
| `src/ui/markdown/highlight.ts` | highlight.js 语言子集，输出 React span，从不输出 HTML 字符串 |
| `src/ui/markdown/url-policy.ts` | 链接/图片目标校验（仅 http/https，另允许 mailto 与同文档锚点） |
| `tests/ui/markdown-luogu.test.ts` | 24b 行为测试（真实渲染管线） |

React 组件调用形式：

```tsx
<MarkdownView text={problem.statement} baseUrl={problem.url} label="题面" source="luogu" />
```

- `source` 只在 `Problem` 中按 `boot.sources` 里该题自身来源实例的 `platform === 'luogu'` 传入；题解、Coaching 与其它平台文本永不使用旧样例适配器。
- `查看原文` 始终展示**未修改的原始字符串**，`source` 只影响显示形态，不影响存储。

## 2. 安全与本地性

- 渲染过程**不调用 AI、不访问存储、不发起任何网络请求**；KaTeX 字体在构建期离线内联。
- **不启用 raw HTML**（无 `rehype-raw`、无 MDX）：`<details>`、`<img …>` 等原样作为文本显示，原始文本仍在 `查看原文` 中。
- 指令属性**从不转发**到 DOM：只读取 `open`（折叠）与 `tuack`（cute-table）两个白名单属性的**存在性**，取值忽略；`id`/`class`/`style`/`on*` 不会出现在输出里。
- 链接与图片只接受 http/https（链接另允许 `mailto:` 与同文档锚点），相对地址按调用方给出的 `baseUrl` 解析，绝不使用 `window.location`；被阻止的目标保留可见文字。
- 数学使用 KaTeX `trust: false`，无效公式保留原表达式。
- 工作有界：指令嵌套 12 层、单次渲染 20000 节点、单表 200 行 / 2000 单元格、行号与范围高亮最多 5000 行、整段渲染上限 250000 字符；超界部分保持原样而不是被部分改写。

## 3. 已实现语法

### 3.1 折叠块（details/summary）

```
:::info[标题]{open}
正文，支持列表、数学、代码与嵌套折叠
:::
```

- 类型：`info` / `success` / `warning` / `error`（无标题时默认标题为 提示 / 成功 / 注意 / 错误）。
- 标题支持行内 Markdown 与行内数学 `$…$`。
- 只有 `open` **存在**时默认展开；`open=false` 之类取值不改变行为（只判存在）。
- 输出是语义化的 `<details class="icpc-md-fold icpc-md-fold-<kind>">` + `<summary>`，样式类固定且限定作用域。
- 嵌套使用更长的冒号串（外层 `::::info`，内层 `:::warning`）。
- 已知限制：`remark-directive` 会把**未闭合**的容器指令解析为“直到文档结尾的容器”，因此未闭合的 `:::info` 会渲染成一个把后续内容全部包含进来的折叠块；内容不会丢失，但不会保留字面 `:::` 标记。

### 3.2 对齐

```
:::align{center}
居中内容
:::
```

- 只认 `center` 与 `right` 两个关键字；没有任意 CSS 值通道。
- `{justify}`、`{center right}` 等写法不生效，此时按未知指令处理：显示字面标记与完整正文。

### 3.3 题记（epigraph）

```
:::epigraph[作者]
引用正文
:::
```

- 输出 `<blockquote class="icpc-md-epigraph">`，作者以可见的 `<footer class="icpc-md-epigraph-author">` 呈现。
- 无作者时显示“未署名”，不编造作者。

### 3.4 cute-table

```
::cute-table{tuack}

| 列A | 列B |
| --- | --- |
| 1 | 2 |
```

- 仅当 `tuack` 属性存在**且**紧跟其后的节点确实是表格时才被消费，并给表格套上固定类 `icpc-md-cute-table`。
- 未附着表格（或缺少 `tuack`）时不消费：字面 `::cute-table{tuack}` 与正文照常显示。

### 3.5 表格合并标记

在 GFM 表格中，**唯一未转义、未格式化**内容为 `^` 的单元格向上合并，为 `<` 的单元格向左合并，结果显示为起始单元格的 `rowspan`/`colspan`。

- 只在 AST/hast 层处理，不做 HTML 字符串改写；起始单元格以外的内容（数学、对齐、行内代码）原样保留。
- 使用“起始格网格”算法：任一单元格最多归属一个矩形，不会产生重叠。
- 表头（`<thead>`，即源文本第 1 行）与 `<tbody>` 不跨区合并：`^` 出现在第一个正文行时不合并，第 1 行或第 1 列的标记保持可见。
- 矩形必须完整填充才会生长，因此 L 形等非矩形写法回退为可见标记。
- `\^`（转义）、`` `^` ``（行内代码）、`^^`、`^ x` 等都不是标记，保持字面内容。
- 普通无标记表格输出与之前完全一致。

### 3.6 代码围栏 meta

````
```cpp line-numbers lines=2-4
代码…
```
````

- `line-numbers`：显示行号；行号位于 `<code>` **之外**的 `aria-hidden` 装订线中，复制按钮复制的仍是精确代码文本。
- `lines=2-4`（含 `lines=3` 单行）：仅高亮该闭区间；跨行的高亮 span 会在换行处重新打开。
- 两者可任意组合、顺序无关；`lines=9-2`、`lines=0-2`、超出实际行数的范围、`line-numbers=10` 等一律忽略，代码文本不受影响。
- 语言缺省而 meta 位于 info 首词（如 ```` ```line-numbers ````）时，首词被识别为 meta 而不是语言名。
- 超过 5000 行的代码不显示行号/范围（纯表现层上限），代码本身仍完整渲染。

### 3.7 Bilibili 视频链接

`![说明](https://www.bilibili.com/video/BV…)` 这类**可识别的视频/播放器页面**图片链接，会渲染成安全的外链按钮“打开视频：…”，而不是尝试当图片加载。

明确边界：**不嵌入** iframe/播放器，不加脚本，不自动播放，不向 B 站发起任何请求；点击只在新标签页打开原页面。仅识别 `bilibili.com` / `www.bilibili.com` / `m.bilibili.com` 的 `/video/BV…`、`/video/av…` 与 `player.bilibili.com/player.html?bvid=…|aid=…`；短链、空间页、仿冒域名仍按普通图片处理。

### 3.8 未知与不支持的指令

- 未知容器/叶子指令（如 `:::mystery[标题]`）将完整源文本（含嵌套标记）作为代码块保留，包在 `icpc-md-unknown-directive` 中，不会消失。
- 行内指令（`:name[label]{attrs}`）一律还原为**精确原文文本**，既不会消失也不会泄漏属性。
- 超出嵌套层数上限的指令退回字面源文本；原文入口始终保留。

## 4. 洛谷样例空白兼容

老版本构建器把样例写成裸 Markdown（`## 样例 #N` + `输入:` + 原文 + `输出:` + 原文），直接按 Markdown 渲染会吞掉空行、把样例数据当成数学或 HTML。处理分两条路径：

1. **新抓取**：`buildLuoguStatement`（`src/adapters/luogu/parsers.ts`）用自适应字面量围栏写出样例，围栏严格长于内容中最长的反引号串，因此 `$`、HTML 样文本、标题样文本、围栏样文本、空行与行尾空白都原样保留。**已存题面与快照哈希不做迁移或改写**；下次显式刷新自然生成新快照。
2. **已存旧文本**：`src/ui/markdown/luogu-samples.ts` 是**仅显示**的适配器，只在 `source === 'luogu'` 时启用，只重写 `## 样例 #N` 段落，题面正文与提示仍是 Markdown；原始文本始终在 `查看原文` 中。

旧文本适配器的保守规则（任一条命中即回退）：

- 回退为**一个字面围栏块**，内含该样例段落的完整原文（包含 `输入:`/`输出:` 标记与数据），绝不猜测、丢弃或重新解释样例内容：
  1. `输入:` 之前有非空内容，或缺少/顺序错误的 `输入:`/`输出:`；
  2. 段落内出现第二个精确的 `输入:` 或 `输出:` 行；
  3. 段落内出现以 `## ` 开头的标题行；
  4. 输入/输出只有一侧已是围栏；
  5. 旧式（未围栏）样例正文中出现代码围栏行。
- 已是新格式（两侧都是完整的 text 围栏）时跳过，不改写；围栏内的标题、输入输出标记只是样例数据。
- 如果遇到下一节标题时仍未找到完整的输入输出标记，将剩余样例尾部整体显示为字面文本。旧格式无法区分“输出之后恰好同名的样例数据标题”和真正的提示节；已完整的样例仍以原构建器章节标题为边界，遇到疑问可查看原文。
- Markdown 解析会将 CRLF 换行规范化为 LF；复制保留内容、空格与换行结构，逐字节原文仍可在原文入口查看。
- 真实代码围栏内的 `## 样例 #N` 外观行不算段落（扫描时跟踪围栏状态）。

## 5. 明确的能力边界（不支持清单）

| 能力 | 行为 |
| --- | --- |
| raw HTML / `<details>` / `<script>` 等 | 一律作为文本，不解析、不启用 |
| 任意指令属性（`id`/`class`/`style`/`on*`） | 不转发；只有 `open`、`tuack` 的存在性被读取 |
| `:::align` 任意 CSS 值 | 不支持，回退为可见字面标记 |
| Bilibili 播放器嵌入、自动播放、providers 请求 | 不支持，只给外链 |
| 未闭合容器指令保留 `:::` 字面量 | 不支持（解析为到文末的容器，内容保留） |
| 大于 250000 字符的文本解析渲染 | 不渲染，改为完整原文 + 提示 |
| 行号/范围高亮超过 5000 行 | 纯表现层不显示，代码仍完整 |
| 深于 12 层、超过 20000 节点、超 200 行/2000 单元格的表 | 保持原样，不部分变换 |
| 旧快照的哈希/存储迁移 | 不做，仅显示层适配 |

## 6. 与 AI、存储的关系

渲染与 AI 无关：`MarkdownView` 只接收字符串，不读数据库、不触发模型、不写回快照。AI 文本、原始平台文本与人工编辑文本在存储上仍然可区分，渲染层的任何降级（原始文本、字面回退、外链替代）都不改变这一区分。
