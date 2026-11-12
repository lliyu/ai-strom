// 第四批：追问分直接回答 / 裁决 / 核实 / 重新讨论；追问的会话可以接着原会话（resume）或新开（fresh）。
import { whoOf } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { runDiscussion, runFollowUp } from '../src/orchestrator.js';
import { createMemoryPublisher } from '../src/publishers.js';
import { parseTriage, parseVerdictPick, parseVerifyQuestions, triagePrompt } from '../src/modes.js';

const GOOD_DOC = (v = 1) => `【说明】\n第 ${v} 版说明\n【主文档】\n# 结论\n正文 v${v}`;
const PLAN = (x) => `**要点**：方案 ${x}\n**改了什么**\n- 改了\n**立场变化**（小幅）\n\n【完整方案】\n完整方案-${x}`;

const cfg = (extra = {}) => normalizeConfig({
  participants: [
    { id: 'a', name: 'A', provider: 'fake', part: 'lead' },
    { id: 'b', name: 'B', provider: 'fake', part: 'lead' },
    { id: 'r', name: 'R', provider: 'fake', part: 'reviewer' },
  ],
  chair: { id: 'chair', name: '主席', provider: 'fake' },
  providers: { fake: { type: 'mock' } },
  retryDelayMs: 0,
  rounds: 2,
  followUpMaxRounds: 2,
  ...extra,
});

