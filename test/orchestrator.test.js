import { whoOf } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { runDiscussion, assignLabels } from '../src/orchestrator.js';
import { createMemoryPublisher } from '../src/publishers.js';

function cfgFor(mode, rounds = 2, n = 3) {
  return normalizeConfig({
    mode,
    rounds,
    participants: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `模型${i}`, role: `视角${i}`, provider: 'fake', model: `m${i}`, color: 'blue' })),
    chair: { id: 'chair', name: '主席', provider: 'fake', color: 'purple' },
    providers: { fake: { type: 'mock' } },
  });
}

/** 记录每次调用的提示词；可以让指定的发言者在指定阶段失败。 */
function recordingProviders({ failWhen = () => false } = {}) {
  const calls = [];
  const provider = {
    async complete({ model, system, prompt }) {
      const who = whoOf(arguments[0]);
      const stage = /【阶段：([^】]+)】/.exec(prompt)?.[1];
      const text = `发言-${calls.length}`; // 回答里不带发言者名字，才能检验匿名
      calls.push({ who, stage, model, system, prompt, text });
      if (failWhen({ who, stage })) throw new Error('模拟失败');
      return { text, model, durationMs: 10, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { calls, registry: { get: () => provider } };
}

const fixedRng = () => 0; // 固定代号分配，方便断言

test('匿名代号：每人一个，互不重复', () => {
  const labels = assignLabels([{ id: 'x' }, { id: 'y' }, { id: 'z' }], fixedRng);
  assert.deepEqual([...labels.values()].sort(), ['A', 'B', 'C']);
});

test('decision：发言次数、顺序与匿名', async () => {
  const cfg = cfgFor('decision', 3);
  const { calls, registry } = recordingProviders();
  const pub = createMemoryPublisher();
  const result = await runDiscussion({ cfg, topic: '要不要拆分价格服务', providers: registry, publisher: pub, rng: fixedRng });

  // 开场 1 + 3 人 × 3 轮 + 主席 1 + 结束 1
  assert.equal(pub.posts.length, 1 + 9 + 1 + 1);
  assert.equal(calls.filter((c) => c.stage === '独立方案').length, 3);
  assert.equal(calls.filter((c) => /互评与修订/.test(c.stage)).length, 6);

  // 互评时看不到别人的真实名字，只看到代号
  const review = calls.find((c) => c.who.startsWith('模型0') && /第 2 轮/.test(c.stage));
  assert.doesNotMatch(review.prompt, /模型1|模型2/);
  assert.match(review.prompt, /### 方案 [A-C]/);
  assert.doesNotMatch(review.prompt.split('其他主笔')[1], new RegExp(`${result.labels.p0}\\n`));

  // 主席只看到代号，结束卡片补上对照
  const chair = calls.find((c) => c.stage === '汇总');
  assert.doesNotMatch(chair.prompt, /模型\d/);
  const end = pub.posts.at(-1);
  assert.match(end.body, /代号对照/);
  assert.match(end.body, /方案 [A-C]：模型0 · 视角0/);
  assert.equal(result.stats.calls, 10);
});

test('brainstorm：发散 → 盲审 → 修订 → 主编', async () => {
  const cfg = cfgFor('brainstorm', 2);
  const { calls, registry } = recordingProviders();
  const pub = createMemoryPublisher();
  await runDiscussion({ cfg, topic: '修仙 + 外卖', providers: registry, publisher: pub, rng: fixedRng });
  const stages = calls.map((c) => c.stage.replace(/第 \d 轮/, ''));
  assert.deepEqual(stages.filter((s) => s === '发散').length, 3);
  assert.deepEqual(stages.filter((s) => s === '盲审意见').length, 3);
  assert.deepEqual(stages.filter((s) => s === '修订').length, 3);
  assert.equal(stages.at(-1), '汇总');

  // 修订时只拿到别人给的意见，评审者匿名，看不到别人的脑洞原文
  const revise = calls.find((c) => c.who.startsWith('模型0') && /修订/.test(c.stage));
  assert.match(revise.prompt, /### 意见 1/);
  assert.match(revise.prompt, /### 意见 2/);
  assert.doesNotMatch(revise.prompt, /模型[12]/);
  const othersIdeas = calls.filter((c) => c.stage === '发散' && !c.who.startsWith('模型0')).map((c) => c.text);
  for (const t of othersIdeas) assert.ok(!revise.prompt.includes(`\n${t}\n`), '修订时不应看到别人的脑洞原文');
  // 会话模式：自己上一版就在会话里，修订时不再重贴；非会话模式才贴原文
  const ownIdea = calls.find((c) => c.stage === '发散' && c.who.startsWith('模型0')).text;
  assert.ok(!revise.prompt.includes(ownIdea));
  assert.match(revise.prompt, /就是你在本会话中上一次的回答/);

  const plain = recordingProviders();
  await runDiscussion({ cfg: { ...cfg, conversation: false }, topic: '修仙 + 外卖', providers: plain.registry, publisher: createMemoryPublisher(), rng: fixedRng });
  const own2 = plain.calls.find((c) => c.stage === '发散' && c.who.startsWith('模型0')).text;
  assert.ok(plain.calls.find((c) => c.who.startsWith('模型0') && /修订/.test(c.stage)).prompt.includes(own2));
});

function cfgWithReviewers(mode, rounds = 2) {
  const cfg = cfgFor(mode, rounds, 4);
  cfg.participants[2].part = 'reviewer';
  cfg.participants[3].part = 'reviewer';
  return normalizeConfig(cfg);
}

test('decision + 评审：评审先提意见、不出方案，主笔回应后修订', async () => {
  const cfg = cfgWithReviewers('decision', 3);
  const { calls, registry } = recordingProviders();
  const pub = createMemoryPublisher();
  const result = await runDiscussion({ cfg, topic: '议题', providers: registry, publisher: pub, rng: fixedRng });

  const by = (stage, whoPrefix) => calls.filter((c) => c.stage.includes(stage) && (!whoPrefix || c.who.startsWith(whoPrefix)));
  // 第 1 轮只有主笔出方案
  assert.deepEqual(by('独立方案').map((c) => c.who.slice(0, 3)).sort(), ['模型0', '模型1']);
  // 评审每轮（第 2、3 轮）各提一次意见，从不出方案或修订
  assert.equal(by('评审意见').length, 4);
  assert.ok(calls.filter((c) => /模型[23]/.test(c.who)).every((c) => c.stage.includes('评审意见')));
  // 主笔每轮回应评审：提示词里有评审意见，评审意见按「评审 N」匿名
  const r2 = by('第 2 轮互评与修订', '模型0')[0];
  assert.match(r2.prompt, /## 评审意见（匿名，针对所有方案）/);
  assert.match(r2.prompt, /### 评审 1\n发言-\d+/);
  assert.match(r2.prompt, /对评审意见的回应/);
  assert.doesNotMatch(r2.prompt, /模型[123]/);
  // 同一轮里评审先于主笔
  const firstCritique = calls.findIndex((c) => c.stage === '第 2 轮评审意见');
  const firstReview = calls.findIndex((c) => c.stage === '第 2 轮互评与修订');
  assert.ok(firstCritique < firstReview);
  // 评审看到的是主笔的方案
  const crit = by('第 2 轮评审意见')[0];
  assert.match(crit.prompt, /### 方案 A/);
  assert.match(crit.prompt, /### 方案 B/);
  assert.doesNotMatch(crit.prompt, /### 方案 C/);
  // 主席知道方案与评审的区别，并输出未解决的问题
  const chair = calls.find((c) => c.stage === '汇总');
  assert.match(chair.prompt, /#### 评审 1/);
  assert.match(chair.prompt, /评审提出但仍未解决的问题/);
  // 代号对照同时列出方案与评审
  const end = pub.posts.at(-1).body;
  assert.match(end, /方案 A：/);
  assert.match(end, /评审 2：/);
  assert.match(pub.posts[0].body, /\*\*评审\*\*：模型2 · 视角2 \/ 模型3 · 视角3/);
  assert.equal(result.stats.calls, 2 + 2 * (2 + 2) + 1);
});

test('brainstorm + 评审：评审只参与盲审，主笔收到全部意见', async () => {
  const cfg = cfgWithReviewers('brainstorm', 2);
  const { calls, registry } = recordingProviders();
  await runDiscussion({ cfg, topic: '题目', providers: registry, publisher: createMemoryPublisher(), rng: fixedRng });
  assert.equal(calls.filter((c) => c.stage === '发散').length, 2);
  assert.equal(calls.filter((c) => c.stage.includes('盲审意见')).length, 4); // 2 主笔 + 2 评审
  assert.equal(calls.filter((c) => c.stage.includes('修订')).length, 2);
  const revise = calls.find((c) => c.stage.includes('修订') && c.who.startsWith('模型0'));
  assert.match(revise.prompt, /### 意见 3/); // 另一位主笔 + 两位评审
  assert.ok(calls.filter((c) => /模型[23]/.test(c.who)).every((c) => c.stage.includes('盲审意见')));
});

test('配置了评审时校验分工与轮数', () => {
  const raw = cfgFor('decision', 2, 3);
  raw.participants.forEach((p) => { p.part = 'reviewer'; });
  assert.throws(() => normalizeConfig(raw), /至少需要 1 位主笔/);
  const raw2 = cfgFor('decision', 1, 3);
  raw2.participants[2].part = 'reviewer';
  assert.throws(() => normalizeConfig(raw2), /rounds 至少为 2/);
  const raw3 = cfgFor('decision', 2, 3);
  raw3.participants[2].part = 'critic';
  assert.throws(() => normalizeConfig(raw3), /part 只能是/);
});

test('插话进入下一轮所有人的提示词', async () => {
  const cfg = cfgFor('decision', 2, 2);
  const { calls, registry } = recordingProviders();
  let polls = 0;
  const interjections = {
    async poll() {
      polls += 1;
      return polls === 2 ? [{ id: 'om_1', sender: '张三', text: '不能改表结构', time: '14:20' }] : [];
    },
  };
  const result = await runDiscussion({ cfg, topic: '议题', providers: registry, publisher: createMemoryPublisher(), interjections, rng: fixedRng });
  const round1 = calls.filter((c) => c.stage === '独立方案');
  const round2 = calls.filter((c) => /第 2 轮/.test(c.stage));
  assert.ok(round1.every((c) => !c.prompt.includes('不能改表结构')));
  assert.ok(round2.every((c) => c.prompt.includes('[14:20] 张三：不能改表结构')));
  assert.ok(calls.find((c) => c.stage === '汇总').prompt.includes('不能改表结构'));
  assert.equal(result.interjections.length, 1);
});

test('单个模型失败时讨论继续，并发出失败卡片', async () => {
  const cfg = cfgFor('decision', 2, 3);
  const { registry } = recordingProviders({ failWhen: ({ who, stage }) => who.startsWith('模型2') && /第 2 轮/.test(stage) });
  const pub = createMemoryPublisher();
  const result = await runDiscussion({ cfg, topic: '议题', providers: registry, publisher: pub, rng: fixedRng });
  assert.ok(pub.posts.some((p) => /发言失败/.test(p.title)));
  assert.equal(result.stats.failures, 1);
  assert.ok(result.summary);
});

test('用量事件：开始、每次调用、结束都有记录', async () => {
  const cfg = cfgFor('decision', 2, 2);
  cfg.participants[0].contextWindow = 64000; // 参与者上的配置优先于 provider 返回值
  const { registry } = recordingProviders({ failWhen: ({ who, stage }) => who.startsWith('模型1') && /第 2 轮/.test(stage) });
  const events = [];
  await runDiscussion({ cfg, topic: '议题', providers: registry, publisher: createMemoryPublisher(), rng: fixedRng, onEvent: (e) => events.push(e) });
  assert.equal(events[0].type, 'run_started');
  assert.deepEqual(events[0].participants.map((p) => p.id), ['p0', 'p1']);
  assert.equal(events.at(-1).type, 'run_finished');
  const started = events.filter((e) => e.type === 'call_started').length;
  const finished = events.filter((e) => e.type === 'call_finished');
  const failed = events.filter((e) => e.type === 'call_failed');
  assert.equal(started, finished.length + failed.length);
  assert.equal(failed.length, 1);
  const p0 = finished.find((e) => e.speaker === 'p0');
  assert.equal(p0.contextWindow, 64000);
  assert.equal(p0.inputTokens, 1);
  assert.ok(finished.some((e) => e.speaker === 'chair' && e.stage === 'summary'));
});

test('第 1 轮成功不足 2 人时中止', async () => {
  const cfg = cfgFor('decision', 2, 2);
  const { registry } = recordingProviders({ failWhen: ({ who }) => who.startsWith('模型1') });
  await assert.rejects(
    runDiscussion({ cfg, topic: '议题', providers: registry, publisher: createMemoryPublisher(), rng: fixedRng }),
    /讨论无法继续/,
  );
});
