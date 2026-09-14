# 手工导入：JSON 与 CSV

手工导入把你自己整理的文件变成本地训练记录。它是一个**文件格式**，不是平台下载：解析不发出任何请求，文档里的 `http(s)` 链接只作为署名保存，**永远不会被抓取**。没有洛谷连接、平台记录不全、或者要导入自建/合成题目时都可以用它。

## 入口与流程

「账号与同步 → 导入与同步 → 导入 JSON / CSV 文件或粘贴材料」：

1. 选择**文件格式**：`完整 JSON 文档` 或 `CSV`。
2. 可以直接「读取本地文件」（上限 **8 MiB**），也可以在「导入内容」里粘贴文本。
3. 点「预览导入」：这一步**不写入任何数据**，只做校验并显示将要应用的内容与内容哈希。
4. 确认无误后点「确认导入这份内容」。

结果会显示新增/更新题目数、处理的提交记录数与更新的快照份数。校验规则：

- **整份文档要么全部通过，要么返回全部错误**，不会部分写入；解析结果会按内容哈希冻结，重复解析同样文本得到相同哈希。
- 文件与格式错误会定位到**字段或行**（例如 `$.problems[0].ratings[0].value`）。
- CSV 需要额外提供来源与引用：选择「CSV 内容」是 `题目` 还是 `提交记录`，并在「补充索引（JSON，可包含 accounts / problems / editorials）」里给出账号与题目索引——CSV 表本身不含来源实例和引用关系。
- 凭据类字段（如 `token`、`cookie`、`apiKey`）会被拒绝（`secret_field`），格式里没有任何凭据位置。

## 完整 JSON 文档（版本 1）

顶层字段全部必填，未知字段会被递归拒绝。下面是一份**合成**的最小可用样例：

```json
{
  "schemaVersion": 1,
  "source": {
    "platform": "manual",
    "baseUrl": "https://manual.example.test",
    "displayName": "我的训练笔记"
  },
  "accounts": [
    { "handle": "alice", "displayName": "Alice" }
  ],
  "problems": [
    {
      "externalKey": "sample-1",
      "title": "样例：统计数对",
      "url": "https://manual.example.test/p/sample-1",
      "statement": "给定一列小整数，统计有多少个无序数对之和为零。",
      "rawTags": ["hashing"],
      "ratings": [{ "dimension": "difficulty", "value": 2, "raw": "2" }]
    }
  ],
  "submissions": [
    {
      "accountHandle": "alice",
      "externalKey": "sample-1",
      "externalId": "run-1",
      "verdict": "accepted",
      "submittedAt": "2024-05-01T10:00:00Z",
      "language": "C++",
      "timeMs": 12,
      "memoryKiB": 1024
    }
  ],
  "editorials": [
    {
      "externalKey": "sample-1",
      "status": "found",
      "url": "https://manual.example.test/e/sample-1",
      "title": "用频次表统计数对",
      "solutions": [
        { "title": "频次表", "text": "先统计每个值的出现次数，再查询它的相反数。", "language": "zh" }
      ]
    }
  ]
}
```

字段含义：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `schemaVersion` | 是 | 必须是 `1` |
| `source.platform` | 是 | `manual`、`codeforces`、`luogu` 或 `hydro`（Hydro 仅导入，没有在线适配器） |
| `source.baseUrl` | 是 | 绝对 `http(s)` URL，不能带用户名/密码 |
| `source.displayName` | 否 | 显示名称 |
| `source.domain` | 否 | 默认取 `baseUrl` 的主机；来源标识是 `platform:domain` |
| `accounts[].handle` | 是 | 账号标识；Codeforces Handle 会被统一成小写（`Tourist` → `tourist`，原拼写作为显示名保留），其他平台原样保留 |
| `accounts[].displayName` / `profileUrl` | 否 | 显示名与公开主页链接（后者必须是绝对 `http(s)` 且无用户信息） |
| `problems[].externalKey` | 是 | 题目在原平台的键，原样保留，是引用提交与题解的依据 |
| `problems[].title` / `url` | 是 | 标题与链接（链接只作署名） |
| `problems[].statement` | 否 | 题面（Markdown） |
| `problems[].rawTags` | 否 | 平台原始标签字符串数组 |
| `problems[].ratings[]` | 否 | 保留平台原始维度：`{ dimension, value, raw, scale? }`，`scale` 形如 `{ "min": 0, "max": 10 }` 且 `min <= max` |
| `submissions[].accountHandle` / `externalKey` | 是 | 必须指向文档里的账号与题目 |
| `submissions[].externalId` | 是 | 平台提交编号（字符串，最多 2000 字符） |
| `submissions[].verdict` | 是 | 只能是：`accepted`、`wrong_answer`、`time_limit_exceeded`、`memory_limit_exceeded`、`runtime_error`、`compile_error`、`presentation_error`、`partial`、`skipped`、`unknown` |
| `submissions[].submittedAt` | 是 | ISO-8601 **带时区**的真实日期（`2024-02-30T00:00:00Z` 会被拒绝，不会顺延） |
| `submissions[].language` / `timeMs` / `memoryKiB` | 否 | 耗时必须是非负安全整数；内存必须是非负有限数，允许小数（平台按字节/1024 报告时原样保留，不做四舍五入） |
| `editorials[]` | 是（可为空数组） | 每条绑定一道题（题目键），并声明下面两种状态之一 |

