import test from 'node:test';
import assert from 'node:assert/strict';
import { explainRepo, formatExplanation } from '../src/explain.mjs';
import { buildFields } from '../src/heuristic.mjs';
import { normalizeConfig } from '../src/config.mjs';

const config = normalizeConfig({
  interests: [
    { tag: 'edge', weight: 1.1, keywords: ['quantization', 'gguf'] },
    { tag: 'llm', weight: 1.0, keywords: ['tokenizer', 'eval'] },
  ],
  excludes: { topics: ['awesome-list'], keywords: ['trading bot'] },
});

function repo(overrides = {}) {
  return {
    fullName: 'acme/thing',
    owner: 'acme',
    name: 'thing',
    description: 'A quantization toolkit',
    language: 'Rust',
    topics: ['quantization'],
    stars: 10,
    forks: 1,
    sizeKb: 500,
    license: 'MIT',
    homepage: null,
    createdAt: '2026-09-13T01:00:00Z',
    pushedAt: '2026-09-13T05:00:00Z',
    readmeText: 'This project uses gguf and a tokenizer.',
    readmeChars: 40,
    archived: false,
    isFork: false,
    ...overrides,
  };
}

test('关键词能追溯到具体是哪个字段命中的', () => {
  const explanation = explainRepo(repo(), { config });
  const edge = explanation.tags.find((t) => t.tag === 'edge');

  const quantization = edge.hits.find((h) => h.keyword === 'quantization');
  assert.deepEqual(quantization.fields.sort(), ['description', 'topics'], '描述和 topics 里都有');

  const gguf = edge.hits.find((h) => h.keyword === 'gguf');
  assert.deepEqual(gguf.fields, ['readme'], '只出现在 README 里');
});

test('命中来源分布把 README 和 topics 分开统计', () => {
  const explanation = explainRepo(repo(), { config });
  assert.equal(explanation.fieldHits.topics, 1, 'quantization');
  assert.equal(explanation.fieldHits.description, 1, 'quantization');
  assert.equal(explanation.fieldHits.readme, 2, 'gguf + tokenizer');
  assert.equal(explanation.fieldHits.name, 0);
});

test('没有 README 时只靠元数据匹配，并标记这个事实', () => {
  const explanation = explainRepo(repo({ readmeText: null, readmeChars: 0 }), { config });
  assert.equal(explanation.readmeMissing, true);
  assert.equal(explanation.fieldHits.readme, 0);
  assert.equal(explanation.fieldHits.description, 1, '描述里的 quantization 仍然命中');
  assert.equal(explanation.tags.find((t) => t.tag === 'llm').hits.length, 0, '只写在 README 的词匹配不到了');
});

test('被规则拦下的项目也会被指出来，并说明分数只作参考', () => {
  const explanation = explainRepo(repo({ topics: ['awesome-list'] }), { config });
  assert.equal(explanation.filterVerdict.ok, false);
  assert.equal(explanation.filterVerdict.rule, 'excluded-topic');

  const text = formatExplanation(explanation);
  assert.match(text, /被拦下：excluded-topic/);
  assert.match(text, /它不会进入评分/);
});

test('列出画像里有但完全没出现的词', () => {
  const explanation = explainRepo(repo({ description: 'nothing relevant', topics: [], readmeText: null }), { config });
  const missed = explanation.missedKeywords.map((m) => m.keyword);
  assert.deepEqual(missed.sort(), ['eval', 'gguf', 'quantization', 'tokenizer']);

  const text = formatExplanation(explanation);
  assert.match(text, /画像里有、但这个项目完全没出现的词/);
});

test('输出里包含分数构成，且能看出权重相乘', () => {
  const explanation = explainRepo(repo(), { config });
  const text = formatExplanation(explanation);
  assert.match(text, /【4】分数构成/);
  assert.match(text, /兴趣匹配\s+0\.\d+ × 0\.45/);
  assert.match(text, /综合分（启发式）/);
});

test('buildFields 把 topics 数组摊平成可搜索文本', () => {
  const fields = buildFields(repo({ topics: ['edge-ai', 'Quantization'] }));
  assert.match(fields.topics, /edge-ai/);
  assert.match(fields.topics, /quantization/, '应该小写化');
});
