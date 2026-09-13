#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig } from '../src/config.mjs';
import { runScan } from '../src/run.mjs';
import { runSnapshot } from '../src/snapshot.mjs';
import { createGitHubClient } from '../src/github.mjs';
import { createLlmClient } from '../src/llm.mjs';
import { openStore } from '../src/store.mjs';
import { applyFeedback, describeWeights } from '../src/feedback.mjs';
import { formatChecks, runDoctor } from '../src/doctor.mjs';
import {
  applyEnvFile,
  color,
  formatCount,
  isValidDateString,
  log,
  resolveFrom,
  setQuiet,
  truncate,
  utcDateString,
} from '../src/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

const USAGE = `
${color.bold('MetaScanning')} — 每天扫描 GitHub 新发布的项目，按你的兴趣画像排序

用法:
  node bin/metascan.mjs <command> [options]

命令:
  run          执行一次扫描，生成当日 digest
  snapshot     更新已收录项目的 star 数（积累时间序列）
  feedback     对某个项目反馈收藏/忽略/深挖，驱动兴趣权重学习
  weights      查看当前学到的兴趣权重
  stats        查看本地数据库统计
  list         列出已收录的项目
  doctor       环境自检（token / 配置 / 网络 / 数据库）

常用选项:
  --date YYYY-MM-DD     指定扫描日期（UTC 日历日，默认今天）
  --offline             使用内置 fixtures 数据，不访问网络
  --include-zero-star   连 0 star 的新项目也扫（请求数会明显上升）
  --max-requests <n>    限制本次 GitHub API 请求数（想快速试一次真实扫描时用）
  --llm / --no-llm      强制开启或关闭 LLM 打分
  --config <path>       指定配置文件
  --limit <n>           限制处理数量（snapshot / list）
  --json                以 JSON 输出结果
  --quiet               只输出错误
  -h, --help            显示帮助

示例:
  node bin/metascan.mjs run --offline              # 先验证流水线
  node bin/metascan.mjs run --llm                  # 真实扫描 + LLM 打分
  node bin/metascan.mjs run --max-requests 30      # 快速试一次真实扫描（约 1 分钟）
  node bin/metascan.mjs run --include-zero-star    # 连零 star 的新项目一起扫
  node bin/metascan.mjs feedback lumen-labs/tinytune --save
  node bin/metascan.mjs snapshot                   # 第二天再跑，就能看到 star 走势
`;

async function main() {
  applyEnvFile(path.join(PROJECT_ROOT, '.env'));
  applyEnvFile(path.join(process.cwd(), '.env'));

  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        date: { type: 'string' },
        offline: { type: 'boolean' },
        'include-zero-star': { type: 'boolean' },
        'max-requests': { type: 'string' },
        llm: { type: 'boolean' },
        'no-llm': { type: 'boolean' },
        config: { type: 'string' },
        limit: { type: 'string' },
        note: { type: 'string' },
        json: { type: 'boolean' },
        quiet: { type: 'boolean' },
        save: { type: 'boolean' },
        ignore: { type: 'boolean' },
        deep: { type: 'boolean' },
        list: { type: 'boolean' },
        reset: { type: 'boolean' },
        'no-network': { type: 'boolean' },
        yes: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    log.error(error.message);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const { values, positionals } = parsed;
  const command = positionals[0] ?? (values.help ? 'help' : 'run');

  if (values.help || command === 'help') {
    console.log(USAGE);
    return;
  }
  if (values.quiet) setQuiet(true);

  const cwd = process.cwd();
  const day = values.date ?? utcDateString();
  if (values.date && !isValidDateString(values.date)) {
    log.error(`--date 需要是 YYYY-MM-DD 格式，收到：${values.date}`);
    process.exitCode = 2;
    return;
  }

  let config;
  try {
    config = await loadConfig({ cwd, configPath: values.config });
  } catch (error) {
    log.error(error.message);
    process.exitCode = 2;
    return;
  }

  const { errors } = validateConfig(config);
  if (errors.length) {
    for (const error of errors) log.error(`配置错误：${error}`);
    process.exitCode = 2;
    return;
  }

  switch (command) {
    case 'run':
      return cmdRun({ config, cwd, day, values, positionals });
    case 'snapshot':
      return cmdSnapshot({ config, cwd, day, values });
    case 'feedback':
      return cmdFeedback({ config, cwd, values, positionals });
    case 'weights':
      return cmdWeights({ config, cwd, values });
    case 'stats':
      return cmdStats({ config, cwd, values });
    case 'list':
      return cmdList({ config, cwd, values });
    case 'doctor':
      return cmdDoctor({ config, cwd, values });
    default:
      log.error(`未知命令：${command}`);
      console.log(USAGE);
      process.exitCode = 2;
  }
}

