# MetaScanning

每天扫描 GitHub 上**当天新建**的项目，用你自己的兴趣画像过滤、打分、生成一份日报，
并在之后的每一天持续追踪这些项目的 star 走势。

零依赖：只用 Node 内置的 `fetch`、`node:sqlite` 和 `node:test`，不需要 `npm install`。

```bash
node bin/metascan.mjs run --offline   # 先验证流水线（用内置数据，不联网）
node bin/metascan.mjs doctor          # 检查 token / 配置 / 网络
node bin/metascan.mjs run             # 真实扫描，生成 out/digest-YYYY-MM-DD.md
```

## 为什么不直接用 Claude Code / 通用 agent 每天跑一遍

那是一条 prompt 链路，这是一条**有状态的数据管道**。区别集中在四点：

| | 通用 agent + 定时任务 | MetaScanning |
|---|---|---|
| 记忆 | 每天从零开始，容易重复推荐 | 记录每个项目观测过的 star 数、推过几次、你的反馈 |
| 反馈 | 你说「不感兴趣」，下次照旧 | 反馈直接变成兴趣权重，第二天排序就变 |
| 成本 | 原始数据全塞进 context | 规则过滤掉 95%，只有 top N 进 LLM |
| 时间维度 | 只能看到「此刻的 star 数」 | 自己攒 star 曲线（GitHub 没有这个 API） |

最后一条是关键：**GitHub 不提供 star 历史 API**，任何人今天开始跑都得自己按天存快照。
攒满一个月，你就有了一份别人拿不到的数据。

## 工作原理

```
采集 → 规则过滤 → 便宜评分 → README 富化 → 重新评分 → LLM 打分 → 融合排序 → 落库 + 日报
       (0 成本)    (0 成本)   (1 请求/条)            (n 条/请求)
```

顺序不是随意的：README 拉取和 LLM 调用是仅有的两个有边际成本的动作，
所以都被放在便宜过滤之后，并且各有独立的数量上限。

以默认配置跑一天的量级参考：

```
GitHub 当天新建公开仓库   ~10 万
  → 按 语言 × star 区间 分片采集后进入候选     几百 ~ 几千
  → 规则过滤（fork / 作业 / Awesome / 模板）      剩 ~10%
  → 便宜评分后取前 80 条做 README 富化
  → LLM 只打分前 40 条                            成本约 $0.01 量级
  → 日报精选 12 条
```

## 命令

| 命令 | 作用 |
|---|---|
| `run` | 扫描并生成日报 |
| `snapshot` | 刷新已收录项目的 star 数（积累时间序列） |
| `feedback <owner/repo> --save\|--ignore\|--deep` | 反馈，驱动权重学习 |
| `weights` | 查看系统从反馈里学到的权重 |
| `stats` / `list` | 查看数据库 |
| `doctor` | 环境自检 |

常用参数：

```bash
node bin/metascan.mjs run --date 2026-09-13     # 指定日期（UTC 日历日）
node bin/metascan.mjs run --llm                 # 强制开启 LLM 打分
node bin/metascan.mjs run --max-requests 30     # 快速试一次真实扫描（约 1 分钟）
node bin/metascan.mjs run --include-zero-star   # 连 0 star 的新项目也扫
node bin/metascan.mjs run --offline             # 用内置 fixtures，不联网
node bin/metascan.mjs run --json                # 机器可读输出
```

也可以用 `npm run scan` / `npm run snapshot` / `npm test`。

## 配置

所有配置都在 [`metascan.config.mjs`](metascan.config.mjs)，它就是一个普通的 ESM 模块，
可以写注释、做计算、从别处 import。改完直接重跑，不需要构建。

**`interests` 决定召回，`excludes` 决定排除。** 只加兴趣、不加排除，是这个工具最容易踩的坑——
每天的噪音主要是课程作业、练习仓库、Awesome 列表和 UI 模板，它们会淹没真正的信号。

