// 第一批修补：临时故障重试、输出截断、上下文占用口径、评审互见、主席失败兜底、结束原因、本场无代码。
import { whoOf } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { runDiscussion, runFollowUp, occupancyOf, isTransient, blockerLines } from '../src/orchestrator.js';
import { createMemoryPublisher } from '../src/publishers.js';
import { createOpenAICompatibleProvider, httpError } from '../src/providers/openai-compatible.js';
import { docPrompt, critiquePrompt } from '../src/modes.js';

const base = (extra = {}) => normalizeConfig({
  participants: [
    { id: 'a', name: 'A', provider: 'fake', part: 'lead' },
    { id: 'b', name: 'B', provider: 'fake', part: 'lead' },
    { id: 'r1', name: 'R1', provider: 'fake', part: 'reviewer' },
    { id: 'r2', name: 'R2', provider: 'fake', part: 'reviewer' },
  ],
  chair: { id: 'chair', name: '主席', provider: 'fake' },
  providers: { fake: { type: 'mock' } },
  retryDelayMs: 0,
  ...extra,
});

const GOOD_DOC = '【说明】\n一句话结论\n【主文档】\n# 结论\n正文';

/** reply(call) 返回字符串作为回答；返回 Error 就抛出。 */
function scripted(reply = () => null) {
  const calls = [];
  const provider = {
    async complete(opts) {
      const who = whoOf(opts);
      const stage = /【阶段：([^】]+)】/.exec(opts.prompt)?.[1] ?? '';
      const call = { who, stage, prompt: opts.prompt, n: calls.length + 1 };
      calls.push(call);
      const out = reply(call);
      if (out instanceof Error) throw out;
      return { text: out ?? (stage.includes('主文档') ? GOOD_DOC : `发言-${calls.length}`), usage: { inputTokens: 10, outputTokens: 1 } };
    },
  };
  return { calls, registry: { get: () => provider } };
}

const events = () => {
  const list = [];
  return { list, onEvent: (e) => list.push(e) };
};

test('临时故障：超时和 5xx 重试一次，4xx 和普通错误不重试', async () => {
  assert.ok(isTransient(httpError('x', 502, 'bad gateway')));
  assert.ok(!isTransient(httpError('x', 400, 'bad request')));
  assert.ok(isTransient(Object.assign(new Error('t'), { name: 'TimeoutError' })));
  assert.ok(isTransient(new TypeError('fetch failed')));
  assert.ok(!isTransient(new Error('配置错了')));

  let failedOnce = false;
  const { calls, registry } = scripted((c) => {
    if (c.who === 'A' && !failedOnce) {
      failedOnce = true;
      return httpError('fake', 503, 'busy');
    }
    if (c.who === 'B' && c.stage === '独立方案') return new Error('永久失败');
    return null;
  });
  const ev = events();
  const res = await runDiscussion({ cfg: base({ rounds: 2 }), topic: 't', providers: registry, publisher: createMemoryPublisher(), rng: () => 0, onEvent: ev.onEvent });
  assert.equal(calls.filter((c) => c.who === 'A' && c.stage === '独立方案').length, 2); // A 重试成功
  assert.equal(calls.filter((c) => c.who === 'B' && c.stage === '独立方案').length, 1); // B 不重试
  assert.ok(ev.list.some((e) => e.type === 'call_failed' && e.willRetry));
  assert.ok(ev.list.some((e) => e.type === 'call_started' && e.retry === 'error'));
  assert.equal(res.state.latest.length, 1);
});

test('openai-compatible：finish_reason 为 length 时标记截断', async () => {
  const fetchImpl = async () => ({
    ok: true,
    headers: { get: () => null },
    text: async () => JSON.stringify({ choices: [{ message: { content: '半截' }, finish_reason: 'length' }], usage: { prompt_tokens: 5, completion_tokens: 9 } }),
  });
  const p = createOpenAICompatibleProvider({ name: 'gw', baseUrl: 'http://x', contextWindow: 100 }, { fetchImpl });
  const res = await p.complete({ model: 'm', prompt: 'hi' });
  assert.equal(res.truncated, true);
  const failing = createOpenAICompatibleProvider({ name: 'gw', baseUrl: 'http://x', contextWindow: 100 }, { fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'oops' }) });
  await assert.rejects(failing.complete({ model: 'm', prompt: 'hi' }), (err) => err.retryable === true && err.status === 500);
});

test('上下文占用：单回合是准确值，多回合只能估下界', () => {
  assert.deepEqual(occupancyOf({ usage: { inputTokens: 300000 } }, { window: 1000000 }), { tokens: 300000, kind: 'exact', pct: 0.3 });
  // 30 回合累计 120 万：平均 4 万，缓存写入 20 万，上次已知 25 万 → 下界 25 万
  assert.deepEqual(occupancyOf({ usage: { inputTokens: 1200000, cacheWriteTokens: 200000 }, turns: 30 }, { window: 1000000, last: 250000 }), { tokens: 250000, kind: 'lower', pct: 0.25 });
  assert.equal(occupancyOf({ usage: { inputTokens: 10 } }).pct, null);
});

