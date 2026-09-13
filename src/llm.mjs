import { clamp, round, truncate } from './util.mjs';

/**
 * LLM 打分层（OpenAI 兼容接口）。
 *
 * 三个设计要点：
 *  1. 批量：一次请求评多个候选，比逐个调用省大量 token 和延迟。
 *  2. 结构化：强制输出 JSON，并在解析失败时自动缩小批量重试，
 *     而不是把「模型今天多说了一句话」变成整次运行失败。
 *  3. 可降级：没有 key / 接口挂了 / 解析不出来，都会自动退回纯启发式评分，
 *     绝不让整条流水线挂掉。
 */

export const JUDGE_SCHEMA = {
  results: [
    {
      full_name: 'owner/repo',
      fit: '0-10 与开发者关注方向的契合度',
      novelty: '0-10 新颖度，是否只是又一个已有项目的翻版',
      quality: '0-10 工程完成度',
      verdict: '一句话结论（中文，不超过 40 字）',
      why: '为什么值得看（中文，1-2 句，要具体到它做了什么）',
      tags: ['从给定兴趣标签中选，可多选'],
      caution: '需要注意或存疑的地方（中文，没有就写空字符串）',
    },
  ],
};

export function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();

  try {
    return JSON.parse(candidate);
  } catch {
    /* 继续尝试从文本里抠出 JSON 片段 */
  }

  /**
   * 先试文本里出现得更早的那个括号类型，否则
   * "[{...},{...}] 后面还有话" 会因为先匹配到 '{' 而只返回第一个对象。
   */
  const braceAt = candidate.indexOf('{');
  const bracketAt = candidate.indexOf('[');
  const ordered =
    bracketAt !== -1 && (braceAt === -1 || bracketAt < braceAt)
      ? [
          ['[', ']'],
          ['{', '}'],
        ]
      : [
          ['{', '}'],
          ['[', ']'],
        ];

  for (const [open, close] of ordered) {
    const start = candidate.indexOf(open);
    if (start === -1) continue;
    for (let end = candidate.lastIndexOf(close); end > start; end = candidate.lastIndexOf(close, end - 1)) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        /* 缩小范围继续试 */
      }
    }
  }
  return null;
}

export function buildJudgePrompt({ profile, items }) {
  const system = [
    '你是一个技术雷达分析师，帮一位开发者从当天 GitHub 新发布的项目里挑出真正值得看的。',
    '判断要苛刻：绝大多数新仓库没有价值，宁可给低分，也不要为了让每个条目都有话说而抬高分数。',
    '「新颖度」重点看它是不是解决了已有工具没解决的问题，而不是它用了多少流行词。',
    '只输出 JSON，不要 markdown 代码块，不要任何解释性前后缀。',
  ].join('\n');

  const repoBlocks = items
    .map((item, index) => {
      const lines = [
        `[${index + 1}] full_name: ${item.fullName}`,
        `语言: ${item.language ?? '未知'} | star: ${item.stars ?? 0} | fork: ${item.forks ?? 0}`,
        `描述: ${item.description ?? '(无)'}`,
        `topics: ${(item.topics ?? []).join(', ') || '(无)'}`,
        `README 摘要: ${truncate(item.readmeExcerpt ?? '(无)', 1200) || '(无)'}`,
      ];
      return lines.join('\n');
    })
    .join('\n\n');

  const user = [
    '## 这位开发者是谁',
    profile.description || profile.name || '(未填写)',
    '',
    '## 他配置的关注方向标签',
    (profile.tags ?? []).join(', ') || '(未配置)',
    '',
    '## 待评估的项目',
    repoBlocks,
    '',
    '## 输出格式',
    '严格按下面的 JSON 结构输出，results 数组的顺序和项目数量必须与输入一一对应：',
    JSON.stringify(JUDGE_SCHEMA, null, 2),
  ].join('\n');

  return { system, user };
}

export function buildDeepPrompt({ profile, item }) {
  const system = [
    '你是一个资深技术分析师，对单个 GitHub 项目做深度解读。',
    '只输出 JSON，不要 markdown 代码块。',
  ].join('\n');

  const user = [
    '## 开发者背景',
    profile.description || '(未填写)',
    '',
    '## 项目',
    `名称: ${item.fullName}`,
    `描述: ${item.description ?? '(无)'}`,
    `语言: ${item.language ?? '未知'} | star: ${item.stars ?? 0}`,
    `topics: ${(item.topics ?? []).join(', ') || '(无)'}`,
    '',
    '## README',
    truncate(item.readmeText ?? '(无)', 8000),
    '',
    '## 输出格式',
    JSON.stringify(
      {
        summary: '这个项目到底做了什么（中文，2-3 句）',
        why_it_matters: '对这位开发者的具体价值（中文，2-3 句，不要泛泛而谈）',
        risks: '风险或明显的短板（中文，1-2 句）',
        try_first: '如果要试，第一步该做什么（中文，1 句）',
      },
      null,
      2,
    ),
  ].join('\n');

  return { system, user };
}

