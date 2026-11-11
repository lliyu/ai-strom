import { whoOf } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { normalizeConfig } from '../src/config.js';
import { runDiscussion, runFollowUp } from '../src/orchestrator.js';
import { createMemoryPublisher } from '../src/publishers.js';
import { createClaudeCliProvider, callCost } from '../src/providers/claude-cli.js';
import { createOpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { createAnthropicCompatibleProvider } from '../src/providers/anthropic-compatible.js';
import { nextNumber, saveState, findState, listStates, expireOldSessions } from '../src/state.js';
import { parseTrigger } from '../src/watch.js';
import { parseTriage } from '../src/modes.js';

const base = (extra = {}) => normalizeConfig({
  participants: [
    { id: 'a', name: 'A', provider: 'fake', part: 'lead' },
    { id: 'b', name: 'B', provider: 'fake', part: 'lead' },
    { id: 'r', name: 'R', provider: 'fake', part: 'reviewer' },
  ],
  chair: { id: 'chair', name: '主席', provider: 'fake' },
  providers: { fake: { type: 'mock' } },
  ...extra,
});

function scripted(reply = () => null) {
  const calls = [];
  const provider = {
    async complete(opts) {
      const who = whoOf(opts);
      const stage = /【阶段：([^】]+)】/.exec(opts.prompt)?.[1] ?? '';
      const call = { who, stage, ...opts, turnsBefore: opts.session?.turns.length ?? null };
      calls.push(call);
      return { text: reply(call) ?? `发言-${calls.length}`, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { calls, registry: { get: () => provider } };
}

// ---------- 接入方式 ----------

function fakeSpawn(stdout, capture) {
  return (bin, args, opts) => {
    capture.push({ args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => { child.stdout.emit('data', stdout); child.emit('close', 0); });
    return child;
  };
}

test('claude CLI：第一次 --session-id，之后 --resume；不传会话时不保存', async () => {
  const capture = [];
  const ok = JSON.stringify({ type: 'result', subtype: 'success', result: 'x', usage: {}, modelUsage: {} });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'storm-cwd-'));
  const p = createClaudeCliProvider({ cwd }, { spawnImpl: fakeSpawn(ok, capture) });
  const session = { id: 'sid-1', turns: [] };
  await p.complete({ prompt: 'q1', session });
  session.turns.push({ prompt: 'q1', reply: 'x' });
  await p.complete({ prompt: 'q2', session });
  await p.complete({ prompt: 'q3' });
  const [first, second, third] = capture.map((c) => c.args);
  assert.equal(first[first.indexOf('--session-id') + 1], 'sid-1');
  assert.ok(!first.includes('--no-session-persistence'));
  assert.equal(second[second.indexOf('--resume') + 1], 'sid-1');
  assert.ok(third.includes('--no-session-persistence'));
  assert.equal(capture[0].opts.cwd, cwd); // 工作目录固定，续接才找得到会话
});

test('HTTP 接口：把之前每一轮的提问和回答作为历史消息带上', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/models')) return new Response('{}', { status: 404 });
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(url.includes('/v1/messages')
      ? { content: [{ type: 'text', text: 'ok' }], usage: {} }
      : { choices: [{ message: { content: 'ok' } }], usage: {} }), { status: 200 });
  };
  const session = { id: 's', turns: [{ prompt: 'p1', reply: 'r1' }] };
  await createOpenAICompatibleProvider({ name: 'o', baseUrl: 'https://o' }, { fetchImpl, env: {} }).complete({ system: 'S', prompt: 'p2', session });
  await createAnthropicCompatibleProvider({ name: 'a', baseUrl: 'https://a' }, { fetchImpl, env: {} }).complete({ system: 'S', prompt: 'p2', session });
  assert.deepEqual(bodies[0].messages.map((m) => [m.role, m.content]), [['system', 'S'], ['user', 'p1'], ['assistant', 'r1'], ['user', 'p2']]);
  assert.deepEqual(bodies[1].messages.map((m) => [m.role, m.content]), [['user', 'p1'], ['assistant', 'r1'], ['user', 'p2']]);
});

// ---------- 编排 ----------

