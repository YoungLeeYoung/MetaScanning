import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFilters, filterRepo, matchAnyKeyword, repoText } from '../src/filters.mjs';
import { normalizeConfig } from '../src/config.mjs';

const baseConfig = normalizeConfig({
  profile: { name: 'test' },
  interests: [{ tag: 'ai', weight: 1, keywords: ['llm', 'agent'] }],
  excludes: {
    languages: ['HTML', 'Vue'],
    topics: ['awesome-list', 'template', 'course'],
    keywords: ['curated list', 'trading bot', 'homework'],
    owners: ['spam-owner'],
  },
  filters: { minSizeKb: 8, blockedNamePatterns: ['^scratch$'] },
});

function makeRepo(overrides = {}) {
  return {
    fullName: 'someone/something',
    owner: 'someone',
    name: 'something',
    description: 'A real project',
    language: 'Python',
    topics: [],
    stars: 5,
    forks: 0,
    sizeKb: 500,
    createdAt: '2026-09-13T04:00:00Z',
    isFork: false,
    archived: false,
    ...overrides,
  };
}

const day = '2026-09-13';

test('正常项目可以通过过滤', () => {
  const verdict = filterRepo(makeRepo(), { config: baseConfig, day });
  assert.equal(verdict.ok, true);
});

test('matchAnyKeyword 对短词做词边界判断，避免误命中', () => {
  const text = repoText({ name: 'storage-engine', description: 'a storage layer' });
  // "rag" 不应该命中 "storage"
  assert.deepEqual(matchAnyKeyword(text, ['rag']), []);
  assert.deepEqual(matchAnyKeyword(text, ['storage']), ['storage']);
});

test('逐条规则都能拦下对应的噪音', () => {
  const cases = [
    [{ isFork: true }, 'fork'],
    [{ archived: true }, 'archived'],
    [{ owner: 'spam-owner' }, 'excluded-owner'],
    [{ name: 'scratch' }, 'blocked-name'],
    [{ name: 'leetcode-notes' }, 'junk-name'],
    [{ name: 'test' }, 'junk-name'],
    [{ language: 'Vue' }, 'excluded-language'],
    [{ topics: ['awesome-list'] }, 'excluded-topic'],
    [{ description: 'A curated list of things' }, 'excluded-keyword'],
    [{ description: 'Crypto trading bot for airdrops' }, 'excluded-keyword'],
    // 作业类关键词靠配置拦（内置规则只管语言无关的通用垃圾特征）
    [{ description: 'My homework for CS336' }, 'excluded-keyword'],
    [{ description: '课程作业' }, 'junk-text'],
    [{ sizeKb: 3 }, 'too-small'],
    [{ createdAt: '2026-09-12T10:00:00Z' }, 'wrong-day'],
  ];

  for (const [overrides, expectedRule] of cases) {
    const verdict = filterRepo(makeRepo(overrides), { config: baseConfig, day });
    assert.equal(verdict.ok, false, `${expectedRule} 应该被拦下`);
    assert.equal(verdict.rule, expectedRule, `期望规则 ${expectedRule}，实际 ${verdict.rule}`);
  }
});

test('requireDescription 和 allowForks 可以放开对应限制', () => {
  const strict = normalizeConfig({ filters: { requireDescription: true } });
  assert.equal(filterRepo(makeRepo({ description: null }), { config: strict, day }).rule, 'no-description');

  const permissive = normalizeConfig({ filters: { allowForks: true } });
  assert.equal(filterRepo(makeRepo({ isFork: true }), { config: permissive, day }).ok, true);
});

test('applyFilters 汇总每条规则淘汰了多少条', () => {
  const repos = [
    makeRepo({ fullName: 'a/keep' }),
    makeRepo({ fullName: 'b/fork', isFork: true }),
    makeRepo({ fullName: 'c/fork2', isFork: true }),
    makeRepo({ fullName: 'd/test', name: 'test' }),
  ];
  const result = applyFilters(repos, { config: baseConfig, day });
  assert.equal(result.passed.length, 1);
  assert.equal(result.rejected.length, 3);
  assert.equal(result.byRule.fork, 2);
  assert.equal(result.byRule['junk-name'], 1);
});

test('既没有 description 也没有 topics 时会记一条 note', () => {
  const verdict = filterRepo(makeRepo({ description: null, topics: [] }), { config: baseConfig, day });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.notes.length, 1);
});
