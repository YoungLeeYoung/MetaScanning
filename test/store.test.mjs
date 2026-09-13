import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.mjs';

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metascan-store-'));
  return { store: openStore({ dataDir: dir }), dir };
}

function repoFixture(overrides = {}) {
  return {
    fullName: 'acme/tool',
    owner: 'acme',
    name: 'tool',
    url: 'https://github.com/acme/tool',
    description: 'a tool',
    language: 'Rust',
    topics: ['cli'],
    stars: 10,
    forks: 1,
    sizeKb: 300,
    createdAt: '2026-09-13T02:00:00Z',
    archived: false,
    isFork: false,
    ...overrides,
  };
}

test('仓库读写往返保持字段完整', () => {
  const { store } = freshStore();
  store.upsertRepo(repoFixture(), { runDate: '2026-09-13' });
  const loaded = store.getRepo('acme/tool');
  assert.equal(loaded.fullName, 'acme/tool');
  assert.equal(loaded.language, 'Rust');
  assert.deepEqual(loaded.topics, ['cli']);
  assert.equal(loaded.isFork, false);
  assert.equal(loaded.firstSeenDate, '2026-09-13');
  store.close();
});

test('布尔值被正确转换（node:sqlite 不接受 boolean 参数）', () => {
  const { store } = freshStore();
  store.upsertRepo(repoFixture({ isFork: true, archived: true }), { runDate: '2026-09-13' });
  const loaded = store.getRepo('acme/tool');
  assert.equal(loaded.isFork, true);
  assert.equal(loaded.archived, true);
  store.close();
});

test('first_seen_stars 是基线，后续 upsert 不会覆盖它', () => {
  const { store } = freshStore();
  store.upsertRepo(repoFixture({ stars: 10 }), { runDate: '2026-09-13' });
  store.upsertRepo(repoFixture({ stars: 99 }), { runDate: '2026-09-14' });

  const loaded = store.getRepo('acme/tool');
  assert.equal(loaded.stars, 99, 'stars 应该跟着最新观测更新');
  assert.equal(loaded.firstSeenStars, 10, 'first_seen_stars 应该保持首次观测值');
  assert.equal(loaded.firstSeenDate, '2026-09-13', 'first_seen_date 同样不可变');
  store.close();
});

test('star 走势用基线计算 delta（GitHub 没有 star 历史 API，这份数据只能自己攒）', () => {
  const { store } = freshStore();
  store.upsertRepo(repoFixture({ stars: 10 }), { runDate: '2026-09-13' });
  assert.equal(store.getStarTrend('acme/tool'), null, '还没有快照时返回 null');

  store.snapshotRepo('acme/tool', { stars: 10, takenOn: '2026-09-13' });
  store.snapshotRepo('acme/tool', { stars: 42, takenOn: '2026-09-14' });
  store.snapshotRepo('acme/tool', { stars: 64, takenOn: '2026-09-15' });

  const trend = store.getStarTrend('acme/tool');
  assert.equal(trend.firstStars, 10);
  assert.equal(trend.latestStars, 64);
  assert.equal(trend.delta, 54);
  assert.equal(trend.firstOn, '2026-09-13');
  assert.equal(trend.observationDays, 3);
  store.close();
});

test('同一天重复快照以最后一次为准，且不会抹掉走势基线', () => {
  const { store } = freshStore();
  store.upsertRepo(repoFixture({ stars: 10 }), { runDate: '2026-09-13' });
  store.snapshotRepo('acme/tool', { stars: 11, takenOn: '2026-09-13' });
  store.snapshotRepo('acme/tool', { stars: 30, takenOn: '2026-09-13' });

  const trend = store.getStarTrend('acme/tool');
  assert.equal(trend.latestStars, 30);
  assert.equal(trend.delta, 20, '基线来自 repos.first_seen_stars，不会被同一天的重复快照抹平');
  assert.equal(trend.observationDays, 1);
  store.close();
});

test('overwrite=false 适合只想补空洞的场景', () => {
  const { store } = freshStore();
  store.upsertRepo(repoFixture({ stars: 50 }), { runDate: '2026-09-13' });
  store.snapshotRepo('acme/tool', { stars: 50, takenOn: '2026-09-13' });
  store.snapshotRepo('acme/tool', { stars: 7, takenOn: '2026-09-13', overwrite: false });
  const trend = store.getStarTrend('acme/tool');
  assert.equal(trend.latestStars, 50);
  assert.equal(trend.delta, 0);
  store.close();
});

test('没有入库的项目没有走势数据（先 scan 再 snapshot）', () => {
  const { store } = freshStore();
  store.snapshotRepo('ghost/repo', { stars: 5, takenOn: '2026-09-13' });
  assert.equal(store.getStarTrend('ghost/repo'), null);
  store.close();
});

test('权重按 EMA 收敛并始终被夹在 [-1, 1]', () => {
  const { store } = freshStore();
  const first = store.bumpWeight('tag:llm', 1);
  assert.ok(Math.abs(first - 0.35) < 1e-9);

  for (let i = 0; i < 50; i += 1) store.bumpWeight('tag:llm', 1);
  const converged = store.getWeights().get('tag:llm');
  assert.ok(converged.value <= 1 && converged.value > 0.99);
  assert.equal(converged.hits, 51);

  for (let i = 0; i < 60; i += 1) store.bumpWeight('tag:noisy', -1);
  assert.ok(store.getWeights().get('tag:noisy').value >= -1);
  assert.ok(store.getWeights().get('tag:noisy').value < -0.99);
  store.close();
});

test('反馈记录可以被读回，tags 以 JSON 存取', () => {
  const { store } = freshStore();
  store.recordFeedback({ fullName: 'acme/tool', action: 'save', note: '有意思', tags: ['llm', 'edge'] });
  const rows = store.listFeedback();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].tags, ['llm', 'edge']);
  assert.equal(rows[0].note, '有意思');
  store.close();
});

test('作者先验来自历史收录记录', () => {
  const { store } = freshStore();
  store.upsertRepo(repoFixture(), { runDate: '2026-09-13' });
  store.saveScore({ fullName: 'acme/tool', runDate: '2026-09-13', heuristic: 0.8, finalScore: 0.8 });
  const stats = store.getAuthorStats();
  assert.equal(stats.get('acme').repoCount, 1);
  assert.equal(stats.get('acme').bestScore, 0.8);
  store.close();
});

test('runs 表记录每次扫描的漏斗', () => {
  const { store } = freshStore();
  store.startRun({ runDate: '2026-09-13', source: 'github' });
  store.finishRun({
    runDate: '2026-09-13',
    candidates: 1000,
    afterFilter: 80,
    scored: 40,
    shown: 12,
    digestPath: 'out/digest.md',
    stats: { timings: { collectMs: 100 } },
  });
  const run = store.getRun('2026-09-13');
  assert.equal(run.candidates, 1000);
  assert.equal(run.shown, 12);
  assert.equal(run.digest_path, 'out/digest.md');
  assert.equal(JSON.parse(run.stats_json).timings.collectMs, 100);
  store.close();
});

test('数据库文件真的落在磁盘上', () => {
  const { store, dir } = freshStore();
  assert.ok(fs.existsSync(path.join(dir, 'metascan.db')));
  store.close();
});
