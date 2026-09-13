import { filterRepo } from './filters.mjs';
import { FIELD_EVIDENCE_WEIGHT, FIELD_LABELS, buildFields, matchInterests, scoreHeuristic } from './heuristic.mjs';
import { round } from './util.mjs';

/**
 * 解释器：把一个项目的得分拆到「哪一个关键词、在哪一个字段里命中的」。
 *
 * 这个模块存在的唯一理由是回答那个最常被问的问题：
 *   「它凭什么被选中？」「我明明关心 X，为什么这个没出现？」
 *
 * 关键在于把匹配来源分开统计。一个项目被选中，可能是因为它的 topics 标签、
 * 也可能是因为 README 里某个词——这两者的含义完全不同：
 * 前者说明作者主动标了这个方向，后者只说明文中提到过。
 */

export { FIELD_LABELS };

/** 字段的检查顺序，也是 explain 输出里展示的顺序 */
export const MATCH_FIELDS = ['name', 'topics', 'description', 'language', 'readme'];

export function explainRepo(repo, { config, weights = new Map(), authorStats = new Map(), day = null } = {}) {
  const fields = buildFields(repo, { includeReadme: true });
  const heuristic = scoreHeuristic(repo, { config, weights, authorStats, includeReadme: true });
  const matches = matchInterests(repo, { config, weights, includeReadme: true });

  const tags = matches.map((match) => ({
    tag: match.tag,
    weight: match.weight,
    effectiveWeight: round(match.effectiveWeight, 3),
    learned: round(match.learned, 3),
    strength: round(match.strength, 3),
    evidence: match.evidence,
    // matchInterests 已经把「命中在哪个字段、该字段的证据权重是多少」算好了
    hits: match.hits,
  }));

  const fieldHits = Object.fromEntries(MATCH_FIELDS.map((field) => [field, 0]));
  for (const tag of tags) {
    for (const hit of tag.hits) {
      for (const field of hit.fields) fieldHits[field] += 1;
    }
  }

  const allMatched = new Set(matches.flatMap((match) => match.matchedKeywords));
  const missedKeywords = config.interests
    .flatMap((interest) => interest.keywords.map((keyword) => ({ tag: interest.tag, keyword })))
    .filter(({ keyword }) => !allMatched.has(keyword))
    .map(({ tag, keyword }) => ({ tag, keyword }));

  // 规则层：如果它压根没通过过滤，分数就没有意义了——先说清楚这一点
  const filterDay = day ?? (repo.createdAt ? String(repo.createdAt).slice(0, 10) : null);
  const filterVerdict = filterRepo(repo, { config, day: filterDay });

  return {
    repo,
    fields,
    heuristic,
    tags,
    fieldHits,
    missedKeywords,
    filterVerdict,
    readmeMissing: !repo.readmeText,
  };
}

function bar(count, max, width = 20) {
  if (!count) return '';
  const filled = Math.max(1, Math.round((count / Math.max(max, 1)) * width));
  return '█'.repeat(filled);
}