async function cmdRun({ config, cwd, day, values }) {
  if (values['max-requests'] !== undefined) {
    const budget = Number(values['max-requests']);
    if (!Number.isFinite(budget) || budget < 1) {
      log.error(`--max-requests 需要一个正整数，收到：${values['max-requests']}`);
      process.exitCode = 2;
      return;
    }
    config.collection.maxRequests = Math.floor(budget);
  }

  const useLlm = values.llm ? true : values['no-llm'] ? false : null;
  const started = Date.now();

  const result = await runScan({
    day,
    config,
    cwd,
    offline: Boolean(values.offline),
    includeZeroStar: Boolean(values['include-zero-star']),
    useLlm,
  });

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          day: result.day,
          source: result.source,
          funnel: {
            candidates: result.report.uniqueRepos,
            passed: result.funnel.passed.length,
            shown: result.items.length,
            byRule: result.funnel.byRule,
          },
          llm: result.llmInfo,
          coverage: {
            processedShards: result.report.processedShards,
            skippedShards: result.report.skippedShards,
            requests: result.report.requests,
            truncatedShards: result.report.truncatedShards,
          },
          warnings: result.warnings,
          digest: result.paths,
          picks: result.items.map((item) => ({
            fullName: item.repo.fullName,
            stars: item.repo.stars,
            final: item.final,
            verdict: item.llm?.verdict ?? null,
            tags: item.heuristic.matchedTags,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log('');
  const floor = config.ranking.displayFloor ?? 0;
  const shown = result.items.filter((item) => item.final >= floor);
  const lowConfidence = result.items.filter((item) => item.final < floor);

  log.ok(
    `扫描完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s · ` +
      `候选 ${formatCount(result.report.uniqueRepos)} → 精选 ${shown.length}` +
      `${lowConfidence.length ? ` · 低置信度 ${lowConfidence.length}` : ''}`,
  );
  if (shown.length) {
    console.log('');
    console.log(color.bold('今日精选：'));
    shown.forEach((item, index) => {
      const verdict = item.llm?.verdict || item.repo.description || '(无描述)';
      const stars = item.trend?.latestStars ?? item.repo.stars;
      const trend = item.trend?.delta ? color.green(` ${item.trend.delta > 0 ? '+' : ''}${item.trend.delta}`) : '';
      console.log(
        `  ${String(index + 1).padStart(2)}. ${color.cyan(item.repo.fullName)} ` +
          `${color.dim(`⭐${stars}`)}${trend}${color.dim(` · 综合 ${item.final.toFixed(2)}`)}`,
      );
      console.log(`      ${truncate(verdict, 110)}`);
    });
  } else {
    console.log('');
    console.log(color.yellow('今天没有综合分达到质量下限的项目。'));
  }
  if (lowConfidence.length) {
    console.log('');
    console.log(
      color.dim(
        `另有 ${lowConfidence.length} 条低于质量下限 ${floor}（多半是噪音），已列在日报末尾：`,
      ),
    );
    for (const item of lowConfidence) {
      console.log(color.dim(`     ${item.final.toFixed(2)}  ${item.repo.fullName}`));
    }
  }
  console.log('');
  console.log(`完整日报：${color.bold(result.paths.markdown)}`);
  console.log(color.dim(`机器可读：${result.paths.json}`));
  if (result.warnings.length) {
    console.log('');
    for (const warning of result.warnings) log.warn(warning);
  }
}

async function cmdSnapshot({ config, cwd, day, values }) {
  const store = openStore({ dataDir: resolveFrom(cwd, config.output.dataDir) });
  const offline = Boolean(values.offline);
  const client = offline
    ? null
    : createGitHubClient({
        maxRequests: config.collection.maxRequests,
        minIntervalMs: config.collection.minIntervalMs ?? undefined,
        logger: log,
      });

  try {
    const stats = await runSnapshot({
      store,
      client,
      config,
      day,
      offline,
      limit: values.limit ? Number(values.limit) : 2000,
    });
    if (values.json) {
      console.log(JSON.stringify(stats, null, 2));
      return;
    }
    if (!stats.considered) {
      log.warn('数据库里还没有收录任何项目，先跑一次 run。');
      return;
    }
    log.ok(
      `快照完成（${stats.mode}）：更新 ${stats.updated} 条，失败 ${stats.failed} 条` +
        `${stats.skippedNoToken ? `，因配额跳过 ${stats.skippedNoToken} 条` : ''}`,
    );
    if (stats.mode === 'simulated') {
      console.log(
        color.dim(`  离线模式用 fixtures 里声明的日增长量模拟了 ${stats.simulatedDay} 的观测值。`),
      );
    }
  } finally {
    store.close();
  }
}

function cmdFeedback({ config, cwd, values, positionals }) {
  const fullName = positionals[1];
  const store = openStore({ dataDir: resolveFrom(cwd, config.output.dataDir) });
  try {
    if (values.list) {
      const rows = store.listFeedback({ limit: values.limit ? Number(values.limit) : 30 });
      if (values.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (!rows.length) {
        log.info('还没有任何反馈记录。');
        return;
      }
      for (const row of rows) {
        console.log(
          `${color.cyan(row.action.padEnd(6))} ${row.full_name.padEnd(42)} ${color.dim(
            `${row.created_at.slice(0, 19)} ${row.tags.length ? `[${row.tags.join(',')}]` : ''}`,
          )}`,
        );
        if (row.note) console.log(`        ${color.dim(row.note)}`);
      }
      return;
    }

    if (!fullName) {
      log.error('用法：node bin/metascan.mjs feedback <owner/repo> --save|--ignore|--deep');
      log.info(color.dim('查看历史：node bin/metascan.mjs feedback --list'));
      process.exitCode = 2;
      return;
    }

    const chosen = [values.save && 'save', values.ignore && 'ignore', values.deep && 'deep'].filter(Boolean);
    if (chosen.length !== 1) {
      log.error(`需要且只能指定一个动作，收到：${chosen.length ? chosen.join(', ') : '无'}`);
      log.info('可选：--save（值得收藏） --ignore（不相关） --deep（想深入看）');
      process.exitCode = 2;
      return;
    }

    const result = applyFeedback({
      store,
      config,
      fullName,
      action: chosen[0],
      note: values.note ?? null,
    });

    if (values.json) {
      console.log(JSON.stringify({ action: result.action, tags: result.tags, changes: result.changes }, null, 2));
      return;
    }

    log.ok(`已记录 ${color.cyan(result.action)} → ${fullName}`);
    if (result.matchedNothing) {
      log.warn('这个项目没有命中任何兴趣标签，反馈被记录但不会改变权重。');
      return;
    }
    console.log(`  命中标签：${result.tags.join('、')}`);
    const top = result.changes.slice(0, 6);
    for (const change of top) {
      const bar = change.value >= 0 ? color.green('▲') : color.red('▼');
      console.log(`  ${bar} ${change.key.padEnd(34)} → ${change.value.toFixed(3)}`);
    }
    console.log(color.dim('  这些权重会直接参与下一次扫描的排序。'));
  } finally {
    store.close();
  }
}

function cmdWeights({ config, cwd, values }) {
  const store = openStore({ dataDir: resolveFrom(cwd, config.output.dataDir) });
  try {
    if (values.reset && values.yes) {
      store.resetWeights();
      log.ok('已清空学到的权重，兴趣画像回到配置文件的状态。');
      return;
    }
    if (values.reset) {
      log.warn('清空权重需要同时加 --yes 确认。');
      return;
    }
    const weights = describeWeights(store);
    if (values.json) {
      console.log(JSON.stringify(weights, null, 2));
      return;
    }
    if (!weights.length) {
      log.info('还没有学到任何权重。用 feedback 命令给出几条反馈后再来看。');
      return;
    }
    console.log(color.bold('学到的权重（绝对值越大影响越强）：'));
    for (const entry of weights.slice(0, 30)) {
      const sign = entry.value >= 0 ? color.green('+') : color.red('-');
      const bar = '█'.repeat(Math.min(20, Math.round(Math.abs(entry.value) * 20)));
      console.log(`  ${sign}${entry.key.padEnd(36)} ${entry.value.toFixed(3).padStart(7)} ${bar} ${color.dim(`×${entry.hits}`)}`);
    }
  } finally {
    store.close();
  }
}

function cmdStats({ config, cwd, values }) {
  const store = openStore({ dataDir: resolveFrom(cwd, config.output.dataDir) });
  try {
    const stats = store.stats();
    const runs = store.listRuns({ limit: 10 });
    if (values.json) {
      console.log(JSON.stringify({ stats, runs }, null, 2));
      return;
    }
    console.log(color.bold(`数据库：${store.path}`));
    console.log(`  收录项目   ${stats.repoCount}`);
    console.log(`  star 快照  ${stats.snapshotCount}`);
    console.log(`  评分记录   ${stats.scoreCount}`);
    console.log(`  扫描次数   ${stats.runCount}`);
    console.log(`  反馈条数   ${stats.feedbackCount}`);
    if (stats.feedbackByAction.length) {
      console.log(`  反馈分布   ${stats.feedbackByAction.map((row) => `${row.action}:${row.n}`).join(' ')}`);
    }
    if (runs.length) {
      console.log('');
      console.log(color.bold('最近几次运行：'));
      for (const run of runs) {
        console.log(
          `  ${run.run_date}  ${String(run.source).padEnd(8)} 候选 ${String(run.candidates).padStart(6)} → ` +
            `过滤 ${String(run.after_filter).padStart(5)} → 精选 ${String(run.shown).padStart(3)}`,
        );
      }
    }
  } finally {
    store.close();
  }
}

function cmdList({ config, cwd, values }) {
  const store = openStore({ dataDir: resolveFrom(cwd, config.output.dataDir) });
  try {
    const repos = store.listRepos({ limit: values.limit ? Number(values.limit) : 40 });
    if (values.json) {
      console.log(JSON.stringify(repos, null, 2));
      return;
    }
    if (!repos.length) {
      log.info('还没有收录任何项目。');
      return;
    }
    for (const repo of repos) {
      const trend = store.getStarTrend(repo.fullName);
      const trendText = trend && trend.delta ? color.green(` (+${trend.delta})`) : '';
      const stars = trend?.latestStars ?? repo.stars;
      console.log(
        `${repo.firstSeenDate ?? '----------'}  ${color.cyan(repo.fullName.padEnd(42))} ` +
          `⭐${String(stars).padStart(6)}${trendText}  ${color.dim(repo.language ?? '')}`,
      );
    }
  } finally {
    store.close();
  }
}

async function cmdDoctor({ config, cwd, values }) {
  const checks = await runDoctor({ config, cwd, checkNetwork: !values['no-network'] });
  if (values.json) {
    console.log(JSON.stringify(checks, null, 2));
    return;
  }
  console.log(color.bold('环境自检'));
  console.log(formatChecks(checks));
  const failed = checks.filter((c) => c.status === 'error').length;
  console.log('');
  console.log(failed ? color.red(`发现 ${failed} 个阻断问题。`) : color.green('没有阻断性问题，可以开始扫描。'));
  if (!values.offline) {
    console.log(color.dim('提示：想先不联网验证流水线，跑 node bin/metascan.mjs run --offline'));
  }
}

main().catch((error) => {
  log.error(error.stack ?? error.message);
  process.exitCode = 1;
});

export { main };
