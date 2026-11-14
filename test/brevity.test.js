// 篇幅控制：要点 / 详细 / 完整方案的拆分、字数上限与压缩重写、评审分级、卡片折叠。
import { whoOf } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { runDiscussion } from '../src/orchestrator.js';
import { createMemoryPublisher } from '../src/publishers.js';
import { splitReply, charCount, overLimit, hasBlocker, limitsFor, critiquePrompt, reviewPrompt } from '../src/modes.js';
import { buildCard, buildCardWithinLimit } from '../src/lark/card.js';

const base = (extra = {}) => ({
  participants: [
    { id: 'a', name: 'A', provider: 'fake', part: 'lead' },
    { id: 'b', name: 'B', provider: 'fake', part: 'lead' },
    { id: 'r1', name: 'R1', provider: 'fake', part: 'reviewer' },
  ],
  chair: { id: 'chair', name: '主席', provider: 'fake' },
  providers: { fake: { type: 'mock' } },
  ...extra,
});

function scripted(reply) {
  const calls = [];
  const provider = {
    async complete(opts) {
      const { system, prompt } = opts;
      const who = whoOf(opts);
      const stageText = /【阶段：([^】]+)】/.exec(prompt)?.[1] ?? (/【压缩重写】/.test(prompt) ? '压缩重写' : '');
      const round = Number(/第 (\d+) 轮/.exec(stageText)?.[1] ?? 0);
      const call = { who, stageText, round, prompt, system };
      calls.push(call);
      return { text: reply(call) ?? `发言-${calls.length}`, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { calls, registry: { get: () => provider } };
}

const REVISED = '**要点**\n- 结论：可以做\n- 本轮：预算改成按商户迁\n\n**改了什么**\n- 全量迁 → 按商户迁 · 避免规则残留\n\n**立场变化**（小幅）\n\n【完整方案】\n**结论**\n完整方案正文-PLAN';

test('拆分发言：要点、详细内容、完整方案', () => {
  const r = splitReply(REVISED);
  assert.equal(r.brief, '- 结论：可以做\n- 本轮：预算改成按商户迁');
  assert.match(r.detail, /^\*\*改了什么\*\*/);
  assert.doesNotMatch(r.detail, /PLAN|要点/);
  assert.equal(r.plan, '**结论**\n完整方案正文-PLAN');
  assert.doesNotMatch(r.shown, /PLAN/);

  // 要点写在同一行；评审按方案分组
  const c = splitReply('**要点**：阻断 1 条，预算会超扣\n**方案 A**\n- 【阻断】超扣 → 亏钱 → 加锁');
  assert.equal(c.brief, '阻断 1 条，预算会超扣');
  assert.match(c.detail, /^\*\*方案 A\*\*/);
  assert.equal(c.plan, null);

  // 完整方案前的分隔线不留在给人看的部分
  assert.equal(splitReply('**要点**：x\n**改了什么**\n- y\n\n---\n【完整方案】\nz').detail, '**改了什么**\n- y');

  // 没写要点：整段都是详细内容
  assert.deepEqual(splitReply('直接写正文'), { brief: null, detail: '直接写正文', plan: null, shown: '直接写正文' });
});

test('字数：去掉空白和 Markdown 符号；超过上限的 1.25 倍才算超出', () => {
  assert.equal(charCount('**要点**\n- 一二三'), 5);
  const text = `**要点**\n${'字'.repeat(120)}\n\n【完整方案】\n${'方'.repeat(100)}`;
  assert.equal(overLimit(text, { max: 100, plan: 100 }), null); // 122 字 < 125
  assert.match(overLimit(text, { max: 90, plan: 70 }), /给人看的部分 122 字（上限 90）.*完整方案 100 字（上限 70）/);
  assert.equal(limitsFor('brainstorm'), null);
  assert.equal(limitsFor('decision', { review: 500 }).review, 500);
});

test('评审分级：没有【阻断】时写继续也按没有意见处理', async () => {
  assert.ok(hasBlocker('- 【阻断】x'));
  assert.ok(hasBlocker('- [阻断] x'));
  assert.ok(!hasBlocker('- 【建议】x'));
  const { calls, registry } = scripted(({ who }) => (who === 'R1' ? '**要点**：只剩建议\n- 【建议】改个名\n评审结论：继续讨论' : null));
  const cfg = normalizeConfig(base({ rounds: 'auto', maxRounds: 5 }));
  const result = await runDiscussion({ cfg, topic: 't', providers: registry, publisher: createMemoryPublisher(), rng: () => 0.1 });
  assert.equal(result.ending.reason, 'converged');
  assert.equal(result.roundsUsed, 2);
  assert.equal(calls.filter((c) => /互评与修订/.test(c.stageText)).length, 0);
});

test('主笔只把变化发给人看，完整方案交给评审和主席', async () => {
  const { calls, registry } = scripted(({ who, stageText }) => {
    if (who === 'R1') return '**要点**：阻断 1 条\n**方案 A**\n- 【阻断】问题\n评审结论：继续讨论';
    if ((who === 'A' || who === 'B') && /互评与修订/.test(stageText)) return REVISED.replace('PLAN', `PLAN-${who}`);
    if (who === '主席') return '**要点**\n- 结论：做\n\n**共识**\n- x';
    return null;
  });
  const publisher = createMemoryPublisher();
  const cfg = normalizeConfig(base({ rounds: 3 }));
  const result = await runDiscussion({ cfg, topic: 't', providers: registry, publisher, rng: () => 0.1 });

  // 群里：要点单独放，详细内容不含完整方案，完整方案单独放（卡片上折叠）
  const posted = publisher.posts.find((m) => m.meta?.stage === 'review' && m.speaker.id === 'a');
  assert.equal(posted.brief, '- 结论：可以做\n- 本轮：预算改成按商户迁');
  assert.doesNotMatch(posted.body, /PLAN|要点/);
  assert.match(posted.plan, /PLAN-A/);

  // 记录：text 只有给人看的部分，plan 另存
  const entry = result.rounds.find((r) => r.stage === 'review').entries.find((e) => e.id === 'a');
  assert.doesNotMatch(entry.text, /PLAN/);
  assert.match(entry.plan, /PLAN-A/);
  assert.match(result.state.latest.find((e) => e.id === 'a').plan, /PLAN-A/);

  // 第 3 轮评审看到完整方案和修订说明
  const critique3 = calls.find((c) => c.who === 'R1' && c.round === 3);
  assert.match(critique3.prompt, /PLAN-A[\s\S]*这一轮的修订说明[\s\S]*按商户迁/);
  // 主笔修订提示：只写变化，完整方案放在标记之后
  const review = calls.find((c) => c.who === 'A' && /互评与修订/.test(c.stageText));
  assert.match(review.prompt, /只写这一轮的变化[\s\S]*不超过 800 字[\s\S]*【完整方案】[\s\S]*不超过 1800 字/);
  // 主席拿到最终的完整方案
  const summary = calls.find((c) => c.who === '主席');
  const finals = summary.prompt.slice(summary.prompt.indexOf('各主笔的最终方案'));
  assert.match(finals, /PLAN-A/);
  assert.match(finals, /PLAN-B/);
  // 主席写的主文档：讨论里只发开头的结论
  assert.match(publisher.posts.find((m) => m.meta?.stage === 'doc').body, /结论：做[\s\S]*「文档」页/);
});

test('超出字数上限时压缩重写一次，发布重写后的版本；压缩时丢了完整方案就沿用原来的', async () => {
  const long = `**要点**\n- 结论\n\n**改了什么**\n${'很长'.repeat(600)}\n\n【完整方案】\n原方案-PLAN`;
  const { calls, registry } = scripted(({ who, stageText }) => {
    if (who === 'R1') return '**要点**：x\n- 【阻断】y\n评审结论：继续讨论';
    if (who === 'A' && /互评与修订/.test(stageText)) return long;
    if (who === 'A' && stageText === '压缩重写') return '**要点**\n- 结论（压缩后）\n\n**改了什么**\n- 一条';
    return null;
  });
  const publisher = createMemoryPublisher();
  const cfg = normalizeConfig(base({ rounds: 2 }));
  const result = await runDiscussion({ cfg, topic: 't', providers: registry, publisher, rng: () => 0.1 });

  const retry = calls.filter((c) => c.who === 'A' && c.stageText === '压缩重写');
  assert.equal(retry.length, 1);
  assert.match(retry[0].prompt, /给人看的部分 \d+ 字（上限 800）/);
  assert.doesNotMatch(retry[0].prompt, /很长很长/); // 会话模式下原回答在会话里，不再贴
  const posted = publisher.posts.filter((m) => m.meta?.stage === 'review' && m.speaker.id === 'a');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].brief, '- 结论（压缩后）');
  assert.match(posted[0].plan, /原方案-PLAN/);
  const entry = result.rounds.find((r) => r.stage === 'review').entries.find((e) => e.id === 'a');
  assert.match(entry.plan, /原方案-PLAN/);
  // B 没超出，不重写
  assert.equal(calls.filter((c) => c.who === 'B' && c.stageText === '压缩重写').length, 0);
});

test('提示词：评审分级、不写优点；脑洞风暴不限字数', () => {
  const p = critiquePrompt({ round: 2, proposals: [{ tag: '方案 A', text: '变化', plan: '全文' }], askVerdict: true, mode: 'decision' });
  assert.match(p, /### 方案 A\n全文\n\n\*\*方案 A 这一轮的修订说明\*\*\n变化/);
  assert.match(p, /【阻断】[\s\S]*【建议】[\s\S]*不超过 700 字[\s\S]*只有还存在【阻断】级问题时才写「继续讨论」/);
  assert.doesNotMatch(p, /值得保留/);
  const r = reviewPrompt({ round: 2, own: { tag: '方案 A', text: 'x' }, others: [], critiques: [], convo: true, mode: 'refine' });
  assert.match(r, /不超过 1000 字[\s\S]*【完整方案】[\s\S]*完整写出[\s\S]*不超过 2500 字/);
});

test('提示词：打磨是在搭架子，阻断从宽，数值和后期细则只算建议；主笔补漏洞不加成套机制', () => {
  const proposals = [{ tag: '方案 A', text: '变化', plan: '全文' }];
  const refine = critiquePrompt({ round: 2, proposals, askVerdict: true, mode: 'refine' });
  assert.match(refine, /【阻断】只给动摇架子的问题/);
  assert.match(refine, /搭架子[\s\S]*具体数值[\s\S]*最多算【建议】/);
  assert.doesNotMatch(refine, /这版修改就不该采用/);
  const decision = critiquePrompt({ round: 2, proposals, askVerdict: true, mode: 'decision' });
  assert.match(decision, /【阻断】不解决的话方案不成立/);
  assert.doesNotMatch(decision, /搭架子/);
  const critiques = [{ tag: '评审 1', text: '- 【阻断】x' }];
  assert.match(reviewPrompt({ round: 2, own: { tag: '方案 A', text: 'x' }, others: [], critiques, mode: 'refine' }), /可调参数[\s\S]*不要为了堵口子新增成套机制/);
  assert.doesNotMatch(reviewPrompt({ round: 2, own: { tag: '方案 A', text: 'x' }, others: [], critiques, mode: 'decision' }), /堵口子/);
});

test('卡片：有要点时只露出要点，详细内容和完整方案折叠；超长时先去掉完整方案', () => {
  const card = buildCard({ title: 't', brief: '- 结论', body: '**改了什么**\n- x', plan: '全文', footer: 'm' });
  assert.equal(card.elements[0].tag, 'markdown');
  assert.equal(card.elements[0].content, '- 结论');
  assert.equal(card.elements[1].tag, 'collapsible_panel');
  assert.equal(card.elements[1].expanded, false);
  assert.equal(card.elements[1].elements[0].content, '**改了什么**\n- x');
  assert.equal(card.elements[2].header.title.content, '**当前完整方案**');
  assert.equal(buildCard({ title: 't', brief: 'b', body: 'd', expanded: true }).elements[1].expanded, true);
  // 没有要点：和以前一样整段显示
  assert.deepEqual(buildCard({ title: 't', body: 'x' }).elements, [{ tag: 'markdown', content: 'x' }]);

  const big = buildCardWithinLimit({ title: 't', brief: 'b', body: 'd', plan: '方'.repeat(8000) }, { maxBytes: 6000 });
  assert.equal(big.truncated, true);
  assert.equal(big.card.elements.filter((e) => e.tag === 'collapsible_panel').length, 1);
  assert.match(big.card.elements[1].elements[0].content, /完整方案太长没有附上/);
});