```js
interests: [
  { tag: 'edge-inference', weight: 1.1,
    keywords: ['on-device', 'quantization', 'gguf', 'tensorrt'] },
],
excludes: {
  topics: ['awesome-list', 'template', 'course'],
  keywords: ['a curated list', 'trading bot'],
  languages: ['HTML', 'Vue'],
},
```

调参时建议盯住日报里的「扫描覆盖与过滤漏斗」一节：哪条规则淘汰了多少，一眼就能看出该松还是该紧。

### 关于 star 区间

`collection.starTiers` 默认是 `['1..5', '6..25', '26..100', '>100']`。
只看这些区间会漏掉当天刚发布、还没有人 star 的宝藏项目。

把 `'0'` 加进去（或加 `--include-zero-star`）就会扫零 star 的项目，
采集层会自动按「语言 × 体积」递归拆分来绕过下面提到的 1000 条上限，代价是请求数上升不少。

### 成本与质量旋钮

真正花钱的只有三处，都在 `ranking` 和 `collection` 里：

```js
collection: { maxRequests: 240,          // 本次运行的总请求预算
              readmeReserveRatio: 0.25 },// 其中 25% 留给 README 富化
ranking: { enrichLimit: 80,              // 最多拉多少条 README
           llmCandidateLimit: 40,        // 多少条进 LLM 打分
           displayFloor: 0.45,           // 综合分低于它的不进精选
           weights: {                    // 四个维度的权重
             interest: 0.45,             // 和你配置的方向有多契合
             quality: 0.25,              // 文档 / license / demo 站点
             momentum: 0.2,              // 当天拿到的 star、fork
             author: 0.1,                // 这个作者以前收录过的表现
           } },
```

`weights` 是全项目最值得动手调的一项，因为它对应一个价值判断：
`interest` 调高 → 更愿意看还没人发现的新项目，但噪音更多；
`momentum` 调高 → 优先看当天已经有人验证过的，但会漏掉冷启动的好东西。
默认偏兴趣一点，适合「自己先看到」的用法。如果觉得榜单被一堆 1 star 的关键词堆砌项目占满，
就把 `momentum` 提到 0.35 左右。

`readmeReserveRatio` 不建议调成 0。README 是质量分和兴趣匹配最主要的文本来源，
如果搜索阶段把预算吃光，打分就退回成「只看标题和描述」，而你不会收到任何报错——
只会觉得结果莫名地差。

注意「富化」和「排序」的关系：**没拿到 README 的候选会被排除在本次排序之外**，
而不是和有 README 的项目放在同一个榜单里比分数——后者少了一大块文本，
质量分和兴趣分天生偏低，而且能不能入选取决于它排在第几个，等于随机。
日志和日报里都会写明有多少条被排除。

`displayFloor` 控制日报的严格程度。候选少的日子，固定条数的列表会往下捞，
把明显不相关的项目也塞进精选；有了下限，它们会被单独列在日报末尾的「低置信度」区，
既不影响正文，又方便你回头核对过滤规则。

## 反馈闭环

日报末尾会给出可直接复制的命令。反馈会拆解到具体的兴趣标签和关键词上，用指数滑动平均沉淀成权重：

```bash
node bin/metascan.mjs feedback lumen-labs/tinytune --deep --note "on-device 方向继续跟"
node bin/metascan.mjs feedback shadowed/deepseek-wrapper --ignore
node bin/metascan.mjs weights
```

```
▲ tag:edge-inference    0.210 ████
▲ kw:on-device          0.210 ████
▼ tag:llm-engineering  -0.213 ████
▼ kw:llm               -0.350 ███████
```

用 EMA 而不是累加，是为了让反复反馈收敛到稳定值，而不是点几下就把某个方向推到极端。
`node bin/metascan.mjs weights --reset --yes` 可以清空，回到配置文件的状态。

## LLM 打分

默认关闭。任何 OpenAI 兼容的接口都能用：

```bash
cp .env.example .env      # 填 GITHUB_TOKEN 和 OPENAI_API_KEY
# 然后在 metascan.config.mjs 里把 llm.enabled 改成 true
```

