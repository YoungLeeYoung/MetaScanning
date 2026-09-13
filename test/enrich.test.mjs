import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichRepos } from '../src/enrich.mjs';

const silent = { warn() {} };

/** 假客户端：可以精确控制 README 是否存在、还剩多少预算 */
function fakeClient({ readmes = {}, budget = Infinity } = {}) {
  let used = 0;
  return {
    get budgetLeft() {
      return Math.max(0, budget - used);
    },
    get requestCount() {
      return used;
    },
    async getReadme(fullName) {
      used += 1;
      return readmes[fullName] ?? null;
    },
  };
}

function repo(fullName, overrides = {}) {
  return { fullName, owner: fullName.split('/')[0], name: fullName.split('/')[1], ...overrides };
}

test('三种结果分别计数：拉到 README、仓库本身没有、复用历史', async () => {
  const client = fakeClient({ readmes: { 'a/has': '# hello\n内容' } });
  const repos = [
    repo('a/has'),
    repo('b/none'), // API 返回 404
    repo('c/cached', { readmeText: '# cached', readmeChars: 8 }),
  ];

  const { enriched, stats } = await enrichRepos(repos, { client, logger: silent });

  assert.equal(stats.fetched, 1);
  assert.equal(stats.noReadme, 1, '404 既不是成功也不是失败，必须单独计数');
  assert.equal(stats.reused, 1);
  assert.equal(stats.failed, 0);
  assert.equal(stats.attempted, 2, '只有真正发了请求的两个才算 attempted');
  assert.equal(
    stats.attempted,
    stats.fetched + stats.failed + stats.noReadme,
    'attempted 必须能被拆解干净，否则日志里的数字对不上',
  );
  assert.equal(enriched.length, 3, '返回顺序和输入一一对应');
  assert.equal(enriched[1].readmeText, null);
  assert.equal(enriched[1].readmeChars, 0);
});

test('预算用尽时跳过剩余候选，并记下它们的名字', async () => {
  const client = fakeClient({ readmes: { 'a/1': '# 1', 'a/2': '# 2' }, budget: 2 });
  const repos = [repo('a/1'), repo('a/2'), repo('a/3'), repo('a/4')];

  const { stats } = await enrichRepos(repos, { client, logger: silent });

  assert.equal(stats.fetched, 2);
  assert.equal(stats.skippedBudget, 2);
  assert.deepEqual(stats.skippedNames, ['a/3', 'a/4'], '上层要靠这个名字把它们从排序里剔除');
});

test('单个仓库失败不会中断整批', async () => {
  const client = {
    budgetLeft: 100,
    requestCount: 0,
    async getReadme(fullName) {
      if (fullName === 'a/boom') throw new Error('网络抖动');
      return '# ok';
    },
  };
  const repos = [repo('a/boom'), repo('a/fine')];

  const { stats } = await enrichRepos(repos, { client, logger: silent });
  assert.equal(stats.failed, 1);
  assert.equal(stats.fetched, 1);
  assert.equal(stats.attempted, 2);
});
