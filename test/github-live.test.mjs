import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScan } from '../src/run.mjs';
import { runSnapshot } from '../src/snapshot.mjs';
import { openStore } from '../src/store.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { MAX_REACHABLE_RESULTS, createGitHubClient } from '../src/github.mjs';

/**
 * 在线路径的测试。
 *
 * 离线 fixtures 完全不经过 GitHub 客户端，所以「真实扫描」这条分支
 * 只有把 fetch 换掉才测得到：分片查询、1000 条上限的处理、
 * 自适应翻页、预算拆分、README 富化、GraphQL 批量快照。
 */

const silent = { info() {}, step() {}, warn() {}, ok() {}, error() {} };
const day = '2026-09-13';

function makeConfig(overrides = {}) {
  return normalizeConfig({
    profile: { name: 'live-test', description: '关注边缘推理' },
    interests: [{ tag: 'edge', weight: 1.1, keywords: ['on-device', 'quantization', 'quant'] }],
    excludes: { topics: ['awesome-list'], keywords: ['trading bot'] },
    collection: {
      languages: ['Python', 'Rust'],
      starTiers: ['>100', '26..100', '1..5'],
      maxRequests: 13,
      maxPagesPerShard: 3,
      deepShard: true,
      maxShardDepth: 2,
      minIntervalMs: 0,
      readmeReserveRatio: 0.25,
    },
    filters: { minSizeKb: 8 },
    ranking: { shortlistSize: 5, enrichLimit: 20, llmCandidateLimit: 10, displayFloor: 0 },
    output: { dir: 'out', dataDir: 'data' },
    ...overrides,
  });
}

