import path from 'node:path';
import { formatCount, formatDelta, round, truncate, writeJsonFile, writeTextFile } from './util.mjs';

/**
 * 渲染层：把评分结果变成一份可以直接读的 Markdown，外加一份机器可读的 JSON。
 *
 * JSON 那份不是附带产物——它是后面做 Web UI、diff 两天的结果、
 * 或者接你自己的通知渠道时的输入。
 */

export function digestPaths({ outputDir, day }) {
  return {
    markdown: path.join(outputDir, `digest-${day}.md`),
    json: path.join(outputDir, `digest-${day}.json`),
  };
}

function trendLabel(trend) {
  if (!trend) return '';
  const delta = trend.delta ?? 0;
  if (!delta) return '';
  return `${formatDelta(delta)} since ${trend.firstOn}`;
}

/** 展示用的 star 数取最新一次观测，而不是 scan 当时的快照 */
function displayStars(item) {
  return item.trend?.latestStars ?? item.repo.stars ?? 0;
}

function scoreLine(item) {
  const bits = [`启发式 ${item.heuristic.total.toFixed(2)}`];
  if (item.llm) bits.push(`LLM ${item.llm.score.toFixed(2)}`);
  bits.push(`综合 ${item.final.toFixed(2)}`);
  return bits.join(' · ');
}

export function renderDigest({ day, config, items, report, funnel, llmInfo, generatedAt, extraNotes = [] }) {
  const lines = [];

  /**
   * 质量下限。
   *
   * 没有下限的时候，候选少的日子会把明显不相关的项目也塞进精选——
   * 因为 shortlistSize 是个固定值，凑不满就往下捞。
   * 宁可在日报里写「今天没有值得看的东西」，也不要让噪音稀释掉信号。
   */
  const floor = config.ranking?.displayFloor ?? 0;
  const qualified = floor > 0 ? items.filter((item) => item.final >= floor) : items;
  const lowConfidence = floor > 0 ? items.filter((item) => item.final < floor) : [];

  const highlightCount = Math.min(qualified.length, config.ranking.highlightCount ?? 5);
  const highlights = qualified.slice(0, highlightCount);
  const rest = qualified.slice(highlightCount);

  lines.push(`# MetaScanning 日报 · ${day}`);
  lines.push('');

  const sourceLabel =
    report.source === 'fixture' ? '离线 fixtures 数据（非真实扫描）' : 'GitHub Search API';
  const llmLabel = llmInfo.used ? `LLM 打分：${llmInfo.model}` : 'LLM 打分：未启用（纯启发式排序）';
  lines.push(
    `> 画像 **${config.profile.name}** · 数据源 ${sourceLabel} · ${llmLabel}`,
  );
  lines.push(
    `> 候选 ${formatCount(report.uniqueRepos)} → 过滤后 ${formatCount(funnel.passed.length)} → ` +
      `评分 ${formatCount(items.length)} → 精选 ${formatCount(qualified.length)}` +
      `${lowConfidence.length ? `（另有 ${lowConfidence.length} 条低于质量下限）` : ''} · 生成于 ${generatedAt}`,
  );
  lines.push('');

  if (report.source === 'fixture') {
    lines.push('> ⚠️ 这是 `--offline` 的演示数据，用来验证流水线本身。去掉 `--offline` 才是真实扫描。');
    lines.push('');
  }
  for (const note of extraNotes) {
    lines.push(`> ⚠️ ${note}`);
    lines.push('');
  }

  if (!qualified.length) {
    lines.push('## 今天没有符合条件的结果');
    lines.push('');
    lines.push(
      items.length
        ? `有 ${items.length} 条候选，但综合分都低于质量下限 ${floor}。`
        : '可能的原因：过滤规则太严、`collection.starTiers` 区间太窄、或者当天确实没有相关项目。',
    );
    lines.push('可以试着放宽 `filters.minSizeKb`，或把 `0` 加进 `collection.starTiers` 来扫描零 star 的新项目。');
    lines.push('');
  } else {
    lines.push('## 今日精选');
    lines.push('');
    highlights.forEach((item, index) => {
      lines.push(...renderHighlight(item, index + 1));
    });
  }

  if (rest.length) {
    lines.push('## 也值得扫一眼');
    lines.push('');
    rest.forEach((item, index) => {
      const stars = `⭐ ${formatCount(displayStars(item))}`;
      const trend = trendLabel(item.trend);
      const verdict = item.llm?.verdict || item.repo.description || '(无描述)';
      lines.push(
        `${index + 1}. **[${item.repo.fullName}](${item.repo.url})** · ${stars}` +
          `${trend ? ` (${trend})` : ''} · \`${item.repo.language ?? '未知'}\` · 综合 ${item.final.toFixed(2)}`,
      );
      lines.push(`   ${truncate(verdict, 140)}`);
      lines.push(`   命中：${item.heuristic.matchedTags.join('、') || '无'}`);
    });
    lines.push('');
  }

  // 放在最后：它是核对用的参考信息，不该挡在正文前面
  if (lowConfidence.length) {
    lines.push(`## 低置信度（综合分 < ${floor}）`);
    lines.push('');
    lines.push(
      '这些项目通过了规则过滤，但综合分没到质量下限，**多半是噪音**。' +
        '列出来只为了让你能核对过滤规则——如果里面有你想要的，说明 `excludes` 太松或者 `interests` 缺了方向。',
    );
    lines.push('');
    for (const item of lowConfidence) {
      lines.push(
        `- [${item.repo.fullName}](${item.repo.url}) · ⭐ ${formatCount(displayStars(item))} · ` +
          `${item.final.toFixed(2)} · ${truncate(item.llm?.verdict || item.repo.description || '(无描述)', 90)}`,
      );
    }
    lines.push('');
  }

  lines.push(...renderCoverage({ report, funnel, config }));
  lines.push(...renderFeedbackSection(qualified));

  return lines.join('\n');
}

