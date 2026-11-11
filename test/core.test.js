import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { normalizeConfig, resolveWebhook, loadDotEnv, ConfigError } from '../src/config.js';
import { buildCardWithinLimit, toCardMarkdown, payloadBytes } from '../src/lark/card.js';
import { signWebhook, sendCard } from '../src/lark/webhook.js';
import { toInterjection, extractMessages, createInterjectionReader } from '../src/lark/interjections.js';
import { createOpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { createClaudeCliProvider } from '../src/providers/claude-cli.js';
import { createAnthropicCompatibleProvider } from '../src/providers/anthropic-compatible.js';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const baseCfg = () => ({
  participants: [
    { id: 'a', name: 'A 模型', role: '甲', provider: 'mock', color: 'blue', webhook: { urlEnv: 'HOOK_A', secretEnv: 'SEC_A' } },
    { id: 'b', name: 'B 模型', role: '乙', provider: 'mock', color: 'orange' },
  ],
  chair: { id: 'chair', name: '主席', provider: 'mock', color: 'purple' },
});

test('normalizeConfig 补默认值', () => {
  const cfg = normalizeConfig(baseCfg());
  assert.equal(cfg.mode, 'decision');
  assert.equal(cfg.rounds, 20); // 默认自动轮数，上限 20
  assert.equal(cfg.adaptive, true);
  assert.equal(cfg.lark.maxCardBytes, 18000);
});

test('normalizeConfig 报出所有错误', () => {
  const raw = baseCfg();
  raw.participants[1].color = 'pink';
  raw.participants[1].provider = 'nope';
  raw.mode = 'chat';
  assert.throws(() => normalizeConfig(raw), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /mode/);
    assert.match(err.message, /color/);
    assert.match(err.message, /providers 里没有 nope/);
    return true;
  });
});

test('normalizeConfig 命令行覆盖', () => {
  const cfg = normalizeConfig(baseCfg(), { mode: 'brainstorm', rounds: 3, ignored: undefined });
  assert.equal(cfg.mode, 'brainstorm');
  assert.equal(cfg.rounds, 3);
});

test('resolveWebhook 从环境变量读取', () => {
  const cfg = normalizeConfig(baseCfg());
  assert.deepEqual(resolveWebhook(cfg.participants[0], { HOOK_A: 'https://x/hook/abc', SEC_A: 's' }), { url: 'https://x/hook/abc', secret: 's' });
  assert.equal(resolveWebhook(cfg.participants[0], {}), null);
  assert.equal(resolveWebhook(cfg.participants[1], {}), null);
});

test('loadDotEnv 不覆盖已有变量', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storm-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, '# c\nA=1\nB="two"\nC=keep\n');
  const env = { C: 'orig' };
  loadDotEnv(file, env);
  assert.deepEqual(env, { A: '1', B: 'two', C: 'orig' });
});

test('卡片 markdown 把 # 标题转成加粗', () => {
  assert.equal(toCardMarkdown('## 结论\n内容'), '**结论**\n内容');
});

test('超长卡片截断到上限以内', () => {
  const body = '很长的内容'.repeat(5000);
  const { card, truncated } = buildCardWithinLimit({ title: 't', body, color: 'blue', footer: 'f' }, { maxBytes: 18000 });
  assert.equal(truncated, true);
  assert.ok(payloadBytes(card) <= 18000);
  assert.match(card.elements[0].content, /已截断/);
  assert.equal(card.header.template, 'blue');
});

test('签名算法与飞书文档一致', () => {
  const expected = crypto.createHmac('sha256', '1700000000\nsecret').update('').digest('base64');
  assert.equal(signWebhook('secret', '1700000000'), expected);
});

test('sendCard 带签名，限流后重试', async () => {
  const calls = [];
  const replies = [{ code: 11232, msg: 'rate limited' }, { code: 0, msg: 'success' }];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify(replies.shift()), { status: 200 });
  };
  await sendCard({ url: 'https://x/hook/1', secret: 's' }, { header: {} }, { fetchImpl, now: () => 1700000000000, sleep: async () => {} });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].timestamp, '1700000000');
  assert.equal(calls[0].sign, signWebhook('s', '1700000000'));
  assert.equal(calls[0].msg_type, 'interactive');
});

test('sendCard 签名失败给出提示', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ code: 19021, msg: 'sign match fail' }), { status: 200 });
  await assert.rejects(sendCard({ url: 'u', secret: 's' }, {}, { fetchImpl, sleep: async () => {} }), /签名校验失败/);
});

