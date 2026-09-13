/**
 * MetaScanning 兴趣画像配置。
 *
 * 这是一个普通的 ESM 配置，所以你可以写注释、做计算、从别处 import。
 * 改完直接重跑 `npm run scan` 即可，不需要重新构建任何东西。
 *
 * 调参心法：
 *  - interests 决定「召回」，宁可写宽一点；
 *  - excludes 决定「排除」，这一层往往是提升体感最快的地方；
 *  - 只加正向兴趣、不加排除项，是这个工具最容易踩的坑。
 */

export default {
  profile: {
    name: 'AI 工程 / 开发者工具',
    // 这段话会作为「这个开发者是谁、关心什么」的上下文交给 LLM。
    // 用自然语言写，像在跟同事描述你的方向。
    description: `
我在做 AI 应用和开发者工具方向的事情，日常关注：
- LLM / agent 的工程化落地：上下文管理、评测、可观测性、编排框架
- 能在本地或边缘设备上跑的推理方案：量化、小模型、推理引擎
- 新的开发范式工具：MCP、代码检索、自动化工作流
不关心：前端 UI 模板、加密货币投机、课程作业、纯 Awesome 列表。
`.trim(),
  },

  /**
   * 加权兴趣点。weight 是相对权重（1.0 为基准）。
   * keywords 会同时匹配 name / description / topics / README 前若干字符。
   * 大小写不敏感，多词短语按子串匹配。
   */
  interests: [
    {
      tag: 'llm-engineering',
      weight: 1.2,
      keywords: [
        'llm', 'large language model', 'prompt', 'rag', 'retrieval augmented',
        'context window', 'eval', 'evaluation harness', 'observability', 'tracing',
        'tokenizer', 'fine-tune', 'finetune', 'lora', 'inference server',
      ],
    },
    {
      tag: 'agent-tooling',
      weight: 1.2,
      keywords: [
        'agent', 'agentic', 'tool calling', 'function calling', 'mcp',
        'model context protocol', 'workflow automation', 'orchestration',
        'autonomous', 'multi-agent', 'coding agent',
      ],
    },
    {
      tag: 'edge-inference',
      weight: 1.1,
      keywords: [
        'on-device', 'edge', 'embedded', 'quantization', 'quantized', 'int4', 'int8',
        'gguf', 'llama.cpp', 'inference engine', 'tensorrt', 'onnx', 'npu',
        'raspberry pi', 'jetson', 'microcontroller', 'tinyml',
      ],
    },
    {
      tag: 'dev-infra',
      weight: 0.8,
      keywords: [
        'developer tool', 'devtool', 'cli', 'code search', 'linter', 'formatter',
        'ci/cd', 'build system', 'static analysis', 'language server', 'lsp',
        'program analysis', 'code review',
      ],
    },
    {
      tag: 'data-and-storage',
      weight: 0.6,
      keywords: [
        'vector database', 'embedding', 'sqlite', 'postgres', 'storage engine',
        'indexing', 'distributed', 'stream processing', 'query engine',
      ],
    },
  ],

  /**
   * 排除规则。命中任意一条候选就被丢弃，不消耗 LLM 调用。
   */
  excludes: {
    languages: ['HTML', 'CSS', 'SCSS', 'Less', 'PHP', 'Hack', 'Vue', 'Blade'],
    topics: [
      'awesome', 'awesome-list', 'course', 'tutorial', 'roadmap', 'interview',
      'leetcode', 'homework', 'notes', 'ebook', 'cheatsheet', 'dotfiles',
      'template', 'boilerplate', 'resume', 'portfolio',
    ],
    keywords: [
      'a curated list', 'awesome list', 'my homework', 'course assignment',
      '学习笔记', '课程作业', '刷题', 'crypto trading', 'trading bot', 'airdrop',
      'wallpaper', 'portfolio website', 'clone of', 'first repository', 'my first',
    ],
    // 直接把某些 owner（组织或用户）整体拉黑，适合屏蔽刷仓库的营销号
    owners: [],
  },

  filters: {
    // 0 表示不因 star 少而丢弃；当天新建的仓库经常是 0 star
    minStars: 0,
    maxStars: null,
    // 仓库体积下限（KB）。太小基本是空仓库或只有个 README。
    minSizeKb: 8,
    maxSizeKb: 2_000_000,
    // 即使没有 description 也放行（README 可能很完整），置 false 更严格
    requireDescription: false,
    allowForks: false,
    blockedNamePatterns: ['^test$', '^demo$', '^hello[-_ ]?world$', '^untitled'],
  },

  collection: {
    /**
     * 分片语言列表。GitHub Search API 单次查询最多只能翻到 1000 条结果，
     * 所以采集层必须按 语言 × star 区间 切片，否则你会静默漏掉大量项目。
     * 列表越长覆盖越全，但 API 调用次数也线性增长。
     */
    languages: [
      'Python', 'TypeScript', 'JavaScript', 'Rust', 'Go', 'C', 'C++', 'C#',
      'Java', 'Kotlin', 'Swift', 'Ruby', 'Zig', 'Shell', 'Jupyter Notebook',
      'HTML', 'Lua', 'Elixir', 'Dart', 'Scala', 'Julia', 'OCaml', 'Haskell', 'Nim',
    ],
    /**
     * star 区间分片。默认只扫 >=1 star 的区间：信噪比高、请求数可控。
     * 想连 0 star 的「当天新发布宝藏」一起扫，把 '0' 加进来，
     * 采集层会自动再按仓库体积递归拆分来绕过 1000 条上限（请求数会明显上升）。
     */
    starTiers: ['1..5', '6..25', '26..100', '>100'],
    // 单次运行的 API 请求预算。超了就停，并在报告里说明哪些分片被跳过。
    maxRequests: 240,
    maxPagesPerShard: 3,
    // 当某个分片撞到 1000 条上限时，是否自动按体积继续拆分
    deepShard: true,
    maxShardDepth: 2,
    // 两次 GitHub 请求之间的最小间隔（毫秒）。留 null 会自动按 token 情况决定：
    // 有 token 2100ms（30 次/分钟），没有 token 6500ms（10 次/分钟）。
    minIntervalMs: null,
    /**
     * maxRequests 是本次运行的总预算，其中这个比例留给 README 富化。
     * 别调成 0：README 是质量分和兴趣匹配最主要的文本来源，
     * 没有它的话打分等于只看了标题和描述。
     */
    readmeReserveRatio: 0.25,
  },

  ranking: {
    // 便宜评分（无 LLM）之后保留多少条进入 README 富化阶段
    enrichLimit: 80,
    // 进入 LLM 打分的候选上限（控制成本的关键旋钮）
    llmCandidateLimit: 40,
    // 最终写进 digest 的项目数
    shortlistSize: 12,
    /**
     * 质量下限：综合分低于它的不进「精选」，只列在日报末尾的「低置信度」里。
     * 这个值可以按自己的口味调——调高会得到更短但更准的日报，
     * 调成 0 就退化成「有多少显示多少」。
     */
    displayFloor: 0.45,
    // 启发式分数低于此值直接淘汰
    minHeuristicScore: 0.16,
  },

  llm: {
    enabled: false,
    batchSize: 5,
    temperature: 0,
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrlEnv: 'OPENAI_BASE_URL',
    modelEnv: 'METASCAN_MODEL',
    deep: {
      // 开启后，启发式排名最靠前的若干条会额外做一次深度分析
      enabled: false,
      topK: 5,
      modelEnv: 'METASCAN_DEEP_MODEL',
    },
  },

  snapshot: {
    enabled: true,
    batchSize: 100,
    // 无 token 时走 REST 逐仓库查询，这里限制单次运行最多查几个
    unauthenticatedLimit: 40,
  },

  output: {
    dir: 'out',
    dataDir: 'data',
  },
};
