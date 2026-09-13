import { createSerialQueue, sleep, truncate } from './util.mjs';

/**
 * GitHub REST / GraphQL 客户端。
 * 只用内置 fetch，没有第三方依赖。
 *
 * 限流节奏：
 *   - 带 token：Search API 30 次/分钟
 *   - 不带 token：10 次/分钟
 * 这里用串行队列 + 固定间隔来保证不触发 secondary rate limit。
 */

export const API_ROOT = 'https://api.github.com';

/** Search API 的分页硬限制：page × per_page 不能超过 1000，也就是最多 10 页 × 100 条 */
export const MAX_REACHABLE_RESULTS = 1000;
export const MAX_PAGES = 10;

export class GitHubError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
}

export class RateLimitError extends GitHubError {
  constructor(message, { resetAt, status, body } = {}) {
    super(message, { status, body });
    this.name = 'RateLimitError';
    this.resetAt = resetAt ?? null;
  }
}

export class RequestBudgetExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RequestBudgetExceededError';
  }
}

export function mapApiRepo(item) {
  return {
    fullName: item.full_name,
    owner: item.owner?.login ?? String(item.full_name ?? '').split('/')[0] ?? null,
    name: item.name ?? String(item.full_name ?? '').split('/')[1] ?? null,
    url: item.html_url ?? null,
    description: item.description ?? null,
    homepage: item.homepage || null,
    language: item.language ?? null,
    topics: Array.isArray(item.topics) ? item.topics : [],
    stars: item.stargazers_count ?? 0,
    forks: item.forks_count ?? 0,
    openIssues: item.open_issues_count ?? 0,
    sizeKb: item.size ?? 0,
    createdAt: item.created_at ?? null,
    pushedAt: item.pushed_at ?? null,
    license: item.license?.spdx_id && item.license.spdx_id !== 'NOASSERTION' ? item.license.spdx_id : null,
    archived: Boolean(item.archived),
    isFork: Boolean(item.fork),
    hasReadme: false,
    readmeChars: 0,
    readmeText: null,
    nodeId: item.node_id ?? null,
    extra: {
      watchers: item.watchers_count ?? null,
      defaultBranch: item.default_branch ?? null,
      hasIssues: item.has_issues ?? null,
      isTemplate: item.is_template ?? null,
    },
  };
}

