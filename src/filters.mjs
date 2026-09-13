import { includesKeyword, normalizeText } from './util.mjs';

/**
 * 零成本预过滤层。
 *
 * 这一层的价值被严重低估：每天新建的公开仓库里 95% 以上是
 * 课程作业、练习仓库、空仓库、镜像、Awesome 列表。把它们在调用 LLM 之前丢掉，
 * 是成本能压到几美分、而不是几美元的根本原因。
 */

export const JUNK_NAME_PATTERNS = [
  /^test(ing)?[-_0-9]*$/i,
  /^demo[-_0-9]*$/i,
  /^hello[-_]?world/i,
  /^untitled/i,
  /^new[-_]?repo/i,
  /^my[-_]?(first|test|project)/i,
  /^leetcode/i,
  /^study[-_]?(notes|record)/i,
  /^practice/i,
  /^\d+$/,
];

export const JUNK_TEXT_PATTERNS = [
  /first repository/i,
  /my first repo/i,
  /just (a )?test/i,
  /testing github/i,
  /学习笔记/,
  /课程设计/,
  /课程作业/,
  /实验报告/,
  /刷题记录/,
  /\bleetcode (solution|solutions|题解)/i,
  /^a curated list of/i,
  /^awesome[- ]/i,
  /collection of (my )?(notes|scripts)/i,
];

/** 生成用于关键词匹配的文本（不含 README，README 单独处理） */
export function repoText(repo) {
  return normalizeText(
    [repo.name, repo.description, ...(repo.topics ?? []), repo.owner].filter(Boolean).join(' \n '),
  );
}

export function matchAnyKeyword(haystack, keywords) {
  const hits = [];
  for (const keyword of keywords) {
    if (includesKeyword(haystack, keyword)) hits.push(keyword);
  }
  return hits;
}

/**
 * 对单个仓库做规则判断。
 * 返回 { ok: true, notes } 或 { ok: false, rule, reason }。
 */
export function filterRepo(repo, { config, day } = {}) {
  const { filters, excludes } = config;
  const notes = [];

  if (!repo?.fullName) return { ok: false, rule: 'invalid', reason: '缺少 full_name' };

  if ((excludes.owners ?? []).some((owner) => owner.toLowerCase() === String(repo.owner).toLowerCase())) {
    return { ok: false, rule: 'excluded-owner', reason: `owner ${repo.owner} 在排除名单里` };
  }

  if (repo.isFork && !filters.allowForks) {
    return { ok: false, rule: 'fork', reason: '是 fork 的仓库' };
  }

  if (repo.archived) {
    return { ok: false, rule: 'archived', reason: '仓库已归档' };
  }

  for (const pattern of filters.blockedNamePatterns ?? []) {
    if (new RegExp(pattern, 'i').test(repo.name ?? '')) {
      return { ok: false, rule: 'blocked-name', reason: `仓库名命中屏蔽规则 /${pattern}/` };
    }
  }

  for (const pattern of JUNK_NAME_PATTERNS) {
    if (pattern.test(repo.name ?? '')) {
      return { ok: false, rule: 'junk-name', reason: `仓库名像练习/测试仓库（/${pattern.source}/）` };
    }
  }

  if (repo.language && (excludes.languages ?? []).some((lang) => lang.toLowerCase() === String(repo.language).toLowerCase())) {
    return { ok: false, rule: 'excluded-language', reason: `语言 ${repo.language} 被排除` };
  }

  const topicList = (repo.topics ?? []).map((t) => String(t).toLowerCase());
  const hitTopic = (excludes.topics ?? []).find((topic) => topicList.includes(String(topic).toLowerCase()));
  if (hitTopic) {
    return { ok: false, rule: 'excluded-topic', reason: `topic「${hitTopic}」被排除` };
  }

  const text = repoText(repo);
  const hitKeyword = matchAnyKeyword(text, excludes.keywords ?? []);
  if (hitKeyword.length) {
    return { ok: false, rule: 'excluded-keyword', reason: `命中排除关键词「${hitKeyword[0]}」` };
  }

  for (const pattern of JUNK_TEXT_PATTERNS) {
    if (pattern.test(repo.description ?? '') || pattern.test(repo.name ?? '')) {
      return { ok: false, rule: 'junk-text', reason: `描述命中垃圾特征（/${pattern.source}/）` };
    }
  }

  const sizeKb = repo.sizeKb ?? 0;
  if (filters.minSizeKb && sizeKb < filters.minSizeKb) {
    return { ok: false, rule: 'too-small', reason: `体积 ${sizeKb}KB 低于下限 ${filters.minSizeKb}KB` };
  }
  if (filters.maxSizeKb && sizeKb > filters.maxSizeKb) {
    return { ok: false, rule: 'too-large', reason: `体积 ${sizeKb}KB 超过上限 ${filters.maxSizeKb}KB` };
  }

  const stars = repo.stars ?? 0;
  if (filters.minStars && stars < filters.minStars) {
    return { ok: false, rule: 'min-stars', reason: `star 数 ${stars} 低于下限 ${filters.minStars}` };
  }
  if (filters.maxStars && stars > filters.maxStars) {
    return { ok: false, rule: 'max-stars', reason: `star 数 ${stars} 超过上限 ${filters.maxStars}` };
  }

  if (filters.requireDescription && !repo.description) {
    return { ok: false, rule: 'no-description', reason: '没有 description' };
  }

  // 日期校准：search 的 created: 是按 UTC 日历日过滤的，这里做一次自检，
  // 防止镜像源或 fixtures 混入不属于这一天的数据。
  if (day && repo.createdAt) {
    const createdDay = String(repo.createdAt).slice(0, 10);
    if (createdDay !== day) {
      return { ok: false, rule: 'wrong-day', reason: `创建于 ${createdDay}，不属于 ${day}` };
    }
  }

  if (!repo.description && (repo.topics ?? []).length === 0) {
    notes.push('既没有 description 也没有 topics，判断依据只有 README');
  }

  return { ok: true, notes };
}

export function applyFilters(repos, { config, day } = {}) {
  const passed = [];
  const rejected = [];
  const byRule = new Map();

  for (const repo of repos) {
    const verdict = filterRepo(repo, { config, day });
    if (verdict.ok) {
      passed.push({ ...repo, notes: verdict.notes });
    } else {
      rejected.push({ repo, rule: verdict.rule, reason: verdict.reason });
      byRule.set(verdict.rule, (byRule.get(verdict.rule) ?? 0) + 1);
    }
  }

  return {
    passed,
    rejected,
    byRule: Object.fromEntries([...byRule.entries()].sort((a, b) => b[1] - a[1])),
  };
}