test('会话：每位参与者一条会话，只发新内容，评审先跟进上一轮意见', async () => {
  const cfg = base({ maxRounds: 3 });
  const polls = [[], [{ sender: '我', text: '插话一' }], []];
  const interjections = { poll: async () => polls.shift() ?? [] };
  const { calls, registry } = scripted(({ who }) => (who === 'R' ? '【阻断】还有问题\n评审结论：继续讨论' : null));
  const res = await runDiscussion({ cfg, topic: 't', providers: registry, publisher: createMemoryPublisher(), interjections, rng: () => 0 });
  const of = (w) => calls.filter((c) => c.who === w);
  // 同一个人用同一条会话，轮次递增；主席不用会话
  assert.equal(new Set(of('A').map((c) => c.session.id)).size, 1);
  assert.deepEqual(of('A').map((c) => c.turnsBefore), [0, 1, 2]);
  assert.ok(of('主席').every((c) => !c.session));
  // 身份只说一次；自己的上一版不重贴
  assert.match(of('A')[0].prompt, /^你是「A/);
  assert.doesNotMatch(of('A')[1].prompt, /^你是「/);
  assert.ok(of('A')[0].prompt.includes(`你的代号是「${res.state.tags.a.tag}」`));
  assert.match(of('A')[1].prompt, /就是你在本会话中上一次的回答/);
  // 插话只发一次
  assert.match(of('A')[1].prompt, /插话一/);
  assert.doesNotMatch(of('A')[2].prompt, /插话一/);
  // 评审第 3 轮先跟进上一轮的意见
  assert.doesNotMatch(of('R')[0].prompt, /上轮未解决/);
  assert.match(of('R')[1].prompt, /你上一轮的意见就在本会话里[\s\S]*已解决或被合理反驳的不要再写[\s\S]*上轮未解决/);
  // 导出的状态可以续接
  assert.equal(res.state.lastRound, 3);
  assert.equal(res.state.sessions.a.turns.length, 3);
  assert.match(res.state.tags.a.tag, /^方案 [AB]$/);
});

test('非会话模式：每轮都是新会话，照旧贴全部内容', async () => {
  const cfg = base({ conversation: false, rounds: 2 });
  const { calls, registry } = scripted();
  await runDiscussion({ cfg, topic: 't', providers: registry, publisher: createMemoryPublisher(), rng: () => 0 });
  assert.ok(calls.every((c) => !c.session));
  assert.ok(calls.filter((c) => c.who === 'A').every((c) => /^你是「A/.test(c.prompt)));
});

async function finished(extra = {}) {
  const cfg = base({ maxRounds: 2, ...extra });
  const { registry } = scripted(({ who }) => (who === 'R' ? '【阻断】还有问题\n评审结论：继续讨论' : null));
  const res = await runDiscussion({ cfg, topic: '要不要拆服务', providers: registry, publisher: createMemoryPublisher(), rng: () => 0, number: 7 });
  return { cfg, state: res.state };
}

test('追问：主席判断直接回答，不惊动参与者', async () => {
  const { cfg, state } = await finished();
  const { calls, registry } = scripted(({ who }) => (who === '主席' ? '处理方式：直接回答\n第 2 轮方案 A 说的是……' : null));
  const pub = createMemoryPublisher();
  const out = await runFollowUp({ cfg, state, question: '方案 A 的熔断是什么意思？', providers: registry, publisher: pub });
  assert.equal(out.handling, 'answer');
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /讨论记录[\s\S]*人类的追问[\s\S]*方案 A 的熔断/);
  assert.equal(calls[0].system, state.shared); // 和原讨论同一份系统提示词
  assert.match(pub.posts[1].body, /^第 2 轮方案 A 说的是/); // 卡片里去掉「处理方式」那行
  assert.equal(out.state.followUps[0].handling, 'answer');
  assert.equal(out.state.lastRound, state.lastRound);
});

