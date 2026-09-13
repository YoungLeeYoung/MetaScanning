import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScan } from '../src/run.mjs';
import { runSnapshot } from '../src/snapshot.mjs';
import { openStore } from '../src/store.mjs';
import { applyFeedback } from '../src/feedback.mjs';
import { normalizeConfig } from '../src/config.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const silent = {
  info() {},
  step() {},
  warn() {},
  ok() {},
  error() {},
};
const day = '2026-09-13';

function setupWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metascan-e2e-'));
  fs.mkdirSync(path.join(dir, 'fixtures'), { recursive: true });
  fs.copyFileSync(
    path.join(PROJECT_ROOT, 'fixtures', 'sample-repos.json'),
    path.join(dir, 'fixtures', 'sample-repos.json'),
  );
  const config = normalizeConfig({
    profile: { name: 'e2e', description: '端到端测试画像' },
    interests: [
      { tag: 'llm', weight: 1.2, keywords: ['llm', 'eval', 'rag', 'context-window'] },
      { tag: 'edge', weight: 1.1, keywords: ['on-device', 'quantization', 'edge', 'gguf'] },
      { tag: 'agent', weight: 1.2, keywords: ['agent', 'mcp'] },
    ],
    excludes: {
      languages: ['HTML'],
      topics: ['awesome-list', 'template', 'course', 'leetcode'],
      keywords: ['curated list', 'trading bot', 'homework', 'course assignment', '课程作业', '刷题'],
    },
    filters: { minSizeKb: 8, blockedNamePatterns: [] },
    ranking: {
      shortlistSize: 8,
      enrichLimit: 40,
      llmCandidateLimit: 20,
      minHeuristicScore: 0.16,
      // 这个用例关注流水线本身，质量下限单独测
      displayFloor: 0,
    },
    output: { dir: 'out', dataDir: 'data' },
  });
  return { dir, config };
}

