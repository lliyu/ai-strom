import { whoOf } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig } from '../src/config.js';
import { runDiscussion, runFollowUp } from '../src/orchestrator.js';
import { createMemoryPublisher } from '../src/publishers.js';
import { parseFactQuestions } from '../src/modes.js';
import { codeForFollowUp } from '../src/runner.js';

const TOOLS = ['Read', 'Grep', 'Glob'];

const config = (extra = {}) => normalizeConfig({
  participants: [
    { id: 'a', name: 'A', provider: 'fake', part: 'lead', readCode: true },
    { id: 'b', name: 'B', provider: 'fake', part: 'lead' },
    { id: 'c', name: 'C', provider: 'fake', part: 'reviewer' },
  ],
  chair: { id: 'chair', name: '主席', provider: 'fake', color: 'purple' },
  providers: { fake: { type: 'mock' } },
  repos: { fission: { path: '/r/fission', description: '价格' } },
  maxRounds: 5,
  ...extra,
});

const code = {
  repos: [{ alias: 'fission', description: '价格', readPath: '/tmp/x', branch: 'main', commit: 'abc', dirty: 0, snapshot: false }],
  docs: ['/d/pricing'],
  groups: [],
  dirs: ['/tmp/x', '/d/pricing'],
};

/** 按发言者和阶段返回脚本里的回答；记录每次调用（含工具参数）。 */
function scripted(reply) {
  const calls = [];
  const provider = {
    async complete(opts) {
      const who = whoOf(opts);
      const stage = /【阶段：([^】]+)】/.exec(opts.prompt)?.[1] ?? '';
      const call = { who, stage, ...opts };
      calls.push(call);
      const text = reply(call);
      if (text instanceof Error) throw text;
      return { text: text ?? `发言-${calls.length}`, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { calls, registry: { get: () => provider } };
}

const QUESTION = 'SP 的 stack_strategy 对同一 promotion_type 的多条规则是叠加还是只取一条？';
const ANSWER = '1. 只取一条：同类型不堆叠（fission:stacking.go:520）。背景资料不完整：漏了同类型限制。';

function discussionScript({ failFirstCheck = false } = {}) {
  let checks = 0;
  return ({ who, stage }) => {
    if (stage === '核对主文档') return '没有问题';
    if (who === '调研员' && stage === '代码调研') return '**一句话现状**\nfission:Price.java:42';
    if (who === '调研员' && /代码核实/.test(stage)) {
      checks += 1;
      if (failFirstCheck && checks === 1) return new Error('超时');
      return ANSWER;
    }
    if (who === 'C') {
      if (/第 2 轮/.test(stage)) return `【阻断】取最优没确认\n\n**待核实的事实**\n- ${QUESTION}\n\n评审结论：继续讨论`;
      return '评审结论：没有意见了';
    }
    return null;
  };
}

test('解析待核实的事实：列表项、编号、写「无」、遇到别的段落结束', () => {
  assert.deepEqual(parseFactQuestions('正文\n\n**待核实的事实**\n- 问题一？\n2. 问题二\n\n评审结论：继续讨论'), ['问题一？', '问题二']);
  assert.deepEqual(parseFactQuestions('**待核实的事实**：\n- 无'), []);
  assert.deepEqual(parseFactQuestions('**待核实的事实**（没把握的）\n1、问题\n**立场变化**\n- 不是问题'), ['问题']);
  assert.deepEqual(parseFactQuestions('提到待核实的事实这个词\n- 不算'), []);
});

test('配置：claude-cli 主笔默认能查代码，评审和其他接口不能；核实默认开启', () => {
  const cfg = normalizeConfig({
    participants: [
      { id: 'l', provider: 'claude-cli', part: 'lead' },
      { id: 'r', provider: 'claude-cli', part: 'reviewer' },
      { id: 'h', provider: 'http', part: 'lead' },
      { id: 'off', provider: 'claude-cli', part: 'lead', readCode: false },
    ],
    chair: { id: 'chair', provider: 'claude-cli' },
    providers: { http: { type: 'openai-compatible', baseUrl: 'https://x' } },
    repos: { fission: { path: '/r/fission' } },
  });
  assert.deepEqual(cfg.participants.map((p) => p.readCode), [true, false, false, false]);
  assert.equal(cfg.research.factCheck, true);
  assert.equal(cfg.research.factCheckMaxQuestions, 8);
  assert.throws(() => normalizeConfig({
    participants: [{ id: 'h', provider: 'http', readCode: true }, { id: 'l', provider: 'claude-cli' }],
    chair: { id: 'chair', provider: 'claude-cli' },
    providers: { http: { type: 'openai-compatible', baseUrl: 'https://x' } },
    repos: { fission: { path: '/r/fission' } },
  }), /readCode 需要 claude-cli/);
});

test('讨论中：能查代码的主笔带只读工具；评审提的待核实问题由调研员在下一轮开始前查代码，结果发给所有人', async () => {
  const cfg = config();
  const { calls, registry } = scripted(discussionScript());
  const publisher = createMemoryPublisher();
  const res = await runDiscussion({ cfg, topic: 'PAT 接入 SP', providers: registry, publisher, rng: () => 0, code });

  assert.deepEqual(calls.map((c) => `${c.who}:${c.stage}`), [
    '调研员:代码调研',
    'A:独立方案', 'B:独立方案',
    'C:第 2 轮评审意见', 'A:第 2 轮互评与修订', 'B:第 2 轮互评与修订',
    '调研员:第 3 轮代码核实',
    'C:第 3 轮评审意见', // 评审没有意见了，但有新的核实结果：主笔要先修订，不提前结束
    'A:第 3 轮互评与修订', 'B:第 3 轮互评与修订',
    'C:第 4 轮评审意见', // 这才结束
    '主席:主文档',
    'A:核对主文档', 'B:核对主文档', // 主笔核对，没有意见就不用改
  ]);
  assert.equal(res.ending.reason, 'converged');

  // 能查代码的主笔：每次都带只读工具和目录；第一次给完整目录，之后只提醒
  const a = calls.filter((c) => c.who === 'A' && c.stage !== '核对主文档'); // 核对主文档不用查代码
  for (const c of a) {
    assert.deepEqual(c.tools, TOOLS);
    assert.deepEqual(c.addDirs, ['/tmp/x', '/d/pricing']);
  }
  assert.match(a[0].prompt, /你可以查代码[\s\S]*fission：`\/tmp\/x`[\s\S]*参考资料：`\/d\/pricing`/);
  assert.match(a[1].prompt, /你可以查代码\*\*：和前面一样/);
  assert.doesNotMatch(a[1].prompt, /`\/tmp\/x`/);
  // 其他人不带工具，但都被告知可以提待核实的问题
  for (const c of calls.filter((x) => ['B', 'C'].includes(x.who) && x.stage !== '核对主文档')) {
    assert.equal(c.tools, undefined);
    assert.match(c.prompt, /单独写一节「\*\*待核实的事实\*\*」/);
  }

  // 调研员核实：带工具，问题来自评审的发言
  const check = calls.find((c) => c.stage === '第 3 轮代码核实');
  assert.deepEqual(check.tools, TOOLS);
  assert.deepEqual(check.addDirs, ['/tmp/x', '/d/pricing']);
  assert.equal(check.system, res.state.shared); // 和讨论共用系统提示词（有议题和背景资料）
  assert.ok(check.prompt.includes(`1. ${QUESTION}`));
  assert.match(check.prompt, /背景资料有误/);

  // 核实结果：会话模式下每人只收到一次
  const r3 = calls.filter((c) => /第 3 轮/.test(c.stage) && c.who !== '调研员');
  for (const c of r3) assert.ok(c.prompt.includes('## 代码核实结果') && c.prompt.includes('同类型不堆叠'), `${c.who} 没收到核实结果`);
  assert.doesNotMatch(calls.find((c) => c.stage === '第 4 轮评审意见').prompt, /代码核实结果/);
  // 主席写主文档时拿到全部核实结果
  assert.match(calls.find((c) => c.stage === '主文档').prompt, /讨论中的代码核实结果[\s\S]*同类型不堆叠/);
  // 发到群里，记进讨论状态
  assert.ok(publisher.posts.some((p) => p.speaker.id === 'research' && p.subtitle === '第 3 轮 · 代码核实 · 1 个问题'));
  assert.deepEqual(res.state.facts, [{ round: 3, questions: [QUESTION], answer: ANSWER }]);
  assert.deepEqual(res.state.code, { auto: false, repos: [{ name: 'fission' }] });
});

test('核实失败不影响讨论，问题留到下一轮再查；同一个问题不重复查', async () => {
  const cfg = config();
  const { calls, registry } = scripted(discussionScript({ failFirstCheck: true }));
  const res = await runDiscussion({ cfg, topic: 't', providers: registry, publisher: createMemoryPublisher(), rng: () => 0, code });
  const checks = calls.filter((c) => /代码核实/.test(c.stage));
  assert.deepEqual(checks.map((c) => c.stage), ['第 3 轮代码核实', '第 4 轮代码核实']);
  assert.ok(checks.every((c) => c.prompt.includes(QUESTION)));
  assert.equal(res.state.facts.length, 1);
  assert.equal(res.state.facts[0].round, 4);
});

test('最后一轮才提的问题：写主文档前查掉，主席拿到结果', async () => {
  const cfg = config({ rounds: 2 });
  const { calls, registry } = scripted(({ who, stage }) => {
    if (stage === '核对主文档') return '没有问题';
    if (who === '调研员' && stage === '代码调研') return '资料';
    if (who === '调研员') return ANSWER;
    if (who === 'B' && /第 2 轮/.test(stage)) return `修订\n\n**待核实的事实**\n- ${QUESTION}`;
    return null;
  });
  await runDiscussion({ cfg, topic: 't', providers: registry, publisher: createMemoryPublisher(), rng: () => 0, code });
  assert.deepEqual(calls.slice(-4, -2).map((c) => `${c.who}:${c.stage}`), ['调研员:第 3 轮代码核实', '主席:主文档']);
  assert.match(calls.at(-3).prompt, /讨论中的代码核实结果/);
});

test('调研员判断不涉及代码时：不带工具，不请大家提待核实的问题', async () => {
  const cfg = config();
  const { calls, registry } = scripted(({ who, stage }) => (who === '调研员' && stage === '代码调研' ? '无相关代码' : null));
  await runDiscussion({ cfg, topic: '周会改到周四？', providers: registry, publisher: createMemoryPublisher(), rng: () => 0, code: { ...code, auto: true } });
  for (const c of calls.slice(1)) {
    assert.equal(c.tools, undefined);
    assert.doesNotMatch(c.prompt, /待核实的事实|你可以查代码/);
  }
});

test('关掉 research.factCheck：主笔仍能查代码，但不收集待核实的问题', async () => {
  const cfg = config({ research: { provider: 'fake', factCheck: false } });
  const { calls, registry } = scripted(discussionScript());
  await runDiscussion({ cfg, topic: 't', providers: registry, publisher: createMemoryPublisher(), rng: () => 0, code });
  assert.ok(calls.every((c) => !/代码核实/.test(c.stage)));
  assert.ok(calls.filter((c) => c.who === 'A' && c.stage !== '核对主文档').every((c) => c.tools));
  assert.ok(calls.filter((c) => c.who !== '调研员').every((c) => !/单独写一节/.test(c.prompt)));
});

test('追问：带上代码目录时主笔照样能查代码，新的待核实问题接着查，原来的核实结果保留', async () => {
  const cfg = config();
  const first = await runDiscussion({ cfg, topic: 't', providers: scripted(discussionScript()).registry, publisher: createMemoryPublisher(), rng: () => 0, code });
  const Q2 = 'Return 是否幂等？';
  const { calls, registry } = scripted(({ who, stage }) => {
    if (who === '主席' && /追问判断/.test(stage)) return '处理方式：重新讨论\n**给参与者的说明**\n按新目标';
    if (who === '调研员') return '1. 是（fission:budget.go:10）';
    if (who === 'B' && /回应追问/.test(stage)) return `回应\n\n**待核实的事实**\n- ${Q2}\n- ${QUESTION}`;
    if (who === 'C') return '评审结论：没有意见了';
    return null;
  });
  const out = await runFollowUp({ cfg, state: first.state, question: '只聊可行性', providers: registry, publisher: createMemoryPublisher(), code });

  const a = calls.find((c) => c.who === 'A' && /回应追问/.test(c.stage));
  assert.deepEqual(a.tools, TOOLS);
  assert.match(a.prompt, /你可以查代码[\s\S]*`\/tmp\/x`/); // 这次运行第一次发言，给完整目录
  assert.doesNotMatch(a.prompt, /## 代码核实结果/); // 原讨论里已经收到过
  // 已经核实过的问题不再查，只查新的
  const check = calls.find((c) => /代码核实/.test(c.stage));
  assert.ok(check.prompt.includes(`1. ${Q2}`));
  assert.ok(!check.prompt.includes(QUESTION));
  assert.match(calls.find((c) => c.who === '主席' && /追问判断/.test(c.stage)).prompt, /讨论中的代码核实结果/);
  assert.equal(out.state.facts.length, 2);
});

test('追问前准备代码目录：按原讨论记录的仓库或 auto；旧记录从说明里取别名；没有背景资料时不准备', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'storm-fc-')));
  const cfg = config({ repos: { fission: { path: dir }, other: { path: dir } } });
  assert.equal(codeForFollowUp(cfg, { context: null }), null);

  const bySpec = codeForFollowUp(cfg, { context: { repos: [] }, code: { auto: false, repos: [{ name: 'fission' }] } });
  assert.deepEqual(bySpec.repos.map((r) => r.alias), ['fission']);
  bySpec.cleanup();

  const legacy = codeForFollowUp(cfg, { context: { auto: false, repos: ['other（说明）：非 git 目录', 'gone：main @ abc'] } });
  assert.deepEqual(legacy.repos.map((r) => r.alias), ['other']);
  legacy.cleanup();

  const auto = codeForFollowUp(cfg, { context: { auto: true, repos: [] } });
  assert.equal(auto.auto, true);
  assert.deepEqual(auto.repos.map((r) => r.alias).sort(), ['fission', 'other']);
  auto.cleanup();
});
