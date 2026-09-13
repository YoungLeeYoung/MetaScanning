import fs from 'node:fs';
import path from 'node:path';

/**
 * 离线数据源。
 *
 * 存在的意义：让整条流水线在没有网络、没有 token、没有 LLM key 的情况下
 * 也能完整跑通并被验证。测试和首次上手都靠它。
 *
 * fixture 里的时间用「相对当天的分钟数」表示，这样 --date 换成任意一天都能跑。
 */
export function fixturePath(cwd = process.cwd()) {
  return path.join(cwd, 'fixtures', 'sample-repos.json');
}

export function loadFixtureRepos({ day, cwd = process.cwd(), file } = {}) {
  const target = file ?? fixturePath(cwd);
  if (!fs.existsSync(target)) {
    throw new Error(`找不到离线数据：${target}`);
  }
  const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
  const entries = Array.isArray(raw) ? raw : raw.repos ?? [];

  const repos = entries.map((entry) => {
    const offsetMinutes = entry.created_offset_minutes ?? 0;
    const createdAt = new Date(`${day}T00:00:00Z`);
    createdAt.setUTCMinutes(createdAt.getUTCMinutes() + offsetMinutes);
    const createdISO = createdAt.toISOString();
    const growth = entry.star_growth_per_day ?? 0;

    return {
      fullName: entry.full_name,
      owner: entry.full_name.split('/')[0],
      name: entry.full_name.split('/')[1],
      url: `https://github.com/${entry.full_name}`,
      description: entry.description ?? null,
      homepage: entry.homepage ?? null,
      language: entry.language ?? null,
      topics: entry.topics ?? [],
      stars: entry.stars ?? 0,
      forks: entry.forks ?? 0,
      openIssues: entry.open_issues ?? 0,
      sizeKb: entry.size_kb ?? 0,
      createdAt: createdISO,
      pushedAt: entry.pushed_at === 'created' || !entry.pushed_at ? createdISO : entry.pushed_at,
      license: entry.license ?? null,
      archived: Boolean(entry.archived),
      isFork: Boolean(entry.is_fork),
      hasReadme: Boolean(entry.readme_text),
      readmeChars: (entry.readme_text ?? '').length,
      readmeText: entry.readme_text ?? null,
      nodeId: entry.node_id ?? null,
      extra: { fixture: true, starGrowthPerDay: growth },
    };
  });

  const report = {
    source: 'fixture',
    day,
    isFixture: true,
    plannedShards: 0,
    processedShards: 0,
    skippedShards: 0,
    uniqueRepos: repos.length,
    requests: 0,
    authenticated: false,
    truncatedShards: 0,
    unresolvedShards: 0,
    failedShards: 0,
    budgetExhausted: false,
    rateLimited: false,
    fixtureFile: target,
    warnings: ['本次运行使用离线 fixtures 数据，不是真实的 GitHub 搜索结果。'],
    shards: [],
  };

  return { repos, report };
}
