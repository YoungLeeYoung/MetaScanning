import { clamp, includesKeyword, normalizeText, round, truncate } from './util.mjs';

/**
 * 启发式评分：不花一分钱 LLM 费用的第一层排序。
 *
 * 四个维度：兴趣匹配 / 工程质量 / 早期动量 / 作者先验。
 * 兴趣维度用 noisy-or 组合而不是加权平均——平均会惩罚「只命中一个方向但非常准」的项目，
 * 而实际使用中，一个精准命中比四个模糊命中更有价值。
 */

export const DEFAULT_WEIGHTS = {
  interest: 0.45,
  quality: 0.25,
  momentum: 0.2,
  author: 0.1,
};

/** 反馈动作 → 兴趣权重的目标值。deep 比 save 更强，ignore 是负向。 */
export const FEEDBACK_TARGETS = {
  deep: 1.0,
  save: 0.6,
  ignore: -1.0,
};

export function buildHaystack(repo, { includeReadme = false, readmeChars = 4000 } = {}) {
  const parts = [
    repo.name,
    repo.description,
    ...(repo.topics ?? []),
    repo.language,
  ];
  if (includeReadme && repo.readmeText) {
    parts.push(truncate(repo.readmeText, readmeChars));
  }
  return normalizeText(parts.filter(Boolean).join(' \n '));
}

/**
 * 统计每个兴趣点命中多少关键词。
 * learnedBoost 来自反馈表：你点过 save/deep 的标签会被放大，ignore 过的会被压低。
 */
export function matchInterests(repo, { config, weights = new Map(), includeReadme = false }) {
  const haystack = buildHaystack(repo, { includeReadme });
  const results = [];

  for (const interest of config.interests) {
    const rawHits = interest.keywords.filter((keyword) => includesKeyword(haystack, keyword));
    const learned = weights.get(`tag:${interest.tag}`)?.value ?? 0;
    const effectiveWeight = interest.weight * (1 + 0.6 * learned);

    /**
     * 关键词级别的反馈权重。作用是把「llm-engineering 这个方向」细化成
     * 「具体是 eval 还是 tokenizer 打动了我」——你反复忽略含某个词的条目后，
     * 那个词会自己沉下去，而不用你去改配置文件。
     */
    const weightedHits = rawHits.reduce((sum, keyword) => {
      const kwLearned = weights.get(`kw:${keyword}`)?.value ?? 0;
      return sum + Math.max(1 + 0.5 * kwLearned, 0.25);
    }, 0);

    results.push({
      tag: interest.tag,
      weight: interest.weight,
      effectiveWeight: Math.max(effectiveWeight, 0.05),
      learned,
      hits: rawHits,
      weightedHits: round(weightedHits, 3),
      strength: rawHits.length ? clamp(0.45 + 0.25 * (weightedHits - 1), 0, 1) : 0,
    });
  }

  return results;
}

export function scoreQuality(repo) {
  const parts = {};
  let score = 0;

  const descLength = (repo.description ?? '').length;
  parts.description = descLength >= 60 ? 0.2 : descLength >= 20 ? 0.12 : descLength > 0 ? 0.05 : 0;
  score += parts.description;

  const topicCount = (repo.topics ?? []).length;
  parts.topics = topicCount >= 4 ? 0.15 : topicCount >= 2 ? 0.1 : topicCount === 1 ? 0.05 : 0;
  score += parts.topics;

  parts.license = repo.license ? 0.1 : 0;
  score += parts.license;

  parts.homepage = repo.homepage ? 0.15 : 0;
  score += parts.homepage;

  const readmeChars = repo.readmeChars ?? 0;
  parts.readme =
    readmeChars >= 3000 ? 0.25 : readmeChars >= 800 ? 0.17 : readmeChars >= 200 ? 0.1 : readmeChars > 0 ? 0.04 : 0;
  score += parts.readme;

  // 有 demo 站点 + 有 README 说明 + 有 license，基本可以确定是认真做的项目
  parts.freshness = repo.pushedAt && repo.createdAt && repo.pushedAt !== repo.createdAt ? 0.15 : 0;
  score += parts.freshness;

  return { score: clamp(score, 0, 1), parts };
}

/** 早期动量：当天新建的仓库能拿到 star，本身就是最强的信号之一 */
export function scoreMomentum(repo) {
  const stars = repo.stars ?? 0;
  const forks = repo.forks ?? 0;
  const starScore =
    stars >= 100 ? 1 : stars >= 50 ? 0.92 : stars >= 25 ? 0.8 : stars >= 10 ? 0.65 : stars >= 5 ? 0.5 : stars >= 2 ? 0.33 : stars >= 1 ? 0.2 : 0.04;
  const forkScore = forks >= 10 ? 0.15 : forks >= 3 ? 0.1 : forks >= 1 ? 0.05 : 0;
  return { score: clamp(starScore + forkScore, 0, 1), parts: { stars: starScore, forks: forkScore } };
}

