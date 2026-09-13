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
  assert.deepEqual(llm.matchedKeywords.sort(), ['eval', 'llm']);
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
  assert.deepEqual(withReadme.find((m) => m.tag === 'llm').matchedKeywords, ['tokenizer']);
});

test('字段证据权重：作者主动声明的 topics 比 README 里顺带提及更有分量', () => {
  const declared = matchInterests(repo({ description: '', topics: ['llm'], readmeText: '' }), { config });
  const mentioned = matchInterests(
    repo({ description: '', topics: [], readmeText: 'a long doc that happens to mention llm' }),
    { config },
  );
  const declaredLlm = declared.find((m) => m.tag === 'llm');
  const mentionedLlm = mentioned.find((m) => m.tag === 'llm');

  assert.equal(declaredLlm.hits[0].fieldWeight, 1, 'topics 权重 1.0');
  assert.equal(mentionedLlm.hits[0].fieldWeight, 0.4, 'README 权重 0.4');
  assert.ok(declaredLlm.strength > mentionedLlm.strength);
});

test('兴趣分不再四次命中就饱和：堆关键词换不来满分', () => {
  const many = ['llm', 'eval', 'tokenizer'];
  const a = matchInterests(repo({ description: many.join(' '), topics: many, readmeText: '' }), { config });
  const b = matchInterests(
    repo({ description: 'llm eval tokenizer', topics: ['llm', 'eval', 'tokenizer', 'prompt', 'rag'], readmeText: '' }),
    { config },
  );
  const strengthA = a.find((m) => m.tag === 'llm').strength;
  const strengthB = b.find((m) => m.tag === 'llm').strength;

  assert.ok(strengthA < 1, `多次命中也不该直接顶到 1.0，实际 ${strengthA}`);
  assert.ok(strengthB > strengthA, '命中更多时仍应该继续上升，而不是提前封顶');
});

test('质量分是连续曲线：更长的 README 拿到更高而不是相同的分', () => {
  const short = scoreQuality({ description: 'x'.repeat(60), topics: [], readmeChars: 4000, license: 'MIT' });
  const long = scoreQuality({ description: 'x'.repeat(60), topics: [], readmeChars: 18000, license: 'MIT' });
  assert.ok(long.score > short.score, '4KB 和 18KB 的 README 必须拉得开');
  assert.ok(short.score < 1, '不该轻易顶到满分');
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

test('四个维度的权重可以从配置里调，而不是写死在代码里', () => {
  const base = { description: 'x'.repeat(80), topics: ['llm'], readmeChars: 100, readmeText: '', stars: 1 };
  const popular = repo({ ...base, stars: 60, topics: ['llm'] });

  const interestFirst = normalizeConfig({
    interests: [{ tag: 'llm', keywords: ['llm'] }],
    ranking: { weights: { interest: 0.9, quality: 0.05, momentum: 0.05, author: 0 } },
  });
  const momentumFirst = normalizeConfig({
    interests: [{ tag: 'llm', keywords: ['llm'] }],
    ranking: { weights: { interest: 0.05, quality: 0.05, momentum: 0.9, author: 0 } },
  });

  const a = scoreHeuristic(popular, { config: interestFirst });
  const b = scoreHeuristic(popular, { config: momentumFirst });

  assert.equal(a.weights.interest, 0.9);
  assert.equal(b.weights.momentum, 0.9);
  assert.ok(b.total > a.total, '动量权重高时，同一条高 star 项目得分应该更高');
  // 未指定的维度回落到默认值，不需要把四个都写全
  assert.equal(b.weights.quality, 0.05);
});

test('没配置 weights 时用默认值', () => {
  const scored = scoreHeuristic(repo(), { config });
  assert.deepEqual(scored.weights, { interest: 0.45, quality: 0.25, momentum: 0.2, author: 0.1 });
});
