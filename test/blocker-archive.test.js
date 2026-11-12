// 阻断存档：状态按评审最后一次发言的结论，原文取最近一次写在行首的【阻断】；否定句不再顶掉真实阻断。
import { whoOf } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { runDiscussion } from '../src/orchestrator.js';
import { createMemoryPublisher } from '../src/publishers.js';
import { blockersBlock, isPendingBlocker, blockerStatusText, lineStartBlockers } from '../src/modes.js';

const GOOD_DOC = '【说明】\n一句话结论\n【主文档】\n# 结论\n正文';
const PLAN = (x) => `**要点**：方案 ${x}\n**改了什么**\n- 改了\n**立场变化**（小幅）\n\n【完整方案】\n完整方案-${x}`;
const REAL = (what) => `**要点**：1 条阻断\n- 【阻断】${what} → 出事回不去 → 加开关\n评审结论：继续讨论`;
const NEGATION_DONE = '**要点**：本轮没有【阻断】，只剩措辞\n评审结论：没有意见了';
const NEGATION_CONTINUE = '**要点**：本轮没有新的【阻断】，但还想再看一轮\n评审结论：继续讨论';
const QUIET = '**要点**：主要问题都解决了\n评审结论：继续讨论';

const cfgOf = (reviewers, extra = {}) => normalizeConfig({
  participants: [
    { id: 'a', name: 'A', provider: 'fake', part: 'lead' },
    { id: 'b', name: 'B', provider: 'fake', part: 'lead' },
    ...reviewers.map((id) => ({ id, name: id.toUpperCase(), provider: 'fake', part: 'reviewer' })),
  ],
  chair: { id: 'chair', name: '主席', provider: 'fake' },
  providers: { fake: { type: 'mock' } },
  retryDelayMs: 0,
  ...extra,
});

