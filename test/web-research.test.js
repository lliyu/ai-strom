// 本场无代码时联网搜集资料：主席判断要不要搜 → 核实员联网写初稿 → 调研员联网审查纠正 → 定稿才当背景资料。
// 讨论中的待核实问题也联网查。只在网页阵容选了核实员时生效。
import { whoOf } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { runDiscussion } from '../src/orchestrator.js';
import { createMemoryPublisher } from '../src/publishers.js';
import { parseWebPlan } from '../src/modes.js';
import { lineupConfig } from '../src/lineup.js';

const GOOD_DOC = '【说明】\n一句话结论\n【主文档】\n# 结论\n正文';
const DONE = '**要点**：没有了\n评审结论：没有意见了';
const PLAN_NEED = '搜集资料：需要\n**要查的问题**\n- Kafka 重平衡时单分区顺序还保证吗？（关键词：Kafka partition ordering rebalance）\n- Redis 7 的 WAIT 能保证强一致吗？（关键词：Redis WAIT consistency）';
const DRAFT = '1. 保证（https://kafka.apache.org/x）\n2. 能（https://redis.io/wrong）';
const FINAL = '**审查**：共 2 条，1 条有更正（第 2 条）\n1. 保证（https://kafka.apache.org/x）\n2. 【已更正】不能，WAIT 不保证强一致（https://redis.io/docs/wait）';

const cfg = (extra = {}) => normalizeConfig({
  participants: [
    { id: 'a', name: 'A', provider: 'fake', part: 'lead' },
    { id: 'b', name: 'B', provider: 'fake', part: 'lead' },
    { id: 'r', name: 'R', provider: 'fake', part: 'reviewer' },
  ],
  chair: { id: 'chair', name: '主席', provider: 'fake' },
  providers: { fake: { type: 'mock' } },
  research: { factChecker: { id: 'factchecker', name: '核实员', role: '代码核实 · Sonnet', provider: 'fake', model: 'sonnet' } },
  retryDelayMs: 0,
  rounds: 3,
  ...extra,
});

