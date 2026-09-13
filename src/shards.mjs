import { uniq } from './util.mjs';

/**
 * GitHub Search API 的一个硬限制：单次查询最多只能翻到 1000 条结果
 * （page * per_page <= 1000）。而一天新建的公开仓库是 10 万量级，
 * 所以「created:DATE fork:false」这一个查询会静默丢掉 99% 的数据。
 *
 * 解决办法是按 star 区间切片，撞到上限时再按体积、语言递归拆分。
 *
 * 这里有一个容易做错的地方：语言分片是宽查询的**子集**，
 * 所以「预先展开语言分片」是纯浪费——某天如果没有任何 >100 star 的新项目，
 * 那个区间的宽查询返回 0，它的 24 个语言分片也必然全是 0。
 * 因此这里的策略是「先问宽查询，只在撞到上限时才展开」。
 *
 * 如果哪天 GitHub 放宽了这个限制，改这一个文件就够了。
 */

export const SEARCH_RESULT_CAP = 1000;

/** 仓库体积（KB）分桶，用于撞上限后的二次拆分 */
export const SIZE_BUCKETS = ['<25', '25..150', '150..1000', '1000..10000', '>10000'];

/** 把 '26..100' / '>100' / '0' 这类写法解析成数值区间 */
export function parseStarTier(tier) {
  const text = String(tier).trim();
  if (text.startsWith('>=')) {
    const min = Number(text.slice(2));
    return { min, max: null, sortKey: Number.isFinite(min) ? min : 0 };
  }
  if (text.startsWith('>')) {
    const min = Number(text.slice(1)) + 1;
    return { min, max: null, sortKey: Number.isFinite(min) ? min : 0 };
  }
  if (text.includes('..')) {
    const [rawMin, rawMax] = text.split('..');
    const min = Number(rawMin);
    const max = Number(rawMax);
    return { min, max, sortKey: Number.isFinite(min) ? min : 0 };
  }
  const exact = Number(text);
  return { min: exact, max: exact, sortKey: Number.isFinite(exact) ? exact : 0 };
}

export function tierInRange(stars, tier) {
  const { min, max } = parseStarTier(tier);
  if (Number.isFinite(min) && stars < min) return false;
  if (max !== null && Number.isFinite(max) && stars > max) return false;
  return true;
}

export function buildQuery({ day, tier, language, sizeBucket, allowForks = false }) {
  const parts = [`created:${day}`];
  if (!allowForks) parts.push('fork:false');
  if (tier) parts.push(`stars:${tier}`);
  if (language) parts.push(`language:"${language}"`);
  if (sizeBucket) parts.push(`size:${sizeBucket}`);
  return parts.join(' ');
}

export function shardLabel({ tier, language, sizeBucket }) {
  const bits = [tier ? `stars:${tier}` : 'stars:*'];
  if (language) bits.push(language);
  if (sizeBucket) bits.push(`size:${sizeBucket}`);
  return bits.join(' / ');
}

/**
 * 生成初始分片计划：每个 star 区间只发一个宽查询。
 *
 * 排序原则：star 越高的区间信号越强，排在最前面。
 * 这样即使请求预算中途耗尽，你拿到的也是质量最高的那部分数据。
 *
 * 语言维度不在这里展开，交给 expandShard——只有当某个区间真的超过
 * 1000 条可达上限时，按语言拆分才有意义。
 */
export function planShards({ day, config, includeZeroStar = false }) {
  const allowForks = config.filters?.allowForks ?? false;

  const tiers = uniq(config.collection?.starTiers ?? [])
    .concat(includeZeroStar ? ['0'] : [])
    .sort((a, b) => parseStarTier(b).sortKey - parseStarTier(a).sortKey);

  return tiers.map((tier) => {
    const shard = {
      id: `t=${tier}|lang=*`,
      tier,
      language: null,
      sizeBucket: null,
      depth: 0,
      query: buildQuery({ day, tier, allowForks }),
    };
    return { ...shard, label: shardLabel(shard) };
  });
}

/**
 * 把一个撞到 1000 条上限的分片继续拆小。
 *
 * 拆分维度是交替的：先按体积，再按语言。
 * 只用一个维度是不够的——比如 stars:0 的整个「无语言」宽查询，
 * 按体积拆完之后单个桶仍可能超过 1000 条，这时必须再叠一层语言。
 *
 * 两个维度都用满还超上限时返回空数组，由调用方记录「不可再分」的告警，
 * 而不是假装数据是完整的。
 */
export function expandShard(shard, { day, config } = {}) {
  const allowForks = config?.filters?.allowForks ?? false;
  const makeChild = (patch) => {
    const child = {
      ...shard,
      ...patch,
      depth: (shard.depth ?? 0) + 1,
    };
    child.query = buildQuery({
      day,
      tier: child.tier,
      language: child.language,
      sizeBucket: child.sizeBucket,
      allowForks,
    });
    child.id = `t=${child.tier}|lang=${child.language ?? '*'}|size=${child.sizeBucket ?? '*'}`;
    child.label = shardLabel(child);
    return child;
  };

  if (!shard.sizeBucket) {
    return SIZE_BUCKETS.map((sizeBucket) => makeChild({ sizeBucket }));
  }

  if (!shard.language) {
    /**
     * 不往被排除的语言里展开。
     *
     * 否则会花请求去拉一堆注定要被丢掉的仓库——实测里一次运行有 324 条
     * 因为 excluded-language 被淘汰，其中 215 条是 HTML，白花了 3 次请求。
     * 代价是子分片的并集不再覆盖父分片全集，但被排除掉的那部分本来就不要。
     */
    const excluded = new Set((config?.excludes?.languages ?? []).map((lang) => String(lang).toLowerCase()));
    const languages = (config?.collection?.languages ?? []).filter(
      (language) => !excluded.has(String(language).toLowerCase()),
    );
    return languages.map((language) => makeChild({ language }));
  }

  return [];
}

/**
 * 采集结果的自检：判断一个分片是否没能拿全。
 *
 * overCap 单独标出来，因为两种截断的处理方式不同：
 *   overCap=true  —— 总量超过 1000 条可达上限，**必须**拆分成子分片才可能拿全
 *   overCap=false —— 只是翻页没翻完，多翻几页就行，拆反而是浪费
 */
export function detectTruncation({ totalCount = 0, fetchedCount = 0, reachedPageCap = false }) {
  if (totalCount > SEARCH_RESULT_CAP) {
    return {
      truncated: true,
      overCap: true,
      reason: `total_count=${totalCount} 超过 ${SEARCH_RESULT_CAP} 条可达上限`,
    };
  }
  if (fetchedCount < totalCount) {
    return {
      truncated: true,
      overCap: false,
      reason: reachedPageCap
        ? `翻页受限，仅抓取 ${fetchedCount}/${totalCount} 条`
        : `仅抓取 ${fetchedCount}/${totalCount} 条`,
    };
  }
  return { truncated: false, overCap: false, reason: null };
}
