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

/**
 * 关键词出现在不同字段里，证据强度完全不同。
 *
 * topics 和仓库名是作者**主动声明**「我这个项目是什么」；
 * description 次之；README 里出现某个词可能只是顺带提了一句——
 * 一份 10KB 的文档里凑齐四五个技术名词太容易了。
 *
 * 早期版本把五个字段平权、并且 4 次命中就把兴趣分顶到 1.0，
 * 实测下来 12 条精选里 9 条兴趣分在 0.98 以上——主维度完全失去了区分度。
 * 给字段加权重，等于让「声明」比「提及」更有分量。
 */
export const FIELD_EVIDENCE_WEIGHT = {
  name: 1.0,
  topics: 1.0,
  description: 0.8,
  language: 0.3,
  readme: 0.4,
};

export const FIELD_LABELS = {
  name: '仓库名',
  topics: 'topics 标签',
  description: '描述',
  language: '语言',
  readme: 'README',
};

export function buildFields(repo, { includeReadme = false, readmeChars = 4000 } = {}) {
  return {
    name: normalizeText(repo.name),
    topics: normalizeText((repo.topics ?? []).join(' ')),
    description: normalizeText(repo.description),
    language: normalizeText(repo.language),
    readme: includeReadme ? normalizeText(truncate(repo.readmeText ?? '', readmeChars)) : '',
  };
}

/** 兼容旧签名：把各字段拼成一个大字符串。 */
export function buildHaystack(repo, { includeReadme = false, readmeChars = 4000 } = {}) {
  const fields = buildFields(repo, { includeReadme, readmeChars });
  return normalizeText(Object.values(fields).filter(Boolean).join(' \n '));
}

/**
 * 证据量 → 强度的饱和曲线常数。
 *
 * strength = 1 - e^(-evidence / K)
 * 越大越难拿高分。K=3 意味着：两个 topics 命中 ≈ 0.49，
 * 四个 ≈ 0.74，八个 ≈ 0.93——想要满分就得真的有料，
 * 而不是像旧公式那样命中四次就到顶。
 */
export const EVIDENCE_SATURATION_K = 3;

/**
 * 统计每个兴趣点命中多少关键词。
 * learnedBoost 来自反馈表：你点过 save/deep 的标签会被放大，ignore 过的会被压低。
 */
export function matchInterests(repo, { config, weights = new Map(), includeReadme = false }) {
  const fields = buildFields(repo, { includeReadme });
  const results = [];

  for (const interest of config.interests) {
    const learned = weights.get(`tag:${interest.tag}`)?.value ?? 0;
    const effectiveWeight = interest.weight * (1 + 0.6 * learned);

    /**
     * 关键词级别的反馈权重。作用是把「llm-engineering 这个方向」细化成
     * 「具体是 eval 还是 tokenizer 打动了我」——你反复忽略含某个词的条目后，
     * 那个词会自己沉下去，而不用你去改配置文件。
     */
    const hits = [];
    let evidence = 0;
    for (const keyword of interest.keywords) {
      const matchedFields = [];
      let keywordEvidence = 0;
      for (const [field, text] of Object.entries(fields)) {
        if (!text || !includesKeyword(text, keyword)) continue;
        matchedFields.push(field);
        keywordEvidence = Math.max(keywordEvidence, FIELD_EVIDENCE_WEIGHT[field] ?? 0.3);
      }
      if (!matchedFields.length) continue;
      const kwLearned = weights.get(`kw:${keyword}`)?.value ?? 0;
      // 反馈也能改变单个词的证据强度：被反复忽略的词，说了等于没说
      const weighted = Math.max(keywordEvidence * (1 + 0.5 * kwLearned), 0.05);
      evidence += weighted;
      hits.push({
        keyword,
        fields: matchedFields,
        fieldWeight: round(keywordEvidence, 2),
        learned: round(kwLearned, 3),
        weight: round(weighted, 3),
      });
    }

    const strength = hits.length
      ? clamp(1 - Math.exp(-evidence / EVIDENCE_SATURATION_K), 0, 1)
      : 0;

    results.push({
      tag: interest.tag,
      weight: interest.weight,
      effectiveWeight: Math.max(effectiveWeight, 0.05),
      learned,
      hits,
      matchedKeywords: hits.map((hit) => hit.keyword),
      evidence: round(evidence, 3),
      strength,
    });
  }

  return results;
}

export function scoreQuality(repo) {
  const parts = {};
  /**
   * 质量分刻意做成连续曲线而不是阶梯。
   *
   * 旧版本用「README >= 3000 字符就算满分、description >= 60 字符就给 0.2」这种阈值，
   * 结果是把候选收窄到「都有一份像样 README」之后，这一项也集体顶到 1.0，
   * 和兴趣分一起变成常数。改成对数刻度之后，
   * 4KB 和 20KB 的 README 才拉得开差距。
   */
  const logScore = (value, floor, ceiling) => {
    if (!value || value <= floor) return 0;
    return clamp(Math.log10(value / floor) / Math.log10(ceiling / floor), 0, 1);
  };

  parts.description = round(0.15 * logScore((repo.description ?? '').length, 20, 400), 4);
  parts.topics = round(0.15 * clamp((repo.topics ?? []).length / 8, 0, 1), 4);
  // license 和 demo 站点是二值信号，没有什么"程度"，保持原样
  parts.license = repo.license ? 0.1 : 0;
  parts.homepage = repo.homepage ? 0.15 : 0;
  parts.readme = round(0.3 * logScore(repo.readmeChars ?? 0, 200, 20000), 4);
  // 创建之后又推送过：说明不是一次性 dump
  parts.freshness = repo.pushedAt && repo.createdAt && repo.pushedAt !== repo.createdAt ? 0.15 : 0;

  const score = Object.values(parts).reduce((sum, value) => sum + value, 0);
  return { score: clamp(round(score, 4), 0, 1), parts };
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

  /**
   * 四个维度的权重可以调。这不是装饰性的开关：
   * 「兴趣匹配」和「早期动量」之间的取舍，就是
   * 「宁可多看几个还没人发现的」还是「优先看已经有验证的」这个价值判断，
   * 只有你自己能决定，所以不该写死在代码里。
   */
  const dimensionWeights = { ...DEFAULT_WEIGHTS, ...(config?.ranking?.weights ?? {}) };
  const weighted =
    dimensionWeights.interest * interestScore +
    dimensionWeights.quality * quality.score +
    dimensionWeights.momentum * momentum.score +
    dimensionWeights.author * author.score;

  const total = clamp(weighted - penaltyTotal, 0, 1);

  const matchedTags = interestMatches.filter((m) => m.hits.length).map((m) => m.tag);
  const matchedKeywords = interestMatches.flatMap((m) => m.matchedKeywords);

  return {
    total: round(total, 4),
    parts: {
      interest: round(interestScore, 4),
      quality: round(quality.score, 4),
      momentum: round(momentum.score, 4),
      author: round(author.score, 4),
      penalty: round(penaltyTotal, 4),
    },
    weights: dimensionWeights,
    detail: {
      interest: interestMatches.map((m) => ({
        tag: m.tag,
        hits: m.hits.map((hit) => hit.keyword),
        evidence: m.evidence,
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
  if (top) bits.push(`关键词 ${top.matchedKeywords.slice(0, 4).join('、')}`);
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
