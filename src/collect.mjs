import { log } from './util.mjs';
import { SEARCH_RESULT_CAP, detectTruncation, expandShard, planShards } from './shards.mjs';

/**
 * 采集层：按分片计划调用 GitHub Search API，并把撞上限的分片自动拆细。
 *
 * 设计上刻意做成「预算内尽力而为」：
 * 请求预算耗尽或触发限流时不会崩，而是返回已经拿到的部分 + 一份诚实的覆盖报告。
 * 对你来说，「今天只扫了 60% 的分片」比「静默给出不完整的数据」重要得多。
 */
export async function collectCandidates({
  day,
  config,
  client,
  includeZeroStar = false,
  /**
   * 本阶段（搜索）允许消耗的请求数。
   * 刻意不直接用 client.budgetLeft——整个客户端的预算还要给后面的
   * README 富化留一部分，否则搜索会把预算吃光，富化一次都跑不了。
   */
  requestLimit = Infinity,
  logger = log,
  onProgress = null,
}) {
  const maxPages = config.collection.maxPagesPerShard ?? 1;
  const deepShard = config.collection.deepShard ?? true;
  const maxDepth = config.collection.maxShardDepth ?? 2;
  const startRequests = client.requestCount;

  const queue = planShards({ day, config, includeZeroStar });
  const plannedTiers = queue.length;
  // 展开出来的子分片也算进「计划」里，这样「处理 M / 计划 N」才读得懂
  let totalEnqueued = queue.length;

  const repoMap = new Map();
  const shardResults = [];
  const warnings = [];
  const MAX_WARNINGS = 20;
  const addWarning = (message) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
  };

  let budgetExhausted = false;
  let rateLimited = false;
  let processed = 0;
  let consecutiveFailures = 0;
  let aborted = false;

  while (queue.length) {
    const used = client.requestCount - startRequests;
    if (client.budgetLeft <= 0 || used >= requestLimit) {
      budgetExhausted = true;
      addWarning(
        `搜索预算用尽（已用 ${used} 次，上限 ${requestLimit} 次），剩余 ${queue.length} 个分片未扫描。` +
          `调大 collection.maxRequests 可以让覆盖更完整。`,
      );
      break;
    }

    const shard = queue.shift();
    processed += 1;

    let result;
    try {
      result = await client.searchRepos({ q: shard.query, maxPages });
    } catch (error) {
      if (error.name === 'RateLimitError') {
        rateLimited = true;
        addWarning(`触发 GitHub 限流，提前结束采集：${error.message}`);
        break;
      }
      if (error.name === 'RequestBudgetExceededError') {
        budgetExhausted = true;
        break;
      }
      // 单个分片失败不应该拖垮整次运行（比如某个语言的查询语法被拒），
      // 但如果连续多个分片都失败，那基本是网络或认证整体坏了，
      // 继续刷下去只会浪费时间并把警告刷屏。
      consecutiveFailures += 1;
      addWarning(`分片 ${shard.label} 失败：${error.message}`);
      shardResults.push({ ...shard, error: error.message, fetched: 0 });
      if (consecutiveFailures >= 3) {
        aborted = true;
        addWarning(
          `连续 ${consecutiveFailures} 个分片失败，判断为网络或认证问题，提前结束采集。` +
            `请检查网络连通性和 GITHUB_TOKEN。`,
        );
        break;
      }
      continue;
    }
    consecutiveFailures = 0;

    for (const repo of result.items) {
      const existing = repoMap.get(repo.fullName);
      if (!existing) {
        repoMap.set(repo.fullName, repo);
      } else if ((repo.stars ?? 0) > (existing.stars ?? 0)) {
        // 同一个仓库被多个分片命中时，保留 star 更高的那份观测
        repoMap.set(repo.fullName, repo);
      }
    }

    const truncated = detectTruncation({
      totalCount: result.totalCount,
      fetchedCount: result.items.length,
      reachedPageCap: result.pages >= result.pageLimit,
    });

    const entry = {
      ...shard,
      fetched: result.items.length,
      totalCount: result.totalCount,
      pages: result.pages,
      truncated: truncated.truncated,
      overCap: truncated.overCap,
      truncationReason: truncated.reason,
    };

    /**
     * 只有「总量超过 1000 条可达上限」才值得拆分子分片。
     * 如果只是翻页没翻完，多翻两页比拆成几十个语言分片便宜得多——
     * 而自适应翻页已经在 searchRepos 里处理了这种情况。
     */
    if (truncated.truncated && truncated.overCap && deepShard && shard.depth < maxDepth) {
      const children = expandShard(shard, { day, config });
      if (children.length) {
        // 插到队首：优先补齐刚刚发现的数据空洞
        queue.unshift(...children);
        totalEnqueued += children.length;
        entry.expandedInto = children.length;
      } else {
        entry.unresolvable = true;
        addWarning(
          `分片 ${shard.label} 在已达到最大拆分深度后仍超过 1000 条（${truncated.reason}），` +
            `这一部分数据不完整。`,
        );
      }
    } else if (truncated.truncated) {
      entry.unresolvable = true;
      addWarning(
        truncated.overCap
          ? `分片 ${shard.label} 超过 ${SEARCH_RESULT_CAP} 条上限但未自动拆分（${truncated.reason}）。`
          : `分片 ${shard.label} 数据不完整：${truncated.reason}。`,
      );
    }

    shardResults.push(entry);
    onProgress?.({
      processed,
      planned: totalEnqueued,
      queued: queue.length,
      found: repoMap.size,
      shard: shard.label,
      fetched: entry.fetched,
      totalCount: entry.totalCount,
    });
  }

  const skipped = budgetExhausted ? queue.length : 0;
  const report = {
    source: 'github',
    day,
    plannedShards: totalEnqueued,
    plannedTiers,
    processedShards: processed,
    skippedShards: skipped,
    searchRequests: client.requestCount - startRequests,
    requestLimit: Number.isFinite(requestLimit) ? requestLimit : null,
    uniqueRepos: repoMap.size,
    requests: client.requestCount,
    authenticated: client.authenticated,
    truncatedShards: shardResults.filter((s) => s.truncated).length,
    overCapShards: shardResults.filter((s) => s.overCap).length,
    emptyShards: shardResults.filter((s) => s.totalCount === 0).length,
    unresolvedShards: shardResults.filter((s) => s.unresolvable).length,
    failedShards: shardResults.filter((s) => s.error).length,
    budgetExhausted,
    rateLimited,
    aborted,
    warningsTruncated: warnings.length >= MAX_WARNINGS,
    warnings,
    shards: shardResults,
  };

  return { repos: [...repoMap.values()], report };
}