test('追问：主席判断重新讨论，参与者在原会话里接着讨论，直到评审没有新意见', async () => {
  const { cfg, state } = await finished();
  const { calls, registry } = scripted(({ who, stage }) => {
    if (who === '主席' && /追问判断/.test(stage)) return '处理方式：重新讨论\n**给参与者的说明**\n大促只剩两周，重新权衡上线节奏';
    if (who === 'R') return /第 4 轮/.test(stage) ? '评审结论：没有意见了' : '【阻断】还有问题\n评审结论：继续讨论';
    return null;
  });
  const out = await runFollowUp({ cfg, state, question: '如果大促只剩两周呢？', providers: registry, publisher: createMemoryPublisher() });
  assert.equal(out.handling, 'discuss');
  const stages = calls.map((c) => `${c.who}:${c.stage}`);
  assert.deepEqual(stages, [
    '主席:追问判断',
    'A:第 3 轮回应追问', 'B:第 3 轮回应追问',
    'R:第 4 轮评审意见', // 评审没有新意见，提前结束
    '主席:汇总',
  ]);
  // 主笔接着原来的会话：会话 id 不变，历史还在
  const a = calls.find((c) => c.who === 'A');
  assert.equal(a.session.id, state.sessions.a.id);
  assert.equal(a.turnsBefore, state.sessions.a.turns.length);
  assert.match(a.prompt, /如果大促只剩两周[\s\S]*主席的说明[\s\S]*重新权衡上线节奏/);
  assert.match(calls.at(-1).prompt, /追问之前的汇总[\s\S]*和之前结论相比的变化/);
  assert.equal(out.state.lastRound, 4);
  assert.equal(out.state.followUps[0].handling, 'discuss');
  assert.equal(out.state.sessions.a.turns.length, state.sessions.a.turns.length + 1);
});

for (const conversation of [true, false]) {
  test(`追问：评审收到追问原文作为讨论范围，不收到主席的说明（${conversation ? '会话模式只说一次' : '非会话模式每轮都说'}）`, async () => {
    const { cfg, state } = await finished({ conversation });
    const { calls, registry } = scripted(({ who, stage }) => {
      if (who === '主席' && /追问判断/.test(stage)) return '处理方式：重新讨论\n**给参与者的说明**\n主席认为要重新权衡上线节奏';
      if (who === 'R') return /第 5 轮/.test(stage) ? '评审结论：没有意见了' : '【阻断】还有问题\n评审结论：继续讨论';
      return null;
    });
    await runFollowUp({ cfg, state, question: '只聊可行性，不需要实现方案', providers: registry, publisher: createMemoryPublisher() });
    const r = calls.filter((c) => c.who === 'R');
    assert.deepEqual(r.map((c) => c.stage), ['第 4 轮评审意见', '第 5 轮评审意见']);
    assert.match(r[0].prompt, /本次讨论范围（人类的追问原文）\n只聊可行性，不需要实现方案[\s\S]*超出这个范围的问题/);
    assert.ok(r.every((c) => !c.prompt.includes('主席认为要重新权衡上线节奏')));
    if (conversation) assert.doesNotMatch(r[1].prompt, /本次讨论范围/);
    else assert.match(r[1].prompt, /本次讨论范围（人类的追问原文）\n只聊可行性/);
    // 主笔修订时不重复贴范围（回应追问时已经看过原文）
    assert.ok(calls.filter((c) => c.who === 'A' && /评审后修订|修订/.test(c.stage)).every((c) => !/本次讨论范围/.test(c.prompt)));
  });
}

test('首次讨论的评审不带讨论范围', async () => {
  const { calls, registry } = scripted(({ who }) => (who === 'R' ? '评审结论：没有意见了' : null));
  await runDiscussion({ cfg: base({ maxRounds: 3 }), topic: 't', providers: registry, publisher: createMemoryPublisher(), rng: () => 0 });
  assert.ok(calls.filter((c) => c.who === 'R').every((c) => !/本次讨论范围/.test(c.prompt)));
});

test('追问：已过期的讨论不能追问', async () => {
  const { cfg, state } = await finished();
  await assert.rejects(runFollowUp({ cfg, state: { ...state, expired: true }, question: 'q', providers: scripted().registry, publisher: createMemoryPublisher() }), /超过保留期/);
});