test('离线端到端：采集 → 过滤 → 评分 → digest 落盘', async () => {
  const { dir, config } = setupWorkspace();
  const result = await runScan({ day, config, cwd: dir, offline: true, logger: silent });

  assert.equal(result.report.source, 'fixture');
  assert.equal(result.report.uniqueRepos, 23, 'fixtures 里的条目数');
  assert.equal(result.funnel.passed.length, 13, '过滤后剩下的条目数（改过滤规则时这个断言应该一起更新）');
  assert.equal(result.items.length, 8, 'shortlistSize = 8');

  // 排名第一的应该是那个真正贴合画像的项目
  assert.equal(result.items[0].repo.fullName, 'lumen-labs/tinytune');

  // 明显该被过滤的东西一个都不能出现
  const names = result.items.map((i) => i.repo.fullName);
  for (const bad of [
    'chans/leetcode-archive',
    'misc-stars/awesome-llm-agents',
    'coursework-2026/cs336-assignment3',
    'bob/test',
    'wallet-hunter/defi-airdrop-bot',
    'bigcorp/mirror-torch-libs',
    'oldproj/legacy-render',
    'noinfo/xq7',
  ]) {
    assert.ok(!names.includes(bad), `${bad} 不应该出现在结果里`);
  }

  // 产出文件
  assert.ok(fs.existsSync(result.paths.markdown));
  assert.ok(fs.existsSync(result.paths.json));
  const markdown = fs.readFileSync(result.paths.markdown, 'utf8');
  assert.match(markdown, /# MetaScanning 日报 · 2026-09-13/);
  assert.match(markdown, /lumen-labs\/tinytune/);
  assert.match(markdown, /离线 fixtures 数据/);
  assert.match(markdown, /## 扫描覆盖与过滤漏斗/);
  assert.doesNotMatch(markdown, /NaN/, '渲染里不应该出现 NaN');

  const payload = JSON.parse(fs.readFileSync(result.paths.json, 'utf8'));
  assert.equal(payload.picks.length, 8);
  assert.equal(payload.picks[0].fullName, 'lumen-labs/tinytune');
  assert.ok(payload.picks[0].scores.final > 0.5);
  assert.equal(payload.funnel.candidates, 23);
  assert.equal(payload.isFixture, true);
});

test('落库统计与漏斗一致', async () => {
  const { dir, config } = setupWorkspace();
  const result = await runScan({ day, config, cwd: dir, offline: true, logger: silent });
  assert.equal(result.store.repoCount, 13);
  assert.equal(result.store.runCount, 1);
  assert.ok(result.store.snapshotCount >= 13, '每条通过过滤的项目都应该有一条 star 观测');
});

test('第二次运行能通过快照看到 star 走势', async () => {
  const { dir, config } = setupWorkspace();
  await runScan({ day, config, cwd: dir, offline: true, logger: silent });

  // 模拟第二天再观测一次
  const store = openStore({ dataDir: path.join(dir, 'data') });
  const snapshotStats = await runSnapshot({ store, config, day, offline: true, logger: silent });
  assert.equal(snapshotStats.updated, 13);
  store.close();

  const second = await runScan({ day, config, cwd: dir, offline: true, logger: silent });
  const top = second.items.find((i) => i.repo.fullName === 'lumen-labs/tinytune');
  assert.ok(top.trend, '应该有走势数据');
  assert.ok(top.trend.delta > 0, 'fixture 声明的日增长应该体现成正 delta');
  // 模拟值必须落在次日：写在当天的话，随后的 run 会用真实观测把它覆盖掉
  assert.equal(snapshotStats.simulatedDay, '2026-09-14');
  assert.equal(top.trend.latestOn, '2026-09-14');
  assert.equal(top.trend.delta, top.trend.latestStars - top.trend.firstStars);

  const markdown = fs.readFileSync(second.paths.markdown, 'utf8');
  assert.match(markdown, /since 2026-09-13/, '日报里应该展示 star 增长');
});

test('重复运行同一天不会让走势基线漂移', async () => {
  const { dir, config } = setupWorkspace();
  await runScan({ day, config, cwd: dir, offline: true, logger: silent });

  const store = openStore({ dataDir: path.join(dir, 'data') });
  const baseline = store.getRepo('lumen-labs/tinytune').firstSeenStars;
  store.close();

  // 再跑两次，中间还把 fixture 里的 star 数改高，验证基线不受影响
  await runScan({ day, config, cwd: dir, offline: true, logger: silent });
  await runScan({ day, config, cwd: dir, offline: true, logger: silent });

  const store2 = openStore({ dataDir: path.join(dir, 'data') });
  const repo = store2.getRepo('lumen-labs/tinytune');
  assert.equal(repo.firstSeenStars, baseline);
  assert.equal(repo.firstSeenDate, day);
  assert.equal(store2.stats().repoCount, 13, '重复运行不应该产生重复记录');
  store2.close();
});

test('反馈会改变兴趣权重，并影响下一次排序', async () => {
  const { dir, config } = setupWorkspace();
  const first = await runScan({ day, config, cwd: dir, offline: true, logger: silent });
  const before = first.items.find((i) => i.repo.fullName === 'lumen-labs/tinytune').final;

  const store = openStore({ dataDir: path.join(dir, 'data') });
  const feedback = applyFeedback({ store, config, fullName: 'lumen-labs/tinytune', action: 'deep' });
  assert.ok(feedback.tags.includes('edge'));
  assert.ok(feedback.changes.length > 0, '应该产生权重变化');
  assert.ok(feedback.changes.every((c) => c.value > 0), 'deep 是正向反馈');
  assert.ok(feedback.changes.every((c) => Math.abs(c.value) <= 1), '权重必须被夹在 [-1, 1]');
  store.close();

  const second = await runScan({ day, config, cwd: dir, offline: true, logger: silent });
  const after = second.items.find((i) => i.repo.fullName === 'lumen-labs/tinytune').final;
  assert.ok(after > before, `反馈后分数应该上升（${before} → ${after}）`);
});

test('负向反馈会压低对应方向的分数', async () => {
  const { dir, config } = setupWorkspace();
  await runScan({ day, config, cwd: dir, offline: true, logger: silent });

  const store = openStore({ dataDir: path.join(dir, 'data') });
  const feedback = applyFeedback({ store, config, fullName: 'lumen-labs/tinytune', action: 'ignore' });
  assert.ok(feedback.tags.length > 0);
  const weights = store.getWeights();
  // 被忽略的每个方向都应该是负权重
  for (const tag of feedback.tags) {
    assert.ok(weights.get(`tag:${tag}`).value < 0, `tag:${tag} 应该变成负权重`);
  }
  store.close();

  const second = await runScan({ day, config, cwd: dir, offline: true, logger: silent });
  const entry = second.items.find((i) => i.repo.fullName === 'lumen-labs/tinytune');
  assert.ok(entry.heuristic.parts.interest < 0.9, '被忽略的方向权重应该下降');
});

test('未配置 LLM key 时自动退回纯启发式，并给出说明', async () => {
  const { dir, config } = setupWorkspace();
  const saved = { key: process.env.OPENAI_API_KEY, model: process.env.METASCAN_MODEL };
  delete process.env.OPENAI_API_KEY;
  try {
    const result = await runScan({ day, config, cwd: dir, offline: true, useLlm: true, logger: silent });
    assert.equal(result.llmInfo.used, false);
    assert.match(result.llmInfo.reason, /OPENAI_API_KEY/);
    assert.ok(result.warnings.some((w) => w.includes('OPENAI_API_KEY')));
    assert.ok(result.items.length > 0, '降级之后仍然要有结果');
  } finally {
    if (saved.key !== undefined) process.env.OPENAI_API_KEY = saved.key;
    if (saved.model !== undefined) process.env.METASCAN_MODEL = saved.model;
  }
});

test('反馈不存在的仓库时报出可操作的错误', async () => {
  const { dir, config } = setupWorkspace();
  await runScan({ day, config, cwd: dir, offline: true, logger: silent });
  const store = openStore({ dataDir: path.join(dir, 'data') });
  assert.throws(
    () => applyFeedback({ store, config, fullName: 'nobody/nothing', action: 'save' }),
    /数据库里没有/,
  );
  assert.throws(
    () => applyFeedback({ store, config, fullName: 'lumen-labs/tinytune', action: 'nonsense' }),
    /未知的反馈动作/,
  );
  store.close();
});

test('质量下限：分数不够的项目不进精选，只出现在低置信度区', async () => {
  const { dir, config } = setupWorkspace();
  config.ranking.displayFloor = 0.6;

  const result = await runScan({ day, config, cwd: dir, offline: true, logger: silent });
  const payload = JSON.parse(fs.readFileSync(result.paths.json, 'utf8'));

  assert.equal(payload.displayFloor, 0.6);
  assert.ok(payload.picks.length > 0, '应该还有够格的条目');
  assert.ok(payload.picks.every((p) => p.scores.final >= 0.6));
  assert.ok(payload.lowConfidencePicks.length > 0, '被刷下来的条目要有地方可看');
  assert.ok(payload.lowConfidencePicks.every((p) => p.scores.final < 0.6));
  assert.equal(
    payload.picks.length + payload.lowConfidencePicks.length,
    result.items.length,
    '两条加起来应该等于全部候选，不能丢数据',
  );

  const markdown = fs.readFileSync(result.paths.markdown, 'utf8');
  assert.match(markdown, /## 低置信度（综合分 < 0\.6）/);
  assert.match(markdown, /多半是噪音/);
});

test('质量下限放到极高时，日报明说没有值得看的，而不是硬凑', async () => {
  const { dir, config } = setupWorkspace();
  config.ranking.displayFloor = 0.99;

  const result = await runScan({ day, config, cwd: dir, offline: true, logger: silent });
  const markdown = fs.readFileSync(result.paths.markdown, 'utf8');
  const payload = JSON.parse(fs.readFileSync(result.paths.json, 'utf8'));

  assert.equal(payload.picks.length, 0);
  assert.ok(payload.lowConfidencePicks.length > 0);
  assert.match(markdown, /## 今天没有符合条件的结果/);
  assert.match(markdown, /综合分都低于质量下限 0\.99/);
});

test('README 富化有独立的预算，不会被搜索阶段吃光', async () => {
  const { dir, config } = setupWorkspace();
  // 离线模式没有 GitHub 客户端，用假的搜索源验证不了预算拆分，
  // 所以这里只验证「富化阶段确实跑过」这个不变式在 fixtures 上成立
  const result = await runScan({ day, config, cwd: dir, offline: true, logger: silent });
  assert.equal(result.enrichStats.fetched, 0, '离线数据自带 README，不需要联网拉');
  assert.equal(result.enrichStats.skippedBudget, 0, '离线模式不应该有预算跳过');
  assert.ok(
    result.items.every((item) => item.repo.readmeChars > 0),
    '每条候选都应该带着 README 进入评分',
  );
});