test('插话只收人类的文本消息', () => {
  const user = { message_id: 'om_1', msg_type: 'text', create_time: '1700000000000', sender: { sender_type: 'user', id: 'ou_1', name: '张三' }, content: '{"text":"不能改表结构"}' };
  assert.deepEqual(toInterjection(user).text, '不能改表结构');
  assert.equal(toInterjection({ ...user, sender: { sender_type: 'app', id: 'cli' } }), null);
  assert.equal(toInterjection({ ...user, deleted: true }), null);
  assert.equal(toInterjection(user, ['ou_2']), null);
  const post = { ...user, msg_type: 'post', content: { title: '补充', content: [[{ tag: 'text', text: '预算有限' }]] } };
  assert.equal(toInterjection(post).text, '补充\n预算有限');
});

test('extractMessages 识别失败结果', () => {
  assert.throws(() => extractMessages({ ok: false, error: { message: 'denied' } }), /denied/);
  assert.equal(extractMessages({ ok: true, data: { messages: [1] } }).length, 1);
});

test('插话读取去重并带上时间窗', async () => {
  const seenArgs = [];
  const msg = { message_id: 'om_1', msg_type: 'text', sender: { sender_type: 'user', id: 'ou_1', name: '张三' }, content: { text: 'hi' } };
  const reader = createInterjectionReader({ chatId: 'oc_1', since: new Date('2026-01-01T00:00:00Z'), execImpl: async (bin, args) => { seenArgs.push(args); return { ok: true, data: { messages: [msg] } }; } });
  assert.equal((await reader.poll()).length, 1);
  assert.equal((await reader.poll()).length, 0);
  assert.ok(seenArgs[0].includes('--as') && seenArgs[0].includes('user'));
  assert.ok(seenArgs[0].includes('2026-01-01T00:00:00.000Z'));
});

test('OpenAI 兼容接口', async () => {
  let req;
  const fetchImpl = async (url, init) => {
    req = { url, init };
    return new Response(JSON.stringify({ model: 'deepseek-chat', choices: [{ message: { content: ' 答案 ' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }), { status: 200 });
  };
  const p = createOpenAICompatibleProvider({ name: 'ds', baseUrl: 'https://api.example.com/v1/', apiKeyEnv: 'K' }, { fetchImpl, env: { K: 'sk-test' } });
  const res = await p.complete({ model: 'deepseek-chat', system: 'sys', prompt: 'q' });
  assert.equal(req.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(req.init.headers.Authorization, 'Bearer sk-test');
  assert.deepEqual(JSON.parse(req.init.body).messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q' }]);
  assert.equal(res.text, '答案');
  assert.deepEqual(res.usage, { inputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

test('OpenAI 兼容接口缺 key 时报错', async () => {
  const p = createOpenAICompatibleProvider({ name: 'ds', baseUrl: 'https://x', apiKeyEnv: 'K' }, { fetchImpl: async () => { throw new Error('不应调用'); }, env: {} });
  await assert.rejects(p.complete({ prompt: 'q' }), /K 未设置/);
});

test('Anthropic 兼容接口：只取正文块，支持两种鉴权头', async () => {
  const reqs = [];
  const fetchImpl = async (url, init) => {
    reqs.push({ url, init });
    return new Response(JSON.stringify({
      model: 'deepseek-v4.1-flash-1017',
      content: [{ type: 'thinking', thinking: '想一想' }, { type: 'text', text: ' 收到 ' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 35, output_tokens: 18 },
    }), { status: 200 });
  };
  const spec = { name: 'bl', baseUrl: 'https://x/apps/anthropic/', apiKeyEnv: 'K' };
  const p = createAnthropicCompatibleProvider(spec, { fetchImpl, env: { K: 'sk-1' } });
  const res = await p.complete({ model: 'm', system: 'sys', prompt: 'q' });
  assert.equal(res.text, '收到');
  assert.deepEqual(res.usage, { inputTokens: 35, outputTokens: 18, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.equal(reqs[0].url, 'https://x/apps/anthropic/v1/messages');
  assert.equal(reqs[0].init.headers['x-api-key'], 'sk-1');
  const body = JSON.parse(reqs[0].init.body);
  assert.equal(body.system, 'sys');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'q' }]);

  const bearer = createAnthropicCompatibleProvider({ ...spec, authHeader: 'bearer' }, { fetchImpl, env: { K: 'sk-1' } });
  await bearer.complete({ model: 'm', prompt: 'q' });
  assert.equal(reqs[1].init.headers.Authorization, 'Bearer sk-1');
  assert.equal(reqs[1].init.headers['x-api-key'], undefined);
});

test('Anthropic 兼容接口：没有正文时报错', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ content: [{ type: 'thinking', thinking: '…' }], stop_reason: 'max_tokens' }), { status: 200 });
  const p = createAnthropicCompatibleProvider({ name: 'bl', baseUrl: 'https://x' }, { fetchImpl, env: {} });
  await assert.rejects(p.complete({ prompt: 'q' }), /没有正文.*max_tokens/);
});

function fakeSpawn(stdout, capture) {
  return (bin, args, opts) => {
    capture.push({ bin, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: (input) => { capture.at(-1).input = input; } };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', stdout);
      child.emit('close', 0);
    });
    return child;
  };
}

test('claude CLI：参数、输入与结果解析', async () => {
  const capture = [];
  const out = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: ' 方案 ', duration_ms: 1200,
    usage: { input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 9 }, total_cost_usd: 0.01,
    modelUsage: { 'claude-haiku-5-5': { outputTokens: 9, contextWindow: 1000000 } },
  });
  const p = createClaudeCliProvider({ name: 'claude-cli', effort: 'low', cwd: os.tmpdir() }, { spawnImpl: fakeSpawn(out, capture) });
  const res = await p.complete({ model: 'haiku', system: '你是测试', prompt: '议题' });
  assert.equal(res.text, '方案');
  assert.deepEqual(res.usage, { inputTokens: 12, outputTokens: 9, cacheReadTokens: 7, cacheWriteTokens: 0 });
  assert.equal(res.model, 'claude-haiku-5-5'); // 别名解析成真实模型
  assert.equal(res.contextWindow, 1000000);
  const { args, input } = capture[0];
  assert.equal(input, '议题');
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', '']);
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'haiku']);
  assert.ok(args.includes('--system-prompt') && args.includes('--effort'));
});

