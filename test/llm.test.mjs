import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlmClient, extractJson, fuseScores, normalizeJudgement } from '../src/llm.mjs';

const silent = { warn() {}, info() {}, step() {}, error() {} };

function mockChatResponse(content, usage = { prompt_tokens: 100, completion_tokens: 50 }) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }], usage }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

test('extractJson 能处理裸 JSON、代码块和带前后缀的回复', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('```\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(extractJson('好的，结果如下：\n{"a":1}\n以上。'), { a: 1 });
  assert.deepEqual(extractJson('[{"a":1},{"b":2}] 后面还有废话'), [{ a: 1 }, { b: 2 }]);
  assert.equal(extractJson('完全不是 JSON'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
});

test('normalizeJudgement 把 0-10 的评分折算成 0-1，并做边界保护', () => {
  const judgement = normalizeJudgement({ fit: 8, novelty: 6, quality: 10, verdict: ' 不错 ', tags: ['llm', '', 3] });
  assert.equal(judgement.score, (8 * 0.5 + 6 * 0.25 + 10 * 0.25) / 10);
  assert.equal(judgement.verdict, '不错');
  assert.deepEqual(judgement.tags, ['llm']);

  const clamped = normalizeJudgement({ fit: 99, novelty: -5, quality: 'abc' });
  assert.equal(clamped.fit, 10);
  assert.equal(clamped.novelty, 0);
  assert.equal(clamped.quality, 3, '解析不出来时用保守的默认值');
});

test('fuseScores 在没有 LLM 分数时退回启发式', () => {
  assert.equal(fuseScores({ heuristic: 0.4, llm: null }), 0.4);
  assert.equal(fuseScores({ heuristic: 0.4, llm: 0.8 }), 0.4 * 0.45 + 0.8 * 0.55);
});

test('judge 按 batchSize 分批调用，并把结果映射回仓库名', async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const names = [...body.messages[1].content.matchAll(/full_name: ([\w-]+\/[\w-]+)/g)].map((m) => m[1]);
    calls.push(names);
    return mockChatResponse(
      JSON.stringify({
        results: names.map((full_name) => ({
          full_name,
          fit: 7,
          novelty: 5,
          quality: 6,
          verdict: '还行',
          why: '因为它做了 X',
          tags: ['llm'],
          caution: '',
        })),
      }),
    );
  };

  const client = createLlmClient({ apiKey: 'test-key', fetchImpl, logger: silent });
  const items = [
    { fullName: 'a/one' },
    { fullName: 'b/two' },
    { fullName: 'c/three' },
  ];
  const { results } = await client.judge({ profile: { description: 'x' }, items, batchSize: 2 });

  assert.equal(calls.length, 2, '3 条候选、批量 2 → 应该有 2 次调用');
  assert.equal(results.size, 3);
  assert.equal(results.get('c/three').verdict, '还行');
  assert.equal(client.usage.calls, 2);
  assert.equal(client.usage.promptTokens, 200);
});

test('judge 遇到无法解析的回复时自动拆小批量重试，而不是整体失败', async () => {
  const calls = [];
  let call = 0;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const names = [...body.messages[1].content.matchAll(/full_name: ([\w-]+\/[\w-]+)/g)].map((m) => m[1]);
    calls.push(names);
    call += 1;
    // 第一次故意返回垃圾，后面返回正常 JSON
    if (call === 1) return mockChatResponse('对不起，我无法完成这个请求');
    return mockChatResponse(
      JSON.stringify({ results: names.map((full_name) => ({ full_name, fit: 5, novelty: 5, quality: 5 })) }),
    );
  };

  const client = createLlmClient({ apiKey: 'test-key', fetchImpl, logger: silent });
  const { results, failedBatches } = await client.judge({
    profile: { description: 'x' },
    items: [{ fullName: 'a/one' }, { fullName: 'b/two' }],
    batchSize: 2,
  });

  assert.equal(failedBatches, 0);
  assert.equal(results.size, 2, '拆成单条之后都应该拿到结果');
  assert.equal(calls.length, 3, '1 次批量失败 + 2 次单条重试');
});

test('接口报错时不会抛穿，而是把错误带回来让上层降级（并保留可读信息）', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 });
  const client = createLlmClient({ apiKey: 'bad', fetchImpl, logger: silent });

  const outcome = await client.judge({ profile: { description: 'x' }, items: [{ fullName: 'a/one' }] });
  assert.equal(outcome.results.size, 0, '拿不到结果');
  assert.equal(outcome.callErrors.length, 1, '错误被收集而不是被吞掉');
  assert.match(outcome.callErrors[0], /401/);
  assert.match(outcome.callErrors[0], /invalid api key/);
  assert.equal(outcome.parseFailures, 0, '这不是解析失败，不应该被算成解析问题');
});

test('解析失败和接口失败被分开统计', async () => {
  const fetchImpl = async () => mockChatResponse('我今天不想输出 JSON');
  const client = createLlmClient({ apiKey: 'test-key', fetchImpl, logger: silent });
  const outcome = await client.judge({ profile: { description: 'x' }, items: [{ fullName: 'a/one' }] });
  assert.equal(outcome.parseFailures, 1);
  assert.equal(outcome.callErrors.length, 0);
});

test('没有 api key 时 available 为 false', () => {
  const client = createLlmClient({ apiKey: '', fetchImpl: async () => mockChatResponse('{}') });
  assert.equal(client.available, false);
});
