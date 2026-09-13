import { addDays, log, nowISO } from './util.mjs';

/**
 * star 快照。
 *
 * 这是这个项目真正的数据护城河：GitHub 不提供 star 历史 API，
 * 任何人都只能从今天开始自己攒。攒满一个月，你就能看到
 * 「发布后 30 天的增长曲线」——这是任何一次性 prompt 方案永远得不到的东西。
 *
 * 有 token 时走 GraphQL，一次请求查 100 个仓库；
 * 没有 token 时退回 REST，但会严格限制数量，因为未认证只有 60 次/小时。
 */
export async function runSnapshot({
  store,
  client,
  config,
  day,
  offline = false,
  limit = 2000,
  logger = log,
}) {
  const repos = store.listRepos({ limit });
  const stats = {
    day,
    considered: repos.length,
    updated: 0,
    failed: 0,
    skippedNoToken: 0,
    mode: offline ? 'simulated' : client?.authenticated ? 'graphql' : 'rest',
    requests: 0,
  };

  if (!repos.length) return stats;

  if (offline) {
    // 用 fixtures 里声明的日增长量模拟出第二天的观测值，
    // 让「时间序列」这个能力当场可见，而不是要等一整天。
    //
    // 写在「第二天」而不是当天，是因为当天稍后再跑一次 run 会用真实观测
    // 覆盖当天的记录；模拟值必须落在未来的日期上才不会被抹掉。
    const simulatedDay = addDays(day, 1);
    for (const repo of repos) {
      const growth = repo.extra?.starGrowthPerDay ?? 0;
      const days = Math.max(1, daysBetween(repo.firstSeenDate, simulatedDay));
      store.snapshotRepo(repo.fullName, {
        stars: (repo.stars ?? 0) + growth * days,
        forks: repo.forks ?? 0,
        openIssues: repo.openIssues ?? 0,
        takenOn: simulatedDay,
      });
      stats.updated += 1;
    }
    stats.simulatedDay = simulatedDay;
    return stats;
  }

  if (client?.authenticated) {
    const batchSize = config.snapshot?.batchSize ?? 100;
    const withIds = repos.filter((r) => r.nodeId);
    for (let i = 0; i < withIds.length; i += batchSize) {
      const batch = withIds.slice(i, i + batchSize);
      try {
        const results = await client.fetchRepoStars(batch.map((r) => r.nodeId));
        const byName = new Map(results.map((r) => [r.fullName, r]));
        for (const repo of batch) {
          const fresh = byName.get(repo.fullName);
          if (!fresh) {
            stats.failed += 1;
            continue;
          }
          store.snapshotRepo(repo.fullName, {
            stars: fresh.stars,
            forks: fresh.forks,
            openIssues: fresh.openIssues,
            takenOn: day,
          });
          stats.updated += 1;
        }
      } catch (error) {
        logger.warn(`GraphQL 批量查询失败：${error.message}`);
        stats.failed += batch.length;
      }
    }
    stats.requests = client.requestCount;
    return stats;
  }

  // 未认证：REST 逐个查，严格限量
  const budget = Math.min(config.snapshot?.unauthenticatedLimit ?? 40, client?.budgetLeft ?? 0);
  if (budget <= 0) {
    stats.skippedNoToken = repos.length;
    return stats;
  }
  for (const repo of repos.slice(0, budget)) {
    try {
      const fresh = await client.getRepo(repo.fullName);
      if (!fresh) {
        stats.failed += 1;
        continue;
      }
      store.snapshotRepo(repo.fullName, {
        stars: fresh.stars,
        forks: fresh.forks,
        openIssues: fresh.openIssues,
        takenOn: day,
      });
      stats.updated += 1;
    } catch (error) {
      logger.warn(`快照失败 ${repo.fullName}：${error.message}`);
      stats.failed += 1;
    }
  }
  stats.skippedNoToken = Math.max(0, repos.length - budget);
  stats.requests = client.requestCount;
  stats.capturedAt = nowISO();
  return stats;
}

function daysBetween(fromDate, toDate) {
  if (!fromDate) return 1;
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 1;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}