export function createLlmClient({
  apiKey = process.env.OPENAI_API_KEY,
  baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  model = process.env.METASCAN_MODEL || 'gpt-4o-mini',
  temperature = 0,
  fetchImpl = globalThis.fetch,
  timeoutMs = 120_000,
  logger = null,
} = {}) {
  const usage = { promptTokens: 0, completionTokens: 0, calls: 0 };

  async function chat({ system, user, model: overrideModel, maxTokens = 2000 }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = {
        model: overrideModel || model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
      };
      // 部分推理模型不接受 temperature，配成 null 就不传
      if (temperature !== null && temperature !== undefined) body.temperature = temperature;

      const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }

      if (!response.ok) {
        const message = json?.error?.message ?? truncate(text, 300);
        throw new Error(`LLM 接口 ${response.status}：${message}`);
      }

      usage.calls += 1;
      usage.promptTokens += json?.usage?.prompt_tokens ?? 0;
      usage.completionTokens += json?.usage?.completion_tokens ?? 0;

      const content = json?.choices?.[0]?.message?.content ?? '';
      return typeof content === 'string' ? content : JSON.stringify(content);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    model,
    get available() {
      return Boolean(apiKey);
    },
    get usage() {
      return { ...usage };
    },

    /**
     * 批量评估。返回 Map<fullName, judgement>。
     * 解析失败时自动把批量减半重试，最多递归到单条。
     */
    async judge({ profile, items, batchSize = 5 }) {
      if (!apiKey) throw new Error('未配置 LLM API key');
      const results = new Map();
      let failedBatches = 0;
      let parseFailures = 0;
      const callErrors = [];

      const chunks = [];
      for (let i = 0; i < items.length; i += batchSize) {
        chunks.push(items.slice(i, i + batchSize));
      }

      const judgeChunk = async (chunk) => {
        if (!chunk.length) return;
        const { system, user } = buildJudgePrompt({ profile, items: chunk });
        const raw = await chat({ system, user, maxTokens: 600 + chunk.length * 220 });
        const parsed = extractJson(raw);
        const list = Array.isArray(parsed) ? parsed : parsed?.results;

        if (!Array.isArray(list)) {
          if (chunk.length > 1) {
            const mid = Math.ceil(chunk.length / 2);
            await judgeChunk(chunk.slice(0, mid));
            await judgeChunk(chunk.slice(mid));
            return;
          }
          failedBatches += 1;
          parseFailures += 1;
          logger?.warn?.(`LLM 返回无法解析为 JSON，跳过 ${chunk[0].fullName}`);
          return;
        }

        list.forEach((entry, index) => {
          const fallbackName = chunk[index]?.fullName;
          const fullName = entry?.full_name ?? entry?.fullName ?? fallbackName;
          if (!fullName) return;
          results.set(fullName, normalizeJudgement(entry));
        });
      };

      for (const chunk of chunks) {
        try {
          await judgeChunk(chunk);
        } catch (error) {
          logger?.warn?.(`LLM 批量评估失败（${chunk.length} 条）：${error.message}`);
          failedBatches += 1;
          callErrors.push(error.message);
        }
      }

      return { results, failedBatches, parseFailures, callErrors };
    },

    /** 对单个项目做深度解读，用于最终 top N */
    async deepDive({ profile, item, model: overrideModel }) {
      if (!apiKey) throw new Error('未配置 LLM API key');
      const { system, user } = buildDeepPrompt({ profile, item });
      const raw = await chat({ system, user, maxTokens: 1200, model: overrideModel });
      const parsed = extractJson(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    },
  };
}

export function normalizeJudgement(entry = {}) {
  const num = (value, fallback = 0) =>
    Number.isFinite(Number(value)) ? clamp(Number(value), 0, 10) : fallback;
  const tags = Array.isArray(entry.tags)
    ? entry.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
    : [];

  const fit = num(entry.fit, 3);
  const novelty = num(entry.novelty, 3);
  const quality = num(entry.quality, 3);

  return {
    fit,
    novelty,
    quality,
    verdict: typeof entry.verdict === 'string' ? entry.verdict.trim() : '',
    why: typeof entry.why === 'string' ? entry.why.trim() : '',
    caution: typeof entry.caution === 'string' ? entry.caution.trim() : '',
    tags,
    // 融合成 0..1，契合度权重最高：这个工具的目标是「对你有用」，不是「客观上最好」
    score: round((fit * 0.5 + novelty * 0.25 + quality * 0.25) / 10, 4),
  };
}

/**
 * 把启发式分数和 LLM 分数融合。
 * LLM 缺位时直接退回启发式，保证任何时候都有排序结果。
 */
export function fuseScores({ heuristic, llm, heuristicWeight = 0.45, llmWeight = 0.55 }) {
  if (!llm) return heuristic;
  const total = heuristicWeight * heuristic + llmWeight * llm;
  return clamp(total, 0, 1);
}

export function estimateCost(usage, { promptPerMillion = 0.15, completionPerMillion = 0.6 } = {}) {
  const cost =
    (usage.promptTokens / 1_000_000) * promptPerMillion + (usage.completionTokens / 1_000_000) * completionPerMillion;
  return round(cost, 4);
}
