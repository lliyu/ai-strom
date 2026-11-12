// 页面第三期：问题编号与跨轮追踪。程序给评审的【阻断】【建议】编号，主笔按编号回应，页面按编号串出时间线。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { runDiscussion } from '../src/orchestrator.js';
import { createMemoryPublisher } from '../src/publishers.js';
import { createMockProvider } from '../src/providers/index.js';
import { assignIssueIds, trackIssues, parseItemLine, critiquePrompt, reviewPrompt, ownIssuesBlock, peersBlock } from '../src/modes.js';
import { issueTracking, itemDigest } from '../src/web/digest.js';

test('编号：只写在正文的【阻断】【建议】上；自己的旧编号保留，别人的、不存在的、重复的剥掉重编', () => {
  const text = [
    '**要点**：还有 2 条阻断',
    '- 【阻断】写在要点里的不编号',
    '**方案 A**',
    '- 【阻断】Q1-2 旧问题仍坚持 ｜改法：x ｜依据：推断',
    '- 【阻断】Q2-1 抄了别人的编号 ｜改法：y ｜依据：推断',
    '- **【建议】** 新建议',
    '- 【阻断】Q1-2 同一条发言里又写了一次',
    '- 【阻断】Q1-9 不存在的编号',
    '```',
    '- 【阻断】代码块里的不编号',
    '```',
    '**对其他评审的阻断**',
    '- 【不同意】Q2-1 ｜依据：推断',
    '评审结论：继续讨论',
    '【完整方案】',
    '- 【阻断】完整方案里的不编号',
  ].join('\n');
  const r = assignIssueIds(text, { own: 1, used: new Set(['Q1-1', 'Q1-2']) });
  assert.deepEqual([r.kept, r.assigned], [['Q1-2'], ['Q1-3', 'Q1-4', 'Q1-5', 'Q1-6']]);
  assert.deepEqual(r.stripped, [{ id: 'Q2-1', reason: '别人的编号' }, { id: 'Q1-2', reason: '重复' }, { id: 'Q1-9', reason: '不存在' }]);
  const lines = r.text.split('\n');
  assert.equal(lines[1], '- 【阻断】写在要点里的不编号');
  assert.equal(lines[4], '- 【阻断】Q1-3 抄了别人的编号 ｜改法：y ｜依据：推断');
  assert.equal(lines[5], '- **【建议】**Q1-4 新建议');
  assert.equal(lines[9], '- 【阻断】代码块里的不编号');
  assert.equal(lines[12], '- 【不同意】Q2-1 ｜依据：推断', '表态里的编号是引用，原样保留');
  assert.equal(lines.at(-1), '- 【阻断】完整方案里的不编号');
  // 解析：编号单独拿出来，问题里不带
  assert.deepEqual([parseItemLine(lines[5]).id, parseItemLine(lines[5]).head], ['Q1-4', '新建议']);
  assert.deepEqual(parseItemLine('- 【不同意】Q2-1 ｜依据：推断').id, 'Q2-1');
  assert.equal(parseItemLine('- 【阻断】 没有编号').id, undefined);
});

const S = (stage, round, tag, body) => ({ stage, round, tag, body });

test('时间线：提出 → 主笔称采纳 / 不采纳 → 原评审仍坚持或没再提；引用不存在的编号单独列出', () => {
  const { issues, invalid } = trackIssues([
    S('critique', 2, '评审 1', '**方案 A**\n- 【阻断】Q1-1 会超扣 ｜改法：加锁 ｜依据：推断\n- 【建议】Q1-2 补告警'),
    S('critique', 2, '评审 2', '**方案 A**\n- 【阻断】Q2-1 回滚没设计 ｜改法：加开关 ｜依据：推断'),
    S('review', 2, '方案 A', '**对评审意见的回应**\n- 【采纳】Q1-1 ｜改法：加行锁\n- 【不采纳】Q2-1 ｜依据：已有开关\n- 【采纳】Q9-9 ｜改法：x'),
    S('critique', 3, '评审 1', '**方案 A**\n无新问题\n**对其他评审的阻断**\n- 【补充】Q2-1 ｜依据：pc:src/a.js:1'),
    S('critique', 3, '评审 2', '**方案 A**\n- 【阻断】Q2-1 开关只关了入口 ｜改法：出口也关 ｜依据：推断'),
  ]);
  const by = Object.fromEntries(issues.map((x) => [x.id, x]));
  assert.deepEqual([by['Q1-1'].status, by['Q1-1'].handled], ['dropped', 'accepted']);
  assert.deepEqual([by['Q1-2'].status, by['Q1-2'].handled, by['Q1-2'].level], ['dropped', 'unanswered', '建议']);
  assert.deepEqual([by['Q2-1'].status, by['Q2-1'].handled, by['Q2-1'].head], ['current', 'unanswered', '开关只关了入口']);
  assert.deepEqual(by['Q2-1'].mentions.map((m) => m.round), [2, 3]);
  assert.deepEqual(by['Q2-1'].responses.map((r) => [r.tag, r.kind, r.note]), [['方案 A', '不采纳', '已有开关']]);
  assert.deepEqual(by['Q2-1'].stances.map((s) => [s.tag, s.kind]), [['评审 1', '补充']]);
  assert.equal(by['Q1-1'].section, '方案 A');
  assert.deepEqual(invalid.map((v) => [v.id, v.kind]), [['Q9-9', '采纳']]);
  // 原评审在【阻断】上写了别人的编号（程序没剥掉的旧数据）：算引用无效，不挂到别人的问题上
  assert.deepEqual(trackIssues([S('critique', 2, '评审 2', '- 【阻断】Q1-1 x')]).invalid.map((v) => v.id), ['Q1-1']);
});