test('解析主席的处理方式与追问指令', () => {
  assert.equal(parseTriage('处理方式：重新讨论\n…'), 'discuss');
  assert.equal(parseTriage('**处理方式**：直接回答'), 'answer');
  assert.equal(parseTriage('没写'), 'answer');
  assert.deepEqual(parseTrigger('/追问 如果只剩两周？'), { mode: 'followup', target: undefined, topic: '如果只剩两周？' });
  assert.deepEqual(parseTrigger('/追问 #12 换成按商家分呢'), { mode: 'followup', target: 12, topic: '换成按商家分呢' });
  assert.deepEqual(parseTrigger('/追问 #12'), { mode: 'followup', error: '缺少问题' });
});

// ---------- 状态与保留期 ----------

test('编号递增、按编号或最近一场查找、超过保留期清理会话', () => {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'storm-runs-'));
  const mk = (n, updatedAt) => {
    const dir = path.join(runs, `run-${n}`);
    fs.mkdirSync(dir);
    saveState(dir, { version: 1, number: n, topic: `t${n}`, updatedAt, sessions: { a: { id: `sid-${n}`, turns: [{ prompt: 'p', reply: 'r' }] } } });
  };
  assert.equal(nextNumber(runs), 1);
  assert.equal(nextNumber(runs), 2);
  const now = Date.parse('2026-11-20T00:00:00Z');
  mk(1, '2026-11-10T00:00:00Z'); // 10 天前
  mk(2, '2026-11-18T00:00:00Z'); // 2 天前
  fs.rmSync(path.join(runs, '.counter')); // 计数文件丢了也不重号
  assert.equal(nextNumber(runs), 3);
  assert.equal(findState(runs).state.number, 2);
  assert.equal(findState(runs, 1).state.number, 1);
  assert.throws(() => findState(runs, 9), /找不到讨论 #9/);
  // dry-run 与正式讨论分开找最近一场
  saveState(path.join(runs, 'run-2'), { ...findState(runs, 2).state, dryRun: true });
  assert.equal(findState(runs, undefined, { dryRun: false }).state.number, 1);
  assert.equal(findState(runs, undefined, { dryRun: true }).state.number, 2);

  const files = new Map([['sid-1', path.join(runs, 'sid-1.jsonl')], ['sid-2', path.join(runs, 'sid-2.jsonl')]]);
  for (const f of files.values()) fs.writeFileSync(f, '{}');
  const cleaned = expireOldSessions(runs, { retentionDays: 7, now, sessionFile: (id) => files.get(id) });
  assert.deepEqual(cleaned, [1]);
  assert.equal(fs.existsSync(files.get('sid-1')), false);
  assert.equal(fs.existsSync(files.get('sid-2')), true);
  const s1 = listStates(runs).find((s) => s.state.number === 1).state;
  assert.equal(s1.expired, true);
  assert.deepEqual(s1.sessions, {});
  assert.deepEqual(expireOldSessions(runs, { retentionDays: 7, now, sessionFile: (id) => files.get(id) }), []); // 不重复清理
});

test('claude CLI：续接会话时 total_cost_usd 是累计值，只计差值', async () => {
  const outs = [0.5, 0.62, 0.75].map((c) => JSON.stringify({ type: 'result', subtype: 'success', result: 'x', usage: {}, modelUsage: {}, total_cost_usd: c }));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'storm-cwd-'));
  let i = 0;
  const capture = [];
  const p = createClaudeCliProvider({ cwd }, { spawnImpl: (...a) => fakeSpawn(outs[i++], capture)(...a) });
  const session = { id: 'sid-c', turns: [] };
  const costs = [];
  for (const q of ['q1', 'q2', 'q3']) {
    costs.push((await p.complete({ prompt: q, session })).costUsd);
    session.turns.push({ prompt: q, reply: 'x' });
  }
  assert.deepEqual(costs, [0.5, 0.12, 0.13]);
  assert.equal(session.cliCostUsd, 0.75); // 随 state.json 保存，追问时接着求差
});

test('callCost：不续接直接用；续接旧会话没有累计值时交给价格估算', () => {
  assert.equal(callCost(0.3, null), 0.3);
  assert.equal(callCost(undefined, { turns: [] }), undefined);
  const old = { turns: [{ prompt: 'p', reply: 'r' }] };
  assert.equal(callCost(1.6, old), undefined);
  assert.equal(old.cliCostUsd, 1.6);
  assert.equal(callCost(1.7, old), 0.1);
  assert.equal(callCost(0.05, old), 0.05); // 累计值变小：当作本次费用
});
