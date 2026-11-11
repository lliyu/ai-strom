import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost, inWindow, priceFor } from '../src/pricing.js';
import { normalizeConfig } from '../src/config.js';
import { runDiscussion } from '../src/orchestrator.js';
import { createMemoryPublisher } from '../src/publishers.js';

const price = {
  currency: 'CNY', usdRate: 7.1, inputPerM: 2, outputPerM: 8, cacheReadRatio: 0.1,
  offPeak: { from: '22:00', to: '08:00', timezone: 'Asia/Shanghai', inputPerM: 1, outputPerM: 4 },
};
// 北京时间 = UTC+8
const busy = new Date('2026-11-10T06:00:00Z'); // 14:00
const idle = new Date('2026-11-10T15:30:00Z'); // 23:30

test('闲时区间跨零点', () => {
  assert.equal(inWindow(busy, price.offPeak), false);
  assert.equal(inWindow(idle, price.offPeak), true);
  assert.equal(inWindow(new Date('2026-11-10T23:59:00Z'), price.offPeak), true); // 07:59
  assert.equal(inWindow(new Date('2026-11-11T00:00:00Z'), price.offPeak), false); // 08:00
});

test('按忙闲时与缓存命中估算，折成美元', () => {
  const usage = { inputTokens: 2_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 };
  // 忙时：未命中 1M×2 + 命中 1M×2×0.1 + 输出 1M×8 = 10.2 元
  const b = estimateCost(price, usage, busy);
  assert.equal(b.amount, 10.2);
  assert.equal(b.currency, 'CNY');
  assert.equal(b.offPeak, false);
  assert.equal(b.costUsd, Math.round((10.2 / 7.1) * 1e6) / 1e6);
  // 闲时：1M×1 + 1M×1×0.1 + 1M×4 = 5.1 元
  assert.equal(estimateCost(price, usage, idle).amount, 5.1);
  assert.equal(estimateCost(null, usage), null);
});

test('接口没返回费用时，讨论里用估算值并标记', async () => {
  const cfg = normalizeConfig({
    participants: [{ id: 'a', provider: 'bl', model: 'm' }, { id: 'b', provider: 'bl', model: 'm' }],
    chair: { id: 'chair', provider: 'bl', model: 'm' },
    providers: { bl: { type: 'mock', pricing: { m: { ...price, offPeak: undefined } } } },
    rounds: 1,
  });
  assert.ok(priceFor(cfg, cfg.participants[0], 'm'));
  const events = [];
  const providers = { get: () => ({ async complete() { return { text: 'x', model: 'm', usage: { inputTokens: 1_000_000, outputTokens: 0 } }; } }) };
  await runDiscussion({ cfg, topic: 't', providers, publisher: createMemoryPublisher(), onEvent: (e) => events.push(e) });
  const done = events.filter((e) => e.type === 'call_finished');
  assert.ok(done.every((e) => e.costEstimated && e.costOriginal.amount === 2 && e.costOriginal.currency === 'CNY'));
  assert.ok(Math.abs(events.at(-1).stats.costUsd - (done.length * 2) / 7.1) < 1e-4);
});