function renderHighlight(item, rank) {
  const lines = [];
  const { repo, heuristic, llm, deep, final, trend } = item;
  const stars = `⭐ ${formatCount(displayStars(item))}`;
  const trendText = trendLabel(trend);

  lines.push(`### ${rank}. [${repo.fullName}](${repo.url})`);
  lines.push('');
  lines.push(
    `${stars}${trendText ? ` (${trendText})` : ''} · \`${repo.language ?? '未知'}\`` +
      `${repo.license ? ` · ${repo.license}` : ''}` +
      `${(repo.topics ?? []).length ? ` · ${repo.topics.slice(0, 6).map((t) => `\`${t}\``).join(' ')}` : ''}`,
  );
  lines.push('');
  if (repo.description) {
    lines.push(`**描述**：${repo.description}`);
    lines.push('');
  }
  if (llm?.verdict) {
    lines.push(`**结论**：${llm.verdict}`);
    lines.push('');
  }
  if (llm?.why) {
    lines.push(`**为什么值得看**：${llm.why}`);
    lines.push('');
  }
  if (deep?.summary) {
    lines.push(`**它到底做了什么**：${deep.summary}`);
    lines.push('');
  }
  if (deep?.why_it_matters) {
    lines.push(`**对你的价值**：${deep.why_it_matters}`);
    lines.push('');
  }
  if (deep?.try_first) {
    lines.push(`**上手第一步**：${deep.try_first}`);
    lines.push('');
  }
  if (llm?.caution || deep?.risks || heuristic.penalties.length) {
    const cautions = [llm?.caution, deep?.risks, ...heuristic.penalties.map((p) => p.reason)].filter(Boolean);
    lines.push(`**存疑**：${cautions.join('；')}`);
    lines.push('');
  }
  lines.push(
    `*命中方向：${heuristic.matchedTags.join('、') || '无'} · ${scoreLine(item)} · ` +
      `${heuristic.rankReason}*`,
  );
  lines.push('');
  return lines;
}