export function formatExplanation(explanation, { savedScore = null, savedLlm = null } = {}) {
  const { repo, heuristic, tags, fieldHits, missedKeywords, filterVerdict, readmeMissing } = explanation;
  const lines = [];

  const meta = [
    `⭐ ${repo.stars ?? 0}`,
    repo.language ?? '未知语言',
    repo.license ?? '无 license',
    repo.sizeKb ? `${repo.sizeKb}KB` : null,
    repo.firstSeenDate ? `收录于 ${repo.firstSeenDate}` : null,
  ].filter(Boolean);

  lines.push(`${repo.fullName}  ·  ${meta.join(' · ')}`);
  if (repo.description) lines.push(`描述：${repo.description}`);
  lines.push(`topics：${(repo.topics ?? []).length ? repo.topics.join(', ') : '(作者没有填)'}`);
  lines.push(`README：${repo.readmeChars ? `${repo.readmeChars} 字符` : '**没有拉到**'}`);
  lines.push('');

  /* ---------------------------------------------------------- 规则层 */
  lines.push('【1】规则过滤');
  if (filterVerdict.ok) {
    lines.push('  通过。没有任何排除规则命中它。');
  } else {
    lines.push(`  被拦下：${filterVerdict.rule} —— ${filterVerdict.reason}`);
    lines.push('  这种情况下它不会进入评分，下面的分数只作参考。');
  }
  lines.push('');

  /* ---------------------------------------------------------- 兴趣层 */
  const hitTags = tags.filter((tag) => tag.hits.length);
  lines.push(`【2】兴趣匹配（${hitTags.length}/${tags.length} 个方向命中）`);
  for (const tag of tags) {
    const marker = tag.hits.length ? '●' : '○';
    const learnedNote = tag.learned ? ` 反馈 ${tag.learned > 0 ? '+' : ''}${tag.learned}` : '';
    lines.push(
      `  ${marker} ${tag.tag}  权重 ${tag.weight.toFixed(2)} → 实际 ${tag.effectiveWeight.toFixed(2)}` +
        ` 强度 ${tag.strength.toFixed(2)}${learnedNote}`,
    );
    for (const hit of tag.hits) {
      const where = hit.fields
        .map((field) => `${FIELD_LABELS[field]}(×${FIELD_EVIDENCE_WEIGHT[field]})`)
        .join(' + ');
      const learnedNote = hit.learned ? ` 反馈 ${hit.learned > 0 ? '+' : ''}${hit.learned}` : '';
      lines.push(`      · ${hit.keyword.padEnd(18)} ← ${where} = 证据 ${hit.weight}${learnedNote}`);
    }
    if (tag.hits.length) {
      lines.push(
        `      合计证据 ${tag.evidence} → 强度 ${tag.strength.toFixed(2)}` +
          `（饱和曲线：1 - e^(-证据/3)，堆词堆不出满分）`,
      );
    }
  }
  lines.push('');

  /* ------------------------------------------------------ 命中来源分布 */
  const maxHits = Math.max(...Object.values(fieldHits), 1);
  lines.push('【3】关键词是从哪里找到的');
  for (const field of MATCH_FIELDS) {
    const count = fieldHits[field];
    lines.push(`  ${FIELD_LABELS[field].padEnd(12)} ${String(count).padStart(3)}  ${bar(count, maxHits)}`);
  }
  if (readmeMissing) {
    lines.push('  ⚠️ README 没拉到，等于少了一个最大的文本来源，兴趣命中和质量分都会偏低。');
  }
  lines.push('');

  /* ---------------------------------------------------------- 分数构成 */
  const parts = heuristic.parts;
  lines.push('【4】分数构成');
  const w = heuristic.weights ?? { interest: 0.45, quality: 0.25, momentum: 0.2, author: 0.1 };
  const rows = [
    ['兴趣匹配', parts.interest, w.interest],
    ['工程质量', parts.quality, w.quality],
    ['早期动量', parts.momentum, w.momentum],
    ['作者先验', parts.author, w.author],
  ];
  let weighted = 0;
  for (const [label, value, weight] of rows) {
    weighted += value * weight;
    lines.push(`  ${label}  ${value.toFixed(2)} × ${weight.toFixed(2)} = ${(value * weight).toFixed(3)}`);
  }
  lines.push(`  ${'─'.repeat(38)}`);
  lines.push(`  加权合计                       ${weighted.toFixed(3)}`);
  if (heuristic.penalties.length) {
    for (const penalty of heuristic.penalties) {
      lines.push(`  惩罚  -${penalty.amount.toFixed(2)}  ${penalty.reason}`);
    }
  }
  lines.push(`  综合分（启发式）               ${heuristic.total.toFixed(3)}`);
  if (savedLlm) {
    lines.push('');
    lines.push(`  LLM 评分：契合 ${savedLlm.fit}/10 · 新颖 ${savedLlm.novelty}/10 · 完成度 ${savedLlm.quality}/10`);
    if (savedLlm.verdict) lines.push(`  LLM 结论：${savedLlm.verdict}`);
    if (savedLlm.why) lines.push(`  LLM 理由：${savedLlm.why}`);
    if (savedLlm.caution) lines.push(`  LLM 存疑：${savedLlm.caution}`);
  } else if (savedScore && savedScore.llm_score === null) {
    lines.push('  （这次运行没有 LLM 分数，排序完全由上面的启发式决定）');
  }
  lines.push('');

  /* ------------------------------------------------------ 没命中的词 */
  if (missedKeywords.length) {
    const grouped = new Map();
    for (const { tag, keyword } of missedKeywords) {
      if (!grouped.has(tag)) grouped.set(tag, []);
      grouped.get(tag).push(keyword);
    }
    lines.push('【5】画像里有、但这个项目完全没出现的词');
    for (const [tag, keywords] of grouped) {
      lines.push(`  ${tag}: ${keywords.slice(0, 12).join('、')}${keywords.length > 12 ? ' …' : ''}`);
    }
    lines.push('  这些词没命中很正常。但如果某个方向**反复**整列不命中，说明该调整配置了。');
    lines.push('');
  }

  lines.push(`一句话总结：${heuristic.rankReason}`);
  return lines.join('\n');
}