function apiRepo(overrides = {}) {
  return {
    full_name: 'acme/edge-runner',
    name: 'edge-runner',
    owner: { login: 'acme' },
    html_url: 'https://github.com/acme/edge-runner',
    description: 'Run quantized models on-device',
    homepage: 'https://example.dev',
    language: 'Rust',
    topics: ['quantization', 'on-device'],
    stargazers_count: 42,
    forks_count: 3,
    open_issues_count: 1,
    size: 900,
    created_at: '2026-09-13T03:00:00Z',
    pushed_at: '2026-09-13T06:00:00Z',
    license: { spdx_id: 'MIT' },
    archived: false,
    fork: false,
    node_id: 'NODE_1',
    default_branch: 'main',
    ...overrides,
  };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function emptyResult() {
  return jsonResponse({ total_count: 0, incomplete_results: false, items: [] });
}

/**
 * 假的 GitHub API。
 *
 * 刻意还原真实数据的形状：
 *   - stars:>100 的宽查询总量 5000（超过 1000 条可达上限）→ 必须拆分子分片
 *   - stars:26..100 当天一个都没有 → 空区间，不应该再花请求去拆
 *   - stars:1..5 总量 2 → 自适应翻页一页拿完
 */
function fakeGitHub({ readmeText = '# edge-runner\n\nRuns quantized models on-device with a tiny runtime.' } = {}) {
  const log = [];
  const fetchImpl = async (url) => {
    const target = String(url);
    const parsed = new URL(target);
    log.push(target);

    if (target.includes('/search/repositories')) {
      const q = parsed.searchParams.get('q') ?? '';

      // 拆分后的体积子分片
      const sizeBucket = q.match(/size:(\S+)/)?.[1];
      if (sizeBucket) {
        if (sizeBucket === '25..150') {
          return jsonResponse({
            total_count: 3,
            incomplete_results: false,
            items: [
              apiRepo({
                full_name: 'tiny/edge-helper',
                name: 'edge-helper',
                owner: { login: 'tiny' },
                html_url: 'https://github.com/tiny/edge-helper',
                description: 'On-device quantization helper',
                language: 'Python',
                topics: ['on-device'],
                stargazers_count: 3,
                node_id: 'NODE_2',
              }),
              // 这条应该被过滤掉
              apiRepo({
                full_name: 'spam/awesome-list',
                name: 'awesome-list',
                owner: { login: 'spam' },
                html_url: 'https://github.com/spam/awesome-list',
                description: 'A curated list of things',
                language: 'Python',
                topics: ['awesome-list'],
                stargazers_count: 2,
                node_id: 'NODE_3',
              }),
              apiRepo({
                full_name: 'other/quant-tool',
                name: 'quant-tool',
                owner: { login: 'other' },
                html_url: 'https://github.com/other/quant-tool',
                description: 'Quantization toolkit for embedded targets',
                language: 'Rust',
                topics: ['quantization'],
                stargazers_count: 14,
                node_id: 'NODE_4',
              }),
            ],
          });
        }
        return emptyResult();
      }

      // star 区间的宽查询
      if (/stars:>100/.test(q)) {
        return jsonResponse({ total_count: 5000, incomplete_results: false, items: [apiRepo()] });
      }
      if (/stars:26\.\.100/.test(q)) return emptyResult();
      if (/stars:1\.\.5/.test(q)) {
        return jsonResponse({
          total_count: 2,
          incomplete_results: false,
          items: [
            apiRepo({
              full_name: 'new/llm-agent',
              name: 'llm-agent',
              owner: { login: 'new' },
              html_url: 'https://github.com/new/llm-agent',
              description: 'Quantization aware agent runtime',
              language: 'Python',
              topics: ['quantization', 'agent'],
              stargazers_count: 2,
              node_id: 'NODE_5',
            }),
            apiRepo({
              full_name: 'new/edge-notes',
              name: 'edge-notes',
              owner: { login: 'new' },
              html_url: 'https://github.com/new/edge-notes',
              description: 'Notes on on-device inference',
              language: 'Rust',
              topics: ['on-device'],
              stargazers_count: 1,
              node_id: 'NODE_6',
            }),
          ],
        });
      }
      return emptyResult();
    }

    if (target.includes('/readme')) {
      return new Response(readmeText, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (target.includes('/rate_limit')) {
      return jsonResponse({ resources: { search: { limit: 30, remaining: 29, reset: 1799999999 } } });
    }
    if (target.includes('/graphql')) {
      return jsonResponse({
        data: {
          nodes: [
            { nameWithOwner: 'acme/edge-runner', stargazerCount: 88, forkCount: 5, issues: { totalCount: 2 } },
            { nameWithOwner: 'tiny/edge-helper', stargazerCount: 9, forkCount: 0, issues: { totalCount: 0 } },
          ],
        },
      });
    }
    if (/\/repos\/[\w-]+\/[\w-]+$/.test(target)) {
      return jsonResponse(apiRepo());
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, log };
}

function setupWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metascan-live-'));
}

test('真实扫描路径：分片、1000 条上限拆分、README 富化、落盘', async () => {
  const dir = setupWorkspace();
  const config = makeConfig();
  const { fetchImpl, log } = fakeGitHub();

  const result = await runScan({
    day,
    config,
    cwd: dir,
    offline: false,
    githubFetchImpl: fetchImpl,
    logger: silent,
  });

  assert.equal(result.report.source, 'github');
  assert.equal(result.report.plannedTiers, 3, '3 个 star 区间');

  // 超过 1000 条上限的区间应该被按体积拆开
  assert.equal(result.report.overCapShards, 1);
  assert.ok(
    log.some((u) => decodeURIComponent(u).includes('size:')),
    '拆分后的子查询里应该带 size 条件',
  );

  // 空区间不应该继续拆分：26..100 当天没有新项目，拆语言纯属浪费
  const expandedEmptyTier = log.some((u) => {
    const q = new URL(u).searchParams.get('q') ?? '';
    return /stars:26\.\.100/.test(q) && /size:/.test(q);
  });
  assert.equal(expandedEmptyTier, false, '空 star 区间不应该产生子分片');

  // 过滤掉 awesome-list
  assert.equal(result.funnel.passed.length, 5);
  assert.ok(!result.items.some((i) => i.repo.fullName === 'spam/awesome-list'));

  // 关键回归：搜索不能把预算吃光，README 富化必须真的跑起来
  assert.ok(
    result.report.searchRequests < config.collection.maxRequests,
    `搜索只应该用完自己的那份预算，实际用了 ${result.report.searchRequests}/${config.collection.maxRequests}`,
  );
  assert.equal(result.enrichStats.skippedBudget, 0, '不该有候选因为预算被跳过');
  assert.equal(result.enrichStats.fetched, 5, '所有候选都应该拉到 README');
  assert.ok(result.items.every((i) => i.repo.readmeChars > 0));

  const markdown = fs.readFileSync(result.paths.markdown, 'utf8');
  assert.match(markdown, /数据源 GitHub Search API/);
  assert.doesNotMatch(markdown, /NaN/);
  assert.match(markdown, /acme\/edge-runner/);
});

test('自适应翻页：总量在 1000 以内时一次把分片翻完，而不是拆成子分片', async () => {
  const total = 250;
  let pagesServed = 0;
  const fetchImpl = async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    pagesServed = Math.max(pagesServed, page);
    const count = page <= 2 ? 100 : page === 3 ? 50 : 0;
    return jsonResponse({
      total_count: total,
      incomplete_results: false,
      items: Array.from({ length: count }, (_, i) => apiRepo({ full_name: `page${page}/repo${i}`, name: `repo${i}` })),
    });
  };

  const client = createGitHubClient({ token: 'fake', fetchImpl, minIntervalMs: 0, logger: silent });
  // maxPages 只给 1，但自适应逻辑应该把它提到 3
  const result = await client.searchRepos({ q: 'created:2026-09-13', maxPages: 1 });

  assert.equal(result.totalCount, total);
  assert.equal(result.pages, 3);
  assert.equal(result.items.length, total, '应该拿全，而不是只拿第一页');
  assert.equal(result.adapted, true);
  assert.equal(pagesServed, 3);
  assert.equal(client.requestCount, 3);
});

test('自适应翻页不会突破 1000 条硬上限', async () => {
  let maxPageRequested = 0;
  const fetchImpl = async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    maxPageRequested = Math.max(maxPageRequested, page);
    return jsonResponse({
      total_count: 5000,
      incomplete_results: false,
      items: Array.from({ length: 100 }, () => apiRepo()),
    });
  };

  const client = createGitHubClient({ token: 'fake', fetchImpl, minIntervalMs: 0, logger: silent });
  const result = await client.searchRepos({ q: 'created:2026-09-13', maxPages: 1 });

  assert.equal(result.pageLimit, 1, '总量超过上限时不该自适应加页，交给上层拆分子分片');
  assert.equal(maxPageRequested, 1);
  assert.ok(result.items.length <= MAX_REACHABLE_RESULTS);
});

test('没有 token 时报告里明确提示限流影响', async () => {
  const dir = setupWorkspace();
  const config = makeConfig();
  const { fetchImpl } = fakeGitHub();
  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;

  try {
    const result = await runScan({
      day,
      config,
      cwd: dir,
      offline: false,
      githubFetchImpl: fetchImpl,
      logger: silent,
    });
    assert.equal(result.report.authenticated, false);
    assert.ok(result.warnings.some((w) => w.includes('GITHUB_TOKEN')));
  } finally {
    if (saved !== undefined) process.env.GITHUB_TOKEN = saved;
  }
});

test('网络持续失败时快速中止，并留下可理解的告警（不刷屏、不崩溃）', async () => {
  const dir = setupWorkspace();
  const config = makeConfig();
  let attempts = 0;
  const failing = async () => {
    attempts += 1;
    throw new Error('getaddrinfo ENOTFOUND api.github.com');
  };

  const result = await runScan({
    day,
    config,
    cwd: dir,
    offline: false,
    githubFetchImpl: failing,
    logger: silent,
  });

  assert.equal(attempts, 3, '连续 3 次失败后应该停下，而不是把三个区间全试一遍');
  assert.equal(result.report.aborted, true);
  assert.equal(result.report.uniqueRepos, 0);
  assert.ok(result.warnings.some((w) => w.includes('连续 3 个分片失败')));
  assert.ok(result.warnings.length <= 6, '警告不应该刷屏');
  // 即使一条数据都没有，也要产出一份说明情况的报告
  assert.ok(fs.existsSync(result.paths.markdown));
  assert.match(fs.readFileSync(result.paths.markdown, 'utf8'), /今天没有符合条件的结果/);
});

test('预算很紧时优先保证搜索覆盖，同时给 README 留出余量', async () => {
  const dir = setupWorkspace();
  const config = makeConfig();
  config.collection.maxRequests = 60;
  config.collection.readmeReserveRatio = 0.25;
  const { fetchImpl } = fakeGitHub();

  const result = await runScan({
    day,
    config,
    cwd: dir,
    offline: false,
    githubFetchImpl: fetchImpl,
    logger: silent,
  });

  const searchBudget = 60 - Math.max(3, Math.round(60 * 0.25));
  assert.ok(result.report.searchRequests <= searchBudget);
  assert.equal(result.report.requestLimit, searchBudget, '采集层应该拿到拆分后的搜索预算');
  assert.ok(result.enrichStats.fetched > 0, '富化阶段仍然要有预算可用');
});

test('有 token 时用 GraphQL 批量刷新快照（1 次请求查多个仓库）', async () => {
  const dir = setupWorkspace();
  const config = makeConfig();
  const { fetchImpl, log } = fakeGitHub();

  const store = openStore({ dataDir: path.join(dir, 'data') });
  store.upsertRepo(
    {
      fullName: 'acme/edge-runner',
      owner: 'acme',
      name: 'edge-runner',
      stars: 42,
      forks: 3,
      nodeId: 'NODE_1',
      topics: [],
      createdAt: '2026-09-13T03:00:00Z',
    },
    { runDate: day },
  );

  const client = createGitHubClient({ token: 'fake-token', fetchImpl, minIntervalMs: 0, logger: silent });
  const stats = await runSnapshot({ store, client, config, day, offline: false, logger: silent });

  assert.equal(stats.mode, 'graphql');
  assert.equal(stats.updated, 1);
  const trend = store.getStarTrend('acme/edge-runner');
  assert.equal(trend.latestStars, 88, '应该写入 GraphQL 返回的最新 star 数');
  assert.equal(trend.delta, 46);
  assert.ok(log.some((u) => u.includes('/graphql')), '应该走 GraphQL');
  store.close();
});

test('没有 token 时快照退回 REST 并遵守配额上限', async () => {
  const dir = setupWorkspace();
  const config = makeConfig({ snapshot: { unauthenticatedLimit: 1 } });
  const { fetchImpl, log } = fakeGitHub();

  const store = openStore({ dataDir: path.join(dir, 'data') });
  for (const name of ['acme/edge-runner', 'tiny/edge-helper']) {
    store.upsertRepo(
      {
        fullName: name,
        owner: name.split('/')[0],
        name: name.split('/')[1],
        stars: 10,
        topics: [],
        createdAt: '2026-09-13T03:00:00Z',
      },
      { runDate: day },
    );
  }

  const client = createGitHubClient({ token: null, fetchImpl, minIntervalMs: 0, logger: silent });
  const stats = await runSnapshot({ store, client, config, day, offline: false, logger: silent });

  assert.equal(stats.mode, 'rest');
  assert.equal(stats.updated, 1);
  assert.equal(stats.skippedNoToken, 1);
  assert.ok(!log.some((u) => u.includes('/graphql')));
  store.close();
});