test('提示词：评审拿到自己还没解决的问题清单（附主笔的处理）；表态和主笔回应都按编号', () => {
  const own = [{ id: 'Q1-1', level: '阻断', head: '会超扣', section: '方案 A', latestResponses: [{ tag: '方案 A', kind: '不采纳', note: '已有锁' }] }];
  assert.match(ownIssuesBlock(own), /- Q1-1【阻断】会超扣（方案 A） · 主笔：方案 A不采纳：已有锁/);
  assert.match(ownIssuesBlock([{ ...own[0], latestResponses: [] }]), /主笔未回应/);
  const c = critiquePrompt({ round: 3, proposals: [{ label: 'A', text: 'x' }], peers: [{ tag: '评审 2', lines: ['- 【阻断】Q2-1 回滚'] }], items: true, ownIssues: own, mode: 'decision' });
  assert.match(c, /你提过、还没解决的问题/);
  assert.match(c, /新问题不要写编号/);
  assert.match(c, /「- 【不同意】编号 ｜依据：…」或「- 【补充】编号 ｜依据：…」/);
  // 不追踪时（没开条目化）照旧
  assert.doesNotMatch(critiquePrompt({ round: 3, proposals: [{ label: 'A', text: 'x' }], items: true, mode: 'decision' }), /你提过/);
  assert.match(peersBlock([{ tag: '评审 2', lines: ['x'] }]), /对评审 N 的『……』/);
  assert.match(reviewPrompt({ round: 2, own: { text: 'x' }, others: [], critiques: [{ tag: '评审 1', text: 'y' }], mode: 'decision', items: true, tracking: true }), /「- 【采纳】Q1-3 ｜改法：…」/);
});

test('流程：mock 讨论里评审发言带编号、主笔按编号回应，第 3 轮的评审看到自己的清单，页面串出时间线', async () => {
  const cfg = normalizeConfig({
    participants: [
      { id: 'a', name: 'A', provider: 'fake', part: 'lead' },
      { id: 'b', name: 'B', provider: 'fake', part: 'lead' },
      { id: 'r1', name: 'R1', provider: 'fake', part: 'reviewer' },
      { id: 'r2', name: 'R2', provider: 'fake', part: 'reviewer' },
    ],
    chair: { id: 'chair', name: '主席', provider: 'fake' },
    providers: { fake: { type: 'mock' } },
    items: true,
  });
  const mock = createMockProvider();
  const prompts = [];
  const providers = { get: () => ({ complete: async (opts) => { prompts.push(opts.prompt); return mock.complete(opts); } }) };
  const events = [];
  const publisher = createMemoryPublisher();
  const res = await runDiscussion({ cfg, topic: '预算扣减', providers, publisher, rng: () => 0, onEvent: (e) => events.push(e) });
  const crit = publisher.posts.filter((p) => p.meta?.stage === 'critique');
  assert.match(crit[0].body, /【阻断】Q\d-1 并发扣减/);
  assert.match(crit[0].body, /【建议】Q\d-2 补一个超扣告警/);
  const rev = publisher.posts.find((p) => p.meta?.stage === 'review');
  assert.match(rev.body, /【采纳】Q1-1 ｜改法/);
  const r3 = prompts.find((p) => /第 3 轮评审意见/.test(p) && /你提过、还没解决的问题/.test(p));
  assert.match(r3, /Q\d-1【阻断】并发扣减时预算会超扣（mock）（方案 A） · 主笔：方案 [AB]称采纳/);
  const ids = events.filter((e) => e.type === 'issue_ids');
  assert.ok(ids.length >= 4 && ids.every((e) => e.stripped.length === 0));
  assert.equal(res.ending.reason, 'converged');

  // 页面：按编号串出时间线
  const posts = publisher.posts.filter((p) => p.meta?.stage).map((p) => ({ stage: p.meta.stage, round: p.meta.round, tag: p.meta.tag, body: p.body }));
  const t = issueTracking(posts);
  const q = t.issues.find((x) => x.id === 'Q1-1');
  assert.deepEqual([q.status, q.handled, q.responses.length], ['dropped', 'accepted', 2]);
  assert.deepEqual(q.stances.map((s) => [s.tag, s.kind]), [['评审 2', '补充']], '评审 2 第 3 轮对 Q1-1 补充了依据');
  assert.deepEqual(t.invalid, []);
  assert.equal(issueTracking([{ stage: 'critique', round: 2, tag: '评审 1', body: '- 【阻断】没有编号' }]), null, '没有编号的旧讨论不显示追踪');
  // 表态条目也照常解析（卡片上显示在「对其他评审的阻断」小节下）
  const withStance = crit.find((p) => /【补充】/.test(p.body));
  assert.equal(itemDigest({ stage: 'critique', brief: '', body: withStance.body }).items.at(-1).section, '对其他评审的阻断');
});
