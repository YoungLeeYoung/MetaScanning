import fs from 'node:fs';
import os from 'node:os';
import { validateConfig } from './config.mjs';
import { createGitHubClient } from './github.mjs';
import { createLlmClient } from './llm.mjs';
import { color, resolveFrom } from './util.mjs';

/**
 * 环境自检。
 *
 * 存在的理由：这个工具会同时依赖 GitHub API、可选的 LLM key、以及本地数据库。
 * 出问题时，你希望一眼看到「是哪一环没配好」，而不是对着一个报错猜。
 */
export async function runDoctor({ config, cwd, checkNetwork = true }) {
  const checks = [];
  const push = (name, status, detail, hint = null) => checks.push({ name, status, detail, hint });

  const major = Number(process.versions.node.split('.')[0]);
  const minor = Number(process.versions.node.split('.')[1]);
  const nodeOk = major > 22 || (major === 22 && minor >= 5);
  push(
    'Node.js 版本',
    nodeOk ? 'ok' : 'error',
    `v${process.versions.node}`,
    nodeOk ? null : '需要 Node 22.5 以上（内置 node:sqlite 需要），建议用 Node 24 LTS。',
  );

  try {
    const { DatabaseSync } = await import('node:sqlite');
    const probe = new DatabaseSync(':memory:');
    probe.exec('CREATE TABLE t(a INTEGER)');
    probe.close();
    push('node:sqlite', 'ok', '可用');
  } catch (error) {
    push('node:sqlite', 'error', error.message, '当前 Node 不带 sqlite 支持，请升级到 Node 22.5+ / 24。');
  }

  push('配置文件', 'ok', config.__source ?? '(已加载)');

  const { errors, warnings } = validateConfig(config);
  for (const error of errors) push('配置校验', 'error', error);
  for (const warning of warnings) push('配置校验', 'warn', warning);
  if (!errors.length && !warnings.length) push('配置校验', 'ok', '没有发现问题');

  const dataDir = resolveFrom(cwd, config.output.dataDir);
  const outputDir = resolveFrom(cwd, config.output.dir);
  for (const [label, dir] of [
    ['数据目录', dataDir],
    ['输出目录', outputDir],
  ]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      push(label, 'ok', dir);
    } catch (error) {
      push(label, 'error', `${dir}（${error.message}）`);
    }
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    push('GitHub token', 'ok', `已配置（${mask(token)}），搜索限流 30 次/分钟，快照走 GraphQL 批量`);
  } else {
    push(
      'GitHub token',
      'warn',
      '未配置',
      '搜索限流只有 10 次/分钟，且快照只能逐仓库查（每小时 60 次）。强烈建议配置 GITHUB_TOKEN。',
    );
  }

  const llmClient = createLlmClient({});
  if (llmClient.available) {
    const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    push('LLM', config.llm.enabled ? 'ok' : 'warn', `已配置 ${llmClient.model} @ ${baseUrl}`, config.llm.enabled ? null : 'llm.enabled 目前是 false，扫描时不会调用。');
  } else {
    push(
      `LLM（${config.llm.apiKeyEnv}）`,
      'warn',
      '未配置',
      '没有 key 也能跑，排序会退回纯启发式。想要「按方向理解项目」的效果时需要配置。',
    );
  }

  if (checkNetwork) {
    const client = createGitHubClient({ token, maxRequests: 1, maxRetries: 0 });
    try {
      const rate = await client.getRateLimit();
      const search = rate.search;
      push(
        'GitHub API 连通性',
        'ok',
        search ? `搜索配额剩余 ${search.remaining}/${search.limit}，重置于 ${new Date(search.reset * 1000).toLocaleTimeString()}` : '可达',
      );
    } catch (error) {
      push(
        'GitHub API 连通性',
        'warn',
        error.message,
        '如果这里是网络问题，可以先跑 `node bin/metascan.mjs run --offline` 验证流水线。',
      );
    }
  }

  return checks;
}

function mask(value) {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function formatChecks(checks) {
  const icon = { ok: color.green('✓'), warn: color.yellow('!'), error: color.red('✗') };
  const lines = [];
  for (const check of checks) {
    lines.push(`${icon[check.status] ?? '·'} ${check.name}: ${check.detail}`);
    if (check.hint) lines.push(`    ${color.dim(check.hint)}`);
  }
  return lines.join('\n');
}

export function platformSummary() {
  return `${os.platform()} ${os.release()} · ${os.cpus().length} cores`;
}