test('评审互见：评审看到上一轮其他评审的阻断原文，看不到自己的', async () => {
  assert.deepEqual(blockerLines('**要点**：x\n- 【阻断】缓存击穿 → 超卖 → 加锁\n- 【建议】改名'), ['- 【阻断】缓存击穿 → 超卖 → 加锁']);
  const { calls, registry } = scripted((c) => (c.who === 'R1' && c.stage.includes('第 2 轮') ? '**要点**：1 条阻断\n- 【阻断】缓存击穿-R1 → 超卖 → 加锁\n评审结论：继续讨论' : null));
  await runDiscussion({ cfg: base({ rounds: 3 }), topic: 't', providers: registry, publisher: createMemoryPublisher(), rng: () => 0 });
  const r2 = calls.find((c) => c.who === 'R2' && c.stage.includes('第 3 轮'));
  assert.match(r2.prompt, /上一轮其他评审提的阻断/);
  assert.match(r2.prompt, /缓存击穿-R1/);
  const r1 = calls.find((c) => c.who === 'R1' && c.stage.includes('第 3 轮'));
  assert.doesNotMatch(r1.prompt, /上一轮其他评审提的阻断/);
  // 第 2 轮没有上一轮的评审意见
  assert.doesNotMatch(calls.find((c) => c.who === 'R2' && c.stage.includes('第 2 轮')).prompt, /上一轮其他评审提的阻断/);
  assert.equal(critiquePrompt({ round: 2, proposals: [], peers: [] }).includes('上一轮其他评审'), false);
});

test('主席写不出主文档（调用失败）：重写一次，仍失败就由程序发兜底卡片', async () => {
  const { calls, registry } = scripted((c) => {
    if (c.stage === '主文档') return new Error('主席挂了');
    if (c.who === 'R1') return '**要点**：x\n- 【阻断】漏了回滚 → 出事回不去 → 加开关\n评审结论：继续讨论';
    return null;
  });
  const publisher = createMemoryPublisher();
  const ev = events();
  const res = await runDiscussion({ cfg: base({ rounds: 2 }), topic: 't', providers: registry, publisher, rng: () => 0, onEvent: ev.onEvent, number: 9 });
  assert.equal(calls.filter((c) => c.stage === '主文档').length, 2);
  const card = publisher.posts.find((p) => p.meta?.stage === 'fallback');
  assert.ok(card, '应该有兜底卡片');
  assert.match(card.body, /各主笔的最终方案/);
  assert.match(card.body, /漏了回滚/);
  assert.match(card.body, /node src\/cli\.js doc 9/);
  assert.equal(res.state.docFailed, true);
  assert.ok(ev.list.some((e) => e.type === 'doc_failed'));
  assert.equal(res.state.ending.reason, 'fixed');
});

test('追问：主席判断失败按重新讨论处理；run_finished 写真实的结束原因', async () => {
  const cfg = base({ rounds: 2, followUpMaxRounds: 2 });
  const first = await runDiscussion({ cfg, topic: 't', providers: scripted().registry, publisher: createMemoryPublisher(), rng: () => 0 });
  const { calls, registry } = scripted((c) => (c.stage === '追问判断' ? new Error('主席挂了') : null));
  const ev = events();
  const out = await runFollowUp({ cfg, state: first.state, question: '再想想', providers: registry, publisher: createMemoryPublisher(), onEvent: ev.onEvent });
  assert.equal(out.handling, 'discuss');
  assert.ok(calls.some((c) => c.stage.includes('回应追问')));
  assert.equal(out.state.followUps.at(-1).triageFailed, true);
  const finished = ev.list.find((e) => e.type === 'run_finished');
  assert.ok(['max', 'converged', 'fixed'].includes(finished.ending), finished.ending);
  assert.notEqual(finished.ending, 'followup');
});

test('本场无代码：开场卡片和主席的提示词都写明', async () => {
  const publisher = createMemoryPublisher();
  const { calls, registry } = scripted();
  await runDiscussion({ cfg: base({ rounds: 2 }), topic: 't', providers: registry, publisher, rng: () => 0 });
  assert.match(publisher.posts[0].body, /本场无代码/);
  assert.match(calls.find((c) => c.stage === '主文档').prompt, /本场无代码/);
  assert.match(publisher.posts.at(-1).body, /本场无代码/);
  assert.doesNotMatch(docPrompt({ mode: 'decision', rounds: [], finals: [] }), /本场无代码/);
});