题解材料有两种写法：

- `status: "found"`：必须给出 `url`、`title` 与至少一条 `solutions`（`title`、`text` 必填，`language` 可选）；正文按原文保存。
- `status: "absent"`：这是**用户明确声明“这道题没有题解”**，必须写非空的 `note`，且不能带 `solutions`。空白或缺少 `note` 会被拒绝。**没有**题解记录只表示“未声明”，不会从空字段推断成“没有题解”。

## CSV 表

`题目` 与 `提交记录` 使用下面固定的列集合。列顺序自由，列名必须精确（首尾空白会被去掉），**每一列都必须存在**，多余或重复的列会被拒绝。

| 类型 | 列 |
| --- | --- |
| 题目 | `domain`、`externalKey`、`title`、`url`、`statement`、`rawTags`、`ratings` |
| 提交记录 | `accountHandle`、`domain`、`externalKey`、`externalId`、`verdict`、`submittedAt`、`language`、`timeMs`、`memoryKiB` |

`rawTags` 与 `ratings` 单元格里放对应 JSON 字段的 JSON 文本（例如 `["dp"]`、`[{"dimension":"difficulty","value":3,"raw":"3"}]`）；**空单元格表示该字段缺失**，非法 JSON 会以 `invalid_json` 报出所在行与字段。

CSV 支持带引号的逗号、`""` 转义的双引号、多行单元格、UTF-8 BOM 与空行；空行会被跳过；字段数不对的行报错。表格行数上限 **10000 行**，超过会被拒绝（不会把多余行静默截断成一次有效导入）。

合成示例：

```csv
domain,externalKey,title,url,statement,rawTags,ratings
,sample-2,"样例：""A + B""",https://manual.example.test/p/sample-2,"读入两个整数并输出它们的和。","[""implementation""]","[{""dimension"":""difficulty"",""value"":1,""raw"":""1""}]"
```

```csv
accountHandle,domain,externalKey,externalId,verdict,submittedAt,language,timeMs,memoryKiB
alice,,sample-2,run-2,wrong_answer,2024-05-02T09:30:00Z,C++,,
```

导入上面的提交 CSV 时，在「补充索引」粘贴以下内容，并选择与题目 CSV 相同的来源（本例为 manual、https://manual.example.test）：

```json
{
  "accounts": [{ "handle": "alice", "displayName": "Alice" }],
  "problems": [{ "externalKey": "sample-2", "title": "样例：A + B", "url": "https://manual.example.test/p/sample-2" }]
}
```

## 常见校验错误与处理

| 错误 | 含义 | 处理 |
| --- | --- | --- |
| `duplicate_id` | 同一文档里账号/题目/题解身份重复 | 合并或删除重复项；重复提交会分别报 `duplicate_row`（完全相同）或 `duplicate_conflict`（内容不同），同样的行也会被报告，不会静默合并 |
| `invalid_json` | CSV 单元格里的 JSON 非法 | 修正该单元格的 JSON，按提示的行与字段定位 |
| `too_many_rows` | 数组或表格超过 10000 行 | 拆分为多次导入 |
| `secret_field` | 出现凭据类字段名 | 删除该字段：格式里没有凭据位置，也不要把 Cookie 写进任何导入材料 |
| 未知字段被拒绝 | 文档里有格式之外的字段 | 删除未知字段后重新预览 |

其他限制：输入文本上限 8 MiB；题面/题解正文每条上限 200000 字符；其余字符串上限 2000 字符。

## 导入之后

导入只写训练数据，不调用模型、不产生费用。导入后可以：

- 在「题库」按平台查看题目；缺失的题目资料仍可刷新或手工补充；
- 在「标签审核」把题目加入标签分析批次；
- 如果导入的提交被判定为 AC，它会进入通过统计；独立性仍取决于你是否记录完成方式（见[题库](problem-bank.md)）。

字段级的完整格式说明（含适配器与哈希规则）见[技术参考：Manual interchange v1](https://github.com/UnivmemorN/dsh-icpc-workbench/blob/main/docs/manual-import.md)。

## 相关

- [账号与同步](accounts-and-sync.md)
- [题库](problem-bank.md)
- [标签与题解材料](tags-and-answers.md)
- [返回用户文档索引](README.md)