function scripted(reply) {
  const calls = [];
  const provider = {
    async complete(opts) {
      const who = whoOf(opts);
      const stage = /【阶段：([^】]+)】/.exec(opts.prompt)?.[1] ?? '';
      const round = Number(/第 (\d+) 轮/.exec(stage)?.[1] ?? 0);
      const call = { who, stage, round, prompt: opts.prompt };
      calls.push(call);
      return { text: reply(call) ?? (stage.includes('主文档') ? (stage === '核对主文档' ? '没有问题' : GOOD_DOC) : `发言-${calls.length}`), usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { calls, registry: { get: () => provider } };
}

test('存档：否定句不顶掉真实阻断；状态按最后一次结论分四种；没提过阻断的不进', async () => {
  const script = {
    // #8 的情形：真实阻断之后写「本轮没有【阻断】」加「没有意见了」
    r1: { 2: REAL('回滚没设计'), 3: REAL('灰度没设计'), 4: NEGATION_DONE },
    // 最后一次结论是继续，【阻断】却不在行首：格式未识别，附上更早写在行首的
    r2: { 2: REAL('接口不兼容'), 3: QUIET, 4: NEGATION_CONTINUE },
    // 最后一次一个【阻断】都没写：之前的阻断照录，标从哪一轮起未再提
    r3: { 2: REAL('没有监控'), 3: QUIET, 4: QUIET },
    // 最后一次有行首阻断、没写结论（固定轮数不要求结论）：仍在阻断
    r4: { 2: QUIET, 3: QUIET, 4: '**要点**：1 条\n- 【阻断】数据会丢' },
    // 从来没提过阻断
    r5: { 2: QUIET, 3: QUIET, 4: NEGATION_DONE },
  };
  const { calls, registry } = scripted((c) => {
    if (c.who === 'A' || c.who === 'B') return PLAN(`${c.who}${c.round}`);
    return script[c.who.toLowerCase()]?.[c.round] ?? null;
  });
  const res = await runDiscussion({ cfg: cfgOf(['r1', 'r2', 'r3', 'r4', 'r5'], { rounds: 4 }), topic: 't', providers: registry, publisher: createMemoryPublisher(), rng: () => 0 });
  const by = Object.fromEntries(res.state.blockers.map((b) => [b.id, b]));
  assert.deepEqual(Object.keys(by).sort(), ['r1', 'r2', 'r3', 'r4']);

  assert.deepEqual([by.r1.status, by.r1.round, by.r1.statusRound, by.r1.clearedAt], ['done', 3, 4, 4]);
  assert.deepEqual(by.r1.lines, ['- 【阻断】灰度没设计 → 出事回不去 → 加开关'], '真实阻断还在，否定句没有顶掉它');

  assert.deepEqual([by.r2.status, by.r2.round], ['unknown', 4]);
  assert.deepEqual(by.r2.lines, ['**要点**：本轮没有新的【阻断】，但还想再看一轮']);
  assert.deepEqual(by.r2.prev, { round: 2, lines: ['- 【阻断】接口不兼容 → 出事回不去 → 加开关'] });

  assert.deepEqual([by.r3.status, by.r3.round, by.r3.clearedAt], ['dropped', 2, 3]);
  assert.deepEqual([by.r4.status, by.r4.round, by.r4.lines], ['open', 4, ['- 【阻断】数据会丢']]);

  assert.deepEqual(res.state.blockers.filter(isPendingBlocker).map((b) => b.id).sort(), ['r2', 'r4']);

  // 交给主席的存档写明各自的状态
  const doc = calls.find((c) => c.stage === '主文档');
  assert.match(doc.prompt, /状态按他最后一次发言的评审结论/);
  assert.match(doc.prompt, /第 3 轮；第 4 轮评审结论：没有意见了\）\n- 【阻断】灰度没设计/);
  assert.match(doc.prompt, /第 4 轮；格式未识别[\s\S]*更早第 2 轮写在行首的阻断：\n- 【阻断】接口不兼容/);
  assert.match(doc.prompt, /第 2 轮；第 3 轮起未再提阻断/);
  assert.match(doc.prompt, /第 4 轮；仍在阻断\）\n- 【阻断】数据会丢/);
});

test('待裁决卡片：到上限时只发仍在阻断和格式未识别的，未识别的注明由主席判断', async () => {
  const { registry } = scripted((c) => {
    if (c.who === 'A' || c.who === 'B') return PLAN(`${c.who}${c.round}`); // 主笔每轮都改，不会熔断一
    if (c.who === 'R1') return NEGATION_CONTINUE; // 流程控制仍用旧判定：算有阻断，不收敛
    if (c.who === 'R2') return c.round === 2 ? REAL('回滚没设计') : NEGATION_DONE;
    return null;
  });
  const publisher = createMemoryPublisher();
  const res = await runDiscussion({ cfg: cfgOf(['r1', 'r2'], { rounds: 'auto', maxRounds: 3 }), topic: 't', providers: registry, publisher, rng: () => 0 });
  assert.equal(res.ending.reason, 'max');
  const card = publisher.posts.find((p) => p.meta?.stage === 'blockers');
  assert.ok(card, '到上限时发待裁决卡片');
  assert.match(card.body, /格式未识别.*请自行判断/);
  assert.match(card.body, /本轮没有新的【阻断】/);
  assert.doesNotMatch(card.body, /回滚没设计/, '写了「没有意见了」的评审不进待裁决卡片');
});

test('状态说明：旧状态没有 status 时按 clearedAt；行首阻断行去重', () => {
  assert.equal(blockerStatusText({ round: 3, clearedAt: 5 }), '第 3 轮；第 5 轮起未再提阻断');
  assert.equal(blockerStatusText({ round: 3 }), '第 3 轮；仍在阻断');
  assert.equal(isPendingBlocker({ round: 3 }), true);
  assert.equal(isPendingBlocker({ round: 3, clearedAt: 4 }), false);
  assert.equal(blockersBlock([]), '');
  assert.deepEqual(lineStartBlockers('- 【阻断】x', '1. **【阻断】x**\n- 本轮没有【阻断】'), ['- 【阻断】x']);
});
