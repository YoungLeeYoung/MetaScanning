import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScan } from '../src/run.mjs';
import { normalizeConfig } from '../src/config.mjs';

/**
 * LLM 打分链路的端到端测试。
 *
 * 用一个假的 OpenAI 兼容接口替换 fetch，验证的是真实代码路径：
 * 批量 prompt 组装 → 结构化解析 → 分数融合 → 深度分析 → 写进 digest。
 */

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const silent = { info() {}, step() {}, warn() {}, ok() {}, error() {} };
const day = '2026-09-13';

function setupWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metascan-llm-'));
  fs.mkdirSync(path.join(dir, 'fixtures'), { recursive: true });
  fs.copyFileSync(
    path.join(PROJECT_ROOT, 'fixtures', 'sample-repos.json'),
    path.join(dir, 'fixtures', 'sample-repos.json'),
  );
  const config = normalizeConfig({
    profile: { name: 'llm-e2e', description: '关注边缘推理和 agent 工具链' },
    interests: [
      { tag: 'edge', weight: 1.1, keywords: ['on-device', 'quantization', 'gguf'] },
      { tag: 'agent', weight: 1.2, keywords: ['agent', 'mcp'] },
    ],
    excludes: { topics: ['awesome-list', 'template'], keywords: ['trading bot', 'course assignment'] },
    ranking: { shortlistSize: 6, enrichLimit: 40, llmCandidateLimit: 10 },
    llm: {
      enabled: true,
      batchSize: 5,
      deep: { enabled: true, topK: 2, modelEnv: 'METASCAN_DEEP_MODEL' },
    },
    output: { dir: 'out', dataDir: 'data' },
  });
  return { dir, config };
}

/** 假接口：judge 请求返回评分数组，deep 请求返回解读对象 */
function fakeOpenAi({ onCall } = {}) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const userContent = body.messages[1].content;
    onCall?.(body);

    const isDeepDive = userContent.includes('## README');
    let content;
    if (isDeepDive) {
      content = JSON.stringify({
        summary: '一个边缘端微调工具',
        why_it_matters: '正好对应你在做的本地推理场景',
        risks: '只支持 LoRA',
        try_first: '先跑 profile 子命令看看自己设备的余量',
      });
    } else {
      const names = [...userContent.matchAll(/full_name: ([\w-]+\/[\w-]+)/g)].map((m) => m[1]);
      content = JSON.stringify({
        results: names.map((full_name, index) => ({
          full_name,
          fit: index === 0 ? 9 : 6,
          novelty: 7,
          quality: 8,
          verdict: `判定：${full_name} 值得一看`,
          why: '它解决了一个具体的工程问题',
          tags: ['edge'],
          caution: '',
        })),
      });
    }

    return new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 800, completion_tokens: 200 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
}

test('LLM 打分：结果被融合进最终排序并写进 digest', async () => {
  const { dir, config } = setupWorkspace();
  const calls = [];
  const savedKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';

  try {
    const result = await runScan({
      day,
      config,
      cwd: dir,
      offline: true,
      useLlm: true,
      llmFetchImpl: fakeOpenAi({ onCall: (b) => calls.push(b) }),
      logger: silent,
    });

    assert.equal(result.llmInfo.used, true);
    assert.equal(result.llmInfo.model, 'gpt-4o-mini');
    assert.ok(result.llmInfo.judged > 0, '应该有候选被评分');
    assert.equal(result.llmInfo.deepDives, 2, 'topK=2 应该做两次深度分析');
    assert.ok(result.llmInfo.estimatedCostUsd > 0);

    const judged = result.items.filter((item) => item.llm);
    assert.ok(judged.length > 0, 'digest 里应该有带 LLM 结论的条目');
    // 融合后 LLM 分数必须真的参与计算，而不是只被记录
    for (const item of judged) {
      const expected = item.heuristic.total * 0.45 + item.llm.score * 0.55;
      assert.ok(Math.abs(item.final - expected) < 1e-9, `${item.repo.fullName} 的融合分数不对`);
    }

    const deep = result.items.filter((item) => item.deep);
    assert.equal(deep.length, 2);
    assert.ok(deep[0].deep.summary);

    const markdown = fs.readFileSync(result.paths.markdown, 'utf8');
    assert.match(markdown, /\*\*结论\*\*：判定：/);
    assert.match(markdown, /\*\*为什么值得看\*\*：/);
    assert.match(markdown, /\*\*它到底做了什么\*\*：一个边缘端微调工具/);
    assert.match(markdown, /LLM 打分：gpt-4o-mini/);
    assert.doesNotMatch(markdown, /NaN/);

    const payload = JSON.parse(fs.readFileSync(result.paths.json, 'utf8'));
    assert.equal(payload.llm.used, true);
    assert.ok(payload.picks[0].scores.llm !== null);
    assert.ok(payload.picks[0].verdict);
    assert.ok(payload.picks[0].deep.summary);
  } finally {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
  }
});

test('LLM 打分：接口整体失败时降级为纯启发式并说明原因', async () => {
  const { dir, config } = setupWorkspace();
  const savedKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';

  try {
    const failing = async () => new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429 });
    const result = await runScan({
      day,
      config,
      cwd: dir,
      offline: true,
      useLlm: true,
      llmFetchImpl: failing,
      logger: silent,
    });

    assert.equal(result.llmInfo.used, true, '接口调用了，只是没结果');
    assert.ok(result.items.length > 0, '降级之后仍然要有结果');
    assert.ok(result.items.every((item) => !item.llm), '没有 LLM 分数');
    assert.ok(
      result.warnings.some((w) => w.includes('LLM 接口出错') && w.includes('quota exceeded')),
      `警告里应该说明原因，实际：${JSON.stringify(result.warnings)}`,
    );

    const markdown = fs.readFileSync(result.paths.markdown, 'utf8');
    assert.match(markdown, /LLM 接口出错/);
    assert.match(markdown, /OPENAI_API_KEY \/ OPENAI_BASE_URL \/ METASCAN_MODEL/);
  } finally {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
  }
});