function renderCoverage({ report, funnel, config }) {
  const lines = ['## 扫描覆盖与过滤漏斗', ''];

  if (report.source === 'fixture') {
    lines.push(`- 数据源：离线 fixtures（${report.uniqueRepos} 条）`);
  } else {
    lines.push(
      `- 分片：计划 ${report.plannedShards} 个（来自 ${report.plannedTiers ?? '?'} 个 star 区间），` +
        `处理 ${report.processedShards} 个` +
        `${report.skippedShards ? `，**跳过 ${report.skippedShards} 个**` : ''}` +
        `${report.budgetExhausted ? '（搜索预算耗尽）' : ''}`,
    );
    if (report.emptyShards) {
      lines.push(`- 其中 ${report.emptyShards} 个分片当天没有新项目（空区间不会继续拆分，不浪费请求）`);
    }
    lines.push(
      `- API 请求：${report.requests} 次${report.authenticated ? '（已认证）' : '（**未认证，限流很紧**）'}` +
        `${report.requestLimit ? `，其中搜索 ${report.searchRequests}/${report.requestLimit} 次` : ''}`,
    );
    lines.push(
      `- 撞到 1000 条上限的分片：${report.truncatedShards} 个` +
        `${report.unresolvedShards ? `，其中 ${report.unresolvedShards} 个无法再拆分（数据不完整）` : ''}`,
    );
    if (report.failedShards) lines.push(`- 失败分片：${report.failedShards} 个`);
  }

  const passedCount = Array.isArray(funnel.passed) ? funnel.passed.length : (funnel.passed ?? 0);
  lines.push(`- 过滤：${formatCount(report.uniqueRepos)} → ${formatCount(passedCount)}`);
  const topReasons = Object.entries(funnel.byRule ?? {}).slice(0, 8);
  if (topReasons.length) {
    lines.push(`- 主要淘汰原因：${topReasons.map(([rule, n]) => `${rule} ${n}`).join(' · ')}`);
  }
  if (config.ranking.enrichLimit) {
    lines.push(`- README 富化上限：${config.ranking.enrichLimit} 条；LLM 候选上限：${config.ranking.llmCandidateLimit} 条`);
  }
  for (const warning of report.warnings ?? []) {
    lines.push(`- ⚠️ ${warning}`);
  }
  lines.push('');
  return lines;
}

function renderFeedbackSection(items) {
  const lines = ['## 快速反馈（闭环就靠这一步）', ''];
  lines.push('反馈会更新兴趣权重，明天的排序就会变。这一步不做，工具就退化成普通的趋势列表。');
  lines.push('');
  lines.push('```bash');
  const samples = items.slice(0, 2);
  samples.forEach((item, index) => {
    const action = index === 0 ? '--save' : '--ignore';
    lines.push(`node bin/metascan.mjs feedback ${item.repo.fullName} ${action}`);
  });
  lines.push('node bin/metascan.mjs feedback <owner/repo> --deep --note "想深入看这个方向"');
  lines.push('node bin/metascan.mjs weights   # 看看系统从你的反馈里学到了什么');
  lines.push('```');
  lines.push('');
  return lines;
}

export function buildDigestPayload({ day, config, items, report, funnel, llmInfo, generatedAt }) {
  const floor = config.ranking?.displayFloor ?? 0;
  const toPick = (item, index) => ({
    rank: index + 1,
    fullName: item.repo.fullName,
    url: item.repo.url,
    description: item.repo.description,
    language: item.repo.language,
    topics: item.repo.topics,
    stars: displayStars(item),
    starsAtScan: item.repo.stars,
    forks: item.repo.forks,
    createdAt: item.repo.createdAt,
    trend: item.trend ?? null,
    scores: {
      heuristic: round(item.heuristic.total, 4),
      llm: item.llm ? round(item.llm.score, 4) : null,
      final: round(item.final, 4),
    },
    parts: item.heuristic.parts,
    matchedTags: item.heuristic.matchedTags,
    matchedKeywords: item.heuristic.matchedKeywords,
    penalties: item.heuristic.penalties,
    verdict: item.llm?.verdict ?? null,
    why: item.llm?.why ?? null,
    caution: item.llm?.caution ?? null,
    deep: item.deep ?? null,
  });

  const qualified = floor > 0 ? items.filter((item) => item.final >= floor) : items;
  const lowConfidence = floor > 0 ? items.filter((item) => item.final < floor) : [];

  return {
    day,
    generatedAt,
    displayFloor: floor,
    profile: {
      name: config.profile.name,
      description: config.profile.description,
      tags: config.interests.map((i) => i.tag),
    },
    source: report.source,
    isFixture: Boolean(report.isFixture),
    llm: llmInfo,
    coverage: {
      plannedShards: report.plannedShards,
      processedShards: report.processedShards,
      skippedShards: report.skippedShards,
      requests: report.requests,
      authenticated: report.authenticated,
      truncatedShards: report.truncatedShards,
      unresolvedShards: report.unresolvedShards,
      budgetExhausted: report.budgetExhausted,
      warnings: report.warnings ?? [],
    },
    funnel: {
      candidates: report.uniqueRepos,
      passed: funnel.passed,
      scored: items.length,
      byRule: funnel.byRule ?? {},
    },
    picks: qualified.map(toPick),
    lowConfidencePicks: lowConfidence.map(toPick),
  };
}

export function writeDigest({ outputDir, day, markdown, payload }) {
  const paths = digestPaths({ outputDir, day });
  writeTextFile(paths.markdown, markdown);
  writeJsonFile(paths.json, payload);
  return paths;
}