export function createGitHubClient({
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null,
  fetchImpl = globalThis.fetch,
  minIntervalMs,
  maxRequests = Infinity,
  maxRetries = 2,
  apiRoot = API_ROOT,
  logger = null,
} = {}) {
  const authenticated = Boolean(token);
  const interval = minIntervalMs ?? (authenticated ? 2100 : 6500);
  const enqueue = createSerialQueue({ minIntervalMs: interval });
  let requestCount = 0;

  async function rawRequest(url, { accept = 'application/vnd.github+json', method = 'GET', body = null } = {}) {
    if (requestCount >= maxRequests) {
      throw new RequestBudgetExceededError(`已达请求预算上限 ${maxRequests}`);
    }
    requestCount += 1;

    const headers = {
      accept,
      'user-agent': 'MetaScanning/0.1 (+https://github.com/)',
      'x-github-api-version': '2022-11-28',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body) headers['content-type'] = 'application/json';

    return enqueue(async () => {
      let attempt = 0;
      for (;;) {
        const response = await fetchImpl(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
        });

        if (response.status === 404) return { response, json: null, notFound: true };

        if (response.status === 403 || response.status === 429) {
          const remaining = response.headers.get('x-ratelimit-remaining');
          const resetHeader = response.headers.get('x-ratelimit-reset');
          const retryAfter = Number(response.headers.get('retry-after') ?? '0');
          const isRateLimited = remaining === '0' || retryAfter > 0 || response.status === 429;

          if (isRateLimited && attempt < maxRetries) {
            const resetAt = resetHeader ? Number(resetHeader) * 1000 : null;
            const waitMs = retryAfter > 0 ? retryAfter * 1000 : resetAt ? resetAt - Date.now() : 2000;
            // 等待超过 90 秒就不硬扛了，交给上层降级处理（保留已抓到的部分结果）
            if (waitMs <= 90_000) {
              attempt += 1;
              logger?.warn?.(`命中限流，等待 ${Math.ceil(waitMs / 1000)}s 后重试（第 ${attempt} 次）`);
              await sleep(Math.max(waitMs, 1000));
              continue;
            }
            throw new RateLimitError('GitHub 限流，且重置时间太远', {
              status: response.status,
              resetAt,
            });
          }
        }

        if (response.status >= 500 && attempt < maxRetries) {
          attempt += 1;
          await sleep(1000 * 2 ** attempt);
          continue;
        }

        const text = await response.text();
        let json = null;
        if (text) {
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
        }

        if (!response.ok) {
          throw new GitHubError(`GitHub API ${response.status} ${url}`, {
            status: response.status,
            body: json ?? text,
          });
        }
        return { response, json, text, notFound: false };
      }
    });
  }

  return {
    authenticated,
    get requestCount() {
      return requestCount;
    },
    get budgetLeft() {
      return Math.max(0, maxRequests - requestCount);
    },
    intervalMs: interval,

    /**
     * 搜索仓库。perPage 最大 100，page 最多到 10（1000 条硬上限）。
     *
     * adaptivePaging：第一页会带回 total_count，如果这个分片总量在 1000 条以内，
     * 就自动把翻页上限提到「刚好把它翻完」。
     *
     * 这一步很关键。不做的话会出现两种浪费：
     *   - 拿不全 → 上层以为被截断 → 花几十次请求拆成语言子分片去补，而其实多翻两页就够了
     *   - 或者干脆静默少拿数据
     */
    async searchRepos({ q, perPage = 100, maxPages = 1, sort = null, order = 'desc', adaptivePaging = true }) {
      const items = [];
      let totalCount = 0;
      let pages = 0;
      let incomplete = false;
      let pageLimit = Math.max(1, maxPages);
      let adapted = false;

      for (let page = 1; page <= pageLimit; page += 1) {
        const params = new URLSearchParams({ q, per_page: String(perPage), page: String(page) });
        if (sort) {
          params.set('sort', sort);
          params.set('order', order);
        }
        const { json } = await rawRequest(`${apiRoot}/search/repositories?${params.toString()}`);
        if (!json) break;
        totalCount = json.total_count ?? 0;
        incomplete = Boolean(json.incomplete_results);
        const batch = json.items ?? [];
        items.push(...batch.map(mapApiRepo));
        pages += 1;

        if (page === 1 && adaptivePaging && totalCount > 0 && totalCount <= MAX_REACHABLE_RESULTS) {
          const needed = Math.ceil(totalCount / perPage);
          if (needed > pageLimit) {
            pageLimit = Math.min(MAX_PAGES, needed);
            adapted = true;
          }
        }

        // 已经拿完 / 已经到达 1000 条可达上限，就没必要继续翻页
        if (batch.length < perPage) break;
        if (page * perPage >= MAX_REACHABLE_RESULTS) break;
      }

      return { items, totalCount, pages, incomplete, pageLimit, adapted };
    },

    async getReadme(fullName) {
      const { text, json, notFound } = await rawRequest(`${apiRoot}/repos/${fullName}/readme`, {
        accept: 'application/vnd.github.raw',
      });
      if (notFound) return null;
      if (typeof text === 'string' && text.trim()) return text;
      // 某些代理/镜像会忽略 Accept，退化成 JSON + base64
      if (json?.content) {
        return Buffer.from(json.content, json.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
      }
      return null;
    },

    async getRepo(fullName) {
      const { json, notFound } = await rawRequest(`${apiRoot}/repos/${fullName}`);
      if (notFound || !json) return null;
      return mapApiRepo(json);
    },

    /**
     * 用 GraphQL 一次查 100 个仓库的最新 star 数。
     * REST 要 100 次请求的事情，这里 1 次就能做完——快照功能靠它才现实。
     */
    async fetchRepoStars(nodeIds) {
      if (!authenticated) throw new GitHubError('GraphQL 需要 token');
      const ids = nodeIds.filter(Boolean);
      if (!ids.length) return [];

      const query = `
        query ($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Repository {
              nameWithOwner
              stargazerCount
              forkCount
              issues(states: OPEN) { totalCount }
            }
          }
        }
      `;
      const { json } = await rawRequest(`${apiRoot}/graphql`, {
        method: 'POST',
        body: { query, variables: { ids } },
      });
      if (json?.errors?.length) {
        throw new GitHubError(`GraphQL 错误：${json.errors[0]?.message ?? 'unknown'}`);
      }
      return (json?.data?.nodes ?? [])
        .filter(Boolean)
        .map((node) => ({
          fullName: node.nameWithOwner,
          stars: node.stargazerCount ?? 0,
          forks: node.forkCount ?? 0,
          openIssues: node.issues?.totalCount ?? 0,
        }));
    },

    async getRateLimit() {
      const { json } = await rawRequest(`${apiRoot}/rate_limit`);
      return {
        core: json?.resources?.core ?? null,
        search: json?.resources?.search ?? null,
        graphql: json?.resources?.graphql ?? null,
      };
    },
  };
}

export function assertReadmePreview(text, max = 6000) {
  return truncate(text ?? '', max);
}
