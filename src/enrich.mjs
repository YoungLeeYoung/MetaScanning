import { truncate } from './util.mjs';

/** 存进 SQLite 的 README 上限，避免数据库被超大文档撑爆 */
export const README_STORE_LIMIT = 20_000;

/**
 * 富化层：为候选补上 README。
 *
 * 位置很关键——放在「便宜的启发式评分」之后、正式评分之前。
 * README 是判断项目质量最有价值的一段文本，但每个仓库都要额外一次 API 请求，
 * 所以只对已经通过初筛的候选拉取，而不是对所有候选拉。
 */
export async function enrichRepos(repos, { client, logger, limit = Infinity, onProgress = null } = {}) {
  const targets = repos.slice(0, limit);
  const stats = { attempted: 0, fetched: 0, reused: 0, failed: 0, noReadme: 0, skippedBudget: 0 };
  // 记下因为预算没拉的仓库：它们随后必须退出排序，
  // 否则「有 README 的」和「没 README 的」会在同一个榜单里比大小，
  // 而后者天生少了一大块文本，质量分和兴趣分都被系统性压低。
  const skippedNames = [];
  const enriched = [];

  for (const repo of targets) {
    if (repo.readmeText) {
      stats.reused += 1;
      enriched.push(repo);
      continue;
    }
    if (client && client.budgetLeft <= 0) {
      stats.skippedBudget += 1;
      skippedNames.push(repo.fullName);
      enriched.push(repo);
      continue;
    }
    stats.attempted += 1;
    try {
      const text = await client.getReadme(repo.fullName);
      if (text) {
        stats.fetched += 1;
        enriched.push({
          ...repo,
          readmeText: truncate(text, README_STORE_LIMIT),
          readmeChars: text.length,
          hasReadme: true,
        });
      } else {
        // 仓库确实没有 README（API 返回 404）。这既不是失败也不是成功，
        // 必须单独计数，否则 attempted 和 fetched+failed 对不上。
        stats.noReadme += 1;
        enriched.push({ ...repo, readmeText: null, readmeChars: 0, hasReadme: false });
      }
    } catch (error) {
      stats.failed += 1;
      logger?.warn?.(`拉取 README 失败 ${repo.fullName}：${error.message}`);
      enriched.push(repo);
    }
    onProgress?.({ done: stats.attempted, total: targets.length });
  }

  // limit 之外的候选原样带上，它们不参与后续评分，但要保留元数据
  return { enriched: [...enriched, ...repos.slice(targets.length)], stats: { ...stats, skippedNames } };
}
