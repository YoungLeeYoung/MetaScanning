import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_RESULT_CAP,
  buildQuery,
  detectTruncation,
  expandShard,
  parseStarTier,
  planShards,
  tierInRange,
} from '../src/shards.mjs';

const config = {
  filters: { allowForks: false },
  collection: { languages: ['Python', 'Rust'], starTiers: ['1..5', '26..100', '>100'] },
};

test('parseStarTier 支持区间、开区间和精确值', () => {
  assert.deepEqual(parseStarTier('1..5'), { min: 1, max: 5, sortKey: 1 });
  assert.deepEqual(parseStarTier('>100'), { min: 101, max: null, sortKey: 101 });
  assert.deepEqual(parseStarTier('>=100'), { min: 100, max: null, sortKey: 100 });
  assert.deepEqual(parseStarTier('0'), { min: 0, max: 0, sortKey: 0 });
});

test('tierInRange 正确判断边界', () => {
  assert.equal(tierInRange(3, '1..5'), true);
  assert.equal(tierInRange(1, '1..5'), true);
  assert.equal(tierInRange(5, '1..5'), true);
  assert.equal(tierInRange(6, '1..5'), false);
  assert.equal(tierInRange(0, '1..5'), false);
  assert.equal(tierInRange(101, '>100'), true);
  assert.equal(tierInRange(100, '>100'), false);
});

test('buildQuery 拼出合法的 GitHub 搜索语法', () => {
  assert.equal(
    buildQuery({ day: '2026-09-13', tier: '>100', language: 'Rust' }),
    'created:2026-09-13 fork:false stars:>100 language:"Rust"',
  );
  assert.equal(
    buildQuery({ day: '2026-09-13', tier: '0', sizeBucket: '<25', allowForks: true }),
    'created:2026-09-13 stars:0 size:<25',
  );
});

test('planShards 每个 star 区间只发一个宽查询，不预先展开语言分片', () => {
  const shards = planShards({ day: '2026-09-13', config });
  // 语言分片是宽查询的子集，只有撞到 1000 条上限时展开才有意义。
  // 预先展开会让「今天没有高 star 新项目」这种常见情况白白烧掉几十次请求。
  assert.equal(shards.length, 3);
  assert.ok(shards.every((s) => s.language === null && s.sizeBucket === null));
  assert.equal(shards[0].tier, '>100');

  const tiers = shards.map((s) => s.tier);
  assert.deepEqual(tiers, ['>100', '26..100', '1..5'], '高 star 区间排在最前面');
});

test('planShards 的 includeZeroStar 会把 0 star 区间加到最后', () => {
  const shards = planShards({ day: '2026-09-13', config, includeZeroStar: true });
  const tiers = shards.map((s) => s.tier);
  assert.deepEqual(tiers, ['>100', '26..100', '1..5', '0']);
  assert.equal(shards.length, 4);
});

test('expandShard 先按体积拆，再按语言拆，最后停止', () => {
  const [wide] = planShards({ day: '2026-09-13', config });
  assert.equal(wide.depth, 0);

  const bySize = expandShard(wide, { day: '2026-09-13', config });
  assert.equal(bySize.length, 5);
  assert.ok(bySize.every((s) => s.depth === 1 && s.sizeBucket));

  const byLanguage = expandShard(bySize[0], { day: '2026-09-13', config });
  assert.equal(byLanguage.length, 2);
  assert.ok(byLanguage.every((s) => s.depth === 2 && s.language && s.sizeBucket));
  // 子分片的查询必须同时带上两个维度，否则会和父分片重叠
  assert.match(byLanguage[0].query, /size:<25/);
  assert.match(byLanguage[0].query, /language:"Python"/);

  // 两个维度都用满后不再继续拆，返回空数组让调用方记录告警
  assert.deepEqual(expandShard(byLanguage[0], { day: '2026-09-13', config }), []);
});

test('detectTruncation 区分「超过 1000 上限」和「翻页没翻完」', () => {
  const complete = detectTruncation({ totalCount: 300, fetchedCount: 300, reachedPageCap: false });
  assert.equal(complete.truncated, false);

  const overCap = detectTruncation({ totalCount: 12000, fetchedCount: 1000, reachedPageCap: true });
  assert.equal(overCap.truncated, true);
  assert.equal(overCap.overCap, true, '超过 1000 上限才值得拆分子分片');
  assert.match(overCap.reason, /12000/);

  const pageCap = detectTruncation({ totalCount: 800, fetchedCount: 200, reachedPageCap: true });
  assert.equal(pageCap.truncated, true);
  assert.equal(pageCap.overCap, false, '只是没翻完，多翻几页就行，不该拆分');
  assert.match(pageCap.reason, /200\/800/);

  assert.equal(SEARCH_RESULT_CAP, 1000);
});
