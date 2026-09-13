import test from 'node:test';
import assert from 'node:assert/strict';
import { deepMerge, defaultConfig, normalizeConfig, validateConfig } from '../src/config.mjs';

test('deepMerge 递归合并对象，但数组整体替换', () => {
  const merged = deepMerge({ a: { b: 1, c: 2 }, list: [1, 2] }, { a: { c: 3 }, list: [9] });
  assert.deepEqual(merged, { a: { b: 1, c: 3 }, list: [9] });
});

test('normalizeConfig 填上默认值并清洗兴趣点', () => {
  const config = normalizeConfig({
    interests: [
      { tag: 'ok', weight: '2', keywords: ['  a  ', 'b', ''] },
      { tag: '', keywords: ['x'] },
      { tag: 'no-keywords', keywords: [] },
    ],
  });
  assert.equal(config.interests.length, 1);
  assert.equal(config.interests[0].weight, 2);
  assert.deepEqual(config.interests[0].keywords, ['  a  ', 'b']);
  assert.deepEqual(config.llm.deep, defaultConfig().llm.deep);
});

test('normalizeConfig 把越界的权重夹回合法区间', () => {
  const config = normalizeConfig({ interests: [{ tag: 't', weight: 99, keywords: ['k'] }] });
  assert.equal(config.interests[0].weight, 5);
  const low = normalizeConfig({ interests: [{ tag: 't', weight: -3, keywords: ['k'] }] });
  assert.equal(low.interests[0].weight, 0.05);
});

test('validateConfig 报出阻断性错误', () => {
  const empty = normalizeConfig({ interests: [], collection: { starTiers: [] } });
  const { errors } = validateConfig(empty);
  assert.ok(errors.some((e) => e.includes('interests')));
  assert.ok(errors.some((e) => e.includes('starTiers')));
});

test('validateConfig 对可优化项给出警告而不是报错', () => {
  const config = normalizeConfig({
    interests: [{ tag: 't', keywords: ['k'] }],
    excludes: { keywords: [], topics: [] },
    collection: { languages: [] },
  });
  const { errors, warnings } = validateConfig(config);
  assert.equal(errors.length, 0);
  assert.ok(warnings.some((w) => w.includes('excludes')));
  assert.ok(warnings.some((w) => w.includes('languages')));
});
