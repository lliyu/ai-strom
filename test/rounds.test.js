import { whoOf } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { runDiscussion } from '../src/orchestrator.js';
import { createMemoryPublisher } from '../src/publishers.js';
import { parseVerdict, parseStanceChange } from '../src/modes.js';

const base = (extra = {}) => ({
  participants: [
    { id: 'a', name: 'A', provider: 'fake', part: 'lead' },
    { id: 'b', name: 'B', provider: 'fake', part: 'lead' },
    { id: 'r1', name: 'R1', provider: 'fake', part: 'reviewer' },
    { id: 'r2', name: 'R2', provider: 'fake', part: 'reviewer' },
  ],
  chair: { id: 'chair', name: '主席', provider: 'fake' },
  providers: { fake: { type: 'mock' } },
  ...extra,
});

/** reply({ who, stage, round, prompt }) 决定每次的回答 */
function scripted(reply) {
  const calls = [];
  const provider = {
    async complete({ system, prompt }) {
      const who = whoOf(arguments[0]);
      const stageText = /【阶段：([^】]+)】/.exec(prompt)?.[1] ?? '';
      const round = Number(/第 (\d+) 轮/.exec(stageText)?.[1] ?? 0);
      const call = { who, stageText, round, prompt, system };
      calls.push(call);
      return { text: reply(call) ?? `发言-${calls.length}`, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { calls, registry: { get: () => provider } };
}

test('解析评审结论与立场变化', () => {
  assert.equal(parseVerdict('意见……\n评审结论：没有意见了'), 'done');
  assert.equal(parseVerdict('**评审结论**：继续讨论'), 'continue');
  assert.equal(parseVerdict('评审结论：没有意见了\n……\n评审结论：继续讨论'), 'continue'); // 取最后一次
  assert.equal(parseVerdict('没写结论'), null);
  assert.equal(parseStanceChange('**立场变化**（无，一句话）'), '无');
  assert.equal(parseStanceChange('**立场变化**\n小幅：采纳了缓存建议'), '小幅');
});

test('自动轮数：评审都没有意见时提前结束，主笔不再修订', async () => {
  const cfg = normalizeConfig(base());
  // 第 2 轮 R1 还有意见，第 3 轮两位评审都没有意见
  const { calls, registry } = scripted(({ who, round }) => {
    if (who === 'R1') return round >= 3 ? '小问题\n评审结论：没有意见了' : '【阻断】大问题\n评审结论：继续讨论';
    if (who === 'R2') return '还行\n评审结论：没有意见了';
    return null;
  });
  const publisher = createMemoryPublisher();
  const events = [];
  const res = await runDiscussion({ cfg, topic: 't', providers: registry, publisher, onEvent: (e) => events.push(e) });
  assert.equal(res.roundsUsed, 3);
  assert.equal(res.ending.reason, 'converged');
  // 第 3 轮只有评审发言，主笔没有修订
  assert.deepEqual(calls.filter((c) => c.round === 3).map((c) => c.who).sort(), ['R1', 'R2']);
  // 评审被要求给结论，主席知道讨论是怎么结束的
  assert.match(calls.find((c) => c.who === 'R1').prompt, /评审结论：继续讨论」或「评审结论：没有意见了/);
  assert.match(calls.find((c) => c.stageText === '主文档').prompt, /第 3 轮所有评审都表示没有新意见/);
  assert.match(publisher.posts[0].body, /直到评审都没有新意见（最多 20 轮）/);
  assert.match(publisher.posts.at(-1).subtitle, /共 3 轮，评审都没有新意见/);
  assert.deepEqual(events.at(-1).ending, 'converged');
});

test('自动轮数：一直有意见就跑到上限，主席被告知强制结束', async () => {
  const cfg = normalizeConfig(base({ maxRounds: 4 }));
  const { calls, registry } = scripted(({ who }) => (who?.startsWith('R') ? '【阻断】还有问题\n评审结论：继续讨论' : null));
  const res = await runDiscussion({ cfg, topic: 't', providers: registry, publisher: createMemoryPublisher() });
  assert.equal(res.roundsUsed, 4);
  assert.equal(res.ending.reason, 'max');
  assert.match(calls.find((c) => c.stageText === '主文档').prompt, /达到上限 4 轮，评审仍有意见/);
});

test('自动轮数：没写结论或评审失败不算同意；有新插话时不结束', async () => {
  const cfg = normalizeConfig(base({ maxRounds: 3 }));
  const { registry } = scripted(({ who }) => (who === 'R1' ? '忘了写结论' : who === 'R2' ? '评审结论：没有意见了' : null));
  const res = await runDiscussion({ cfg, topic: 't', providers: registry, publisher: createMemoryPublisher() });
  assert.equal(res.ending.reason, 'max');

  // 一位评审没意见、另一位调用失败：不算都同意，继续到上限
  const failing = { get: () => ({ async complete(o) { const who = whoOf(o); if (who === 'R1') throw new Error('max_tokens'); return { text: who === 'R2' ? '评审结论：没有意见了' : 'x', usage: {} }; } }) };
  const res3 = await runDiscussion({ cfg, topic: 't', providers: failing, publisher: createMemoryPublisher() });
  assert.equal(res3.ending.reason, 'max');

  // 两位评审都没意见，但第 2 轮开始前人类插话了：主笔要先回应，所以不结束
  const polls = [[], [{ sender: '我', text: '补充约束' }], [], [], []];
  const interjections = { poll: async () => polls.shift() ?? [] };
  const { calls, registry: r2 } = scripted(({ who }) => (who?.startsWith('R') ? '评审结论：没有意见了' : null));
  const res2 = await runDiscussion({ cfg, topic: 't', providers: r2, publisher: createMemoryPublisher(), interjections });
  assert.equal(res2.roundsUsed, 3);
  assert.ok(calls.some((c) => c.round === 2 && c.who === 'A'));
});

test('固定轮数：不要求评审给结论，跑满', async () => {
  const cfg = normalizeConfig(base(), { rounds: 3 });
  assert.equal(cfg.adaptive, false);
  const { calls, registry } = scripted(({ who }) => (who?.startsWith('R') ? '评审结论：没有意见了' : null));
  const res = await runDiscussion({ cfg, topic: 't', providers: registry, publisher: createMemoryPublisher() });
  assert.equal(res.roundsUsed, 3);
  assert.equal(res.ending.reason, 'fixed');
  assert.ok(calls.filter((c) => c.who === 'R1').every((c) => !/评审结论/.test(c.prompt)));
  // 已规范化的自动配置再规范化仍是自动
  assert.equal(normalizeConfig(normalizeConfig(base())).adaptive, true);
});

test('没有评审的方案讨论：主笔立场都不变时结束', async () => {
  const cfg = normalizeConfig({ ...base(), participants: base().participants.slice(0, 2) });
  const { registry } = scripted(({ round, who }) => (who && round === 3 ? '**立场变化**（无）' : who ? '**立场变化**（小幅）' : null));
  const res = await runDiscussion({ cfg, topic: 't', providers: registry, publisher: createMemoryPublisher() });
  assert.equal(res.roundsUsed, 3);
  assert.equal(res.ending.reason, 'converged');
});

test('脑洞风暴 + 评审：评审都没有意见时在修订前结束', async () => {
  const cfg = normalizeConfig(base({ mode: 'brainstorm' }));
  const { calls, registry } = scripted(({ who, stageText }) => (who?.startsWith('R') && /盲审/.test(stageText) ? '评审结论：没有意见了' : null));
  const res = await runDiscussion({ cfg, topic: 't', providers: registry, publisher: createMemoryPublisher() });
  assert.equal(res.roundsUsed, 2);
  assert.ok(!calls.some((c) => /修订/.test(c.stageText)));
  // 只有评审被要求给结论，主笔的盲审不需要
  assert.ok(calls.filter((c) => c.who === 'A' && /盲审/.test(c.stageText)).every((c) => !/评审结论/.test(c.prompt)));
});
