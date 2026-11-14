import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIdeaMarks, abandonedIdeas, keptIdeas, feedbackPrompt, revisePrompt } from '../src/modes.js';

const fb = (round, entries) => ({ round, stage: 'feedback', entries: entries.map(([tag, text]) => ({ tag, text })) });

test('去留标记：认「【留】B1」「【弃】方案 B 2：理由」和加粗写法，同一个脑洞取第一次', () => {
  const marks = parseIdeaMarks('**【弃】A1**：老套路\n- 【留】B1\n【弃】方案 B 2：撑不起长篇\n正文里提到【弃】不算\n【留】A1');
  assert.deepEqual(marks, [
    { code: 'A1', keep: false, reason: '老套路' },
    { code: 'B1', keep: true, reason: '' },
    { code: 'B2', keep: false, reason: '撑不起长篇' },
  ]);
});

test('放弃：评审过半才算，有评审时主笔的票不算；放弃过的不再重复计', () => {
  const rounds = [
    fb(2, [['方案 A', '【弃】B1'], ['评审 1', '【弃】A1：旧\n【弃】B1'], ['评审 2', '【弃】A1：套路\n【留】B1'], ['评审 3', '【留】A1']]),
    fb(3, [['评审 1', '【弃】A1\n【弃】B2'], ['评审 2', '【弃】B2'], ['评审 3', '【留】B2']]),
  ];
  const gone = abandonedIdeas(rounds, { hasReviewers: true });
  assert.deepEqual(gone.map((g) => [g.code, g.round, g.votes, g.voters]), [['A1', 2, 2, 3], ['B2', 3, 2, 3]]);
  assert.deepEqual(gone[0].reasons, ['旧', '套路']);
  // 2 位评审时要 2 票
  assert.deepEqual(abandonedIdeas([fb(2, [['评审 1', '【弃】A1'], ['评审 2', '【留】A1']])]), []);
  assert.deepEqual(keptIdeas('方案 A', 2, gone), [2]);
  assert.deepEqual(keptIdeas('方案 B', 2, gone), [1]);
});

test('放弃：没有评审时由其他主笔投票，主笔不给自己投、也不算进分母', () => {
  const rounds = [fb(2, [['方案 A', '【弃】B1\n【弃】C1'], ['方案 B', '【弃】C1\n【弃】A1'], ['方案 C', '【留】A1\n【弃】B1']])];
  assert.deepEqual(abandonedIdeas(rounds, { hasReviewers: false }).map((g) => g.code).sort(), ['B1', 'C1']);
});

test('盲审提示词：先标去留，问题只写脑洞级，后续注意单列；结论只看留着的脑洞', () => {
  const p = feedbackPrompt({ round: 2, others: [{ tag: '方案 A', text: 'x' }], askVerdict: true, abandoned: [{ code: 'B2', round: 2, votes: 2, voters: 2, reasons: ['老套路'] }] });
  assert.match(p, /「【留】B1」或「【弃】B1：一句话理由」/);
  assert.match(p, /该放弃就放弃/);
  assert.match(p, /\*\*后续注意\*\*（写梗概、大纲、正文时要留意的，主笔这一轮不用改/);
  assert.match(p, /具体数字、设定里的逻辑小漏洞[\s\S]*写进\*\*后续注意\*\*/);
  assert.match(p, /已经放弃的脑洞[\s\S]*B2（第 2 轮，2\/2 位评审标【弃】）：老套路/);
  assert.match(p, /只有你标了【留】的脑洞里还有脑洞级问题/);
  assert.doesNotMatch(p, /明显提升这些脑洞/);
});

test('修订提示词：不补新的、不靠加机制补漏洞，后续注意这轮不用改', () => {
  const p = revisePrompt({ round: 2, own: { tag: '方案 A', text: 'x' }, feedback: ['y'], ideasPerAgent: 2, kept: [2], dropped: [{ code: 'A1', reasons: ['老套路'] }] });
  assert.match(p, /A1：老套路[\s\S]*不要再写它们/);
  assert.match(p, /只写还留着的脑洞（编号 2），编号不变，不补新的/);
  assert.match(p, /不要为了堵漏洞新增规则或机制/);
  assert.match(p, /「后续注意」是写大纲和正文时的事/);
  assert.doesNotMatch(p, /补新的、|可以删掉弱的、补新的/);
});