```bash
OPENAI_BASE_URL=https://api.deepseek.com/v1   # 或者本地 vLLM / Ollama
METASCAN_MODEL=deepseek-chat
METASCAN_DEEP_MODEL=...                       # 可选：给最终 top N 的更强模型
```

LLM 只做两件事：给候选打结构化分（契合度 / 新颖度 / 完成度 + 一句结论），
以及给最终 top N 做一次深度解读。**没有 key、接口挂了、模型输出不是 JSON，都会自动退回纯启发式排序**，
流水线不会因此中断，日报里会写明降级原因。

## 每日自动化

[`.github/workflows/daily.yml`](.github/workflows/daily.yml) 每天 UTC 01:00 跑一次，
用 cache 保留 `data/` 里的历史数据库，把日报提交回仓库并上传 artifact。

也可以用自己的 cron / 计划任务，本质上就是两行：

```bash
node bin/metascan.mjs run
node bin/metascan.mjs snapshot
```

> `data/` 不要丢。它装着 star 走势和你的反馈权重，是唯一需要备份的东西。
> 用云端定时任务时，记得把它挂成持久卷或者定期导出。

## 关于 GitHub API 的三个坑

这三个坑决定了「扫 GitHub」这件事是能用还是不能用，代码里都做了处理：

1. **Search API 单次查询最多返回 1000 条结果。** 一天新建的仓库是 10 万量级，
   直接查 `created:DATE` 会静默丢掉 99%。采集层按 star 区间分片，
   撞到上限的分片再按体积、语言递归拆细，拆不动了会在日报里明说数据不完整。

   这里有个不直观的地方：**语言分片是宽查询的子集，所以不能预先展开**。
   某天如果没有 >100 star 的新项目，那个区间的宽查询返回 0，
   它的 24 个语言分片也必然全是 0——预展开等于白烧 24 次请求。
   同理，只要一个区间的总量在 1000 条以内，就应该直接多翻几页拿完，
   而不是拆成子分片（拆分更贵）。这两件事都是自适应做的。
2. **限流很紧。** 未认证 10 次/分钟，认证后 30 次/分钟。所以有串行队列 + 固定间隔，
   遇到 403/429 会读 `retry-after` 重试，等待时间过长时降级返回已抓到的部分。
3. **没有 star 历史 API。** 只能自己每天存快照，`snapshot` 命令干这个。

## 项目结构

```
bin/metascan.mjs        CLI 入口
src/
  collect.mjs           采集编排：分片调度、预算、拆分
  shards.mjs            分片计划与 1000 条上限的拆解策略
  github.mjs            REST / GraphQL 客户端 + 限流
  filters.mjs           零成本规则过滤
  heuristic.mjs         启发式评分 + 关键词/标签权重
  enrich.mjs            README 富化
  llm.mjs               LLM 打分（批量、结构化、可降级）
  feedback.mjs          反馈 → 权重
  snapshot.mjs          star 快照
  run.mjs               主流程编排
  digest.mjs            日报渲染（Markdown + JSON）
  store.mjs             SQLite（repos / snapshots / scores / feedback / weights）
fixtures/sample-repos.json   离线演示与测试数据
test/                   83 个测试
```

## 测试

```bash
npm test
```

覆盖了分片与 1000 条上限的处理（含自适应翻页、空区间不展开、预算不被搜索吃光）、
每条过滤规则、评分的单调性与噪声组合、权重收敛与边界、
LLM 的批量/解析失败/接口失败三种路径，以及两条完整的端到端链路
（离线 fixtures 和用假 API 驱动的真实扫描路径）。

## 已知限制

- **需要自己提供 token。** 无 token 能跑，但覆盖面和速度都会明显下降。
- **`created:` 是 UTC 日历日。** 东八区早上跑，扫到的是 UTC 前一天的发布。
- **新颖度判断依赖 LLM。** 纯启发式只能做到「像不像你关心的方向」，判断不了「是不是又一个翻版」。
- **作者先验是冷启动的。** 前几周几乎没有历史数据，这一项接近中性。
- **仓库哈希/内容层面没有做去重。** 同一个项目换个名字重发，目前识别不出来。