/** 作者先验：这个 owner 以前有没有被我们收录过、表现如何 */
export function scoreAuthor(repo, authorStats) {
  const stat = authorStats?.get?.(repo.owner);
  if (!stat) return { score: 0.5, parts: { known: 0, best: 0 }, known: false };
  const best = stat.bestScore ?? 0;
  const score = best >= 0.7 ? 0.9 : best >= 0.5 ? 0.72 : best >= 0.3 ? 0.55 : 0.4;
  return { score, parts: { known: stat.repoCount, best: round(best, 3) }, known: true };
}

export function scorePenalties(repo) {
  const penalties = [];
  const desc = repo.description ?? '';
  const name = repo.name ?? '';

  if (!desc && (repo.topics ?? []).length === 0 && (repo.readmeChars ?? 0) < 300) {
    penalties.push({ code: 'no-info', amount: 0.2, reason: '几乎没有任何说明信息' });
  }

  // 一堆连字符或纯数字结尾，通常是脚本批量生成的仓库名
  if ((name.match(/-/g) ?? []).length >= 4) {
    penalties.push({ code: 'spammy-name', amount: 0.08, reason: '仓库名像批量生成' });
  }

  const emojiCount = (desc.match(/[\u{1F300}-\u{1FAFF}]/gu) ?? []).length;
  if (emojiCount >= 6) {
    penalties.push({ code: 'emoji-spam', amount: 0.06, reason: '描述里 emoji 过多，营销味重' });
  }

  // 体积很大但 README 很少：多半是数据/依赖转储，不是工具
  if ((repo.sizeKb ?? 0) > 50_000 && (repo.readmeChars ?? 0) < 500) {
    penalties.push({ code: 'bulk-dump', amount: 0.15, reason: '体积很大但几乎没有文档，疑似资源转储' });
  }

  if (/(tutorial|course|guide|从入门到|教程)/i.test(name)) {
    penalties.push({ code: 'tutorial-ish', amount: 0.1, reason: '仓库名像教程' });
  }

  return penalties;
}

/**
 * 主评分函数。
 * 返回结构化结果，便于 digest 展示「它为什么被选中」以及反馈时反查标签。
 */
export function scoreHeuristic(repo, { config, weights = new Map(), authorStats = new Map(), includeReadme = true } = {}) {
  const interestMatches = matchInterests(repo, { config, weights, includeReadme });
  const maxEffective = Math.max(...interestMatches.map((m) => m.effectiveWeight), 1e-9);

  // noisy-or：1 - Π(1 - strength_i * relativeWeight_i)
  let surviving = 1;
  for (const match of interestMatches) {
    if (match.strength <= 0) continue;
    const relative = clamp(match.effectiveWeight / maxEffective, 0, 1);
    surviving *= 1 - match.strength * relative;
  }
  const interestScore = clamp(1 - surviving, 0, 1);

  const quality = scoreQuality(repo);
  const momentum = scoreMomentum(repo);
  const author = scoreAuthor(repo, authorStats);
  const penalties = scorePenalties(repo);
  const penaltyTotal = penalties.reduce((sum, p) => sum + p.amount, 0);

  const weighted =
    DEFAULT_WEIGHTS.interest * interestScore +
    DEFAULT_WEIGHTS.quality * quality.score +
    DEFAULT_WEIGHTS.momentum * momentum.score +
    DEFAULT_WEIGHTS.author * author.score;

  const total = clamp(weighted - penaltyTotal, 0, 1);

  const matchedTags = interestMatches.filter((m) => m.hits.length).map((m) => m.tag);
  const matchedKeywords = interestMatches.flatMap((m) => m.hits);

  return {
    total: round(total, 4),
    parts: {
      interest: round(interestScore, 4),
      quality: round(quality.score, 4),
      momentum: round(momentum.score, 4),
      author: round(author.score, 4),
      penalty: round(penaltyTotal, 4),
    },
    detail: {
      interest: interestMatches.map((m) => ({
        tag: m.tag,
        hits: m.hits,
        strength: round(m.strength, 3),
        learned: round(m.learned, 3),
      })),
      quality: quality.parts,
      authorKnown: author.known,
    },
    matchedTags,
    matchedKeywords,
    penalties,
    includeReadme,
    rankReason: buildRankReason({ interestMatches, momentum, penalties, author }),
  };
}

function buildRankReason({ interestMatches, momentum, penalties, author }) {
  const bits = [];
  const top = interestMatches.filter((m) => m.hits.length).sort((a, b) => b.strength - a.strength)[0];
  if (top) bits.push(`关键词 ${top.hits.slice(0, 4).join('、')}`);
  if (momentum.score >= 0.5) bits.push('当天已有明显 star 增长');
  if (author.known && author.score >= 0.7) bits.push('作者此前收录过的项目表现不错');
  if (penalties.length) bits.push(penalties.map((p) => p.reason).join('；'));
  return bits.join('；') || '没有明显特征';
}

/**
 * 排序：启发式分数优先，同分时 star 多的在前。
 */
export function rankCandidates(scored) {
  return [...scored].sort((a, b) => {
    if (b.heuristic.total !== a.heuristic.total) return b.heuristic.total - a.heuristic.total;
    return (b.repo.stars ?? 0) - (a.repo.stars ?? 0);
  });
}
