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
      const text = stage === '核对主文档' ? '没有问题' : `发言-${calls.length}`; // 回答里不带发言者名字，才能检验匿名
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

  // 开场 1 + 3 人 × 3 轮 + 主文档 1 + 结束 1（主笔核对没有意见时不发）
  assert.equal(pub.posts.length, 1 + 9 + 1 + 1);
  assert.equal(calls.filter((c) => c.stage === '核对主文档').length, 3);
  assert.equal(calls.filter((c) => c.stage === '独立方案').length, 3);
  assert.equal(calls.filter((c) => /互评与修订/.test(c.stage)).length, 6);

  // 互评时看不到别人的真实名字，只看到代号
  const review = calls.find((c) => c.who.startsWith('模型0') && /第 2 轮/.test(c.stage));
  assert.doesNotMatch(review.prompt, /模型1|模型2/);
  assert.match(review.prompt, /### 方案 [A-C]/);
  assert.doesNotMatch(review.prompt.split('其他主笔')[1], new RegExp(`${result.labels.p0}\\n`));

  // 主席只看到代号，结束卡片补上对照
  const chair = calls.find((c) => c.stage === '主文档');
  assert.doesNotMatch(chair.prompt, /模型\d/);
  assert.match(chair.prompt, /文中不要出现代号和轮次/);
  assert.equal(result.state.docs.length, 1);
  assert.equal(result.state.summary, result.state.docs[0].text);
  const end = pub.posts.at(-1);
  assert.match(end.body, /代号对照/);
  assert.match(end.body, /方案 [A-C]：模型0 · 视角0/);
  assert.equal(result.stats.calls, 9 + 1 + 3);
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
  assert.ok(stages.includes('主文档'));
  assert.match(calls.find((c) => c.stage === '主文档').prompt, /## 各方最终版脑洞/);

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
  const chair = calls.find((c) => c.stage === '主文档');
  assert.match(chair.prompt, /#### 评审 1/);
  assert.match(chair.prompt, /评审意见用来判断哪些问题已经解决/);
  // 只有主笔核对主文档
  assert.deepEqual(calls.filter((c) => c.stage === '核对主文档').map((c) => c.who.slice(0, 3)).sort(), ['模型0', '模型1']);
  // 代号对照同时列出方案与评审
  const end = pub.posts.at(-1).body;
  assert.match(end, /方案 A：/);
  assert.match(end, /评审 2：/);
  assert.match(pub.posts[0].body, /\*\*评审\*\*：模型2 · 视角2 \/ 模型3 · 视角3/);
  assert.equal(result.stats.calls, 2 + 2 * (2 + 2) + 1 + 2);
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
  assert.ok(calls.find((c) => c.stage === '主文档').prompt.includes('不能改表结构'));
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
  assert.ok(finished.some((e) => e.speaker === 'chair' && e.stage === 'doc'));
  assert.ok(events.some((e) => e.type === 'doc_written' && e.version === 1));
});

test('第 1 轮成功不足 2 人时中止', async () => {
  const cfg = cfgFor('decision', 2, 2);
  const { registry } = recordingProviders({ failWhen: ({ who }) => who.startsWith('模型1') });
  await assert.rejects(
    runDiscussion({ cfg, topic: '议题', providers: registry, publisher: createMemoryPublisher(), rng: fixedRng }),
    /讨论无法继续/,
  );
});

test('脑洞风暴：评审过半标【弃】就拿掉，不补新的；主笔的脑洞全被放弃就退出，全部放弃提前结束', async () => {
  const cfg = normalizeConfig({ ...cfgWithReviewers('brainstorm', 4), ideasPerAgent: 2 });
  const calls = [];
  const marks = {
    2: '【弃】A1：老套路换皮\n【弃】A2：撑不起长篇\n【留】B1\n**亮点**：x\n【弃】B2：钩子不抓人',
    3: '【弃】B1：越补越重',
  };
  const provider = {
    async complete({ model, prompt }) {
      const who = whoOf(arguments[0]);
      const stage = /【阶段：([^】]+)】/.exec(prompt)?.[1] ?? '';
      const round = Number(/第 (\d+) 轮/.exec(stage)?.[1]);
      let text = `发言-${calls.length}`;
      if (stage.includes('盲审意见') && /模型[23]/.test(who)) text = `${marks[round] ?? '【留】B1'}\n评审结论：继续讨论`;
      if (stage === '核对主文档') text = '没有问题';
      calls.push({ who, stage, prompt, text });
      return { text, model, durationMs: 10, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const pub = createMemoryPublisher();
  const result = await runDiscussion({ cfg, topic: '末日 种田', providers: { get: () => provider }, publisher: pub, rng: fixedRng });
  const leadA = Object.entries(result.labels).find(([, t]) => t === '方案 A')[0];
  const nameA = cfg.participants.find((p) => p.id === leadA).name;

  assert.match(calls.find((c) => c.stage === '发散').prompt, /独立给出 2 个/);
  // 第 2 轮：A 的两个和 B2 被放弃，主编发卡片
  const card = pub.posts.find((p) => p.meta?.stage === 'abandon' && p.meta.round === 2);
  assert.match(card.body, /A1[\s\S]*A2[\s\S]*B2/);
  assert.match(card.body, /方案 A 的脑洞都已放弃/);
  // A 不修订；B 只修订 B1，并被告知 B2 已放弃
  const revise2 = calls.filter((c) => c.stage === '第 2 轮修订');
  assert.equal(revise2.length, 1);
  assert.ok(!revise2[0].who.startsWith(nameA));
  assert.match(revise2[0].prompt, /B2：钩子不抓人[\s\S]*不要再写它们/);
  assert.match(revise2[0].prompt, /只写还留着的脑洞（编号 1）/);
  // 第 3 轮：A 不再发言，评审只评 B，并看到已放弃的清单
  const round3 = calls.filter((c) => c.stage.startsWith('第 3 轮'));
  assert.ok(round3.every((c) => !c.who.startsWith(nameA)));
  const fb3 = round3.find((c) => /模型2/.test(c.who));
  assert.doesNotMatch(fb3.prompt.split('## 待评的脑洞')[1].split('## 已经放弃')[0], /### 方案 A/);
  assert.match(fb3.prompt, /已经放弃的脑洞[\s\S]*A1/);
  // B1 也被放弃：提前结束，不再修订，主编知道放弃了哪些
  assert.equal(result.ending.reason, 'abandoned');
  assert.equal(result.roundsUsed, 3);
  assert.equal(calls.filter((c) => c.stage === '第 3 轮修订').length, 0);
  const doc = calls.find((c) => c.stage === '主文档');
  assert.match(doc.prompt, /讨论中放弃的脑洞[\s\S]*B1（第 3 轮，2\/2 位评审标【弃】）：越补越重/);
  assert.match(doc.prompt, /所有脑洞都被评审过半判定放弃/);
  assert.equal(result.state.ideasPerAgent, 2);
});

test('征询人：主席判断需要就暂停发卡片，一直等到人回答；回答当插话交给所有人，状态里记下问答；最后一轮不问', async () => {
  const cfg = normalizeConfig({ ...cfgFor('decision', 3, 2), humanAsk: { pollMs: 1 } });
  const calls = [];
  const provider = {
    async complete({ model, prompt }) {
      const who = whoOf(arguments[0]);
      const stage = /【阶段：([^】]+)】/.exec(prompt)?.[1] ?? '';
      let text = `发言-${calls.length}`;
      if (stage === '第 1 轮征询判断') text = '**是否需要问人**：需要\n1. 蓝染的终结留给谁？可选：一护 / 主角——决定高潮怎么写';
      else if (stage.includes('征询判断')) text = '是否需要问人：不需要\n方向已经清楚';
      if (stage === '核对主文档') text = '没有问题';
      calls.push({ who, stage, prompt, text });
      return { text, model, durationMs: 10, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const pub = createMemoryPublisher();
  let pollsWhileWaiting = 0;
  const interjections = {
    async poll() {
      if (!pub.posts.some((p) => p.meta?.stage === 'ask')) return [];
      pollsWhileWaiting += 1;
      return pollsWhileWaiting === 3 ? [{ sender: '主持人', text: '留给一护', time: '10:00', source: 'web' }] : [];
    },
  };
  const events = [];
  const result = await runDiscussion({ cfg, topic: '死神同人', providers: { get: () => provider }, publisher: pub, interjections, rng: fixedRng, onEvent: (e) => events.push(e) });

  // 第 1、2 轮之后各判断一次，第 3 轮是最后一轮不判断
  assert.deepEqual(calls.filter((c) => c.stage.includes('征询判断')).map((c) => c.stage), ['第 1 轮征询判断', '第 2 轮征询判断']);
  const card = pub.posts.find((p) => p.meta?.stage === 'ask');
  assert.match(card.body, /1\. 蓝染的终结留给谁？/);
  assert.match(card.body, /一直停在这里/);
  // 发卡片后读了 3 次插话才拿到回答，这之间没有任何发言
  assert.ok(pollsWhileWaiting >= 3);
  const askAt = calls.findIndex((c) => c.stage === '第 1 轮征询判断');
  assert.ok(calls[askAt + 1].stage.startsWith('第 2 轮'));
  // 第 2 轮所有人都看到回答和问题
  const round2 = calls.filter((c) => c.stage.startsWith('第 2 轮') && !c.stage.includes('征询'));
  assert.ok(round2.length >= 2);
  assert.ok(round2.every((c) => /回答主席的征询：蓝染的终结留给谁[\s\S]*留给一护/.test(c.prompt)));
  // 第 2 轮的判断看得到之前问过什么、人怎么答的
  assert.match(calls.find((c) => c.stage === '第 2 轮征询判断').prompt, /之前问过人的问题[\s\S]*人的回答\*\*：留给一护/);
  assert.equal(result.state.asks.length, 1);
  assert.equal(result.state.asks[0].answer, '留给一护');
  assert.deepEqual(events.filter((e) => e.type.startsWith('human_')).map((e) => e.type), ['human_ask', 'human_answered']);
});

test('征询人：默认不限次数，主席每轮判断需要就问', async () => {
  const cfg = normalizeConfig({ ...cfgFor('decision', 4, 2), humanAsk: { pollMs: 1 } });
  const provider = {
    async complete({ model, prompt }) {
      const stage = /【阶段：([^】]+)】/.exec(prompt)?.[1] ?? '';
      const text = stage.includes('征询判断') ? '是否需要问人：需要\n1. 要不要更虐？' : stage === '核对主文档' ? '没有问题' : 'x';
      return { text, model, durationMs: 10, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const pub = createMemoryPublisher();
  let answered = 0;
  const interjections = { async poll() { const asked = pub.posts.filter((p) => p.meta?.stage === 'ask').length; return asked > answered ? (answered = asked, [{ sender: '主持人', text: `回答 ${asked}` }]) : []; } };
  const result = await runDiscussion({ cfg, topic: '题目', providers: { get: () => provider }, publisher: pub, interjections, rng: fixedRng });
  // 第 1、2、3 轮之后各问一次（第 4 轮是最后一轮）
  assert.deepEqual(result.state.asks.map((a) => [a.round, a.answer]), [[1, '回答 1'], [2, '回答 2'], [3, '回答 3']]);
});

test('征询人：配了 maxAsks 就限制每次运行最多问几次，用完不再请主席判断；没有插话通道时不问', async () => {
  const cfg = normalizeConfig({ ...cfgFor('decision', 4, 2), humanAsk: { pollMs: 1, maxAsks: 1 } });
  const calls = [];
  const provider = {
    async complete({ model, prompt }) {
      const stage = /【阶段：([^】]+)】/.exec(prompt)?.[1] ?? '';
      const text = stage.includes('征询判断') ? '是否需要问人：需要\n1. 要不要更虐？' : stage === '核对主文档' ? '没有问题' : `发言-${calls.length}`;
      calls.push({ stage });
      return { text, model, durationMs: 10, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const pub = createMemoryPublisher();
  const interjections = { async poll() { return pub.posts.some((p) => p.meta?.stage === 'ask') && !this.done ? (this.done = true, [{ sender: '主持人', text: '不要' }]) : []; } };
  await runDiscussion({ cfg, topic: '题目', providers: { get: () => provider }, publisher: pub, interjections, rng: fixedRng });
  assert.equal(calls.filter((c) => c.stage.includes('征询判断')).length, 1);
  assert.equal(pub.posts.filter((p) => p.meta?.stage === 'ask').length, 1);

  calls.length = 0;
  await runDiscussion({ cfg, topic: '题目', providers: { get: () => provider }, publisher: createMemoryPublisher(), rng: fixedRng });
  assert.equal(calls.filter((c) => c.stage.includes('征询判断')).length, 0);
});

test('脑洞风暴：每人 3 个，第 1 轮后暂停请作者挑；认不出编号就提示接着等，没选的放弃，全没被选的主笔退出', async () => {
  const cfg = normalizeConfig({ ...cfgWithReviewers('brainstorm', 3), humanAsk: { pollMs: 1 } });
  const calls = [];
  const provider = {
    async complete({ model, prompt }) {
      const who = whoOf(arguments[0]);
      const stage = /【阶段：([^】]+)】/.exec(prompt)?.[1] ?? '';
      let text = `发言-${calls.length}`;
      if (stage === '发散') text = '1. **一句话钩子**：钩子一\n展开\n\n2. **一句话钩子：**钩子二\n\n3. **一句话钩子**：钩子三';
      if (stage.includes('征询判断')) text = '是否需要问人：不需要\n清楚';
      if (stage === '核对主文档') text = '没有问题';
      calls.push({ who, stage, prompt, text });
      return { text, model, durationMs: 10, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const pub = createMemoryPublisher();
  const replies = ['嗯，我想想', '选 b1 和 B 3'];
  const cards = () => pub.posts.filter((p) => p.meta?.stage === 'ask').length;
  let used = 0;
  const interjections = { async poll() { return cards() > used && used < replies.length ? [{ sender: '主持人', text: replies[used++] }] : []; } };
  const result = await runDiscussion({ cfg, topic: '死神同人', providers: { get: () => provider }, publisher: pub, interjections, rng: fixedRng });

  assert.match(calls.find((c) => c.stage === '发散').prompt, /独立给出 3 个/);
  const pick = pub.posts.find((p) => p.meta?.stage === 'ask');
  assert.match(pick.title, /挑出要继续讨论的脑洞/);
  assert.match(pick.body, /\*\*A1\*\*：钩子一[\s\S]*\*\*A2\*\*：钩子二[\s\S]*\*\*B3\*\*：钩子三/);
  assert.match(pub.posts.filter((p) => p.meta?.stage === 'ask')[1].title, /没认出/); // 第一条回复没有编号
  const done = pub.posts.find((p) => /继续讨论 2 个脑洞/.test(p.title));
  assert.match(done.body, /继续\*\*：B1、B3[\s\S]*放弃\*\*：A1、A2、A3、B2[\s\S]*方案 A 的脑洞都没被选/);
  // 第 1 轮后不再让主席做征询判断（作者已经挑过）
  assert.ok(!calls.some((c) => c.stage === '第 1 轮征询判断'));
  // A 退出：第 2 轮起不再发言，评审只评 B，并看到作者没选的
  const nameA = cfg.participants.find((p) => result.labels[p.id] === '方案 A').name;
  assert.ok(calls.filter((c) => /^第 [23] 轮/.test(c.stage)).every((c) => !c.who.startsWith(nameA)));
  const fb = calls.find((c) => c.stage === '第 2 轮盲审意见' && /模型[23]/.test(c.who));
  assert.match(fb.prompt, /已经放弃的脑洞[\s\S]*A1（第 1 轮之后作者没选）/);
  const revise = calls.find((c) => c.stage === '第 2 轮修订');
  assert.match(revise.prompt, /B2：作者没选/);
  assert.match(revise.prompt, /只写还留着的脑洞（编号 1、3）/);
  assert.deepEqual(result.state.asks[0].picked, ['B1', 'B3']);
  assert.equal(result.state.asks[0].answer, '嗯，我想想\n选 b1 和 B 3');
});
