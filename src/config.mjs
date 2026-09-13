import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { clamp, isNonEmptyString, resolveFrom } from './util.mjs';

export const DEFAULT_CONFIG_FILE = 'metascan.config.mjs';

/**
 * 配置里所有「没写就用默认值」的地方都集中在这里，
 * 这样 metascan.config.mjs 可以只写用户真正关心的部分。
 */
export function defaultConfig() {
  return {
    profile: { name: 'default', description: '' },
    interests: [],
    excludes: { languages: [], topics: [], keywords: [], owners: [] },
    filters: {
      minStars: 0,
      maxStars: null,
      minSizeKb: 0,
      maxSizeKb: null,
      requireDescription: false,
      allowForks: false,
      blockedNamePatterns: [],
    },
    collection: {
      languages: ['Python', 'TypeScript', 'JavaScript', 'Rust', 'Go'],
      starTiers: ['1..5', '6..25', '26..100', '>100'],
      maxRequests: 200,
      maxPagesPerShard: 3,
      deepShard: true,
      maxShardDepth: 2,
      // null = 按是否带 token 自动决定（30 次/分钟 或 10 次/分钟）
      minIntervalMs: null,
      // 总预算里留给 README 富化的比例（0~1）
      readmeReserveRatio: 0.25,
    },
    ranking: {
      enrichLimit: 80,
      llmCandidateLimit: 40,
      shortlistSize: 12,
      // 综合分低于这个值的不进精选，只列在「低置信度」里
      displayFloor: 0.45,
      minHeuristicScore: 0.16,
      // 四个维度的权重，见 metascan.config.mjs 里的说明
      weights: { interest: 0.45, quality: 0.25, momentum: 0.2, author: 0.1 },
    },
    llm: {
      enabled: false,
      batchSize: 5,
      temperature: 0,
      apiKeyEnv: 'OPENAI_API_KEY',
      baseUrlEnv: 'OPENAI_BASE_URL',
      modelEnv: 'METASCAN_MODEL',
      deep: { enabled: false, topK: 5, modelEnv: 'METASCAN_DEEP_MODEL' },
    },
    snapshot: { enabled: true, batchSize: 100, unauthenticatedLimit: 40 },
    output: { dir: 'out', dataDir: 'data' },
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 深合并：数组整体替换而不是拼接，这样用户写 languages 就是最终列表 */
export function deepMerge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? deepMerge(base[key], value) : value;
  }
  return result;
}

export function normalizeConfig(raw) {
  const merged = deepMerge(defaultConfig(), raw ?? {});

  merged.interests = (merged.interests ?? [])
    .filter((entry) => entry && isNonEmptyString(entry.tag))
    .map((entry) => ({
      tag: String(entry.tag),
      weight: Number.isFinite(Number(entry.weight)) ? clamp(Number(entry.weight), 0.05, 5) : 1,
      keywords: (entry.keywords ?? []).filter(isNonEmptyString).map((k) => String(k)),
    }))
    .filter((entry) => entry.keywords.length > 0);

  for (const key of ['languages', 'topics', 'keywords', 'owners']) {
    merged.excludes[key] = (merged.excludes[key] ?? []).filter(isNonEmptyString).map((v) => String(v));
  }

  merged.collection.languages = (merged.collection.languages ?? []).filter(isNonEmptyString);
  merged.collection.starTiers = (merged.collection.starTiers ?? []).filter(isNonEmptyString);

  return merged;
}

export function validateConfig(config) {
  const errors = [];
  const warnings = [];

  if (!config.interests.length) {
    errors.push('interests 为空：至少要配置一个带 keywords 的兴趣点，否则评分没有依据。');
  }
  if (!config.collection.starTiers.length) {
    errors.push('collection.starTiers 为空：采集层需要一个 star 区间来切片查询。');
  }
  if (config.ranking.shortlistSize < 1) {
    errors.push('ranking.shortlistSize 必须 >= 1。');
  }
  if (config.ranking.llmCandidateLimit < config.ranking.shortlistSize) {
    warnings.push('ranking.llmCandidateLimit 小于 shortlistSize，最终会凑不满 digest。');
  }
  if (!config.collection.languages.length) {
    warnings.push('collection.languages 为空：只会扫描不带语言切片的宽查询，容易撞上 1000 条结果上限。');
  }
  if (!config.excludes.keywords.length && !config.excludes.topics.length) {
    warnings.push('没有配置任何 excludes：信噪比会很差，建议至少排除课程作业/Awesome 列表类项目。');
  }

  return { errors, warnings };
}

/**
 * 加载配置。支持 .mjs / .js / .json —— 默认优先 metascan.config.mjs。
 */
export async function loadConfig({ cwd = process.cwd(), configPath } = {}) {
  const explicit = configPath ? resolveFrom(cwd, configPath) : null;
  const candidates = explicit
    ? [explicit]
    : [
        path.join(cwd, 'metascan.config.mjs'),
        path.join(cwd, 'metascan.config.json'),
        path.join(cwd, 'metascan.config.js'),
      ];

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    const detail = explicit ? `指定的配置文件不存在：${explicit}` : `在 ${cwd} 下没找到 ${DEFAULT_CONFIG_FILE}`;
    throw new Error(detail);
  }

  let raw;
  if (found.endsWith('.json')) {
    raw = JSON.parse(fs.readFileSync(found, 'utf8'));
  } else {
    const mod = await import(pathToFileURL(found).href);
    raw = mod.default ?? mod.config;
  }

  if (!isPlainObject(raw)) {
    throw new Error(`配置文件没有 default export 一个对象：${found}`);
  }

  const config = normalizeConfig(raw);
  config.__source = found;
  config.__cwd = cwd;
  return config;
}