function scripted(reply = () => null) {
  const calls = [];
  const provider = {
    async complete(opts) {
      const who = whoOf(opts);
      const stage = /【阶段：([^】]+)】/.exec(opts.prompt)?.[1] ?? '';
      const round = Number(/第 (\d+) 轮/.exec(stage)?.[1] ?? 0);
      const call = { who, stage, round, prompt: opts.prompt, session: opts.session ? { id: opts.session.id, turns: opts.session.turns.length } : null, tools: opts.tools };
      calls.push(call);
      const out = reply(call);
      if (out instanceof Error) throw out;
      if (out != null) return { text: out, usage: { inputTokens: 1, outputTokens: 1 } };
      if (stage === '核对主文档') return { text: '没有问题', usage: { inputTokens: 1, outputTokens: 1 } };
      if (stage.includes('主文档')) return { text: GOOD_DOC(stage.startsWith('更新') ? 2 : 1), usage: { inputTokens: 1, outputTokens: 1 } };
      if (who === 'A' || who === 'B') return { text: PLAN(`${who}${round}`), usage: { inputTokens: 1, outputTokens: 1 } };
      return { text: `发言-${calls.length}`, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { calls, registry: { get: () => provider } };
}

async function discussed(extra) {
  const c = cfg(extra);
  const res = await runDiscussion({ cfg: c, topic: '拆不拆库', providers: scripted().registry, publisher: createMemoryPublisher(), rng: () => 0 });
  return { c, state: res.state };
}

test('解析：四种处理方式、裁决的方案和要求、核实的问题', () => {
  assert.equal(parseTriage('处理方式：裁决\n...'), 'verdict');
  assert.equal(parseTriage('**处理方式**：核实'), 'verify');
  assert.equal(parseTriage('处理方式：重新讨论'), 'discuss');
  assert.equal(parseTriage('随便'), 'answer');
  assert.deepEqual(parseVerdictPick('处理方式：裁决\n**按哪个方案定稿**：方案 B\n**人的裁决**：\n- 选 B\n- 回滚开关保留'), { target: '方案 B', ruling: '- 选 B\n- 回滚开关保留' });
  assert.equal(parseVerdictPick('处理方式：裁决\n**按哪个方案定稿**：合并\n**人的裁决**：x').target, 'merge');
  assert.deepEqual(parseVerifyQuestions('处理方式：核实\n**要核实的问题**\n- 问题一？\n2. 问题二\n\n其他'), ['问题一？', '问题二']);
  // 不能核实时不给「核实」选项
  assert.doesNotMatch(triagePrompt({ rounds: [], finals: [], question: 'q', canVerify: false }), /处理方式：核实/);
  assert.match(triagePrompt({ rounds: [], finals: [], question: 'q', canVerify: true }), /处理方式：核实/);
});

test('裁决型：被选中的主笔按裁决定稿，不进入评审；主席按定稿更新主文档', async () => {
  const { c, state } = await discussed();
  const tagA = state.tags.a.tag;
  const { calls, registry } = scripted((x) => (x.stage === '追问判断' ? `处理方式：裁决\n**按哪个方案定稿**：${tagA}\n**人的裁决**：\n- 按 ${tagA}\n- 第二步不做` : null));
  const out = await runFollowUp({ cfg: c, state, question: `按${tagA}，第二步不做`, providers: registry, publisher: createMemoryPublisher() });
  assert.equal(out.handling, 'verdict');
  const final = calls.find((x) => x.stage.includes('按裁决定稿'));
  assert.equal(final.who, 'A');
  assert.match(final.prompt, /第二步不做/);
  assert.ok(!calls.some((x) => x.who === 'R'), '裁决型不经过评审');
  assert.ok(!calls.some((x) => x.who === 'B'));
  const update = calls.find((x) => x.stage === '更新主文档');
  assert.match(update.prompt, /定稿（按人的裁决，未经评审）/);
  assert.match(update.prompt, /完整方案-A3/);
  assert.equal(out.state.followUps.at(-1).target, tagA);
  assert.equal(out.state.followUps.at(-1).ruledAfter, state.lastRound, '记下裁决覆盖到第几轮');
  assert.equal(out.state.docs.length, 2);
});

test('裁决型：选择不对应单个方案时由主席合并；没写方案时按重新讨论', async () => {
  const { c, state } = await discussed();
  const merge = scripted((x) => (x.stage === '追问判断' ? '处理方式：裁决\n**按哪个方案定稿**：合并\n**人的裁决**：A 的第一步加 B 的第二步' : null));
  await runFollowUp({ cfg: c, state, question: 'A 的第一步加 B 的第二步', providers: merge.registry, publisher: createMemoryPublisher() });
  assert.ok(!merge.calls.some((x) => x.stage.includes('按裁决定稿')));
  assert.match(merge.calls.find((x) => x.stage === '更新主文档').prompt, /由你按裁决把各方案组合成定稿/);

  const vague = scripted((x) => (x.stage === '追问判断' ? '处理方式：裁决\n就这样吧' : null));
  const out = await runFollowUp({ cfg: c, state, question: '就这样', providers: vague.registry, publisher: createMemoryPublisher() });
  assert.equal(out.handling, 'discuss');
});

test('核实型：按主席列的问题核实，主席把结论合进主文档，不进入多轮讨论；不能核实时按重新讨论', async () => {
  const withCode = { repos: { x: { path: '/r/x', description: 'x' } } };
  const { c, state } = await discussed(withCode);
  const fakeState = { ...state, context: { auto: false, repos: ['x'], text: '背景' } };
  const code = { repos: [{ alias: 'x', description: 'x', readPath: '/tmp/x', branch: 'main', commit: 'abc', dirty: 0, snapshot: false }], docs: [], groups: [], dirs: ['/tmp/x'] };
  const { calls, registry } = scripted((x) => {
    if (x.stage === '追问判断') return '处理方式：核实\n**要核实的问题**\n- 订单表有没有按用户分区？';
    if (x.who === '调研员') return '1. 没有分区（x:order.sql:3）';
    return null;
  });
  const out = await runFollowUp({ cfg: c, state: fakeState, question: '查一下订单表分区了没', providers: registry, publisher: createMemoryPublisher(), code });
  assert.equal(out.handling, 'verify');
  assert.match(calls.find((x) => x.who === '调研员').prompt, /订单表有没有按用户分区/);
  assert.ok(!calls.some((x) => x.who === 'A' || x.who === 'R'));
  const update = calls.find((x) => x.stage === '更新主文档');
  assert.match(update.prompt, /这次要核实的问题/);
  assert.match(update.prompt, /没有分区/);
  assert.equal(out.state.facts.at(-1).questions[0], '订单表有没有按用户分区？');

  // 本场既没有代码也不能联网：主席写了核实也按重新讨论
  const { c: c2, state: s2 } = await discussed();
  const none = scripted((x) => (x.stage === '追问判断' ? '处理方式：核实\n**要核实的问题**\n- 某事？' : null));
  const out2 = await runFollowUp({ cfg: c2, state: s2, question: '查一下', providers: none.registry, publisher: createMemoryPublisher() });
  assert.equal(out2.handling, 'discuss');
  assert.doesNotMatch(none.calls.find((x) => x.stage === '追问判断').prompt, /处理方式：核实/);
});

test('新会话追问（fresh）：参与者各开一条新会话，第一条消息带上主文档、自己和别人的方案、阻断存档、插话', async () => {
  const { c, state } = await discussed();
  const withIj = { ...state, interjections: [{ sender: '主持人', text: '预算砍半-插话' }] };
  const { calls, registry } = scripted((x) => (x.stage === '追问判断' ? '处理方式：重新讨论\n**给参与者的说明**：重新看预算' : null));
  const out = await runFollowUp({ cfg: c, state: withIj, question: '预算砍半怎么办', providers: registry, publisher: createMemoryPublisher(), context: 'fresh' });
  const firstA = calls.find((x) => x.who === 'A');
  assert.equal(firstA.session.turns, 0);
  assert.notEqual(firstA.session.id, state.sessions.a.id);
  assert.match(firstA.prompt, /这是一条新会话/);
  assert.match(firstA.prompt, /正文 v1/); // 主文档
  assert.match(firstA.prompt, /你目前的方案/);
  assert.match(firstA.prompt, /预算砍半-插话/);
  assert.match(firstA.prompt, /你是「A/); // 身份重新介绍
  // 之后的轮次不再重复
  const laterA = calls.filter((x) => x.who === 'A').slice(1);
  for (const x of laterA) assert.doesNotMatch(x.prompt, /这是一条新会话/);
  assert.equal(out.state.followUps.at(-1).context, 'fresh');
  assert.ok(out.state.retiredSessions.some((r) => r.id === state.sessions.a.id));
  assert.notEqual(out.state.sessions.a.id, state.sessions.a.id);
});

test('新会话追问但没有参与者发言（直接回答）：原会话保留，下次还能接着用', async () => {
  const { c, state } = await discussed();
  const { registry } = scripted((x) => (x.stage === '追问判断' ? '处理方式：直接回答\n就是这样' : x.stage === '更新主文档' ? '【无需修改】' : null));
  const out = await runFollowUp({ cfg: c, state, question: '为什么', providers: registry, publisher: createMemoryPublisher(), context: 'fresh' });
  assert.equal(out.handling, 'answer');
  assert.equal(out.state.sessions.a.id, state.sessions.a.id);
  assert.equal(out.state.sessions.a.turns.length, state.sessions.a.turns.length);
  assert.equal(out.state.retiredSessions, undefined);
});

test('默认接着原会话；配置 followUpContext: fresh 时默认新会话', async () => {
  assert.equal(cfg().followUpContext, 'resume');
  assert.equal(cfg({ followUpContext: 'fresh' }).followUpContext, 'fresh');
  const { c, state } = await discussed();
  const { calls, registry } = scripted((x) => (x.stage === '追问判断' ? '处理方式：重新讨论\n**给参与者的说明**：x' : null));
  await runFollowUp({ cfg: c, state, question: 'q', providers: registry, publisher: createMemoryPublisher() });
  const firstA = calls.find((x) => x.who === 'A');
  assert.equal(firstA.session.id, state.sessions.a.id);
  assert.doesNotMatch(firstA.prompt, /这是一条新会话/);
});
