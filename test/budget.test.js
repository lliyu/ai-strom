// 第二批：主席输入预算。讨论记录和核实结果从新到旧装填，放不下的较早部分缩略或省略；必须保留的内容不受限。
import { whoOf } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { runDiscussion, runFollowUp } from '../src/orchestrator.js';
import { createMemoryPublisher } from '../src/publishers.js';
import { fitHistory, budgetChars, DEFAULT_WINDOW } from '../src/budget.js';

const entry = (id, text) => ({ id, label: id, tag: `方案 ${id}`, text });
const round = (n, text) => ({ round: n, stage: 'review', entries: [entry('A', text)] });
const fact = (n, answer) => ({ round: n, questions: [`问题 ${n}`], answer });

test('预算换算：窗口 × 比例 ÷ 每字 tokens；不知道时用保守的默认值', () => {
  assert.equal(budgetChars({ window: 1000000, tokensPerChar: 1 }), 500000);
  assert.equal(budgetChars({ window: 1000000, tokensPerChar: 1, factor: 0.5 }), 250000);
  assert.equal(budgetChars({}), DEFAULT_WINDOW * 0.5 / 2);
});

test('装填：放得下时原样保留', () => {
  const rounds = [round(1, 'a'), round(2, 'b')];
  const fit = fitHistory({ rounds, facts: [fact(2, 'x')], budgetChars: 100000 });
  assert.deepEqual(fit.rounds, rounds);
  assert.equal(fit.facts.length, 1);
  assert.equal(fit.note, '');
  assert.equal(fit.stats.trimmed, false);
});

test('装填：从新到旧，较早的轮次只留要点，再早的整段省略，并写明范围', () => {
  const long = (n) => `**要点**：第 ${n} 轮的结论\n\n**改了什么**\n${'细节'.repeat(500)}`;
  const rounds = [1, 2, 3, 4, 5].map((n) => round(n, long(n)));
  const facts = [fact(2, `核实结果${'很长'.repeat(300)}`), fact(5, '最新的核实')];
  // 预算只够最新两轮全文、最新的核实，再加一条要点
  const fit = fitHistory({ rounds, facts, budgetChars: 2 * 1090 + 60 + 100 });
  const kept = new Map(fit.rounds.map((r) => [r.round, r]));
  assert.ok(!kept.get(5).compact && !kept.get(4).compact, '最新的两轮保留全文');
  assert.ok(kept.get(3)?.compact, '第 3 轮只留要点');
  assert.match(kept.get(3).entries[0].text, /第 3 轮的结论/);
  assert.doesNotMatch(kept.get(3).entries[0].text, /细节/);
  assert.ok(fit.stats.droppedRounds >= 1);
  assert.match(fit.note, /第 1(–2)? 轮的讨论记录因篇幅省略/);
  assert.match(fit.note, /只留了每条发言的要点/);
  // 时间顺序不变
  assert.deepEqual(fit.rounds.map((r) => r.round), [...fit.rounds.map((r) => r.round)].sort((a, b) => a - b));
  assert.equal(fit.facts.at(-1).answer, '最新的核实');
});

test('装填：预算是 0 时可缩略的全部省略', () => {
  const fit = fitHistory({ rounds: [round(1, 'a')], facts: [fact(1, 'x')], budgetChars: -5 });
  assert.deepEqual(fit.rounds, []);
  assert.deepEqual(fit.facts, []);
  assert.match(fit.note, /第 1 轮的讨论记录因篇幅省略/);
});

const base = (extra = {}) => normalizeConfig({
  participants: [
    { id: 'a', name: 'A', provider: 'fake', part: 'lead' },
    { id: 'b', name: 'B', provider: 'fake', part: 'lead' },
    { id: 'r', name: 'R', provider: 'fake', part: 'reviewer' },
  ],
  chair: { id: 'chair', name: '主席', provider: 'fake' },
  providers: { fake: { type: 'mock' } },
  retryDelayMs: 0,
  ...extra,
});

const GOOD_DOC = '【说明】\n一句话结论\n【主文档】\n# 结论\n正文';

function scripted(reply = () => null) {
  const calls = [];
  const provider = {
    async complete(opts) {
      const who = whoOf(opts);
      const stage = /【阶段：([^】]+)】/.exec(opts.prompt)?.[1] ?? '';
      const call = { who, stage, prompt: opts.prompt };
      calls.push(call);
      const out = reply(call);
      if (out instanceof Error) throw out;
      return { text: out ?? (stage.includes('主文档') ? GOOD_DOC : `**要点**：发言-${calls.length}\n${'正文'.repeat(400)}`), usage: { inputTokens: (opts.prompt?.length ?? 0) + (opts.system?.length ?? 0), outputTokens: 1 } };
    },
  };
  return { calls, registry: { get: () => provider } };
}