test('claude CLI：错误结果抛出', async () => {
  const out = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' });
  const p = createClaudeCliProvider({ cwd: os.tmpdir() }, { spawnImpl: fakeSpawn(out, []) });
  await assert.rejects(p.complete({ prompt: 'q' }), /boom/);
});

test('OpenAI 兼容接口：从 /models 查窗口（只查一次），读缓存命中与网关费用', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'g', max_input_tokens: 1048576 }] }), { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 80 } } }), {
      status: 200,
      headers: { 'x-litellm-response-cost': '0.0041' },
    });
  };
  const p = createOpenAICompatibleProvider({ name: 'gw', baseUrl: 'https://gw/v1' }, { fetchImpl, env: {} });
  const res = await p.complete({ model: 'g', prompt: 'q' });
  await p.complete({ model: 'g', prompt: 'q' });
  assert.equal(res.contextWindow, 1048576);
  assert.equal(res.usage.cacheReadTokens, 80);
  assert.equal(res.costUsd, 0.0041);
  assert.equal(urls.filter((u) => u.endsWith('/models')).length, 1);

  // DeepSeek 原生字段；配置了 contextWindow 时不查 /models
  const ds = createOpenAICompatibleProvider({ name: 'ds', baseUrl: 'https://ds', contextWindow: 5 }, {
    fetchImpl: async (url) => {
      assert.ok(!url.endsWith('/models'));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 9, completion_tokens: 1, prompt_cache_hit_tokens: 6 } }), { status: 200 });
    },
    env: {},
  });
  const r2 = await ds.complete({ model: 'x', prompt: 'q' });
  assert.equal(r2.contextWindow, 5);
  assert.equal(r2.usage.cacheReadTokens, 6);
  assert.equal(r2.costUsd, undefined);
});

test('Anthropic 兼容接口：缓存读写计入输入并单独记录', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 241, output_tokens: 5, cache_read_input_tokens: 1792, cache_creation_input_tokens: 10 } }), { status: 200 });
  const p = createAnthropicCompatibleProvider({ name: 'bl', baseUrl: 'https://x' }, { fetchImpl, env: {} });
  const res = await p.complete({ prompt: 'q' });
  assert.deepEqual(res.usage, { inputTokens: 2043, outputTokens: 5, cacheReadTokens: 1792, cacheWriteTokens: 10 });
});
