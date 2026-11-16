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

test('长上下文分档：完整输入超过门槛时整次按长上下文单价算，缓存比例沿用；不超过按基础价', () => {
  const price = {
    currency: 'CNY', usdRate: 8, inputPerM: 0.24, outputPerM: 1.2, cacheReadRatio: 0.1, cacheWriteRatio: 1.25,
    longContext: { aboveTokens: 272000, inputPerM: 0.48, outputPerM: 1.8 },
  };
  // 27.2 万整：还在标准档。10 万未命中 + 17.2 万命中，输出 1 万
  const std = estimateCost(price, { inputTokens: 272000, cacheReadTokens: 172000, outputTokens: 10000 });
  assert.equal(std.longContext, false);
  assert.equal(std.amount, (100000 * 0.24 + 172000 * 0.024 + 10000 * 1.2) / 1e6);
  // 多 1 个 token 就整次按长上下文：命中 0.048、写入 0.6
  const long = estimateCost(price, { inputTokens: 272001, cacheReadTokens: 172000, cacheWriteTokens: 1000, outputTokens: 10000 });
  assert.equal(long.longContext, true);
  assert.equal(long.amount, Math.round((99001 * 0.48 + 172000 * 0.048 + 1000 * 0.6 + 10000 * 1.8)) / 1e6);
  assert.equal(long.costUsd, Math.round(long.amount / 8 * 1e6) / 1e6);
});