test('主席汇总：窗口小时讨论记录被缩略，必须保留的最终方案和插话不动；重写时预算减半', async () => {
  // 主席窗口 20000 tokens、每字 1 token（脚本的输入 tokens 就是字数）→ 预算 10000 字，重写时 5000 字
  let docCalls = 0;
  const { calls, registry } = scripted((c) => {
    if (c.stage === '主文档') {
      docCalls += 1;
      return docCalls === 1 ? new Error('主席挂了') : GOOD_DOC;
    }
    return null;
  });
  const events = [];
  const cfg = base({ rounds: 4, chair: { id: 'chair', name: '主席', provider: 'fake', contextWindow: 20000 } });
  const res = await runDiscussion({ cfg, topic: 't', providers: registry, publisher: createMemoryPublisher(), rng: () => 0, onEvent: (e) => events.push(e) });
  const docPrompts = calls.filter((c) => c.stage === '主文档');
  assert.equal(docPrompts.length, 2);
  assert.match(docPrompts[0].prompt, /## 篇幅说明/);
  assert.match(docPrompts[0].prompt, /各主笔的最终方案/);
  const budgets = events.filter((e) => e.type === 'chair_budget');
  assert.deepEqual(budgets.map((b) => b.factor), [1, 0.5]);
  assert.ok(budgets[1].budgetChars < budgets[0].budgetChars);
  assert.ok(docPrompts[1].prompt.length < docPrompts[0].prompt.length);
  // 每字 tokens 数从无会话的调用学到了，存进 state
  assert.equal(res.state.budget.tokenRatios.fake, 1);
});

test('追问判断：讨论记录按预算装填，之前的追问回答原样保留', async () => {
  const cfg = base({ rounds: 3, followUpMaxRounds: 2, chair: { id: 'chair', name: '主席', provider: 'fake', contextWindow: 5000 } });
  const first = await runDiscussion({ cfg, topic: 't', providers: scripted().registry, publisher: createMemoryPublisher(), rng: () => 0 });
  const state = { ...first.state, followUps: [{ question: '老问题', handling: 'answer', answer: '老回答-必须保留' }] };
  const { calls, registry } = scripted((c) => (c.stage === '追问判断' ? '处理方式：直接回答\n回答' : null));
  await runFollowUp({ cfg, state, question: '新问题', providers: registry, publisher: createMemoryPublisher() });
  const triage = calls.find((c) => c.stage === '追问判断');
  assert.match(triage.prompt, /篇幅说明/);
  assert.match(triage.prompt, /老回答-必须保留/);
  assert.match(triage.prompt, /新问题/);
});

test('代码核实连续失败 2 次，下一批条数减半', async () => {
  const qs = Array.from({ length: 6 }, (_, i) => `问题${i + 1}？`);
  const sizes = [];
  const { registry } = scripted((c) => {
    if (c.who === '调研员' && c.stage === '代码调研') return '**一句话现状**\nx.java:1';
    if (c.who === '调研员' && /代码核实/.test(c.stage)) {
      sizes.push((c.prompt.match(/^\d+\. 问题/gm) ?? []).length);
      return sizes.length <= 2 ? new Error('坏了') : '1. 是';
    }
    if (c.who === 'R' && /第 2 轮/.test(c.stage)) return `【阻断】x\n\n**待核实的事实**\n${qs.map((q) => `- ${q}`).join('\n')}\n\n评审结论：继续讨论`;
    return null;
  });
  const cfg = base({
    rounds: 5,
    repos: { x: { path: '/r/x', description: 'x' } },
    research: { factCheckMaxQuestions: 4 },
  });
  const code = { repos: [{ alias: 'x', description: 'x', readPath: '/tmp/x', branch: 'main', commit: 'abc', dirty: 0, snapshot: false }], docs: [], groups: [], dirs: ['/tmp/x'] };
  await runDiscussion({ cfg, topic: 't', providers: registry, publisher: createMemoryPublisher(), rng: () => 0, code });
  assert.deepEqual(sizes.slice(0, 3), [4, 4, 2]);
});

test('旧讨论没有预算数据：从 usage.jsonl 推出窗口和每字 tokens 数', async () => {
  const { budgetFromUsage } = await import('../src/budget.js');
  const rows = [
    { type: 'run_started', participants: [{ id: 'a', provider: 'cli', model: 'opus' }], chair: { id: 'chair', provider: 'cli', model: 'opus' } },
    { type: 'call_started', speaker: 'chair', stage: 'doc', round: 3, promptChars: 10000 },
    { type: 'call_finished', speaker: 'chair', stage: 'doc', round: 3, inputTokens: 9000, contextWindow: 1000000, sessionTurn: 1 },
    // 多回合调用和太短的提示词不用来算比例
    { type: 'call_started', speaker: 'a', stage: 'review', round: 2, promptChars: 3000 },
    { type: 'call_finished', speaker: 'a', stage: 'review', round: 2, inputTokens: 900000, turns: 12, contextWindow: 1000000 },
  ];
  assert.deepEqual(budgetFromUsage(rows), { windows: { 'cli:opus': 1000000 }, tokenRatios: { cli: 0.9 } });
});
