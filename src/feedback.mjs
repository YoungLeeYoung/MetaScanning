import { FEEDBACK_TARGETS, matchInterests } from './heuristic.mjs';

/**
 * 反馈闭环。
 *
 * 这是整个项目里唯一「越用越好」的部分：
 * 你说收藏 / 忽略，系统把这次判断拆解到标签和关键词上，
 * 沉淀成权重，下一次排序就带着这个偏好。
 *
 * 用 EMA（指数滑动平均）而不是简单累加，是为了让反复反馈收敛到一个稳定值，
 * 而不是几次点击就把某个方向推到极端。
 */

export const VALID_ACTIONS = Object.keys(FEEDBACK_TARGETS);

export function applyFeedback({ store, config, fullName, action, note = null }) {
  if (!VALID_ACTIONS.includes(action)) {
    throw new Error(`未知的反馈动作「${action}」，可选：${VALID_ACTIONS.join(' / ')}`);
  }

  const repo = store.getRepo(fullName);
  if (!repo) {
    throw new Error(
      `数据库里没有 ${fullName}。反馈只能针对工具推荐过的项目；` +
        `可以先跑一次 scan，或者确认仓库名拼写。`,
    );
  }

  const matches = matchInterests(repo, { config, weights: store.getWeights(), includeReadme: true });
  const hitMatches = matches.filter((m) => m.hits.length);
  const tags = hitMatches.map((m) => m.tag);
  const keywords = hitMatches.flatMap((m) => m.hits);

  const target = FEEDBACK_TARGETS[action];
  const changes = [];

  for (const tag of tags) {
    const next = store.bumpWeight(`tag:${tag}`, target);
    changes.push({ key: `tag:${tag}`, value: next });
  }
  for (const keyword of keywords) {
    const next = store.bumpWeight(`kw:${keyword}`, target);
    changes.push({ key: `kw:${keyword}`, value: next });
  }

  store.recordFeedback({ fullName, action, note, tags });

  return {
    repo,
    action,
    note,
    tags,
    keywords,
    changes,
    matchedNothing: hitMatches.length === 0,
  };
}

export function describeWeights(store) {
  const weights = [...store.getWeights().entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return weights;
}