function scripted(reply = () => null) {
  const calls = [];
  const provider = {
    async complete(opts) {
      const who = whoOf(opts);
      const stage = /【阶段：([^】]+)】/.exec(opts.prompt)?.[1] ?? '';
      const round = Number(/第 (\d+) 轮/.exec(stage)?.[1] ?? 0);
      const call = { who, stage, round, prompt: opts.prompt, system: opts.system, tools: opts.tools, addDirs: opts.addDirs };
      calls.push(call);
      const out = reply(call);
      if (out instanceof Error) throw out;
      return { text: out ?? (stage.includes('主文档') ? (stage === '核对主文档' ? '没有问题' : GOOD_DOC) : `发言-${calls.length}`), usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { calls, registry: { get: () => provider } };
}

const script = ({ plan = PLAN_NEED, review = () => FINAL, reviewer = () => DONE } = {}) => (c) => {
  if (c.stage === '资料搜集判断') return plan;
  if (c.stage === '资料搜集') return DRAFT;
  if (c.stage === '资料审查') return review(c);
  if (c.who === '核实员') return '1. 联网初稿';
  if (c.who === '调研员' && c.stage.includes('核实审查')) return '**审查**：共 1 条，全部无误\n1. 联网定稿';
  if (c.who === 'R') return reviewer(c);
  return null;
};

test('解析搜集判断', () => {
  assert.deepEqual(parseWebPlan(PLAN_NEED).questions.length, 2);
  assert.equal(parseWebPlan(PLAN_NEED).need, true);
  assert.deepEqual(parseWebPlan('搜集资料：不需要\n纯取舍问题'), { need: false, questions: [] });
  assert.deepEqual(parseWebPlan('随便写'), { need: false, questions: [] });
  assert.equal(parseWebPlan('搜集资料：需要\n没列问题').need, false);
});

test('开场联网搜集：主席列问题，核实员和调研员都带联网工具，只有审查后的定稿当背景资料', async () => {
  const { calls, registry } = scripted(script());
  const publisher = createMemoryPublisher();
  const res = await runDiscussion({ cfg: cfg(), topic: '消息顺序怎么保证', providers: registry, publisher, rng: () => 0 });
  const plan = calls.find((c) => c.stage === '资料搜集判断');
  assert.match(plan.prompt, /不要出现公司内部的系统名/);
  const draft = calls.find((c) => c.stage === '资料搜集');
  assert.equal(draft.who, '核实员');
  assert.deepEqual(draft.tools, ['WebSearch', 'WebFetch']);
  assert.equal(draft.addDirs, undefined);
  const review = calls.find((c) => c.stage === '资料审查');
  assert.equal(review.who, '调研员');
  assert.deepEqual(review.tools, ['WebSearch', 'WebFetch']);
  assert.match(review.prompt, /redis\.io\/wrong/);
  // 主笔看到的系统提示词里是定稿，没有初稿
  const lead = calls.find((c) => c.who === 'A' && c.stage === '独立方案');
  assert.match(lead.system, /联网搜集的公开资料/);
  assert.match(lead.system, /【已更正】不能/);
  assert.doesNotMatch(lead.system, /redis\.io\/wrong/);
  assert.equal(res.state.context.web, true);
  assert.equal(res.state.context.review.corrections, 1);
  // 仍然算本场无代码
  assert.match(calls.find((c) => c.stage === '主文档').prompt, /本场无代码/);
  assert.match(publisher.posts[0].body, /联网资料/);
});

test('主席判断不需要：不调用核实员；审查失败：没审过的初稿不当背景资料', async () => {
  const no = scripted(script({ plan: '搜集资料：不需要\n纯取舍' }));
  const r1 = await runDiscussion({ cfg: cfg(), topic: 't', providers: no.registry, publisher: createMemoryPublisher(), rng: () => 0 });
  assert.ok(!no.calls.some((c) => c.stage === '资料搜集'));
  assert.equal(r1.state.context, null);

  const bad = scripted(script({ review: () => new Error('审查挂了') }));
  const r2 = await runDiscussion({ cfg: cfg(), topic: 't', providers: bad.registry, publisher: createMemoryPublisher(), rng: () => 0 });
  assert.equal(r2.state.context, null);
  assert.doesNotMatch(bad.calls.find((c) => c.who === 'A' && c.stage === '独立方案').system ?? '', /redis\.io\/wrong/);
});

test('讨论中的待核实问题联网查：参与者被告知可以问公开资料，核实员和调研员带联网工具', async () => {
  const { calls, registry } = scripted(script({
    plan: '搜集资料：不需要\n先不查',
    reviewer: (c) => (c.round === 2 ? '**要点**：1 条\n- 【阻断】顺序保证没依据 → 会乱序 → 查文档\n\n**待核实的事实**\n- Kafka 幂等生产者能防重复吗？\n\n评审结论：继续讨论' : DONE),
  }));
  const res = await runDiscussion({ cfg: cfg(), topic: 't', providers: registry, publisher: createMemoryPublisher(), rng: () => 0 });
  assert.match(calls.find((c) => c.who === 'A' && c.stage === '独立方案').prompt, /\*\*事实核实\*\*/);
  const draft = calls.find((c) => c.who === '核实员' && c.stage.includes('代码核实'));
  assert.deepEqual(draft.tools, ['WebSearch', 'WebFetch']);
  assert.match(draft.prompt, /公开资料/);
  const review = calls.find((c) => c.who === '调研员' && c.stage.includes('核实审查'));
  assert.deepEqual(review.tools, ['WebSearch', 'WebFetch']);
  assert.equal(res.state.facts[0].source, 'web');
  assert.match(calls.find((c) => c.who === 'A' && c.round === 3).prompt, /联网查证、调研员审查后的定稿/);
});

test('网页阵容：没登记仓库也能选核实员，调研员配置随之生成', () => {
  const base = normalizeConfig({
    participants: [
      { id: 'opus', name: 'Opus', provider: 'claude-cli', model: 'opus', part: 'lead' },
      { id: 'fable', name: 'Fable', provider: 'claude-cli', model: 'fable', part: 'lead' },
    ],
    chair: { id: 'chair', name: '主席', provider: 'claude-cli', model: 'opus' },
    models: [{ id: 'sonnet', name: 'Claude Sonnet', provider: 'claude-cli', model: 'sonnet' }],
    providers: { 'claude-cli': { type: 'claude-cli' } },
  });
  assert.equal(base.research, undefined);
  const c = lineupConfig(base, { mode: 'decision', lineup: { participants: [{ model: 'opus', role: 'x' }, { model: 'fable', role: 'y' }], factChecker: 'sonnet' } });
  assert.equal(c.research.model, 'opus');
  assert.equal(c.research.factChecker.model, 'sonnet');
  assert.deepEqual(c.research.webTools, ['WebSearch', 'WebFetch']);
});
