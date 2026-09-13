import { collectCandidates } from './collect.mjs';
import { createGitHubClient } from './github.mjs';
import { applyFilters } from './filters.mjs';
import { enrichRepos } from './enrich.mjs';
import { rankCandidates, scoreHeuristic } from './heuristic.mjs';
import { createLlmClient, estimateCost, fuseScores } from './llm.mjs';
import { loadFixtureRepos } from './fixtures.mjs';
import { buildDigestPayload, renderDigest, writeDigest } from './digest.mjs';
import { openStore } from './store.mjs';
import { resolveFrom, truncate, nowISO, log, formatCount, uniq } from './util.mjs';

/**
 * 每日扫描的主流程。
 *
 *   采集 → 规则过滤 → 便宜评分 → README 富化 → 重新评分 → LLM 打分 → 融合排序 → 落库 + 出报告
 *
 * 顺序不是随手排的：README 拉取和 LLM 调用是仅有的两个有边际成本的动作，
 * 所以它们都被放在便宜过滤之后，并且各有独立的数量上限。
 */
export async function runScan({
  day,
  config,
  cwd = process.cwd(),
  offline = false,
  includeZeroStar = false,
  useLlm = null,
  // 测试用：注入 LLM 的 fetch 实现，避免真实网络调用
  llmFetchImpl = globalThis.fetch,
  // 测试用：注入 GitHub 的 fetch 实现
  githubFetchImpl = globalThis.fetch,
  logger = log,
  onProgress = null,
}) {
  const outputDir = resolveFrom(cwd, config.output.dir);
  const dataDir = resolveFrom(cwd, config.output.dataDir);
  const store = openStore({ dataDir });
  const startedAt = nowISO();
  const source = offline ? 'fixture' : 'github';
  const extraNotes = [];
  const timings = {};

  store.startRun({ runDate: day, source, startedAt });

  try {
    /* ---------------------------------------------------------- 1. 采集 */
    let stageStart = Date.now();
    let repos;
    let report;
    let client = null;

    if (offline) {
      ({ repos, report } = loadFixtureRepos({ day, cwd }));
      logger.step('离线模式', `载入 ${repos.length} 条 fixtures 数据`);
    } else {
      /**
       * 预算拆分。
       *
       * maxRequests 是这次运行的**总**预算，其中一部分必须留给 README 富化。
       * 之前这里是「搜索先用到把预算花光」，结果是富化一次都没跑成——
       * 而 README 恰好是质量分最大的来源，等于在信息残缺的情况下打分。
       */
      const totalBudget = config.collection.maxRequests;
      const reserveRatio = config.collection.readmeReserveRatio ?? 0.25;
      const readmeReserve = Math.max(
        3,
        Math.min(config.ranking.enrichLimit ?? 20, Math.round(totalBudget * reserveRatio)),
      );
      const searchBudget = Math.max(1, totalBudget - readmeReserve);

      client = createGitHubClient({
        maxRequests: totalBudget,
        minIntervalMs: config.collection.minIntervalMs ?? undefined,
        fetchImpl: githubFetchImpl,
        logger,
      });
      logger.step(
        '采集',
        `${client.authenticated ? '已认证' : '未认证（限流 10 次/分钟）'} · ` +
          `预算 ${totalBudget} 次 = 搜索 ${searchBudget} + README 预留 ${readmeReserve}` +
          ` · 最长约 ${Math.ceil((totalBudget * client.intervalMs) / 60_000)} 分钟`,
      );
      ({ repos, report } = await collectCandidates({
        day,
        config,
        client,
        includeZeroStar,
        requestLimit: searchBudget,
        logger,
        onProgress: (p) => {
          if (p.processed % 5 === 0 || p.fetched > 0) {
            logger.info(
              `   [${p.processed}/${p.planned}] ${p.shard} → ${p.fetched}/${p.totalCount} 条` +
                `（累计 ${formatCount(p.found)} 个仓库）`,
            );
          }
          onProgress?.({ stage: 'collect', ...p });
        },
      }));
      if (!client.authenticated) {
        extraNotes.push(
          '这次运行没有 GITHUB_TOKEN：搜索接口被限流到 10 次/分钟，覆盖会很有限。' +
            '配置 token 后覆盖面和速度都会显著提升。',
        );
      }
    }
    timings.collectMs = Date.now() - stageStart;

    /* ------------------------------------------- 2. 复用库里已有的 README */
    repos = repos.map((repo) => {
      if (repo.readmeText) return repo;
      const existing = store.getRepo(repo.fullName);
      if (existing?.readmeText) {
        return {
          ...repo,
          readmeText: existing.readmeText,
          readmeChars: existing.readmeChars,
          hasReadme: true,
        };
      }
      return repo;
    });

    /* ------------------------------------------------------ 3. 规则过滤 */
    stageStart = Date.now();
    const funnel = applyFilters(repos, { config, day });
    timings.filterMs = Date.now() - stageStart;
    logger.step(
      '过滤',
      `${formatCount(repos.length)} → ${formatCount(funnel.passed.length)}（${Object.entries(funnel.byRule)
        .slice(0, 4)
        .map(([rule, n]) => `${rule}:${n}`)
        .join(', ')}）`,
    );

    const weights = store.getWeights();
    const authorStats = store.getAuthorStats();

    /* ------------------------------------------------- 4. 便宜的第一轮评分 */
    stageStart = Date.now();
    let scored = funnel.passed.map((repo) => ({
      repo,
      heuristic: scoreHeuristic(repo, { config, weights, authorStats, includeReadme: false }),
    }));

    const aboveThreshold = scored.filter((entry) => entry.heuristic.total >= config.ranking.minHeuristicScore);
    // 如果阈值把所有东西都筛掉了，就退回「分数最高的若干条」，避免空报告
    const pool = aboveThreshold.length ? aboveThreshold : scored;
    const toEnrich = rankCandidates(pool).slice(0, config.ranking.enrichLimit);
    timings.cheapScoreMs = Date.now() - stageStart;
    logger.step(
      '初筛',
      `${formatCount(scored.length)} 条评分，${formatCount(toEnrich.length)} 条进入 README 富化`,
    );

    /* --------------------------------------------- 5. README 富化 + 重评 */
    stageStart = Date.now();
    let enrichStats = { attempted: 0, fetched: 0, reused: 0, failed: 0, noReadme: 0, skippedBudget: 0 };
    let skippedFromRanking = [];
    let enrichedEntries = toEnrich;

    if (client && toEnrich.length) {
      const result = await enrichRepos(
        toEnrich.map((entry) => entry.repo),
        { client, logger, limit: toEnrich.length },
      );
      enrichStats = result.stats;
      enrichedEntries = toEnrich.map((entry, index) => ({ ...entry, repo: result.enriched[index] ?? entry.repo }));
      const skipped = enrichStats.skippedBudget ?? 0;
      logger.step(
        '富化',
        `README 新增 ${enrichStats.fetched}，复用 ${enrichStats.reused}，失败 ${enrichStats.failed}` +
          `${enrichStats.noReadme ? `，仓库确实没有 README ${enrichStats.noReadme}` : ''}` +
          `${skipped ? `，因预算跳过 ${skipped}` : ''}`,
      );

      if (skipped > 0) {
        /**
         * 被预算跳过的候选不能继续参与排序。
         * 有 README 的和没 README 的放在同一个榜单里比分数是不公平的——
         * 后者少了一大块文本，质量分和兴趣分天生偏低，
         * 而且它们的入选与否完全取决于前面 68 条谁先谁后，等于随机。
         */
        const skippedSet = new Set(enrichStats.skippedNames ?? []);
        const kept = enrichedEntries.filter((entry) => !skippedSet.has(entry.repo.fullName));
        if (kept.length > 0) {
          skippedFromRanking = enrichedEntries.filter((entry) => skippedSet.has(entry.repo.fullName));
          enrichedEntries = kept;
        }
        extraNotes.push(
          `有 ${skipped} 条候选因为请求预算不足没能拉取 README，已**排除在本次排序之外**` +
            `（没 README 的项目和有 README 的没法公平比较）。` +
            `本次搜索用了 ${report.searchRequests ?? '?'} 次请求；` +
            `想让这 ${toEnrich.length} 条候选全部拿到 README，` +
            `把 collection.maxRequests 提到 ${(report.searchRequests ?? 0) + toEnrich.length} 以上。`,
        );
      }
    }

    scored = enrichedEntries.map((entry) => ({
      repo: entry.repo,
      heuristic: scoreHeuristic(entry.repo, { config, weights, authorStats, includeReadme: true }),
    }));
    let ranked = rankCandidates(scored);
    timings.enrichMs = Date.now() - stageStart;

    /* ------------------------------------------------------- 6. LLM 打分 */
    stageStart = Date.now();
    const llmEnabled = useLlm === null ? Boolean(config.llm.enabled) : Boolean(useLlm);
    let llmInfo = { used: false, model: null, reason: '未启用', calls: 0, estimatedCostUsd: 0 };
    const candidates = ranked.slice(0, config.ranking.llmCandidateLimit);
    const remainder = ranked.slice(config.ranking.llmCandidateLimit);

    if (llmEnabled) {
      const llmClient = createLlmClient({
        model: process.env[config.llm.modelEnv] || undefined,
        temperature: config.llm.temperature,
        fetchImpl: llmFetchImpl,
        logger,
      });

      if (!llmClient.available) {
        llmInfo.reason = `未设置 ${config.llm.apiKeyEnv}，已退回纯启发式排序`;
        extraNotes.push(`开启了 LLM 打分但没有找到 ${config.llm.apiKeyEnv}，本次使用纯启发式排序。`);
        logger.warn(llmInfo.reason);
      } else {
        try {
          const { results, failedBatches, callErrors } = await llmClient.judge({
            profile: {
              description: config.profile.description,
              tags: config.interests.map((i) => i.tag),
            },
            items: candidates.map((entry) => toJudgeInput(entry.repo)),
            batchSize: config.llm.batchSize ?? 5,
          });

          for (const entry of candidates) {
            const judgement = results.get(entry.repo.fullName);
            if (judgement) entry.llm = judgement;
          }

          // 深度分析：只对最终最靠前的几个做
          const deepEnabled = config.llm.deep?.enabled;
          let deepCount = 0;
          if (deepEnabled) {
            const deepModel = process.env[config.llm.deep.modelEnv] || undefined;
            const topK = config.llm.deep.topK ?? 5;
            const preview = [...candidates]
              .map((entry) => ({ entry, final: fuseScores({ heuristic: entry.heuristic.total, llm: entry.llm?.score ?? null }) }))
              .sort((a, b) => b.final - a.final)
              .slice(0, topK);
            for (const { entry } of preview) {
              try {
                entry.deep = await llmClient.deepDive({
                  profile: { description: config.profile.description },
                  item: entry.repo,
                  model: deepModel,
                });
                deepCount += 1;
              } catch (error) {
                logger.warn(`深度分析失败 ${entry.repo.fullName}：${error.message}`);
              }
            }
          }

          const usage = llmClient.usage;
          llmInfo = {
            used: true,
            model: llmClient.model,
            calls: usage.calls,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            estimatedCostUsd: estimateCost(usage),
            judged: results.size,
            failedBatches,
            deepDives: deepCount,
          };
          // 区分「模型多说了一句话」和「接口真的挂了」——
          // 前者无害，后者通常说明 key / base URL / 模型名配错了，必须说清楚
          if (callErrors.length) {
            extraNotes.push(
              `LLM 接口出错（${callErrors[0]}），有 ${callErrors.length} 批候选只有启发式分数。` +
                `请检查 ${config.llm.apiKeyEnv} / ${config.llm.baseUrlEnv} / ${config.llm.modelEnv}。`,
            );
          } else if (failedBatches) {
            extraNotes.push(`有 ${failedBatches} 批 LLM 返回无法解析，这部分候选只有启发式分数。`);
          }
          logger.step(
            'LLM 打分',
            `${results.size} 条 · ${usage.calls} 次调用 · 约 $${llmInfo.estimatedCostUsd}`,
          );
        } catch (error) {
          llmInfo.reason = `调用失败：${error.message}`;
          extraNotes.push(`LLM 打分失败（${error.message}），本次使用纯启发式排序。`);
          logger.warn(llmInfo.reason);
        }
      }
    }
    timings.llmMs = Date.now() - stageStart;

    /* ------------------------------------------------------- 7. 融合排序 */
    const withFinal = [...candidates, ...remainder].map((entry) => ({
      ...entry,
      final: fuseScores({ heuristic: entry.heuristic.total, llm: entry.llm?.score ?? null }),
    }));
    withFinal.sort((a, b) => b.final - a.final);

    const shortlist = withFinal.slice(0, config.ranking.shortlistSize).map((entry) => ({
      ...entry,
      trend: store.getStarTrend(entry.repo.fullName),
    }));

    /* -------------------------------------------------- 8. 落库 + 快照 */
    stageStart = Date.now();
    const persistLimit = 5000;
    /**
     * 落库时要用「富化之后」的那份数据。
     *
     * funnel.passed 是富化之前的快照，里面没有刚拉到的 README——
     * 之前这里直接写 funnel.passed，结果是每天花几十次请求拉回来的 README
     * 一个都没进数据库：explain 显示「没有拉到」，
     * 而且第二天复用逻辑查不到东西，同样的钱再花一遍。
     */
    const enrichedByName = new Map(enrichedEntries.map((entry) => [entry.repo.fullName, entry.repo]));
    const toPersist = funnel.passed
      .slice(0, persistLimit)
      .map((repo) => enrichedByName.get(repo.fullName) ?? repo);
    for (const repo of toPersist) {
      store.upsertRepo(repo, { runDate: day });
      store.snapshotRepo(repo.fullName, {
        stars: repo.stars,
        forks: repo.forks,
        openIssues: repo.openIssues,
        takenOn: day,
      });
    }
    for (const entry of withFinal) {
      store.saveScore({
        fullName: entry.repo.fullName,
        runDate: day,
        heuristic: entry.heuristic.total,
        heuristicDetail: entry.heuristic,
        llmScore: entry.llm?.score ?? null,
        llmDetail: entry.llm ?? null,
        finalScore: entry.final,
        model: entry.llm ? llmInfo.model : null,
      });
    }
    timings.persistMs = Date.now() - stageStart;

    /* ---------------------------------------------------------- 9. 报告 */
    report.enrichment = {
      candidates: toEnrich.length,
      fetched: enrichStats.fetched,
      reused: enrichStats.reused,
      failed: enrichStats.failed,
      noReadme: enrichStats.noReadme,
      skippedBudget: enrichStats.skippedBudget,
      excludedFromRanking: skippedFromRanking.length,
    };

    const generatedAt = new Date().toISOString();
    const markdown = renderDigest({
      day,
      config,
      items: shortlist,
      report,
      funnel,
      llmInfo,
      generatedAt,
      extraNotes: uniq(extraNotes),
    });
    const payload = buildDigestPayload({ day, config, items: shortlist, report, funnel, llmInfo, generatedAt });
    const paths = writeDigest({ outputDir, day, markdown, payload });

    store.finishRun({
      runDate: day,
      candidates: report.uniqueRepos,
      afterFilter: funnel.passed.length,
      scored: withFinal.length,
      shown: shortlist.length,
      digestPath: paths.markdown,
      stats: { timings, enrichStats, llm: llmInfo, rejected: funnel.byRule },
    });

    return {
      day,
      source,
      report,
      funnel,
      items: shortlist,
      llmInfo,
      enrichStats,
      timings,
      paths,
      store: store.stats(),
      // 把采集层的告警也带给 CLI：否则「今天只扫了 3 个分片就断了」这种事
      // 只写在日报里，命令行上反而看不见。
      warnings: uniq([...(report.warnings ?? []), ...extraNotes]),
    };
  } finally {
    store.close();
  }
}

function toJudgeInput(repo) {
  return {
    fullName: repo.fullName,
    description: repo.description,
    language: repo.language,
    topics: repo.topics,
    stars: repo.stars,
    forks: repo.forks,
    readmeExcerpt: truncate(repo.readmeText ?? '', 1200),
  };
}
