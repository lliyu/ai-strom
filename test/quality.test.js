// 第三批：核实两步（核实员答、调研员审查纠正）、「无变化」标记、两种熔断、阻断存档、裁决要求。
import { whoOf } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { runDiscussion } from '../src/orchestrator.js';
import { createMemoryPublisher } from '../src/publishers.js';
import { parseReviewCorrections, isUnchangedPlan } from '../src/modes.js';
import { lineupConfig, savedLineup, configForState } from '../src/lineup.js';

const GOOD_DOC = '【说明】\n一句话结论\n【主文档】\n# 结论\n正文';
const PLAN = (x) => `**要点**：方案 ${x}\n**改了什么**\n- 改了\n**立场变化**（小幅）\n\n【完整方案】\n完整方案-${x}`;
const SAME = '**要点**：不改\n**改了什么**\n- 无变化\n**立场变化**（无）\n\n【完整方案】\n无变化';
const BLOCK = '**要点**：1 条阻断\n- 【阻断】回滚没设计 → 出事回不去 → 加开关\n评审结论：继续讨论';
const DONE = '**要点**：没有了\n评审结论：没有意见了';

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
  rounds: 'auto',
  maxRounds: 8,
  ...extra,
});

function scripted(reply = () => null) {
  const calls = [];
  const provider = {
    async complete(opts) {
      const who = whoOf(opts);
      const stage = /【阶段：([^】]+)】/.exec(opts.prompt)?.[1] ?? '';
      const round = Number(/第 (\d+) 轮/.exec(stage)?.[1] ?? 0);
      const call = { who, stage, round, prompt: opts.prompt };
      calls.push(call);
      const out = reply(call);
      if (out instanceof Error) throw out;
      return { text: out ?? (stage.includes('主文档') ? (stage === '核对主文档' ? '没有问题' : GOOD_DOC) : `发言-${calls.length}`), usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { calls, registry: { get: () => provider } };
}

const lead = (c) => c.who === 'A' || c.who === 'B';
const rev = (c) => c.who === 'R1' || c.who === 'R2';

test('「无变化」：只认【完整方案】下面单独的这三个字，沿用上一版', async () => {
  assert.ok(isUnchangedPlan('无变化'));
  assert.ok(isUnchangedPlan(' **无变化**。'));
  assert.ok(!isUnchangedPlan('无变化，但补了一句'));
  const { registry } = scripted((c) => {
    if (lead(c)) return c.round === 2 ? SAME : PLAN(c.who);
    if (rev(c)) return c.round === 2 ? BLOCK : DONE;
    return null;
  });
  const res = await runDiscussion({ cfg: base(), topic: 't', providers: registry, publisher: createMemoryPublisher(), rng: () => 0 });
  for (const e of res.state.latest) assert.match(e.plan, /^完整方案-[AB]$/);
});

test('熔断一：主笔连续 2 轮全部「无变化」、评审仍有阻断，以分歧结束；主席按裁决要求写', async () => {
  const { calls, registry } = scripted((c) => {
    if (lead(c)) return c.round >= 2 ? SAME : PLAN(c.who);
    if (rev(c)) return BLOCK;
    return null;
  });
  const publisher = createMemoryPublisher();
  const res = await runDiscussion({ cfg: base(), topic: 't', providers: registry, publisher, rng: () => 0 });
  assert.equal(res.ending.reason, 'deadlock');
  assert.equal(res.ending.round, 3);
  const doc = calls.find((c) => c.stage === '主文档');
  assert.match(doc.prompt, /阻断原文存档/);
  assert.match(doc.prompt, /回滚没设计/);
  assert.match(doc.prompt, /推荐方案（未经评审）/);
  assert.match(doc.prompt, /已核实不成立/);
  assert.ok(publisher.posts.some((p) => p.meta?.stage === 'blockers'), '熔断时发阻断存档卡片');
  assert.match(publisher.posts.at(-1).subtitle, /以分歧结束/);
  assert.equal(res.state.blockers.length, 2);
  assert.equal(res.state.ending.reason, 'deadlock');
});

test('熔断二：一位评审连续 3 轮独自坚持阻断、其他评审都没有意见，以评审之间的分歧结束', async () => {
  const { registry } = scripted((c) => {
    if (lead(c)) return PLAN(`${c.who}${c.round}`); // 主笔每轮都改
    if (c.who === 'R1') return BLOCK;
    if (c.who === 'R2') return DONE;
    return null;
  });
  const publisher = createMemoryPublisher();
  const res = await runDiscussion({ cfg: base(), topic: 't', providers: registry, publisher, rng: () => 0 });
  assert.equal(res.ending.reason, 'dissent');
  assert.equal(res.ending.round, 4); // 第 2、3、4 轮
  assert.match(res.ending.tag, /^评审 \d$/);
  assert.ok(publisher.posts.some((p) => p.meta?.stage === 'blockers'));
});

test('修订后结束：评审都没有阻断但有新插话，主笔回应后都没改就结束', async () => {
  let polled = 0;
  const interjections = { async poll() { polled += 1; return polled === 2 ? [{ sender: '主持人', text: '预算只有一半' }] : []; } };
  const { calls, registry } = scripted((c) => {
    if (lead(c)) return c.round === 2 ? SAME : PLAN(c.who);
    if (rev(c)) return DONE;
    return null;
  });
  const res = await runDiscussion({ cfg: base(), topic: 't', providers: registry, publisher: createMemoryPublisher(), rng: () => 0, interjections });
  assert.equal(res.ending.reason, 'converged');
  assert.equal(res.ending.round, 2);
  assert.ok(calls.some((c) => lead(c) && c.round === 2), '主笔先回应了插话');
  assert.ok(!calls.some((c) => c.round === 3));
});

// ---------- 核实两步 ----------

const QUESTION = '同类型的规则会叠加吗？';
const code = { repos: [{ alias: 'x', description: 'x', readPath: '/tmp/x', branch: 'main', commit: 'abc', dirty: 0, snapshot: false }], docs: [], groups: [], dirs: ['/tmp/x'] };
const withChecker = (extra = {}) => base({
  rounds: 3,
  repos: { x: { path: '/r/x', description: 'x' } },
  research: { factChecker: { id: 'factchecker', name: '核实员', role: '代码核实', provider: 'fake', model: 'sonnet' } },
  ...extra,
});

function checkScript({ draft = () => '1. 会叠加（x:a.go:1）', review = () => '**审查**：共 1 条，1 条有更正（第 1 条）\n1. 【已更正】不叠加：初稿看错了分支（x:a.go:9）' } = {}) {
  return (c) => {
    if (c.who === '调研员' && c.stage === '代码调研') return '**一句话现状**\nx:a.go:1';
    if (c.who === '核实员') return draft(c);
    if (c.who === '调研员' && c.stage.includes('核实审查')) return review(c);
    if (c.who === '调研员' && c.stage.includes('代码核实')) return '1. 调研员直接答：不叠加';
    if (c.who === 'R1' && c.round === 2) return `${BLOCK}\n\n**待核实的事实**\n- ${QUESTION}`;
    if (rev(c)) return DONE;
    return null;
  };
}

test('核实两步：核实员写初稿，调研员审查纠正，主笔和评审只看到定稿', async () => {
  const { calls, registry } = scripted(checkScript());
  const res = await runDiscussion({ cfg: withChecker(), topic: 't', providers: registry, publisher: createMemoryPublisher(), rng: () => 0, code });
  const draft = calls.find((c) => c.who === '核实员');
  assert.match(draft.prompt, /你的回答是初稿/);
  const review = calls.find((c) => c.stage.includes('核实审查'));
  assert.match(review.prompt, /会叠加（x:a\.go:1）/);
  const fact = res.state.facts[0];
  assert.match(fact.answer, /【已更正】不叠加/);
  assert.equal(fact.review.corrections, 1);
  assert.match(fact.review.draft, /会叠加/);
  // 第 3 轮主笔看到的是定稿，没有初稿
  const r3 = calls.find((c) => c.who === 'A' && c.round === 3);
  assert.match(r3.prompt, /【已更正】不叠加/);
  assert.doesNotMatch(r3.prompt, /会叠加（x:a\.go:1）/);
});

test('核实两步：审查失败时不发初稿，问题留到下一轮；核实员失败时调研员直接核实', async () => {
  let reviews = 0;
  const { calls, registry } = scripted(checkScript({ review: () => { reviews += 1; return reviews === 1 ? new Error('审查挂了') : '**审查**：共 1 条，全部无误\n1. 会叠加'; } }));
  const res = await runDiscussion({ cfg: withChecker({ rounds: 4 }), topic: 't', providers: registry, publisher: createMemoryPublisher(), rng: () => 0, code });
  assert.equal(res.state.facts.length, 1);
  assert.equal(res.state.facts[0].round, 4); // 第 3 轮审查失败，第 4 轮重来
  assert.equal(res.state.facts[0].review.corrections, 0);
  assert.ok(!calls.some((c) => c.who === 'A' && c.round === 3 && /会叠加/.test(c.prompt)), '没审过的初稿不能发给主笔');

  const failing = scripted(checkScript({ draft: () => new Error('核实员挂了') }));
  const res2 = await runDiscussion({ cfg: withChecker(), topic: 't', providers: failing.registry, publisher: createMemoryPublisher(), rng: () => 0, code });
  assert.match(res2.state.facts[0].answer, /调研员直接答/);
  assert.equal(res2.state.facts[0].review, undefined);
});

test('解析审查结论', () => {
  assert.equal(parseReviewCorrections('**审查**：共 3 条，全部无误\n...'), 0);
  assert.equal(parseReviewCorrections('**审查**：共 3 条，2 条有更正（第 1、3 条）'), 2);
  assert.equal(parseReviewCorrections('1. 直接答'), null);
});

test('网页阵容：核实员只能选 claude-cli 的模型，存进阵容，追问时还原', () => {
  const cfg = normalizeConfig({
    participants: [
      { id: 'opus', name: 'Opus', provider: 'claude-cli', model: 'opus', part: 'lead' },
      { id: 'ds', name: 'DS', provider: 'http', model: 'ds', part: 'reviewer' },
    ],
    chair: { id: 'chair', name: '主席', provider: 'claude-cli', model: 'opus' },
    models: [{ id: 'sonnet', name: 'Claude Sonnet', provider: 'claude-cli', model: 'sonnet' }],
    providers: { 'claude-cli': { type: 'claude-cli' }, http: { type: 'openai-compatible', baseUrl: 'http://x' } },
    repos: { x: { path: '/r/x', description: 'x' } },
  });
  const seats = [{ model: 'opus', part: 'lead', role: '架构' }, { model: 'ds', part: 'reviewer', role: '风险' }];
  const c = lineupConfig(cfg, { mode: 'decision', lineup: { participants: seats, chair: 'opus', factChecker: 'sonnet' } });
  assert.equal(c.research.factChecker.model, 'sonnet');
  assert.equal(c.research.model, 'opus');
  assert.throws(() => lineupConfig(cfg, { mode: 'decision', lineup: { participants: seats, factChecker: 'ds' } }), /不能读代码/);
  const saved = savedLineup(c);
  assert.equal(saved.factChecker.model, 'sonnet');
  assert.equal(configForState(cfg, { mode: 'decision', lineup: saved }).research.factChecker.model, 'sonnet');
  // 不选核实员：调研员直接核实
  assert.equal(lineupConfig(cfg, { mode: 'decision', lineup: { participants: seats } }).research.factChecker, undefined);
});
