import test from 'node:test';
import assert from 'node:assert/strict';
import { matchInterests, rankCandidates, scoreHeuristic, scoreMomentum, scoreQuality } from '../src/heuristic.mjs';
import { normalizeConfig } from '../src/config.mjs';

const config = normalizeConfig({
  profile: { name: 'test' },
  interests: [
    { tag: 'llm', weight: 1.2, keywords: ['llm', 'eval', 'tokenizer'] },
    { tag: 'edge', weight: 1.0, keywords: ['on-device', 'quantization'] },
    { tag: 'infra', weight: 0.5, keywords: ['build system'] },
  ],
});

function repo(overrides = {}) {
  return {
    fullName: 'acme/thing',
    owner: 'acme',
    name: 'thing',
    description: 'An LLM evaluation harness',
    language: 'Python',
    topics: ['llm', 'eval'],
    stars: 10,
    forks: 2,
    sizeKb: 800,
    license: 'MIT',
    homepage: 'https://example.com',
    createdAt: '2026-09-13T01:00:00Z',
    pushedAt: '2026-09-13T05:00:00Z',
    readmeChars: 4000,
    readmeText: 'An evaluation harness for llm pipelines. It supports quantization aware testing.',
    archived: false,
    isFork: false,
    ...overrides,
  };
}

test('matchInterests 命中关键词并算出强度', () => {
  const matches = matchInterests(repo(), { config });
  const llm = matches.find((m) => m.tag === 'llm');
  assert.deepEqual(llm.hits.sort(), ['eval', 'llm']);
  assert.ok(llm.strength > 0.4);
  assert.equal(matches.find((m) => m.tag === 'infra').hits.length, 0);
});

test('includeReadme=false 时只看元数据，不看 README', () => {
  const repoWithReadmeOnly = repo({
    name: 'thing',
    description: 'nothing here',
    topics: [],
    readmeText: 'This project is all about tokenizer internals.',
  });
  const without = matchInterests(repoWithReadmeOnly, { config, includeReadme: false });
  const withReadme = matchInterests(repoWithReadmeOnly, { config, includeReadme: true });
  assert.equal(without.find((m) => m.tag === 'llm').hits.length, 0);
  assert.deepEqual(withReadme.find((m) => m.tag === 'llm').hits, ['tokenizer']);
});

test('学到的正向权重会抬高分数，负向权重会压低分数', () => {
  const weights = new Map([
    ['tag:llm', { value: 1, hits: 3 }],
    ['kw:llm', { value: 1, hits: 3 }],
  ]);
  const boosted = scoreHeuristic(repo(), { config, weights });
  const neutral = scoreHeuristic(repo(), { config });
  assert.ok(boosted.total > neutral.total);

  const negative = new Map([['tag:llm', { value: -1, hits: 3 }]]);
  const damped = scoreHeuristic(repo(), { config, weights: negative });
  assert.ok(damped.total < neutral.total);
});

test('多个方向同时命中时比只命中一个方向得分更高（noisy-or）', () => {
  const single = scoreHeuristic(repo({ readmeText: '' }), { config });
  const multi = scoreHeuristic(
    repo({
      description: 'An LLM evaluation harness with on-device quantization support',
      topics: ['llm', 'eval', 'on-device'],
      readmeText: '',
    }),
    { config },
  );
  assert.ok(multi.parts.interest > single.parts.interest);
  assert.ok(multi.total > single.total);
});

test('quality 和 momentum 随信号单调上升', () => {
  const bare = scoreQuality({ description: '', topics: [], readmeChars: 0, license: null, homepage: null });
  const rich = scoreQuality({
    description: 'x'.repeat(80),
    topics: ['a', 'b', 'c', 'd'],
    readmeChars: 5000,
    license: 'MIT',
    homepage: 'https://example.com',
    pushedAt: '2026-09-13T05:00:00Z',
    createdAt: '2026-09-13T01:00:00Z',
  });
  assert.ok(rich.score > bare.score);
  assert.ok(rich.score <= 1);

  assert.ok(scoreMomentum({ stars: 80 }).score > scoreMomentum({ stars: 3 }).score);
  assert.ok(scoreMomentum({ stars: 0 }).score > 0);
});

test('高分项目不会被惩罚项误伤，垃圾项目会被扣分', () => {
  const clean = scoreHeuristic(repo(), { config });
  assert.equal(clean.penalties.length, 0);

  const spammy = scoreHeuristic(
    repo({ name: 'a-b-c-d-e', description: '', topics: [], readmeChars: 0, homepage: null, license: null }),
    { config },
  );
  assert.ok(spammy.penalties.some((p) => p.code === 'no-info'));
  assert.ok(spammy.penalties.some((p) => p.code === 'spammy-name'));
});

test('rankCandidates 按总分降序，同分时 star 多的在前', () => {
  const ranked = rankCandidates([
    { repo: { fullName: 'a', stars: 1 }, heuristic: { total: 0.5 } },
    { repo: { fullName: 'b', stars: 99 }, heuristic: { total: 0.5 } },
    { repo: { fullName: 'c', stars: 0 }, heuristic: { total: 0.9 } },
  ]);
  assert.deepEqual(ranked.map((r) => r.repo.fullName), ['c', 'b', 'a']);
});
